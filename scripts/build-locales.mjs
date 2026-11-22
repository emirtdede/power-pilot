/**
 * build-locales.mjs - WP-14.T1
 * Renderer sözlüklerini (17 dil) JSON'a çıkarır ve ana süreç kopyalarını üretir.
 *
 * İlk çalıştırma: legacy `src/renderer/i18n.js` içindeki `translations` +
 * `generatedTranslations` birleşimini okur. Sonraki çalıştırmalar mevcut
 * `src/renderer/locales/*.json` dosyalarını yeniden yazar (tek doğruluk kaynağı).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const legacyPath = path.join(root, 'src/renderer/i18n.js');
const rendererDir = path.join(root, 'src/renderer/locales');
const mainDir = path.join(root, 'src/main/locales');

export const LANGUAGE_ORDER = [
    'tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl',
    'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'
];

function readLegacy() {
    if (!fs.existsSync(legacyPath)) return null;
    const source = fs.readFileSync(legacyPath, 'utf8').replace(/^\uFEFF/, '');
    // Legacy dosya artık yükleyici olabilir; `translations` üretmiyorsa atla.
    if (!/const\s+translations\s*=/.test(source)) return null;
    const factory = new Function(`${source}\nreturn translations;`);
    const translations = factory();
    if (!translations || typeof translations !== 'object') {
        throw new Error('Legacy i18n.js sözlük üretmedi.');
    }
    return translations;
}

function readExisting() {
    const out = {};
    if (!fs.existsSync(rendererDir)) return out;
    for (const name of fs.readdirSync(rendererDir)) {
        if (!name.endsWith('.json') || name === 'manifest.json') continue;
        const lang = name.slice(0, -5);
        out[lang] = JSON.parse(fs.readFileSync(path.join(rendererDir, name), 'utf8'));
    }
    return out;
}

function sortedDict(dict) {
    const out = {};
    for (const key of Object.keys(dict).sort()) out[key] = dict[key];
    return out;
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildLocales({ source = null } = {}) {
    const translations = source || readLegacy() || readExisting();
    const missing = LANGUAGE_ORDER.filter((lang) => !translations[lang]);
    if (missing.length > 0) throw new Error(`Eksik dil sözlüğü: ${missing.join(', ')}`);
    const extra = Object.keys(translations).filter((lang) => !LANGUAGE_ORDER.includes(lang));
    if (extra.length > 0) throw new Error(`Beklenmeyen dil: ${extra.join(', ')}`);

    fs.mkdirSync(rendererDir, { recursive: true });
    fs.mkdirSync(mainDir, { recursive: true });

    const manifest = { version: 1, languages: {}, generatedAt: new Date().toISOString() };
    for (const lang of LANGUAGE_ORDER) {
        const dict = sortedDict(translations[lang]);
        const json = `${JSON.stringify(dict, null, 2)}\n`;
        fs.writeFileSync(path.join(rendererDir, `${lang}.json`), json, 'utf8');
        fs.writeFileSync(path.join(mainDir, `${lang}.server.json`), json, 'utf8');
        manifest.languages[lang] = { keys: Object.keys(dict).length, sha256: sha256(json) };
    }
    fs.writeFileSync(path.join(rendererDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const manifest = buildLocales();
    const total = Object.values(manifest.languages).reduce((sum, l) => sum + l.keys, 0);
    console.log(`[locales] ${LANGUAGE_ORDER.length} dil, ${total} anahtar yazıldı.`);
}
