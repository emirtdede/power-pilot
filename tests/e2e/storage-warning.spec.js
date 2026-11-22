/**
 * storage-warning.spec.js - bakım modu görünürlüğü (E2E)
 *
 * Gerçek kullanıcı hatası: depo açılamadığında (bozuk veri) her kayıt sessizce
 * reddediliyordu; arayüz normal görünüyordu ve kullanıcı görevinin
 * kaydedildiğini sanıyordu. Bu test bozuk bir kullanıcı profilini hazırlar,
 * uygulamayı açar ve üstteki uyarı şeridinin gerçekten göründüğünü doğrular.
 * İkinci bölüm sağlıklı profilde şeridin görünmediğini kilitler (yanlış alarm yok).
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

test('bozuk profil: bakım modu şeridi görünür ve kullanıcı diliyle açıklanır', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-maint-'));
    // Eski JSON yolu bozuk: migrasyon parse edemez -> bakım modu.
    fs.writeFileSync(path.join(userDataDir, 'powerpilot_data.json'), '{bozuk json!!!', 'utf8');
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');

        const box = window.locator('#storage-warning');
        await expect(box).toBeVisible();

        // Teknik olmayan, çevrilmiş açıklama; ham anahtar sızıntısı yok.
        const text = await box.innerText();
        expect(text).not.toMatch(/\berrorStorageMaintenance\b|\bstatusWarning\b/);
        expect(text.trim().length).toBeGreaterThan(0);

        // Erişilebilirlik: canlı bölge olarak duyurulur.
        await expect(box).toHaveAttribute('role', 'alert');

        // Gerçekten bakım modunda olduğunu IPC'den doğrula.
        const status = await window.evaluate(() => window.electronAPI.getStorageStatus());
        expect(status.maintenanceMode).toBe(true);
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});

test('sağlıklı profil: şerit gizli kalır (yanlış alarm yok)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-healthy-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForTimeout(1200); // async durum kontrolü tamamlansın

        await expect(window.locator('#storage-warning')).toBeHidden();

        const status = await window.evaluate(() => window.electronAPI.getStorageStatus());
        expect(status.maintenanceMode).toBe(false);
        expect(status.auditTampered).toBe(false);
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});
