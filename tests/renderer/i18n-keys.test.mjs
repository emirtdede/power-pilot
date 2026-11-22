/**
 * i18n-keys.test.mjs - dil sızıntısı sözleşmesi (statik)
 *
 * Üç kapı:
 *  - Şablonlarda ve JS'te başvurulan her i18n anahtarı sözlükte var olmalı
 *    (yoksa arayüz ham anahtar gösterir).
 *  - İkon-only düğmelerin erişilebilir adı i18n'den gelmeli; sabit Türkçe/
 *    İngilizce aria-label sızıntısı kalmamalı.
 *  - 17 sözlük anahtar kümesi birebir aynı olmalı.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LANGS = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const dict = (lang) => JSON.parse(read(`src/renderer/locales/${lang}.json`));

const htmlFiles = ['src/index.html', 'src/mini.html'];
const jsFiles = ['src/renderer/app.js', 'src/renderer/mini.js'];

function referencedKeys() {
    const keys = new Set();
    for (const file of htmlFiles) {
        const text = read(file);
        for (const m of text.matchAll(/data-i18n(?:-placeholder|-title|-aria-label|-aria-context)?="([^"]+)"/g)) keys.add(m[1]);
        for (const m of text.matchAll(/data-nav-key="([^"]+)"/g)) keys.add(m[1]);
    }
    for (const file of jsFiles) {
        const text = read(file);
        for (const m of text.matchAll(/\bt\(\s*'([^']+)'\s*[,)]/g)) keys.add(m[1]);
        for (const m of text.matchAll(/\bt\(\s*"([^"]+)"\s*[,)]/g)) keys.add(m[1]);
    }
    return keys;
}

describe('i18n - anahtar sözleşmesi', () => {
    it('şablon/JS başvurularının tamamı tr sözlüğünde var', () => {
        const tr = dict('tr');
        const missing = [...referencedKeys()].filter((key) => !(key in tr));
        expect(missing).toEqual([]);
    });

    it('17 sözlük aynı anahtar kümesine sahip', () => {
        const base = Object.keys(dict('tr')).sort();
        for (const lang of LANGS) {
            expect(Object.keys(dict(lang)).sort(), lang).toEqual(base);
        }
    });

    it('her dilde boş değer yok', () => {
        for (const lang of LANGS) {
            const d = dict(lang);
            const empty = Object.keys(d).filter((key) => typeof d[key] !== 'string' || d[key].trim() === '');
            expect(empty, lang).toEqual([]);
        }
    });
});

describe('i18n - erişilebilir adlar', () => {
    for (const file of htmlFiles) {
        it(`${file}: ikon-only düğmeler i18n ile adlandırılmış`, () => {
            const { document } = new JSDOM(read(file)).window;
            const leaks = [];
            for (const button of document.querySelectorAll('button')) {
                const text = (button.textContent || '').trim();
                if (text.length > 0) continue; // metin içeren düğme kendi adını taşır
                const keyed = button.hasAttribute('data-i18n-aria-label')
                    || button.hasAttribute('data-i18n-title');
                if (!keyed) leaks.push(button.id || button.outerHTML.slice(0, 80));
            }
            expect(leaks).toEqual([]);
        });
    }

    it('index.html: sabit (i18n anahtarsız) aria-label kalmadı', () => {
        const { document } = new JSDOM(read('src/index.html')).window;
        const leaks = [];
        for (const el of document.querySelectorAll('[aria-label]')) {
            if (!el.hasAttribute('data-i18n-aria-label') && !el.hasAttribute('data-nav-key')) {
                leaks.push(`${el.id || el.tagName}: ${el.getAttribute('aria-label')}`);
            }
        }
        expect(leaks).toEqual([]);
    });
});

describe('i18n - açılış kapısı (yanlış dil flaşı yok)', () => {
    it('iskelet i18n-pending ile gizlenir ve CSS kapısı tanımlı', () => {
        const { document } = new JSDOM(read('src/index.html')).window;
        expect(document.documentElement.classList.contains('i18n-pending')).toBe(true);
        expect(read('src/renderer/app.css')).toContain('html.i18n-pending [data-i18n]');
    });

    it('sözlük uygulandığında ve güvenlik ağında kapı kaldırılır', () => {
        expect(read('src/renderer/app.js')).toContain("classList.remove('i18n-pending')");
        expect(read('src/renderer/i18n.js')).toContain("classList.remove('i18n-pending')");
    });
});
