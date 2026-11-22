/**
 * tests/e2e/helpers/launch.js - ortak Electron açılış/kapatma yardımcıları.
 * Yeni PPX spec'leri aynı deseni kullanır (mevcut spec'ler değişmez).
 */
const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function launchApp(prefix = 'powerpilot-a11y-') {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const app = await electron.launch({
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
    await window.waitForFunction(
        () => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || '')
    );
    return { app, window, userDataDir };
}

async function setSize(app, width, height) {
    await app.evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 40, y: 40, width: size.width, height: size.height });
    }, { width, height });
    await new Promise((r) => setTimeout(r, 220));
}

/** Sihirbaz/rehber katmanlarını kapatır (PPX-016: atlama rehberi de kapatır). */
async function dismissOverlays(window) {
    const wizard = window.locator('#wizard-overlay');
    if (await wizard.isVisible().catch(() => false)) {
        await window.locator('#btn-wz-skip').click().catch(() => {});
    }
    const onboarding = window.locator('#onboarding');
    if (await onboarding.isVisible().catch(() => false)) {
        await window.locator('#onboarding-skip').click().catch(async () => {
            await window.evaluate(() => {
                localStorage.setItem('onboardingDone', '1');
                document.getElementById('onboarding')?.classList.add('hidden');
            });
        });
    }
}

async function closeApp(app, userDataDir) {
    try { await app.close(); } catch (_) { /* yut */ }
    try {
        fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (_) { /* Windows kilidi: geçici dizin */ }
}

module.exports = { launchApp, setSize, dismissOverlays, closeApp };
