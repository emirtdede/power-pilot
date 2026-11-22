/**
 * readiness.spec.js - Faz 3 son kullanıcı özellikleri
 *
 * Kapsam:
 *  1. Tekrarlayan program UI'si (günlük / özel günler) gerçekten görev üretir
 *     ve görev listesinde insan dilinde görünür.
 *  2. "Özel günler" seçilince gün çipleri görünür; gün seçilmeden kayıt reddedilir.
 *  3. Uyku dönüş politikası (wakeMode + tolerans) kaydedilir ve yeniden yüklenir.
 *  4. "Neden çalışmadı?" paneli başarısız geçmiş kaydıyla görünür ve sade dil
 *     kullanır (ham sonuç kodu sızmaz).
 *  5. Şablon dışa aktarma, kullanıcı şablonu yokken anlaşılır hata verir.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Faz 3: tekrarlayan görev, uyku politikası ve neden paneli', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-readiness-'));
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
        window.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

        const dismissOverlays = async () => {
            const wizard = window.locator('#wizard-overlay');
            if (await wizard.isVisible().catch(() => false)) {
                await window.locator('#btn-wz-skip').click();
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
        };
        await dismissOverlays();

        // --- 1) Tekrarlayan günlük görev ---------------------------------
        await window.locator('#nav-smartfinish').click();
        await window.waitForTimeout(300);
        await expect(window.locator('#sf-repeat')).toBeVisible();
        await window.locator('#sf-time').fill('23:30');
        await window.locator('#sf-repeat').selectOption('daily');
        await window.locator('#sf-action').selectOption('shutdown');
        await window.locator('#btn-save-sf-task').click();
        await expect(window.locator('#toast-container')).toContainText(/tekrar|recurring/i, { timeout: 8000 });

        let tasks = await window.evaluate(() => window.electronAPI.getTasks());
        const daily = tasks.find((t) => t.recurrence && t.recurrence.enabled);
        expect(daily, 'tekrarlayan görev oluşmadı').toBeTruthy();
        expect(daily.recurrence.frequency).toBe('daily');
        expect(daily.recurrence.timeOfDay).toBe('23:30');
        expect(daily.trigger.type).toBe('scheduled_time');
        expect(daily.trigger.targetTime).toBeGreaterThan(Date.now());
        // Sonraki tetikleme gerçekten 23:30'a denk gelmeli.
        const target = new Date(daily.trigger.targetTime);
        expect(target.getHours()).toBe(23);
        expect(target.getMinutes()).toBe(30);

        // Görev listesinde insan dilinde tekrar özeti görünür.
        await window.locator('#nav-tasks').click();
        await window.waitForTimeout(400);
        const taskText = await window.locator('#tasks-table-body').innerText();
        expect(taskText).toMatch(/23:30/);

        // --- 2) Özel günler: çipler ve doğrulama ------------------------
        await window.locator('#nav-smartfinish').click();
        await window.waitForTimeout(300);
        await expect(window.locator('#sf-repeat-days')).toBeHidden();
        await window.locator('#sf-repeat').selectOption('custom');
        await expect(window.locator('#sf-repeat-days')).toBeVisible();
        const chips = window.locator('#sf-repeat-day-chips button');
        expect(await chips.count()).toBe(7);
        // Varsayılan olarak hafta içi seçili.
        expect(await window.locator('#sf-repeat-day-chips button[aria-pressed="true"]').count()).toBe(5);
        // Tüm günleri kapat → kayıt reddedilmeli, yeni görev oluşmamalı.
        for (let i = 0; i < 7; i += 1) {
            const chip = chips.nth(i);
            if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
        }
        expect(await window.locator('#sf-repeat-day-chips button[aria-pressed="true"]').count()).toBe(0);
        const beforeCount = (await window.evaluate(() => window.electronAPI.getTasks())).length;
        await window.locator('#btn-save-sf-task').click();
        await window.waitForTimeout(600);
        const afterCount = (await window.evaluate(() => window.electronAPI.getTasks())).length;
        expect(afterCount).toBe(beforeCount);
        expect((await window.locator('#toast-container').innerText()).trim().length).toBeGreaterThan(0);

        // İki gün seçip kaydet → custom recurrence yazılır.
        await chips.nth(5).click(); // Cumartesi
        await chips.nth(6).click(); // Pazar
        await window.locator('#sf-time').fill('04:15');
        await window.locator('#btn-save-sf-task').click();
        await window.waitForTimeout(1200);
        tasks = await window.evaluate(() => window.electronAPI.getTasks());
        const custom = tasks.filter((t) => t.recurrence && t.recurrence.frequency === 'custom');
        expect(custom.length).toBe(1);
        expect(custom[0].recurrence.daysOfWeek.sort()).toEqual([0, 6]);
        // Hafta sonu hedefi cumartesi/pazar olmalı.
        expect([0, 6]).toContain(new Date(custom[0].trigger.targetTime).getDay());

        // --- 3) Uyku dönüş politikası (otomatik kayıt, PIN kapısına takılmaz) --
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-automation"]').click();
        await window.waitForTimeout(350);
        await expect(window.locator('input[name="wakeMode"][value="run"]')).toBeVisible();
        await window.locator('input[name="wakeMode"][value="skip"]').check();
        await window.locator('#setting-wake-tolerance').fill('25');
        await window.locator('#setting-wake-tolerance').dispatchEvent('change');
        await expect(window.locator('#toast-container')).toContainText(/kaydedildi|saved/i, { timeout: 8000 });
        await expect(window.locator('#modal-pin')).toBeHidden();

        const settings = await window.evaluate(() => window.electronAPI.getSettings());
        expect(settings.wakeMode).toBe('skip');
        expect(settings.wakeToleranceMinutes).toBe(25);

        // Yeniden yükleme sonrası form sunucu değerlerini gösterir.
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
        await dismissOverlays();
        await window.locator('#nav-settings').click();
        await window.locator('[data-scroll-target="settings-sec-automation"]').click();
        await window.waitForTimeout(600);
        expect(await window.locator('input[name="wakeMode"][value="skip"]').isChecked()).toBe(true);
        expect(await window.locator('#setting-wake-tolerance').inputValue()).toBe('25');

        // Geçersiz tolerans istemci tarafında reddedilir (sunucuya yazılmaz).
        await window.locator('#setting-wake-tolerance').fill('5000');
        await window.locator('#setting-wake-tolerance').dispatchEvent('change');
        await window.waitForTimeout(500);
        const stillSkip = await window.evaluate(() => window.electronAPI.getSettings());
        expect(stillSkip.wakeToleranceMinutes).toBe(25);
        await window.locator('#setting-wake-tolerance').fill('25');

        // --- 4) "Neden çalışmadı?" paneli ------------------------------
        // Gerçek yol: görev çalışırken değil, uygulama KAPALIYKEN zamanı geçer.
        // Yeniden açılışta kurtarma onu "uykuda kaçırıldı" olarak atlar ve
        // gerekçesiyle geçmişe yazar. Panel bunu sade dille göstermeli.
        const missed = await window.evaluate(() => window.electronAPI.createTask({
            name: 'E2E gece yedeği',
            action: 'lock',
            trigger: { type: 'scheduled_time', targetTime: Date.now() + 4000 }
        }));
        expect(missed && missed.success).toBe(true);

        await app.close();
        app = null;
        // Hedef zaman uygulama kapalıyken geçsin.
        await new Promise((resolve) => setTimeout(resolve, 6000));
        app = await electron.launch({
            args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                POWERPILOT_E2E: '1'
            }
        });
        const window2 = await app.firstWindow();
        window2.on('pageerror', (error) => errors.push(String((error && error.message) || error)));
        await window2.waitForLoadState('domcontentloaded');
        await window2.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
        await window2.waitForTimeout(800);

        const history = await window2.evaluate(() => window.electronAPI.getHistory());
        const missedRecord = (history || []).find((h) => h.resultCode === 'missed_while_asleep');
        expect(missedRecord, 'kaçırılan görev geçmişe yazılmadı').toBeTruthy();
        expect(missedRecord.taskName).toBe('E2E gece yedeği');
        expect(String(missedRecord.detail || '').length).toBeGreaterThan(0);

        // Görev otomatik çalıştırılmadı: EXPIRED kaldı (kullanıcı onayı yok).
        const tasksAfterRestart = await window2.evaluate(() => window.electronAPI.getTasks());
        const missedTask = tasksAfterRestart.find((t) => t.name === 'E2E gece yedeği');
        expect(missedTask).toBeTruthy();
        expect(missedTask.status).toBe('expired');
        expect(missedTask.lastResult && missedTask.lastResult.code).toBe('missed_while_asleep');

        await window2.locator('#nav-history').click();
        await window2.waitForTimeout(700);
        await expect(window2.locator('#history-why-card')).toBeVisible();
        const whyText = await window2.locator('#history-why-list').innerText();
        expect(whyText).toContain('E2E gece yedeği');
        // Ham sonuç kodu kullanıcıya sızmaz; sade etiket gösterilir.
        expect(whyText).not.toContain('missed_while_asleep');
        const rowText = await window2.locator('#history-table-body').innerText();
        expect(rowText).not.toContain('missed_while_asleep');

        // --- 5) Şablon dışa aktarma: kullanıcı şablonu yok --------------
        await window2.locator('#nav-templates').click();
        await window2.waitForTimeout(400);
        await expect(window2.locator('#btn-export-templates')).toBeVisible();
        await expect(window2.locator('#btn-import-templates')).toBeVisible();
        const exportRes = await window2.evaluate(() => window.electronAPI.exportTemplates());
        expect(exportRes && exportRes.success).toBe(false);
        expect(exportRes.code).toBe('NO_CUSTOM_TEMPLATES');
        expect(String(exportRes.message || '').length).toBeGreaterThan(0);

        const bodyText = await window2.locator('body').innerText();
        expect(bodyText).not.toContain("t('");
        expect(bodyText).not.toContain('undefined');
        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
    }
});
