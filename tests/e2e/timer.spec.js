/**
 * timer.spec.js - WP-08.T12 / T-REN-01..T-REN-10
 * Sayaç reddi, koşullu görev geri yükleme, çift iptal, yükleme hataları,
 * pencere IPC dayanıklılığı ve ayar görünümü geçişlerini doğrular.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('renderer sayaç ve iptal durum makinesi', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-timer-'));
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
        const errors = [];
        window.on('pageerror', (error) => errors.push(String(error && error.message || error)));
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

        // T-REN-01: geçersiz/tetiklenemeyen schedule-action sayaç başlatmaz.
        const before = await window.evaluate(() => window.electronAPI.getTasks());
        const rejected = await window.evaluate(() => window.electronAPI.scheduleAction({ action: 'invalid', durationMs: -1 }));
        expect(rejected && rejected.success).toBe(false);
        const after = await window.evaluate(() => window.electronAPI.getTasks());
        expect(after.length).toBe(before.length);

        const pin = await window.evaluate(() => window.electronAPI.setCancelPin('4321'));
        expect(pin && pin.success).not.toBe(false);

        // T-REN-09: koşullu (monitoring) görev yenilemede aktif kartta görünür.
        const conditional = await window.evaluate(() => window.electronAPI.createTask({
            name: 'E2E koşullu görev',
            action: 'lock',
            trigger: { type: 'duration', durationMs: 3600000 },
            conditionGroup: {
                operator: 'AND',
                conditions: [{ type: 'user_idle', idleSeconds: 60 }]
            }
        }));
        expect(conditional && conditional.success).toBe(true);
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
        await window.waitForTimeout(500);
        if (!(await window.locator('#view-active').isVisible())) {
            await window.locator('#nav-active').click().catch(() => {});
        }
        await expect(window.locator('#monitoring-card')).toBeVisible();
        await expect(window.locator('#monitoring-card-list')).toContainText(/İzleniyor|Monitoring/);
        expect(await window.locator('#monitoring-card-list li').count()).toBeGreaterThan(0);
        const removed = await window.evaluate((id) => window.electronAPI.cancelTask(id, '4321'), conditional.task.id);
        expect(removed && removed.success).not.toBe(false);

        // T-REN-04: şablon/geçmiş/istatistik görünümleri boş veriyle çökmez.
        for (const nav of ['nav-templates', 'nav-history', 'nav-stats']) {
            await window.locator(`#${nav}`).click();
            await window.waitForTimeout(300);
            const text = await window.locator('main').innerText();
            expect(text).not.toContain("t('");
            expect(text).not.toContain('undefined');
        }

        // T-REN-05: sunucu reddedince tema/dil ve localStorage eski değerde kalır.
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-appearance"]').click();
        await window.waitForTimeout(350);
        const previousTheme = await window.locator('#setting-theme').inputValue();
        const previousLanguage = await window.locator('#setting-language').inputValue();
        await app.evaluate(({ ipcMain }) => {
            // O-20: ayarlar artık tek atomik IPC ile yazılır; ikisi de reddedilir.
            for (const channel of ['save-settings', 'save-settings-atomic']) {
                ipcMain.removeHandler(channel);
                ipcMain.handle(channel, async () => ({ success: false, message: 'E2E reject' }));
            }
        });
        const nextTheme = previousTheme === 'light' ? 'dark' : 'light';
        const nextLanguage = previousLanguage === 'en' ? 'tr' : 'en';
        await window.locator('#setting-theme').selectOption(nextTheme);
        await window.locator('#setting-language').selectOption(nextLanguage);
        await expect(window.locator('#toast-container')).toContainText('E2E reject', { timeout: 5000 });
        await window.waitForTimeout(450);
        expect(await window.locator('#setting-theme').inputValue()).toBe(previousTheme);
        expect(await window.locator('#setting-language').inputValue()).toBe(previousLanguage);
        expect(await window.evaluate((fb) => localStorage.getItem('theme') || fb, previousTheme)).toBe(previousTheme);
        expect(await window.evaluate((fb) => localStorage.getItem('language') || fb, previousLanguage)).toBe(previousLanguage);

        // T-REN-06: pencere kapatılırken maximize IPC istisna üretmez.
        await window.evaluate(() => window.electronAPI.maximizeToggle());
        await window.waitForTimeout(200);
        await window.evaluate(() => window.electronAPI.maximizeToggle());
        expect(await window.title()).toMatch(/Power Pilot/i);

        // T-REN-03/T-REN-05: PIN tek örneği ve çift iptal tek sonuç üretir.
        const timed = await window.evaluate(() => window.electronAPI.createTask({
            name: 'E2E iptal görevi',
            action: 'lock',
            trigger: { type: 'duration', durationMs: 3600000 }
        }));
        expect(timed && timed.success).toBe(true);
        await window.locator('#nav-tasks').click();
        await expect(window.locator('#tasks-table-body')).toContainText(/Hızlı Zamanlayıcı \(Kilitle\)|Quick Timer \(Lock\)/);

        await window.locator('.btn-task-cancel').first().click();
        await expect(window.locator('#modal-pin')).toBeVisible();
        await window.evaluate(() => document.querySelector('.btn-task-cancel')?.click());
        await expect(window.locator('#modal-pin')).toBeVisible();
        await window.locator('#pin-modal-input').fill('4321');
        await window.locator('#pin-modal-ok').click();
        await expect(window.locator('#modal-pin')).toBeHidden();
        await expect(window.locator('#tasks-empty')).toBeVisible();

        // T-REN-07: ayarlar görünümünden çıkışta arka plan isteği kalmaz.
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-appearance"]').click();
        await window.waitForTimeout(400);
        await window.locator('#nav-dashboard').click();
        await window.waitForTimeout(400);
        expect(await window.evaluate(() => window.electronAPI.getSettings())).toBeTruthy();

        // T-REN-02/T-REN-10: hedef geçmişe düşünce negatif sayaç yok; süre doldu.
        await window.locator('#nav-dashboard').click();
        await window.locator('#input-mins').fill('1');
        await window.clock.install();
        await window.evaluate(() => document.getElementById('btn-start').click());
        await window.waitForTimeout(500);
        await window.clock.fastForward(120000);
        const expired = await window.evaluate(() => ({
            countdown: (document.getElementById('display-time-left')?.innerText || '').trim(),
            sentence: (document.getElementById('display-timer-sentence')?.innerText || '').trim(),
            active: !document.getElementById('view-active')?.classList.contains('hidden')
        }));
        expect(expired.active).toBe(true);
        expect(expired.countdown).not.toMatch(/^-|NaN/);
        expect(expired.countdown).toContain('00:00');
        expect(expired.sentence.length).toBeGreaterThan(0);
        await window.clock.resume();
        await window.evaluate(async () => {
            const tasks = await window.electronAPI.getTasks();
            const active = tasks.find((task) => task.status === 'scheduled');
            if (active) await window.electronAPI.cancelTask(active.id, '4321');
        });

        const body = await window.locator('body').innerText();
        expect(body).not.toContain("t('");
        expect(body).not.toContain('undefined');
        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
    }
});
