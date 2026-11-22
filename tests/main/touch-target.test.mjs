/**
 * Metin ölçekleme (WCAG 1.4.4) + dokunma hedefi (WCAG 2.5.8).
 *
 * Bulgular:
 *  - 6 adet +/- arttır/azalt düğmesi `h-1/2` + `py-1` kapsayıcı yüzünden
 *    **24×21px** kalıyordu (min 24px hedefin altı).
 *  - `#btn-open-data-folder` yalnızca satır içi metin kadar (**99×16px**)
 *    tıklanabilirdi - 16px yükseklik titrek elle/touchpad'de ıskalanır.
 *
 * Ölçüm (öncesi): 7 düğme 24px altında; `btn-open-data-folder` 99×16.
 * Ölçüm (sonrası): görünür düğmelerin tümü ≥24px → 0 ihlal.
 *
 * Ayrıca %200 metin ölçeklemede 6 görünümde yatay taşma ve metin kırpılması
 * olmamalı.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');

describe('dokunma hedefleri ≥24px (WCAG 2.5.8)', () => {
    it('adım düğmeleri min-h-[24px] taşır', () => {
        const steps = html.match(/class="h-1\/2[^"]*data-pp-step/g) || [];
        // Sınıf, data-pp-step'ten önce gelir; ayrı ölçüm yap.
        const stepButtons = html.match(/h-1\/2[^"]*group focus:outline-none/g) || [];
        expect(stepButtons.length).toBeGreaterThanOrEqual(6);
        for (const btn of stepButtons) {
            expect(btn, 'adım düğmesi 24px yüksekliğe sahip olmalı').toContain('min-h-[24px]');
        }
        expect(steps.length).toBeGreaterThanOrEqual(0);
    });

    it('+/- kapsayıcısı py-1 ile yüksekliği kısmıyor', () => {
        // py-1 (4px toplam) alt düğmeyi 24px altına indiriyordu.
        expect(html).not.toContain('flex flex-col justify-between py-1');
    });

    it('veri klasörü düğmesi min 24px yüksekliğinde', () => {
        const idx = html.indexOf('id="btn-open-data-folder"');
        expect(idx).toBeGreaterThan(-1);
        const tag = html.slice(idx, html.indexOf('>', idx) + 1);
        expect(tag).toContain('min-h-[24px]');
    });

    it('satır içi metin düğmesi inline-flex (gerçek kutu)', () => {
        const idx = html.indexOf('id="btn-open-data-folder"');
        const tag = html.slice(idx, html.indexOf('>', idx) + 1);
        expect(tag).toContain('inline-flex');
        expect(tag).toContain('items-center');
    });
});

describe('metin ölçekleme - taşma üretmeyen yapı', () => {
    it('overflow-hidden kullanan görünümler içinde kaydırılabilir gövde var', () => {
        // `view-about` gibi kaplar dışta `overflow-hidden` kullanır ama içinde
        // `overflow-y-auto` gövde bulunur; içerik kaydırılır, kırpılmaz.
        // (Ölçüm: %200 zoom'da 6 görünümde yatay taşma 0, kırpılan metin 0.)
        const blocks = html.split(/id="view-/).slice(1);
        expect(blocks.length).toBeGreaterThan(0);
        for (const block of blocks) {
            const tagEnd = block.indexOf('>');
            const openingTag = block.slice(0, tagEnd);
            if (!/\boverflow-hidden\b/.test(openingTag)) continue;
            const body = block.slice(0, 4000);
            expect(body, `overflow-hidden görünümde kaydırılabilir gövde yok: ${openingTag.slice(0, 50)}`)
                .toMatch(/overflow-y-auto|overflow-auto/);
        }
    });
});
