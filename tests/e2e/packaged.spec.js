/**
 * packaged.spec.js - WP-15.T3
 * Paketlenmiş (ASAR + fuses) uygulamanın temiz kurulum sonrası çalıştığını
 * doğrular. Kurulum/yükseltme/kaldırma adımları `scripts/packaged-e2e.ps1`
 * tarafından yapılır; bu spec kurulum sonrası EXE'yi `PP_PACKAGED_EXE` ile alır.
 *
 * Not: Üretim fuses `enableNodeCliInspectArguments=false` olduğu için
 * Playwright'ın `_electron.launch` ana-süreç denetçisi kullanılamaz. Bu spec
 * uygulamayı normal süreç olarak başlatır ve yalnızca renderer CDP hedefine
 * bağlanır; böylece sertleştirilmiş paket zayıflatılmadan doğrulanır.
 *
 * Yerel/CI: PP_PACKAGED_EXE="C:\Program Files\Power Pilot\Power Pilot.exe" npx playwright test packaged
 */
const { test, expect } = require('@playwright/test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const packagedExe = process.env.PP_PACKAGED_EXE || '';

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitForPageTarget(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            if (res.ok) {
                const targets = await res.json();
                const page = targets.find((target) => target.type === 'page' && String(target.url).startsWith('app://powerpilot/'));
                if (page && page.webSocketDebuggerUrl) return page;
            }
        } catch (_) { /* henüz hazır değil */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Renderer CDP hedefi açılmadı: ${port}`);
}

function connectCdp(wsUrl) {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        const pending = new Map();
        let nextId = 1;
        const timer = setTimeout(() => reject(new Error('CDP bağlantı zaman aşımı')), 15000);
        socket.addEventListener('open', () => {
            clearTimeout(timer);
            const send = (method, params = {}) => new Promise((res, rej) => {
                const id = nextId++;
                pending.set(id, { res, rej });
                socket.send(JSON.stringify({ id, method, params }));
            });
            resolve({
                send,
                evaluate(expression) {
                    return send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
                        .then((result) => (result && result.result ? result.result.value : undefined));
                },
                close() {
                    try { socket.close(); } catch (_) { /* yut */ }
                }
            });
        });
        socket.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('CDP WebSocket hatası'));
        });
        socket.addEventListener('message', (event) => {
            let message = null;
            try { message = JSON.parse(String(event.data)); } catch (_) { return; }
            if (!message || !message.id || !pending.has(message.id)) return;
            const { res, rej } = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) rej(new Error(message.error.message || 'CDP hatası'));
            else res(message.result);
        });
    });
}

function killTree(pid) {
    try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (_) { /* zaten kapanmış */ }
}

test.describe('paketlenmiş uygulama (WP-15.T3)', () => {
    test.skip(!packagedExe, 'PP_PACKAGED_EXE tanımlı değil; NSIS kurulumu sonrası çalıştırın.');

    test('app://, preload, native modül ve SQLite ile açılır', async () => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-packaged-'));
        const port = await freePort();
        let child = null;
        let cdp = null;
        try {
            child = spawn(packagedExe, [
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${userDataDir}`,
                '--disable-gpu'
            ], {
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                    POWERPILOT_E2E: '1'
                },
                stdio: 'ignore',
                windowsHide: true
            });
            const target = await waitForPageTarget(port);
            cdp = await connectCdp(target.webSocketDebuggerUrl);
            await cdp.send('Runtime.enable').catch(() => {});
            await cdp.send('Page.enable').catch(() => {});

            const deadline = Date.now() + 30000;
            let version = '';
            while (Date.now() < deadline) {
                try {
                    version = await cdp.evaluate("document.getElementById('app-version')?.innerText || ''");
                    if (/^v\d+\.\d+\.\d+/.test(String(version))) break;
                } catch (_) { /* execution context henüz hazır değil */ }
                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            const state = await cdp.evaluate(`({
                url: location.href,
                title: document.title,
                locale: typeof window.electronAPI?.getLocale,
                security: typeof window.electronAPI?.getSecurityStatus,
                version: document.getElementById('app-version')?.innerText || ''
            })`);
            expect(state.url).toMatch(/^app:\/\/powerpilot\//);
            expect(state.title).toMatch(/Power Pilot/i);
            expect(state.locale).toBe('function');
            expect(state.security).toBe('function');
            expect(state.version.trim()).toMatch(/^v1\.0\.0$/);

            const locale = await cdp.evaluate("window.electronAPI.getLocale('tr')");
            expect(locale && locale.ok).toBe(true);
            expect(locale.dictionary && typeof locale.dictionary === 'object').toBe(true);
            // Paketlenmiş asar güncel sözlüğü içermeli (dil sızıntısı regresyonu).
            for (const key of ['winMenu', 'winMinimize', 'aiMicListening', 'errorDownloadIntegrity']) {
                expect(key in locale.dictionary, key).toBe(true);
            }

            // Native modül (better-sqlite3) ve DB dosyası userData altında hazır.
            expect(fs.existsSync(path.join(userDataDir, 'powerpilot.db'))).toBe(true);
        } finally {
            if (cdp) cdp.close();
            if (child && child.pid) killTree(child.pid);
            try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
        }
    });
});
