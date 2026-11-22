/**
 * i18n-parity.test.mjs - WBS-11.6 / WP-14.T1
 * JSON locale dosyaları: 17 dil, birebir eşit anahtar kümeleri, placeholder parity.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALE_DIR = path.join(here, '..', '..', 'src', 'renderer', 'locales');

const EXPECTED_LANGS = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];

function loadTranslations() {
    const out = {};
    for (const lang of EXPECTED_LANGS) {
        out[lang] = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${lang}.json`), 'utf8'));
    }
    return out;
}

function placeholders(value) {
    return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

describe('i18n paritesi (TS-11.6 / WP-14)', () => {
    it('17 dil mevcut', () => {
        const translations = loadTranslations();
        expect(Object.keys(translations).sort()).toEqual([...EXPECTED_LANGS].sort());
    });

    it('anahtar kümeleri birebir eşit', () => {
        const translations = loadTranslations();
        const base = Object.keys(translations.tr).sort();
        expect(base.length).toBeGreaterThan(20);
        for (const lang of EXPECTED_LANGS) {
            expect(Object.keys(translations[lang]).sort()).toEqual(base);
        }
    });

    it('placeholder kümeleri dile göre değişmez', () => {
        const translations = loadTranslations();
        const base = translations.tr;
        for (const key of Object.keys(base)) {
            const expected = placeholders(base[key]);
            if (expected.length === 0) continue;
            for (const lang of EXPECTED_LANGS) {
                expect(placeholders(translations[lang][key]), `${lang}.${key}`).toEqual(expected);
            }
        }
    });
});
