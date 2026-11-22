/**
 * i18n-all.spec.js - WP-14.T6
 * 17 dilin tamamı ana ekran + ayarlar görünümünde eksik anahtar/undefined
 * üretmeden açılır; Arapça RTL yönünü uygular.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/locales/manifest.json'), 'utf8'));
const languages = Object.keys(manifest.languages);
const dictionaryOf = (lang) => JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../../src/renderer/locales/${lang}.json`), 'utf8')
);

test('17 dilde ana ekran ve ayarlar eksiksiz', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-i18n-all-'));
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

        for (const lang of languages) {
            // L-01: dil için tek doğruluk kaynağı sunucu ayarlarıdır.
            await window.evaluate(async (value) => {
                localStorage.setItem('language', value);
                if (window.electronAPI && window.electronAPI.saveSettings) {
                    await window.electronAPI.saveSettings({ language: value });
                }
            }, lang);
            await window.reload();
            await window.waitForLoadState('domcontentloaded');
            await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

            await window.locator('#nav-settings').click();
            await window.waitForTimeout(250);
            const state = await window.evaluate(() => ({
                dir: document.documentElement.getAttribute('dir'),
                text: document.querySelector('main')?.innerText || '',
                aria: {
                    menu: document.getElementById('btn-nav-toggle')?.getAttribute('aria-label'),
                    minimize: document.getElementById('btn-minimize')?.getAttribute('aria-label'),
                    maximize: document.getElementById('btn-maximize')?.getAttribute('aria-label'),
                    close: document.getElementById('btn-close')?.getAttribute('aria-label')
                }
            }));
            expect(state.dir, `${lang} dir`).toBe(lang === 'ar' ? 'rtl' : 'ltr');
            expect(state.text, `${lang} literal`).not.toContain("t('");
            expect(state.text, `${lang} undefined`).not.toContain('undefined');
            expect(state.text.trim().length, `${lang} boş`).toBeGreaterThan(20);
            // Pencere denetimlerinin erişilebilir adı da aktif dilde olmalı.
            const dict = dictionaryOf(lang);
            expect(state.aria.menu, `${lang} menu aria`).toBe(dict.winMenu);
            expect(state.aria.minimize, `${lang} minimize aria`).toBe(dict.winMinimize);
            expect(state.aria.maximize, `${lang} maximize aria`).toBe(dict.winMaximize);
            expect(state.aria.close, `${lang} close aria`).toBe(dict.modalClose);
        }
        expect(errors).toEqual([]);
    } finally {
        if (app) {
            try { await app.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (_) { /* Windows kilidi: geçici dizin */ }
    }
});
