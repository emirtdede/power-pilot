/**
 * data-wipe.spec.js - "Verilerimi sil" akışı (Store politikası 10.2.7).
 *
 * Doğrular:
 *  1. Ayarlar > Gizlilik kartı görünür ve düğme erişilebilir.
 *  2. Onay modalı açılır; "Vazgeç" hiçbir şeyi silmez.
 *  3. Onaylanınca veritabanı dosyası gerçekten silinir (yeniden başlatınca
 *     ilk kurulum deneyimi; eski görevler geri gelmez).
 *  4. `confirm` bayrağı olmadan sunucu silmez (istemci güven sınırı değildir).
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

async function ready(window) {
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
    const wizard = window.locator('#wizard-overlay');
    if (await wizard.isVisible().catch(() => false)) {
        await window.locator('#btn-wz-skip').click().catch(() => {});
        await expect(wizard).toBeHidden();
    }
    const onboarding = window.locator('#onboarding');
    if (await onboarding.isVisible().catch(() => false)) {
        await window.locator('#onboarding-skip').click().catch(async () => {
            await window.evaluate(() => {
                localStorage.setItem('onboardingDone', '1');
                document.getElementById('onboarding')?.classList.add('hidden');
            });
        });
        await expect(onboarding).toBeHidden();
    }
}

const dbPath = (dir) => path.join(dir, 'powerpilot.db');

test('verilerimi sil: onay, iptal ve kalıcı silme', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-wipe-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        let window = await app.firstWindow();
        await ready(window);

        // Bir görev oluştur ki silinecek gerçek veri olsun.
        const created = await window.evaluate(() => window.electronAPI.createTask({
            name: 'Silinecek görev',
            action: 'lock',
            trigger: { type: 'duration', durationMs: 3600000 }
        }));
        expect(created && created.success).toBe(true);
        // DB dosyası diskte oluşmuş olmalı.
        await expect.poll(() => fs.existsSync(dbPath(userDataDir))).toBe(true);
        const sizeBefore = fs.statSync(dbPath(userDataDir)).size;
        expect(sizeBefore).toBeGreaterThan(0);

        // --- 1) Kart ve düğme görünür ---------------------------------
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-security"]').click();
        await window.waitForTimeout(400);
        await expect(window.locator('#settings-danger')).toBeVisible();
        await expect(window.locator('#btn-delete-all-data')).toBeVisible();

        // --- 2) İptal hiçbir şeyi silmez -------------------------------
        await window.locator('#btn-delete-all-data').click();
        await expect(window.locator('#modal-delete-data')).toBeVisible();
        await window.locator('#modal-delete-data-cancel').click();
        await expect(window.locator('#modal-delete-data')).toBeHidden();
        expect(fs.existsSync(dbPath(userDataDir))).toBe(true);
        const tasksAfterCancel = await window.evaluate(() => window.electronAPI.getTasks());
        expect(tasksAfterCancel.length).toBe(1);

        // --- 3) confirm olmadan sunucu silmez (güvenlik) ----------------
        const noConfirm = await window.evaluate(() => window.electronAPI.deleteAllData({}));
        expect(noConfirm && noConfirm.success).toBe(false);
        expect(noConfirm.code).toBe('CONFIRM_REQUIRED');
        expect(fs.existsSync(dbPath(userDataDir))).toBe(true);

        // --- 4) Onayla → uygulama kapanır, DB silinir ------------------
        await window.locator('#btn-delete-all-data').click();
        await expect(window.locator('#modal-delete-data')).toBeVisible();
        await window.locator('#modal-delete-data-yes').click();

        // Uygulama kendini kapatır.
        await app.waitForEvent('close', { timeout: 20000 }).catch(() => {});
        try { await app.close(); } catch (_) { /* zaten kapandı */ }
        app = null;

        expect(fs.existsSync(dbPath(userDataDir)), 'veritabanı silinmedi').toBe(false);

        // --- 5) Yeniden açılışta temiz kurulum -------------------------
        app = await launch(userDataDir);
        window = await app.firstWindow();
        await ready(window);
        const tasksAfter = await window.evaluate(() => window.electronAPI.getTasks());
        expect(tasksAfter).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (_) { /* Windows kilidi */ }
    }
});
