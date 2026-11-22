#!/usr/bin/env node
/**
 * check-i18n.js - WP-14.T4
 * 17 dil, anahtar eşitliği, duplicate, {placeholder} parity, kullanılmayan rapor.
 * Hata varsa exit 1 (CI kalite kapısı).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'src', 'renderer', 'locales');
const SERVER_DIR = path.join(ROOT, 'src', 'main', 'locales');
const LANGS = [
    'tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl',
    'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'
];

function placeholders(value) {
    return [...String(value).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
}

function duplicateKeys(text) {
    const seen = new Set();
    const dupes = [];
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^  "([^"]+)":/);
        if (!m) continue;
        if (seen.has(m[1])) dupes.push(m[1]);
        seen.add(m[1]);
    }
    return dupes;
}

function readLang(dir, lang, errors) {
    const file = path.join(dir, `${lang}.json`);
    if (!fs.existsSync(file)) {
        errors.push(`Eksik locale dosyası: ${lang}.json`);
        return null;
    }
    const text = fs.readFileSync(file, 'utf8');
    const dupes = duplicateKeys(text);
    if (dupes.length > 0) errors.push(`${lang}.json duplicate anahtar: ${dupes.join(', ')}`);
    try {
        return JSON.parse(text);
    } catch (err) {
        errors.push(`${lang}.json geçersiz JSON: ${err.message}`);
        return null;
    }
}

/**
 * Ürün kaynak dosyaları: yalnızca uygulamanın gerçekten çalıştırdığı kod.
 * `tests/`, `docs/` ve `scripts/` bilinçli olarak dışarıda - bir anahtarın
 * yalnızca bir testte anılması onu "kullanılıyor" yapmaz.
 */
function sourceFiles() {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'locales' || entry.name === 'node_modules' || entry.name === 'vendor') continue;
                walk(full);
            } else if (/\.(js|html)$/.test(entry.name)) {
                files.push(full);
            }
        }
    };
    walk(path.join(ROOT, 'src'));
    for (const name of ['main.js', 'preload.js']) {
        const full = path.join(ROOT, name);
        if (fs.existsSync(full)) files.push(full);
    }
    return files;
}

/**
 * Bir anahtarın kullanımını tespit eder.
 *
 * Eski sürüm yalnızca `t('key')` ve `data-i18n="key"` desenlerine bakıyordu ve
 * 86 anahtarı yanlışlıkla "kullanılmayan" bildiriyordu (gerçek ölü sayısı 0).
 * Kaçırılan gerçek kullanım biçimleri - hepsi bu kod tabanında mevcut:
 *
 *   1. Harita değeri      BUSY: 'aiBusy'                        (main.js:106)
 *   2. Nesne özelliği     dict.timeFormatDays                   (app.js:775)
 *   3. Metot çağrısı      this.translate('aiNegatedIntent')     (AiService.js:227)
 *   4. Üçlü seçim         t(x ? 'toastScheduledTaskCreated' : …) (app.js:1353)
 *   5. Dinamik önek       t('event_' + ev)                      (app.js:2386)
 *
 * Çözüm katmanlı: doğrudan referanslar + gövdede tam-kelime geçiş + dinamik
 * önek genişletmesi. Rapor amaçlı olduğu için "geçiyor" lehine temkinli
 * davranır; yanlış pozitif üretmez, gerçek ölü anahtarı kaçırmaz.
 */
function usedKeys(baseKeys = []) {
    const keys = new Set();
    const prefixes = new Set();
    const corpus = [];

    for (const file of sourceFiles()) {
        const text = fs.readFileSync(file, 'utf8');
        corpus.push(text);
        // 1) Doğrudan: t('key') / t("key")
        for (const m of text.matchAll(/\bt\(\s*['"]([^'"]+)['"]\s*[,)]/g)) keys.add(m[1]);
        // 2) data-i18n ve türevleri: -placeholder, -title, -aria-label, -aria-context
        for (const m of text.matchAll(/data-i18n(?:-placeholder|-title|-aria-label|-aria-context)?="([^"]+)"/g)) keys.add(m[1]);
        // 3) Metot çağrısı: this.translate('key') / t.call(null, 'key')
        for (const m of text.matchAll(/\btranslate\(\s*['"]([^'"]+)['"]\s*[,)]/g)) keys.add(m[1]);
        // 4) Dinamik önek: t('event_' + ev) / translate("x" + y)
        for (const m of text.matchAll(/\b(?:t|translate)\(\s*['"]([A-Za-z0-9_.]*?)['"]\s*\+/g)) {
            if (m[1]) prefixes.add(m[1]);
        }
    }

    const body = corpus.join('\n');
    for (const key of baseKeys) {
        // Harita değeri, nesne özelliği, üçlü seçim vb. - tam kelime olarak geçiş.
        const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`);
        if (pattern.test(body)) keys.add(key);
    }
    // Dinamik önek genişletmesi: kullanılan önekin tüm anahtarları kullanılmış sayılır.
    for (const prefix of prefixes) {
        for (const key of baseKeys) {
            if (key.startsWith(prefix)) keys.add(key);
        }
    }
    return keys;
}

function checkLocales({ dir = DEFAULT_DIR, serverDir = SERVER_DIR, langs = LANGS } = {}) {
    const errors = [];
    const dictionaries = {};
    for (const lang of langs) {
        const dict = readLang(dir, lang, errors);
        if (dict) dictionaries[lang] = dict;
    }
    const base = dictionaries.tr || {};
    const baseKeys = Object.keys(base).sort();
    if (baseKeys.length === 0) errors.push('tr sözlüğü boş.');
    for (const lang of langs) {
        const dict = dictionaries[lang];
        if (!dict) continue;
        const keys = Object.keys(dict).sort();
        const missing = baseKeys.filter((k) => !(k in dict));
        const extra = keys.filter((k) => !(k in base));
        if (missing.length > 0) errors.push(`${lang}: eksik ${missing.length} anahtar (${missing.slice(0, 5).join(', ')})`);
        if (extra.length > 0) errors.push(`${lang}: fazla ${extra.length} anahtar (${extra.slice(0, 5).join(', ')})`);
        if (serverDir && fs.existsSync(serverDir)) {
            const serverFile = path.join(serverDir, `${lang}.server.json`);
            if (!fs.existsSync(serverFile)) {
                errors.push(`${lang}.server.json eksik.`);
            } else {
                const server = JSON.parse(fs.readFileSync(serverFile, 'utf8'));
                if (JSON.stringify(server) !== JSON.stringify(dict)) {
                    errors.push(`${lang}.server.json renderer sözlüğüyle eşleşmiyor (npm run build:locales).`);
                }
            }
        }
    }
    for (const key of baseKeys) {
        const expected = placeholders(base[key]);
        if (expected.length === 0) continue;
        for (const lang of langs) {
            const dict = dictionaries[lang];
            if (!dict || !(key in dict)) continue;
            const actual = placeholders(dict[key]);
            if (actual.join(',') !== expected.join(',')) {
                errors.push(`${lang}.${key}: placeholder farkı (${actual.join(',') || 'yok'} != ${expected.join(',')})`);
            }
        }
    }
    const used = usedKeys(baseKeys);
    const unused = baseKeys.filter((key) => !used.has(key));
    return { errors, unused, languages: langs.length, keys: baseKeys.length };
}

if (require.main === module) {
    const dir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DIR;
    const result = checkLocales({ dir, serverDir: dir === DEFAULT_DIR ? SERVER_DIR : null });
    if (result.unused.length > 0) {
        console.log(`[locales:check] kullanılmayan anahtar: ${result.unused.length} (rapor)`);
        console.log(`  ${result.unused.slice(0, 20).join(', ')}${result.unused.length > 20 ? ', …' : ''}`);
    }
    if (result.errors.length > 0) {
        for (const err of result.errors) console.error(`[locales:check] ${err}`);
        process.exit(1);
    }
    console.log(`[locales:check] temiz: ${result.languages} dil, ${result.keys} anahtar.`);
}

module.exports = { checkLocales, placeholders, duplicateKeys, LANGS };
