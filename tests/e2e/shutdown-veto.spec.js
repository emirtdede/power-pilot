/**
 * shutdown-veto.spec.js - A6 kapatma engellendi bildirimi (E2E)
 *
 * Gerçek kullanıcı hatası: kaydedilmemiş işi olan bir uygulama kapatmayı veto
 * ettiğinde Windows kendi onay penceresini gösteriyordu; Power Pilot görevi
 * "başarılı" sayıp kullanıcıya hiçbir şey söylemiyordu. Bu test main'den
 * gerçek `shutdown-vetoed` olayını gönderir ve arayüzün kullanıcı diliyle
 * görünür bir uyarı gösterdiğini doğrular.
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

test('kapatma vetosu: kullanıcı diliyle görünür uyarı, ham anahtar sızıntısı yok', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-veto-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');

        const box = window.locator('#shutdown-veto-notice');
        await expect(box).toBeHidden();

        // Main tarafındaki gerçek olay yolunu kullan (renderer sözleşmesi).
        await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
            if (win) {
                win.webContents.send('shutdown-vetoed', {
                    taskId: 'task_e2e',
                    name: 'Kapatma',
                    action: 'shutdown',
                    code: 'SHUTDOWN_VETOED'
                });
            }
        });

        await expect(box).toBeVisible();
        await expect(box).toHaveAttribute('role', 'alert');

        const text = await box.innerText();
        expect(text).not.toMatch(/\bshutdownVetoedTitle\b|\bshutdownVetoedDetail\b/);
        expect(text.trim().length).toBeGreaterThan(0);

        // Kapatılabilir olmalı; kullanıcı uyarıyı sürekli görmek zorunda değil.
        await window.locator('#shutdown-veto-close').click();
        await expect(box).toBeHidden();
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});
