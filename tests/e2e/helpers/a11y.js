/**
 * tests/e2e/helpers/a11y.js - PPX yardımcıları (bağımlılıksız, saf DOM).
 *
 * `contrast(fg, bg)`  : WCAG 2.x bağıl parlaklık oranı (1-21).
 * `rectOverlap(a, b)` : iki DOMRect'in kesişim alanı (px²).
 * `visibleFocusables(page, root)` : odaklanabilir + görünür öğe listesi.
 * `waitForStable(page, ms)` : yerleşim/animasyon oturması için bekleme.
 *
 * Hiçbir paket kullanılmaz (axe-core reddedildi - plan §3/D9).
 */

/** '#rrggbb' | '#rgb' | 'rgb(r, g, b)' → [r, g, b] (0-255). */
function parseColor(value) {
    const s = String(value || '').trim();
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) {
        return m[1].split('').map((c) => parseInt(c + c, 16));
    }
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
    throw new Error(`renk çözümlenemedi: ${s}`);
}

function luminance(rgb) {
    const channel = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = rgb.map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG kontrast oranı: (L1 + 0.05) / (L2 + 0.05). */
function contrast(fg, bg) {
    const a = luminance(parseColor(fg));
    const b = luminance(parseColor(bg));
    const light = Math.max(a, b);
    const dark = Math.min(a, b);
    return (light + 0.05) / (dark + 0.05);
}

/** İki dikdörtgenin kesişim alanı (px²); kesişim yoksa 0. */
function rectOverlap(a, b) {
    if (!a || !b) return 0;
    const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return x * y;
}

/** Görünür ve odaklanabilir öğeler: { id, tag, text, rect } listesi. */
async function visibleFocusables(page, rootSelector = 'body') {
    return page.evaluate((sel) => {
        const root = document.querySelector(sel) || document.body;
        const nodes = root.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        return [...nodes].filter((el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        }).map((el) => {
            const r = el.getBoundingClientRect();
            return {
                id: el.id || '',
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60),
                rect: { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left }
            };
        });
    }, rootSelector);
}

/** Yerleşim ve kısa geçişlerin oturmasını bekle. */
async function waitForStable(page, ms = 180) {
    await page.waitForTimeout(ms);
}

module.exports = { contrast, rectOverlap, visibleFocusables, waitForStable, parseColor };
