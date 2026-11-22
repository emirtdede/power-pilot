#!/usr/bin/env node
/**
 * verify-pack.js - WP-16/TS-16: paketlenmiş ps-list spike'ı.
 *
 * `npm run pack` sonrası çalışır. Doğrular:
 *  1. `dist/win-unpacked/resources/app.asar` mevcut,
 *  2. `app.asar.unpacked/node_modules/ps-list/vendor/fastlist-*.exe` ASAR
 *     dışında (asarUnpack doğru),
 *  3. unpacked ps-list modülü dinamik import ile yüklenebiliyor,
 *  4. gerçek süreç listesi boş değil.
 *
 * Herhangi biri başarısızsa exit 1 - ps-list@9 ESM paketleme regresyonu
 * release'e çıkamaz.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const RESOURCES = path.join(ROOT, 'dist', 'win-unpacked', 'resources');

function fail(message) {
    console.error(`[verify-pack] BAŞARISIZ: ${message}`);
    process.exit(1);
}

function findUnpackedPsList() {
    const candidates = [
        path.join(RESOURCES, 'app.asar.unpacked', 'node_modules', 'ps-list'),
        path.join(RESOURCES, 'app', 'node_modules', 'ps-list')
    ];
    for (const dir of candidates) {
        if (fs.existsSync(path.join(dir, 'index.js'))) return dir;
    }
    return null;
}

async function main() {
    if (!fs.existsSync(path.join(RESOURCES, 'app.asar'))) {
        fail(`app.asar bulunamadı: ${path.join(RESOURCES, 'app.asar')} (önce npm run pack)`);
    }
    const psListDir = findUnpackedPsList();
    if (!psListDir) fail('Paket içinde ps-list modülü bulunamadı.');

    const vendorDir = path.join(psListDir, 'vendor');
    if (!fs.existsSync(vendorDir)) {
        fail(`ps-list vendor dizini ASAR dışında değil: ${vendorDir}`);
    }
    const exes = fs.readdirSync(vendorDir).filter((f) => f.toLowerCase().endsWith('.exe'));
    if (exes.length === 0) fail('ps-list vendor içinde fastlist exe yok (asarUnpack eksik).');
    console.log(`[verify-pack] vendor exe: ${exes.join(', ')}`);

    let mod;
    try {
        mod = await import(pathToFileURL(path.join(psListDir, 'index.js')).href);
    } catch (err) {
        fail(`paketlenmiş ps-list dinamik import edilemedi: ${err.message}`);
    }
    const fn = mod.default || mod.psList;
    if (typeof fn !== 'function') fail('ps-list export şekli beklenenden farklı (default/psList yok).');

    let list;
    try {
        list = await fn({ all: true });
    } catch (err) {
        fail(`ps-list çalıştırılamadı: ${err.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
        fail('ps-list boş liste döndürdü (paketli fastlist çalışmıyor).');
    }
    console.log(`[verify-pack] OK - ${list.length} süreç listelendi.`);
}

if (require.main === module) {
    main().catch((err) => fail((err && err.message) || String(err)));
}

module.exports = { findUnpackedPsList, main };
