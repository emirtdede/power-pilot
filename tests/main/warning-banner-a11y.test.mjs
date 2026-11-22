/**
 * Kapatma uyarısı - kullanıcının gördüğü son çıkış + ekran okuyucu duyurusu.
 *
 * En kritik son kullanıcı güvenliği: "1 saat sonra kapat" diyen kullanıcı
 * kaydedilmemiş işini kaybetmemeli. Akış doğrulandı (probe-warning-cancel.cjs,
 * 12/12 PASS): 30 sn geri sayım → Durdur → `cancelled_by_user`, Ertele →
 * `scheduled`; hiçbir durumda kapatma çalışmadı.
 *
 * Bulgu: banner'da `role`/`aria-live` yoktu → ekran okuyucu kullanıcısı
 * zaman kritik uyarıyı HİÇ duymuyordu (role=null, live=null). Kullanıcı
 * uyarıyı duymadan kaydedilmemiş işiyle kapatılırdı.
 *
 * Düzeltme: banner `role="alert"` + `aria-live="assertive"`; geri sayım
 * sayacı `aria-live="off"` (her saniye duyuru spam'i olmasın).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');

const bannerTag = () => {
    const idx = html.indexOf('id="warning-banner"');
    expect(idx).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<div', idx);
    return html.slice(start, html.indexOf('>', idx) + 1);
};

describe('kapatma uyarı banner’ı - erişilebilirlik', () => {
    it('banner role="alert" + aria-live="assertive"', () => {
        const tag = bannerTag();
        expect(tag).toContain('role="alert"');
        expect(tag).toContain('aria-live="assertive"');
    });

    it('geri sayım sayacı otomatik duyurulmuyor (aria-live="off")', () => {
        const idx = html.indexOf('id="warning-banner-count"');
        expect(idx).toBeGreaterThan(-1);
        const tag = html.slice(html.lastIndexOf('<p', idx), html.indexOf('>', idx) + 1);
        expect(tag).toContain('aria-live="off"');
    });

    it('banner ikonu dekoratif (aria-hidden)', () => {
        const idx = html.indexOf('id="warning-banner"');
        const block = html.slice(idx, idx + 600);
        const iconTags = block.match(/<span[^>]*material-symbols-outlined[^>]*>/g) || [];
        expect(iconTags.length).toBeGreaterThan(0);
        for (const t of iconTags) expect(t).toContain('aria-hidden');
    });
});

describe('kapatma uyarısı - kullanıcı çıkışı', () => {
    it('Durdur, Ertele ve Şimdi Çalıştır düğmeleri var', () => {
        for (const id of ['btn-warn-stop', 'btn-warn-snooze', 'btn-warn-now']) {
            expect(html, `${id} eksik`).toContain(`id="${id}"`);
        }
    });

    it('Durdur gerçek iptal yolunu çağırır (warningCancel)', () => {
        const idx = appSrc.indexOf("getElementById('btn-warn-stop')");
        expect(idx).toBeGreaterThan(-1);
        const block = appSrc.slice(idx, idx + 400);
        expect(block).toMatch(/warningCancel/);
    });

    it('Ertele gerçek erteleme yolunu çağırır (warningSnooze)', () => {
        const idx = appSrc.indexOf("getElementById('btn-warn-snooze')");
        expect(idx).toBeGreaterThan(-1);
        const block = appSrc.slice(idx, idx + 400);
        expect(block).toMatch(/warningSnooze/);
    });

    it('uyarı bitince banner gizlenir (onWarningEnded)', () => {
        expect(appSrc).toMatch(/onWarningEnded\(\(\) => hideWarningBanner\(\)\)/);
    });

    it('banner metni ham i18n anahtarı içermez (çeviri yolu)', () => {
        const idx = appSrc.indexOf("getElementById('warning-banner-text')");
        const block = appSrc.slice(idx, idx + 260);
        expect(block).toMatch(/localizedTaskName/);
        expect(block).toMatch(/getActionString/);
    });
});
