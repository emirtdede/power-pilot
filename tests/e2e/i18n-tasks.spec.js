const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('i18n kapsamı, görev görünümü ve sürüm bilgisi', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-i18n-'));
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
        window.on('pageerror', (e) => errors.push(String(e && e.message || e)));
        await window.waitForLoadState('domcontentloaded');

        await window.waitForFunction(() => {
            const el = document.getElementById('app-version');
            return el && el.innerText && el.innerText !== 'v-';
        });
        expect((await window.locator('#app-version').innerText()).trim()).toBe('v1.0.0');

        const switchTo = async (lang) => {
            // L-01: dil için tek doğruluk kaynağı sunucu ayarlarıdır; localStorage
            // yalnızca anlık görünüm içindir. İkisi birlikte güncellenir.
            await window.evaluate(async (l) => {
                localStorage.setItem('language', l);
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    await window.electronAPI.saveSettings({ language: l });
                }
            }, lang);
            await window.reload();
            await window.waitForLoadState('domcontentloaded');
            await window.waitForTimeout(400);
        };

        await switchTo('de');
        expect((await window.locator('#nav-tasks span[data-i18n="tasks"]').innerText()).trim()).toBe('Aufgaben');
        // Dynamic labels must be re-queried after a language switch, not left
        // on the localized "checking..." placeholder.
        await expect(window.locator('#pin-state')).toHaveText('Nicht festgelegt');
        await expect(window.locator('#set-ai-status')).not.toHaveText(/wird geprüft/, { timeout: 5000 });
        await expect(window.locator('#ai-status-line')).not.toHaveText(/wird überprüft/, { timeout: 5000 });

        const navs = ['nav-dashboard', 'nav-tasks', 'nav-smartfinish', 'nav-assistant', 'nav-templates', 'nav-history', 'nav-stats', 'nav-integrations', 'nav-settings', 'nav-about'];
        for (const nav of navs) {
            await window.locator(`#${nav}`).click();
            await window.waitForTimeout(350);
            const text = await window.locator('main').innerText();
            expect(text, `${nav} literal t( call`).not.toContain("t('");
            expect(text, `${nav} undefined`).not.toContain('undefined');
            expect(text, `${nav} leftover Turkish`).not.toMatch(/[ğışĞŞ]/);
        }

        // Task list: create a far-future task, snooze it, then cancel it.
        await switchTo('tr');
        const created = await window.evaluate(() => window.electronAPI.createTask({
            name: 'E2E test görevi',
            action: 'lock',
            trigger: { type: 'duration', durationMs: 3600000 }
        }));
        expect(created && created.success).toBe(true);
        await window.locator('#nav-tasks').click();
        await expect(window.locator('#tasks-table-body')).toContainText('Hızlı Zamanlayıcı (Kilitle)');
        await window.locator('.btn-task-snooze').first().click();
        await window.waitForTimeout(600);
        // Snooze must extend the future target, not pull it closer.
        await expect(window.locator('#tasks-table-body')).toContainText('1sa');
        // Cancel is PIN-protected when a PIN is configured.
        const pinSet = await window.evaluate(() => window.electronAPI.setCancelPin('4321'));
        expect(pinSet && pinSet.success).not.toBe(false);
        await window.locator('.btn-task-cancel').first().click();
        await expect(window.locator('#modal-pin')).toBeVisible();
        await window.locator('#pin-modal-input').fill('4321');
        await window.locator('#pin-modal-ok').click();
        await expect(window.locator('#modal-pin')).toBeHidden();
        await expect(window.locator('#tasks-empty')).toBeVisible();

        await switchTo('ja');
        expect((await window.locator('#nav-tasks span[data-i18n="tasks"]').innerText()).trim()).toBe('タスク');
        await window.locator('#nav-tasks').click();
        await expect(window.locator('#tasks-empty')).toContainText('まだタスクはありません。');

        const bodyText = await window.locator('body').innerText();
        expect(bodyText).not.toContain("t('");
        expect(bodyText).not.toContain('undefined');
        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* ignore */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi: geçici dizin */ }
    }
});
