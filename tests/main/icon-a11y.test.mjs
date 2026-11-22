/**
 * Dekoratif ikonlar - ekran okuyucu kirliliği (WCAG 1.1.1 / 4.1.2).
 *
 * Bulgu: `material-symbols-outlined` span'ları ligatürle çalışır; metin
 * içerikleri "error", "power_settings_new", "delete_sweep" gibi ANLAMSIZ
 * kelimelerdir. `aria-hidden` verilmediği için ekran okuyucu bunları okurdu:
 *   - Düğme adı: "power_settings_new Bilgisayarı Kapat Gücü tamamen kapatır"
 *   - Toast:     "error Klasör açılamadı."
 * Ölçüm (öncesi): 28/28 ikon açık, 29 düğme etkileniyor.
 * Ölçüm (sonrası): 0/28 açık, 0 düğme etkileniyor.
 *
 * Ayrıca toast'ın canlı bölge semantiği kilitlenir: ekran okuyucu yeni
 * bildirimi kendiliğinden duyurmalı (hata = assertive, diğer = polite).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const htmlFiles = ['src/index.html', 'src/mini.html'];

describe('dekoratif ikonlar ekran okuyucudan gizli', () => {
    for (const rel of htmlFiles) {
        it(`${rel} - tüm ikon span’larında aria-hidden`, () => {
            const src = read(rel);
            const tags = src.match(/<span\b[^>]*material-symbols-outlined[^>]*>/g) || [];
            expect(tags.length, `${rel} içinde ikon bulunmalı`).toBeGreaterThan(0);
            const exposed = tags.filter((tag) => !/aria-hidden/.test(tag));
            expect(exposed, `gizlenmemiş ikon: ${exposed.slice(0, 3).join(' | ')}`).toEqual([]);
        });
    }

    it('programatik üretilen toast ikonu aria-hidden taşır', () => {
        const app = read('src/renderer/app.js');
        const idx = app.indexOf("toastIcon.className = 'material-symbols-outlined");
        expect(idx).toBeGreaterThan(-1);
        const after = app.slice(idx, idx + 320);
        expect(after).toMatch(/toastIcon\.setAttribute\('aria-hidden',\s*'true'\)/);
    });

    it('programatik üretilen şablon kartı ikonu aria-hidden taşır', () => {
        const app = read('src/renderer/app.js');
        const idx = app.indexOf("icon.className = 'material-symbols-outlined");
        expect(idx).toBeGreaterThan(-1);
        const after = app.slice(idx, idx + 320);
        expect(after).toMatch(/icon\.setAttribute\('aria-hidden',\s*'true'\)/);
    });
});

describe('toast canlı bölge semantiği', () => {
    it('hata toast’ı alert + assertive', () => {
        const app = read('src/renderer/app.js');
        expect(app).toMatch(/setAttribute\('role',\s*type === 'error' \? 'alert' : 'status'\)/);
        expect(app).toMatch(/setAttribute\('aria-live',\s*type === 'error' \? 'assertive' : 'polite'\)/);
        expect(app).toMatch(/setAttribute\('aria-atomic',\s*'true'\)/);
    });

    it('toast metni ligatür adı içermez (textContent ayrı öğede)', () => {
        const app = read('src/renderer/app.js');
        // İkon ve metin ayrı öğelerde olmalı; tek metin düğümünde birleşmemeli.
        expect(app).toMatch(/toastRow\.append\(toastIcon, toastText\)/);
    });
});

describe('ikon-only düğmeler erişilebilir ad taşır', () => {
    it('metinsiz düğmelerde aria-label veya title var', () => {
        const src = read('src/index.html');
        const buttons = src.match(/<button\b[\s\S]*?<\/button>/g) || [];
        const offenders = [];
        for (const btn of buttons) {
            if (!/material-symbols-outlined/.test(btn)) continue;
            const text = btn
                .replace(/<span[^>]*material-symbols-outlined[^>]*>[\s\S]*?<\/span>/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (text.length === 0 && !/aria-label\s*=/.test(btn) && !/title\s*=/.test(btn)) {
                offenders.push(btn.slice(0, 90).replace(/\s+/g, ' '));
            }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
    });
});
