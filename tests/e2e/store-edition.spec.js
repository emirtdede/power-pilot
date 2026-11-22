/**
 * store-edition.spec.js - Microsoft Store (MSIX) kapsamı
 *
 * Store dağıtımında autostart Windows Başlangıç ayarlarına devredilir;
 * LAN erişimi, konsol ajanı ve servis modu kapalıdır. PP_STORE_BUILD=1
 * ana süreçte aynı kapsamı simüle eder (process.windowsStore olmadan test).
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Store sürümünde autostart ve LAN kısıtları uygulanır', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-store-'));
    let app = null;
    try {
        app = await electron.launch({
            args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                POWERPILOT_E2E: '1',
                PP_STORE_BUILD: '1'
            }
        });
        const window = await app.firstWindow();
        const errors = [];
        window.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

        const info = await window.evaluate(() => window.electronAPI.getDistribution());
        expect(info.store).toBe(true);
        expect(info.features.lanApi).toBe(false);
        expect(info.features.consoleAgent).toBe(false);
        expect(info.features.startupViaWindowsSettings).toBe(true);

        await window.locator('#nav-settings').click();
        await window.waitForTimeout(200);
        expect(await window.locator('#setting-autostart').isDisabled()).toBe(true);
        await expect(window.locator('#autostart-store-note')).toBeVisible();

        await window.locator('#nav-integrations').click();
        await window.waitForTimeout(200);
        expect(await window.locator('#api-lan').isDisabled()).toBe(true);
        expect(await window.locator('#api-ips').isDisabled()).toBe(true);
        await expect(window.locator('#store-api-note')).toBeVisible();

        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
    }
});
