/**
 * sound-mode.spec.js - A9: uyarı sesi tercihi
 *
 * Eski davranış: ses 22:00-08:00 arası sabit kapalıydı ve kullanıcının seçimi
 * yoktu; gece çalışan kullanıcı kapatma uyarısını hiç duymuyordu. Artık
 * Otomatik / Her zaman / Kapalı seçilebilir ve seçim yeniden açılışta korunur.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launch = (userDataDir) => electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: {
        ...process.env,
        NODE_ENV: 'production',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        POWERPILOT_E2E: '1'
    }
});

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (_) { /* Windows kilidi: geçici dizin */ }
}

test('uyarı sesi tercihi: varsayılan otomatik, değişir ve yeniden açılışta korunur', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-sound-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');

        // Onboarding/ilk sihirbaz varsa kapat (ayarlara erişmek için).
        const wizard = window.locator('#wizard-overlay');
        if (await wizard.isVisible().catch(() => false)) {
            await window.locator('#btn-wz-skip').click();
            await expect(wizard).toBeHidden();
        }
        const onboarding = window.locator('#onboarding');
        if (await onboarding.isVisible().catch(() => false)) {
            await window.locator('#onboarding-skip').click();
            await expect(onboarding).toBeHidden();
        }

        await window.locator('#nav-settings').click();

        const select = window.locator('#setting-sound-mode');
        await expect(select).toBeVisible();
        // Varsayılan: otomatik (gece sessiz) - eski davranışın korunmuş hâli.
        await expect(select).toHaveValue('auto');

        // Üç seçenek de çevrilmiş olmalı (ham anahtar sızıntısı yok).
        const labels = await select.locator('option').allInnerTexts();
        expect(labels.length).toBe(3);
        for (const label of labels) {
            expect(label.trim().length).toBeGreaterThan(0);
            expect(label).not.toMatch(/^soundMode/);
        }

        // 'Her zaman' seçilince anında otomatik kaydedilir (Save düğmesine gerek yok).
        await select.selectOption('always');
        await window.waitForTimeout(400);

        const saved = await window.evaluate(() => localStorage.getItem('soundMode'));
        expect(saved).toBe('always');

        // Yeniden açılışta korunur.
        await app.close();
        app = null;

        app = await launch(userDataDir);
        const window2 = await app.firstWindow();
        await window2.waitForLoadState('domcontentloaded');
        const onboarding2 = window2.locator('#onboarding');
        if (await onboarding2.isVisible().catch(() => false)) {
            await window2.locator('#onboarding-skip').click();
        }
        await window2.locator('#nav-settings').click();
        await expect(window2.locator('#setting-sound-mode')).toHaveValue('always');
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});
