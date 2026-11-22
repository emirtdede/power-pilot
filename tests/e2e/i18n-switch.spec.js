/**
 * i18n-switch.spec.js - oturum içi dil değişimi
 *
 * Yeniden yükleme olmadan dil değiştiğinde yalnızca statik `data-i18n`
 * düğümleri değil, çalışma zamanında üretilen metinler de (pencere
 * denetimlerinin erişilebilir adı, Smart Finish etiketleri) güncellenmeli.
 * Eski dilde kalan metin = dil sızıntısı.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dictionaryOf = (lang) => JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8')
);

test('oturum içi dil değişiminde dinamik etiketler ve aria-adlar güncellenir', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-i18n-switch-'));
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

        const switchLanguage = async (lang) => {
            await window.locator('#nav-settings').click();
            await window.locator('[data-scroll-target="settings-sec-appearance"]').click();
            await window.selectOption('#setting-language', lang);
            await window.waitForFunction((expected) => (
                document.getElementById('btn-minimize')?.getAttribute('aria-label') === expected
            ), dictionaryOf(lang).winMinimize);
        };

        // Smart Finish formunda CPU koşulu seçili bırakılır; dil değişimi bu
        // etiketi kendiliğinden güncellemeli (yeniden seçim tetiklenmeden).
        await window.locator('#nav-smartfinish').click();
        await window.waitForSelector('#view-smartfinish:not(.hidden)');
        await window.evaluate((value) => {
            const el = document.getElementById('sf-condition-type');
            el.value = value;
            el.dispatchEvent(new Event('change'));
        }, 'cpu_usage');

        for (const lang of ['de', 'ja', 'en']) {
            await switchLanguage(lang);
            const dict = dictionaryOf(lang);

            const aria = await window.evaluate(() => ({
                menu: document.getElementById('btn-nav-toggle')?.getAttribute('aria-label'),
                minimize: document.getElementById('btn-minimize')?.getAttribute('aria-label'),
                maximize: document.getElementById('btn-maximize')?.getAttribute('aria-label'),
                close: document.getElementById('btn-close')?.getAttribute('aria-label')
            }));
            expect(aria.menu, `${lang} menu`).toBe(dict.winMenu);
            expect(aria.minimize, `${lang} minimize`).toBe(dict.winMinimize);
            expect(aria.maximize, `${lang} maximize`).toBe(dict.winMaximize);
            expect(aria.close, `${lang} close`).toBe(dict.modalClose);

            await window.locator('#nav-smartfinish').click();
            await window.waitForSelector('#view-smartfinish:not(.hidden)');
            await expect(window.locator('#sf-value-label')).toHaveText(dict.sfCpuThreshold);
        }

        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi */ }
    }
});
