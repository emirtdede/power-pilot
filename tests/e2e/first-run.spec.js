/**
 * first-run.spec.js - ilk açılış rehberi ve PIN çıkmazı
 *
 * PPX-016 (T-08.17) tek kurulum deneyimi:
 *  S1 - sihirbazı atlayan kullanıcı rehberi GÖRMEZ.
 *  S2 - sihirbaz zaten tamamlanmışsa rehber görünür ve 1 görev oluşturur.
 *
 * (Eski tek senaryo, PPX-016 kararıyla bilinçli olarak ikiye bölündü.)
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function launch(userDataDir) {
    return electron.launch({
        args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
            POWERPILOT_E2E: '1'
        }
    });
}

async function waitReady(window) {
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
}

function cleanup(app, userDataDir) {
    if (app) {
        try { app.close(); } catch (_) { /* yut */ }
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
}

test('S1: sihirbazı atlayan kullanıcı rehberi görmez (PPX-016)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-firstrun-s1-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        const errors = [];
        window.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
        await waitReady(window);

        const wizard = window.locator('#wizard-overlay');
        if (await wizard.isVisible().catch(() => false)) {
            await window.locator('#btn-wz-skip').click();
            await expect(wizard).toBeHidden();
        }
        await window.waitForTimeout(600);
        await expect(window.locator('#onboarding')).toBeHidden();

        const flags = await window.evaluate(() => ({
            skipped: localStorage.getItem('pp-wizard-skipped'),
            done: localStorage.getItem('onboardingDone')
        }));
        expect(flags.skipped).toBe('1');
        expect(flags.done).not.toBe('1');
        expect(errors).toEqual([]);
    } finally {
        cleanup(app, userDataDir);
    }
});

test('S2: sihirbaz tamamlanmışsa rehber 1 görev oluşturur + PIN yönlendirmesi', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-firstrun-s2-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        let window = await app.firstWindow();
        await waitReady(window);

        // Sihirbazı önceden tamamlanmış say ve sayfayı yenile.
        await window.evaluate(() => localStorage.setItem('pp-wizard-done', '1'));
        await window.reload();
        await waitReady(window);

        const wizard = window.locator('#wizard-overlay');
        await expect(wizard).toBeHidden();
        await expect(window.locator('#onboarding')).toBeVisible();
        await window.locator('[data-onboarding-choice="download"]').click();
        await expect(window.locator('#onboarding-step-2')).toBeVisible();
        await window.locator('#onboarding-create').click();
        await expect(window.locator('#onboarding')).toBeHidden();

        const tasks = await window.evaluate(() => window.electronAPI.getTasks());
        expect(Array.isArray(tasks)).toBe(true);
        expect(tasks.length).toBe(1);
        expect(tasks[0].conditionGroup.conditions[0].type).toBe('network_speed');

        // PIN yokken kritik otonomi değişikliği: onay penceresi → PIN kur yönlendirmesi.
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-automation"]').click();
        await window.locator('input[name="autonomyMode"][value="full"]').check();
        await expect(window.locator('#modal-confirm-action')).toBeVisible();
        await window.locator('#modal-confirm-action-yes').click();
        await window.waitForTimeout(600);

        const state = await window.evaluate(() => ({
            pinModalHidden: document.getElementById('modal-pin')?.classList.contains('hidden'),
            activeId: document.activeElement && document.activeElement.id,
            toast: document.getElementById('toast-container')?.innerText || ''
        }));
        expect(state.pinModalHidden).toBe(true);
        expect(state.activeId).toBe('btn-pin-set');
        expect(state.toast.trim().length).toBeGreaterThan(0);
    } finally {
        cleanup(app, userDataDir);
    }
});
