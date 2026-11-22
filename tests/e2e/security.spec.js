/**
 * security.spec.js - WP-10 T1/T2/T5/T6/T8 E2E kabulü
 * app:// origin, katı CSP, sandbox, path traversal, sahte IPC ve dış gezinme.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test.describe('renderer güvenlik sınırı', () => {
    let app = null;
    let userDataDir = null;
    let window = null;

    test.beforeAll(async () => {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-sec-'));
        app = await electron.launch({
            args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                POWERPILOT_E2E: '1'
            }
        });
        window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
    });

    test.afterAll(async () => {
        if (app) await app.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* yut */ }
    });

    test('app:// origin, meta CSP, başlıklar ve sandbox etkin', async () => {
        await window.addInitScript(() => {
            window.__cspViolations = [];
            document.addEventListener('securitypolicyviolation', (event) => {
                window.__cspViolations.push(event.violatedDirective || 'unknown');
            });
        });
        const documentResponse = window.waitForResponse((res) => (
            res.url().startsWith('app://powerpilot/') && res.request().resourceType() === 'document'
        ));
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        const response = await documentResponse;
        expect(window.url()).toMatch(/^app:\/\/powerpilot\//);

        const state = await window.evaluate(() => ({
            csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '',
            inlineHandlers: document.querySelectorAll('[onclick],[onload],[onerror],[onchange]').length,
            inlineScripts: [...document.scripts].filter((s) => !s.src).length,
            violations: window.__cspViolations || [],
            processType: typeof window.process,
            requireType: typeof window.require,
            apiType: typeof window.electronAPI
        }));
        expect(state.csp).toContain("default-src 'none'");
        expect(state.csp).toContain("script-src 'self'");
        expect(state.csp).toContain("connect-src 'none'");
        expect(state.inlineHandlers).toBe(0);
        expect(state.inlineScripts).toBe(0);
        expect(state.violations).toEqual([]);
        expect(state.processType).toBe('undefined');
        expect(state.requireType).toBe('undefined');
        expect(state.apiType).toBe('object');

        const headers = await response.allHeaders();
        expect(response.status()).toBe(200);
        expect(headers['content-security-policy']).toContain("default-src 'none'");
        expect(headers['x-content-type-options']).toContain('nosniff');
        expect(headers['referrer-policy']).toBe('no-referrer');
        expect(headers['cross-origin-opener-policy']).toBe('same-origin');
        expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    test('path traversal app:// üzerinden reddedilir', async () => {
        const statuses = await app.evaluate(async ({ net }) => {
            const attempts = [
                'app://powerpilot/%2e%2e/main.js',
                'app://powerpilot/..%2f..%2fpackage.json',
                'app://powerpilot/%2e%2e%5csrc%5cmain.js'
            ];
            const out = [];
            for (const url of attempts) {
                try {
                    const res = await net.fetch(url);
                    out.push(res.status);
                } catch (_) {
                    out.push(0);
                }
            }
            return out;
        });
        for (const status of statuses) expect([0, 403, 404]).toContain(status);
    });

    test('dış gezinme ve yeni pencere reddedilir', async () => {
        const opened = await window.evaluate(() => {
            const child = window.open('https://evil.example/');
            return { child: child === null, url: location.href };
        });
        expect(opened.child).toBe(true);
        expect(opened.url).toMatch(/^app:\/\/powerpilot\//);

        const navigate = await window.evaluate(async () => {
            try {
                window.location.href = 'https://evil.example/';
                await new Promise((resolve) => setTimeout(resolve, 250));
                return location.href;
            } catch (_) {
                return location.href;
            }
        });
        expect(navigate).toMatch(/^app:\/\/powerpilot\//);
    });

    test('preload yalnızca allowlist IPC yüzeyi sunar', async () => {
        const keys = await window.evaluate(() => Object.keys(window.electronAPI || {}));
        expect(keys).toContain('getLocale');
        expect(keys).toContain('securitySettingsUpdate');
        expect(keys).not.toContain('ipcRenderer');
        expect(keys).not.toContain('require');
        expect(keys).not.toContain('eval');
    });

    test('T-CSP-04: görev/şablon başlığı XSS olarak çalışmaz', async () => {
        const saved = await window.evaluate(() => {
            window.__xss = undefined;
            return window.electronAPI.saveTemplate({
                id: 'e2e_xss_template',
                name: '<img src=x onerror="window.__xss=1">',
                action: 'lock',
                defaultCondition: { type: 'user_idle', idleSeconds: 60 }
            });
        });
        expect(saved && saved.success).not.toBe(false);
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
        await window.locator('#nav-templates').click();
        await expect(window.locator('#templates-grid')).toContainText('<img src=x onerror="window.__xss=1">');
        expect(await window.evaluate(() => window.__xss)).toBeUndefined();
        await window.evaluate(() => window.electronAPI.deleteTemplate('e2e_xss_template'));
    });

    test('T-CSP-05: güvenlik ayarları ve API anahtarı PIN olmadan değişmez', async () => {
        const before = await window.evaluate(() => window.electronAPI.getSettings());
        const saved = await window.evaluate(() => window.electronAPI.saveSettings({
            agentDisabled: false,
            autonomyMode: 'full',
            localApiTlsEnabled: false,
            localApiRequireClientCert: false
        }));
        expect(saved).toMatchObject({ success: false, code: 'UNKNOWN_SETTING' });

        const security = await window.evaluate(() => window.electronAPI.securitySettingsUpdate({
            settings: { localApiTlsEnabled: false },
            pin: null
        }));
        expect(security).toMatchObject({ success: false, code: 'PIN_REQUIRED' });

        const key = await window.evaluate(() => window.electronAPI.generateApiKey({ role: 'admin' }));
        expect(key).toMatchObject({ success: false, code: 'PIN_REQUIRED' });

        const after = await window.evaluate(() => window.electronAPI.getSettings());
        expect(after.localApiTlsEnabled).toBe(before.localApiTlsEnabled);

        // PIN yapılandırıldıktan sonra aynı işlemler açılabilir (kilitlenme yok).
        const pinSet = await window.evaluate(() => window.electronAPI.setCancelPin('4321'));
        expect(pinSet && pinSet.success).not.toBe(false);
        const allowed = await window.evaluate(() => window.electronAPI.securitySettingsUpdate({
            settings: { localApiTlsEnabled: false },
            pin: '4321'
        }));
        expect(allowed && allowed.success).not.toBe(false);
    });

    test('T-CSP-06: uzun AI girdisi ve dakikalık komut sınırı uygulanır', async () => {
        const tooLong = await window.evaluate(() => window.electronAPI.aiParse('x'.repeat(4001)));
        expect(tooLong).toMatchObject({ ok: false, code: 'INPUT_TOO_LONG' });

        let last = null;
        for (let i = 0; i < 11; i += 1) {
            last = await window.evaluate((n) => window.electronAPI.aiParse(`kapat ${n}`), i);
        }
        expect(last).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    });
});
