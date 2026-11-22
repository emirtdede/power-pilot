#!/usr/bin/env node
/**
 * verify-models.js - WBS-06/TS-06: model pinleri ve (varsa) yerel dosya bütünlüğü.
 *
 * İki katman:
 *  1. Meta doğrulama (ağsız, her zaman): URL immutable commit içeriyor mu,
 *     bayt sayısı + SHA-256 sabit mi, `main` gibi oynak referans var mı?
 *  2. Yerel dosya doğrulaması: POWERPILOT_MODEL_DIR (veya ./models) altında
 *     dosya varsa boyut + SHA-256 karşılaştırılır.
 *
 * Eksik yerel dosya hata DEĞİLDİR; model yalnızca kullanıcı "AI paketini kur"
 * dediğinde indirilir. Pin meta hatası her zaman exit 1'dir.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MODEL_SPECS } = require('../src/main/services/ModelManager');

const COMMIT_RE = /\/resolve\/[0-9a-f]{40}\//;
const SHA_RE = /^[0-9a-f]{64}$/;

function verifyMetadata(specs = MODEL_SPECS) {
    const issues = [];
    for (const [id, spec] of Object.entries(specs)) {
        if (!spec || typeof spec !== 'object') {
            issues.push(`${id}: spec yok.`);
            continue;
        }
        if (typeof spec.url !== 'string' || !COMMIT_RE.test(spec.url)) {
            issues.push(`${id}: URL immutable commit (40 hex) içermiyor: ${spec && spec.url}`);
        }
        if (/\/(main|master)\//.test(spec.url || '')) {
            issues.push(`${id}: oynak referans (main/master) yasak.`);
        }
        if (!Number.isInteger(spec.bytes) || spec.bytes <= 0) {
            issues.push(`${id}: expectedBytes pozitif tam sayı değil.`);
        }
        if (typeof spec.sha256 !== 'string' || !SHA_RE.test(spec.sha256)) {
            issues.push(`${id}: SHA-256 64 hex değil.`);
        }
    }
    return issues;
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(file);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function verifyLocalFiles(specs = MODEL_SPECS, dir = process.env.POWERPILOT_MODEL_DIR || path.join(process.cwd(), 'models')) {
    const results = [];
    if (!fs.existsSync(dir)) {
        return { dir, missing: true, results };
    }
    for (const [id, spec] of Object.entries(specs)) {
        const file = path.join(dir, spec.file);
        if (!fs.existsSync(file)) {
            results.push({ id, file, present: false });
            continue;
        }
        const stat = fs.statSync(file);
        const sha256 = await sha256File(file);
        results.push({
            id,
            file,
            present: true,
            bytesOk: stat.size === spec.bytes,
            shaOk: sha256 === spec.sha256,
            bytes: stat.size,
            expectedBytes: spec.bytes,
            sha256
        });
    }
    return { dir, missing: false, results };
}

async function main() {
    const metaIssues = verifyMetadata();
    if (metaIssues.length > 0) {
        console.error('[verify-models] Pin meta hataları:');
        for (const issue of metaIssues) console.error(`  - ${issue}`);
        process.exit(1);
    }
    console.log('[verify-models] Pin meta OK (immutable commit + boyut + SHA-256).');

    const local = await verifyLocalFiles();
    if (local.missing) {
        console.log(`[verify-models] Yerel model dizini yok (${local.dir}); yalnızca pin meta doğrulandı.`);
        return;
    }
    let failed = false;
    for (const r of local.results) {
        if (!r.present) {
            console.log(`[verify-models] ${r.id}: yerel dosya yok (atlandı).`);
            continue;
        }
        if (!r.bytesOk || !r.shaOk) {
            failed = true;
            console.error(`[verify-models] ${r.id}: BÜTÜNLÜK HATASI (bytes=${r.bytes}/${r.expectedBytes}, sha=${r.shaOk ? 'ok' : 'mismatch'})`);
        } else {
            console.log(`[verify-models] ${r.id}: OK (${r.bytes} bayt).`);
        }
    }
    if (failed) process.exit(1);
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[verify-models] Hata:', err && err.message);
        process.exit(1);
    });
}

module.exports = { verifyMetadata, verifyLocalFiles, sha256File };
