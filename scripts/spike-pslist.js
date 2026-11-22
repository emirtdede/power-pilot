#!/usr/bin/env node
/**
 * spike-pslist.js - WP-04: 0.5 günlük paketli ps-list spike'ı.
 *
 * `npm run pack` çıktısı üzerinde fastlist vendor exe'sinin ASAR dışında
 * kaldığını ve ps-list@9 ESM modülünün paket içinden yüklenip gerçek süreç
 * listesi döndürdüğünü doğrular. Başarısızsa fallback kararı (ps-list@8 CJS
 * veya doğrudan fastlist) devreye alınır - bu script kapıdır.
 */

'use strict';

const { main } = require('./verify-pack');

main().catch((err) => {
    console.error(`[spike:pslist] BAŞARISIZ: ${(err && err.message) || err}`);
    process.exit(1);
});
