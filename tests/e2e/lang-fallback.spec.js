/**
 * lang-fallback.spec.js - desteklenmeyen sistem dilinde ilk açılış.
 *
 * Neden: `StorageService` varsayılanı `language: 'tr'` idi ve sunucu ayarları
 * sistem dili algısından önce geldiği için, Rusça/Hintçe/Vietnamca bir
 * Windows'ta uygulama **Türkçe** açılıyordu. Ölçüm (önce): navigator.language
 * "ru" → htmlLang "tr". Artık nötr varsayılan İngilizce.
 *
 * Bu test gerçek uygulamayı temiz profil + --lang=ru ile açar.
 */
import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());

for (const sysLang of ['ru', 'hi', 'vi']) {
    test(`desteklenmeyen sistem dili (${sysLang}) arayüzü İngilizce açar`, async () => {
        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-lang-${sysLang}-`));
        const app = await electron.launch({
            args: [ROOT, `--user-data-dir=${userDataDir}`, `--lang=${sysLang}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                POWERPILOT_E2E: '1',
                LANGUAGE: sysLang,
                LANG: `${sysLang}_${sysLang.toUpperCase()}`
            }
        });

        try {
            const win = await app.firstWindow();
            await win.waitForLoadState('domcontentloaded');
            await win.waitForTimeout(2500);

            const info = await win.evaluate(() => ({
                navigatorLanguage: navigator.language,
                htmlLang: document.documentElement.getAttribute('lang'),
                ppLocale: window.PPLocale && window.PPLocale.language,
                navSettings: (document.querySelector('#nav-settings') || {}).textContent || ''
            }));

            expect(info.navigatorLanguage).toBe(sysLang);
            // Çekirdek iddia: arayüz Türkçe değil, İngilizce.
            expect(info.htmlLang).toBe('en');
            expect(info.ppLocale).toBe('en');
            // Metin düzeyinde de doğrula (Ayarlar değil, Settings).
            expect(info.navSettings).toContain('Settings');
            expect(info.navSettings).not.toContain('Ayarlar');
        } finally {
            await app.close().catch(() => {});
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
}

test('Türkçe sistemde Türkçe açılır (regresyon: İngilizceye zorlamıyoruz)', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lang-tr-'));
    const app = await electron.launch({
        args: [ROOT, `--user-data-dir=${userDataDir}`, '--lang=tr', '--disable-gpu'],
        env: { ...process.env, NODE_ENV: 'production', POWERPILOT_E2E: '1', LANGUAGE: 'tr', LANG: 'tr_TR' }
    });

    try {
        const win = await app.firstWindow();
        await win.waitForLoadState('domcontentloaded');
        await win.waitForTimeout(2500);

        const info = await win.evaluate(() => ({
            htmlLang: document.documentElement.getAttribute('lang'),
            ppLocale: window.PPLocale && window.PPLocale.language,
            navSettings: (document.querySelector('#nav-settings') || {}).textContent || ''
        }));

        expect(info.htmlLang).toBe('tr');
        expect(info.ppLocale).toBe('tr');
        expect(info.navSettings).toContain('Ayarlar');
    } finally {
        await app.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});
