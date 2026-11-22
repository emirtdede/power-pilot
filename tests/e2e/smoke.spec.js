/**
 * smoke.spec.js - WP-15/TS-34
 * Electron uygulaması açılır, preload köprüsü yüklenir ve güvenli
 * varsayılanlar (uzaktan kapatma koruması) IPC üzerinden okunur.
 *
 * Not: Test gerçek kullanıcı verisini kirletmez; geçici `--user-data-dir`
 * kullanır ve sonunda temizler.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('uygulama açılır, preload API ve güvenli varsayılanlar hazır', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-e2e-'));
    let app = null;
    try {
        app = await electron.launch({
            args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                POWERPILOT_E2E: '1'
            }
        });

        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');

        await expect(window).toHaveTitle(/Power Pilot/i);
        const bridgeOk = await window.evaluate(() =>
            !!(window.electronAPI && typeof window.electronAPI.getSettings === 'function'));
        expect(bridgeOk).toBe(true);

        const settings = await window.evaluate(() => window.electronAPI.getSettings());
        expect(settings).toBeTruthy();
        expect(settings.blockRemoteShutdownWhenActive).toBe(true);
        expect(Array.isArray(settings.lanAllowedIps)).toBe(true);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* zaten kapalı */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi: geçici dizin */ }
    }
});
