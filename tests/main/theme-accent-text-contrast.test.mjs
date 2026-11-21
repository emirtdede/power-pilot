/**
 * theme-accent-text-contrast.test.mjs - WCAG AA kapısı (vurgu metni).
 *
 * GERÇEK KUSUR (bu turda bulundu):
 *   `.text-primary` kuralı `color: var(--accent) !important` diyordu. İki
 *   kusuru birden doğuruyordu:
 *
 *   1. `!important` yüzünden HTML'deki her `dark:text-primary-light`
 *      yardımcı sınıfı ETKİSİZDİ. Yani "koyu temada açık ton" düzeltmeleri
 *      hiçbir şeyi değiştirmiyordu - placebonun CSS biçimi.
 *
 *   2. `--accent` bir DOLGU rengidir. Açık temada 14 paletin 8'inde
 *      (`cyan`, `pink`, `orange`, `yellow`, `emerald`, `grass`, `lime`,
 *      `custom`) metin olarak beyaz zemin üzerinde WCAG AA (4.5:1) eşiğinin
 *      altında kalıyordu; en kötüsü `yellow` 1.92:1.
 *
 *   Ölçüm (önce): 8/14 açık palet eşik altı.
 *   Çözüm: dolgu ve metin için AYRI token (`--accent` / `--accent-text`),
 *   GitHub Primer ve Material Design ile aynı yaklaşım. Bu test her paleti
 *   ölçer; yeni bir palet eklendiğinde de kendiliğinden denetlenir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const require = createRequire(import.meta.url);

function luminance(hex) {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const [r, g, b] = [0, 2, 4]
        .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** themes.css içindeki her palet bloğunu seçicisiyle birlikte çıkarır. */
function paletteBlocks() {
    const css = read('src/renderer/themes.css');
    const blocks = [];
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
        if (!selector) continue;
        const body = m[2];
        const token = (name) => (body.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,6})`)) || [])[1];
        const accent = token('accent');
        if (!accent) continue;
        blocks.push({
            selector,
            dark: /html\.dark/.test(selector),
            accent,
            accentText: token('accent-text'),
            backgrounds: ['surface', 'canvas', 'surface-subtle', 'surface-hover']
                .map(token)
                .filter(Boolean)
        });
    }
    return blocks;
}

describe('vurgu metni WCAG AA (--accent-text)', () => {
    const blocks = paletteBlocks();

    it('en az 28 palet bloğu bulunur (tarama gerçekten çalışıyor)', () => {
        expect(blocks.length).toBeGreaterThanOrEqual(28);
    });

    it('her palet --accent ile birlikte --accent-text tanımlar', () => {
        const missing = blocks
            .filter((b) => !b.accentText)
            .map((b) => b.selector);
        expect(missing, `--accent-text eksik: ${missing.join(', ')}`).toEqual([]);
    });

    it('her --accent-text, kendi zeminlerinin hepsinde 4.5:1 üstünde', () => {
        const failures = [];
        for (const b of blocks) {
            if (!b.accentText || !b.backgrounds.length) continue;
            const worst = Math.min(...b.backgrounds.map((bg) => contrast(b.accentText, bg)));
            if (worst < 4.5) {
                failures.push(
                    `${b.dark ? 'dark' : 'light'} ${b.selector}: ${b.accentText} → ${worst.toFixed(2)}:1`
                );
            }
        }
        expect(failures, `WCAG AA altında:\n${failures.join('\n')}`).toEqual([]);
    });

    it('.text-primary dolgu token\'ını değil metin token\'ını kullanır', () => {
        // Kusurun kökü buydu: metin rengi olarak dolgu token'ı kullanılıyordu
        // ve `!important` yüzünden hiçbir yardımcı sınıf onu geçemiyordu.
        const css = read('src/renderer/app.css');
        const rule = (css.match(/\.text-primary\s*\{[^}]*\}/) || [''])[0];
        expect(rule, '.text-primary kuralı bulunamadı').not.toBe('');
        expect(rule, '.text-primary hâlâ --accent (dolgu) kullanıyor').not.toMatch(/var\(--accent\)/);
        expect(rule, '.text-primary --accent-text kullanmıyor').toMatch(/var\(--accent-text\)/);
    });

    it('çalışma anı özel renk üreteci de metin token\'ı üretir', () => {
        // Özel renk paleti runtime'da üretilir; yalnızca themes.css'i
        // düzeltmek özel temayı sessizce eski (okunaksız) renge düşürürdü.
        const palette = require('../../src/shared/customColorPalette.js');
        for (const hex of ['#eab308', '#22c55e', '#06b6d4', '#f43f5e', '#ffffff', '#000000']) {
            const t = palette.buildCustomThemeTokens(hex);
            expect(t.light['--accent-text'], `${hex} açık metin token'ı yok`).toBeTruthy();
            expect(t.dark['--accent-text'], `${hex} koyu metin token'ı yok`).toBeTruthy();
            expect(t.lightAccentTextContrast, `${hex} açık kontrast < 4.5`).toBeGreaterThanOrEqual(4.5);
            expect(t.darkAccentTextContrast, `${hex} koyu kontrast < 4.5`).toBeGreaterThanOrEqual(4.5);
        }
    });
});
