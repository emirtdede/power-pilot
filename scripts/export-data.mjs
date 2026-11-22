#!/usr/bin/env node
/**
 * export-data.mjs - WP-04.T7
 * Veriyi SIRLAR OLMADAN dışa aktarır. Dışa aktarılan dosya başka bir makinede
 * geri yüklenirse sırlar/PIN/API anahtarı yeniden provisioning gerektirir.
 *
 * Kullanım:
 *   node scripts/export-data.mjs --data-dir "<userData>" [--out export.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SecretStore } = require('../src/main/security/SecretStore');

function argValue(name) {
    const prefix = `--${name}=`;
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
        if (a.startsWith(prefix)) return a.slice(prefix.length);
    }
    return null;
}

const dataDir = argValue('data-dir') || path.join(process.env.APPDATA || os.homedir(), 'powerpilot');
const source = path.join(dataDir, 'powerpilot_data.json');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = argValue('out') || path.join(process.cwd(), `powerpilot-export-${stamp}.json`);

if (!fs.existsSync(source)) {
    console.error(`HATA: veri dosyası yok: ${source}`);
    process.exit(1);
}

let parsed;
try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
} catch (err) {
    console.error(`HATA: veri dosyası okunamadı: ${err.message}`);
    process.exit(1);
}

const clean = SecretStore.stripForDisk(parsed);
// Kimlik bilgisi türevi alanlar da dışa aktarılmaz: geri yüklemede yeniden
// provisioning zorunlu olsun.
if (clean.settings && typeof clean.settings === 'object') {
    for (const field of ['cancelPinHash', 'cancelPinSalt', 'localApiKeyHash', 'localApiKeyMasked', 'localApiKeyCreatedAt']) {
        if (Object.prototype.hasOwnProperty.call(clean.settings, field)) clean.settings[field] = null;
    }
}
clean.exportedAt = new Date().toISOString();
clean.exportExcludes = [
    'settings secret fields',
    'webhook secrets',
    'PIN/API key credential material'
];

const hits = SecretStore.findPlaintextSecrets(clean);
if (hits.length > 0) {
    console.error(`HATA: dışa aktarımda hâlâ sır var: ${hits.join(', ')}`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const tmp = `${path.resolve(out)}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, path.resolve(out));
console.log(`Dışa aktarıldı (sırlar hariç): ${path.resolve(out)}`);
