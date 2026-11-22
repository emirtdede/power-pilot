/**
 * PIN kurtarma yüzeyi - regresyon kilidi.
 *
 * Bulgu: PIN'i unutan kullanıcıya arayüzde HİÇBİR yön gösterilmiyordu
 * (E2E ölçümü: mentionsForgot=false). Uygulama içi PIN'siz sıfırlama
 * bilinçli olarak YOKTur (REMEDIATION_PLAN_WBS_V3 §2.2: arka kapı yasak),
 * bu yüzden kullanıcıya yolu göstermek zorunlu.
 *
 * Kilitlenen sözleşmeler:
 *   1. `open-data-folder` IPC yalnızca app.getPath('userData') açar;
 *      istemciden gelen yol argümanı YOK SAYILIR (path traversal savunması).
 *   2. Hata yanıtı çevrilmiş metin taşır, ham hata sızdırmaz.
 *   3. preload yüzeyi `openDataFolder` sağlar.
 *   4. Arayüzde kurtarma metni + düğme vardır ve metin 17 dilde çevrilidir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const mainSrc = read('main.js');
const preloadSrc = read('preload.js');
const appSrc = read('src/renderer/app.js');
const html = read('src/index.html');

/** `open-data-folder` handler'ının gövdesini çıkarır. */
function handlerBody() {
    const start = mainSrc.indexOf("ipcHandle('open-data-folder'");
    expect(start, "open-data-folder IPC tanımlı olmalı").toBeGreaterThan(-1);
    const end = mainSrc.indexOf('\n});', start);
    expect(end).toBeGreaterThan(start);
    return mainSrc.slice(start, end);
}

describe('PIN kurtarma - veri klasörü IPC', () => {
    it('handler yalnızca app.getPath(userData) kullanır', () => {
        const body = handlerBody();
        expect(body).toMatch(/app\.getPath\('userData'\)/);
        // İstemciden gelen argüman okunmamalı.
        expect(body).not.toMatch(/args\s*&&\s*args\./);
        expect(body).not.toMatch(/payload\./);
        expect(body).not.toMatch(/event,\s*args/);
    });

    it('handler istemci argümanı kabul etmez (imza argümansız)', () => {
        expect(mainSrc).toMatch(/ipcHandle\('open-data-folder',\s*async\s*\(\s*\)\s*=>/);
    });

    it('ham hata metni renderer’a dönmez', () => {
        const body = handlerBody();
        expect(body).not.toMatch(/message:\s*(err|e|error)\.(message|stack)/);
        // Kullanıcıya giden metin çevrilir.
        expect(body).toMatch(/message:\s*t\('errorInvalidRequest'\)/);
    });

    it('başarıda gerçek yolu döndürür', () => {
        const body = handlerBody();
        expect(body).toMatch(/success:\s*true,\s*path:\s*dir/);
    });
});

describe('PIN kurtarma - preload yüzeyi', () => {
    it('openDataFolder invoke edilir', () => {
        expect(preloadSrc).toMatch(/openDataFolder:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('open-data-folder'\)/);
    });
});

describe('PIN kurtarma - arayüz', () => {
    it('kurtarma metni ve düğmesi HTML’de var', () => {
        expect(html).toContain('data-i18n="cancelPinForgotHint"');
        expect(html).toContain('id="btn-open-data-folder"');
        expect(html).toContain('data-i18n="openDataFolder"');
    });

    it('düğme openDataFolder çağırır ve hatayı bildirir', () => {
        expect(appSrc).toContain("getElementById('btn-open-data-folder')");
        expect(appSrc).toMatch(/electronAPI\.openDataFolder\(\)/);
        expect(appSrc).toMatch(/t\('errorOpenFolder'\)/);
    });

    it('sabit %APPDATA% yolu metne gömülmemiş (MSIX uyumu)', () => {
        // MSIX’te veri sanallaştırılır; sabit yol yanıltıcı olur.
        const hintMatch = html.match(/data-i18n="cancelPinForgotHint">([^<]*)</);
        expect(hintMatch).toBeTruthy();
        expect(hintMatch[1]).not.toMatch(/%APPDATA%/i);
    });

    it('17 dilde kurtarma anahtarları çevrili', () => {
        const langs = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];
        const missing = [];
        const englishHint = JSON.parse(read('src/renderer/locales/en.json')).cancelPinForgotHint;
        for (const lang of langs) {
            const data = JSON.parse(read(`src/renderer/locales/${lang}.json`));
            for (const key of ['cancelPinForgotHint', 'openDataFolder', 'errorOpenFolder']) {
                if (!data[key] || !String(data[key]).trim()) missing.push(`${lang}:${key}`);
            }
            if (lang !== 'en' && lang !== 'tr' && data.cancelPinForgotHint === englishHint) {
                missing.push(`${lang}:INGILIZCE_SIZINTI`);
            }
        }
        expect(missing, missing.join(', ')).toEqual([]);
    });

    it('sunucu locale dosyaları da güncel', () => {
        const server = JSON.parse(read('src/main/locales/tr.server.json'));
        expect(server.cancelPinForgotHint).toBeTruthy();
        expect(server.openDataFolder).toBeTruthy();
    });
});
