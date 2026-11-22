#!/usr/bin/env node
/**
 * license-check.mjs - WP-15.T5
 * Üretim bağımlılıklarının lisanslarını çevrimdışı tarar.
 * GPL/AGPL/SSPL yasak; bilinmeyen lisans release'i bloke eder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const FORBIDDEN = /(^|[^L])(A?GPL|SSPL|CPAL|EUPL)/i;
const rows = [];
const issues = [];

for (const [rel, entry] of Object.entries(lock.packages || {})) {
    if (!rel.startsWith('node_modules/') || !entry || entry.dev === true) continue;
    const name = entry.name || rel.slice('node_modules/'.length).replace(/^node_modules\//, '');
    let license = entry.license || null;
    if (!license) {
        const pkgFile = path.join(ROOT, rel, 'package.json');
        if (fs.existsSync(pkgFile)) {
            const meta = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
            if (typeof meta.license === 'string') license = meta.license;
            else if (Array.isArray(meta.licenses)) license = meta.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' / ');
        }
    }
    const value = license || 'UNKNOWN';
    rows.push({ name, version: entry.version || '', license: value });
    if (value === 'UNKNOWN') issues.push(`Bilinmeyen lisans: ${name}@${entry.version || '?'}`);
    else if (FORBIDDEN.test(value) && !/^LGPL/i.test(value)) {
        issues.push(`Yasaklı lisans: ${name}@${entry.version || '?'} (${value})`);
    }
}

const summary = {};
for (const row of rows) summary[row.license] = (summary[row.license] || 0) + 1;
const report = {
    generatedAt: new Date().toISOString(),
    packages: rows.length,
    licenses: summary,
    issues
};
fs.mkdirSync(path.join(ROOT, 'docs/reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/reports/licenses.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[license-check] ${rows.length} üretim paketi; lisans dağılımı: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ')}`);
if (issues.length > 0) {
    for (const issue of issues) console.error(`[license-check] ${issue}`);
    process.exit(1);
}
console.log('[license-check] temiz - GPL/AGPL/SSPL yok.');
