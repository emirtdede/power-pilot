#!/usr/bin/env node
/**
 * restore-db.mjs - WP-11.T11
 * Şifreli `powerpilot.db` yedeğini doğrulayıp geri yükler.
 *
 * Kullanım:
 *   node scripts/restore-db.mjs --user-data-dir <dir> --input <yedek.db.enc> --key-hex <64 hex>
 *   PP_BACKUP_KEY=<...> node scripts/restore-db.mjs --db <path> --input <yedek> [--quarantine-dir <dir>]
 *
 * Güvenlik: çözülen dosya quick_check'ten geçmeden mevcut DB'ye dokunulmaz;
 * eski DB `quarantine/` altına taşınır (silinmez).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { restoreDatabase, quickCheck } = require('../src/main/storage/Backup.js');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[key] = next;
            i += 1;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function fail(message, code = 'RESTORE_FAILED') {
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const userData = args['user-data-dir'] || process.env.POWERPILOT_USER_DATA || null;
if (!userData && !args.db) fail('--user-data-dir veya --db gerekli.', 'INVALID_ARGS');
if (!args.input) fail('--input (yedek dosyası) gerekli.', 'INVALID_ARGS');

const dbPath = path.resolve(args.db || path.join(userData, 'powerpilot.db'));
const inputPath = path.resolve(args.input);
if (!fs.existsSync(inputPath)) fail(`Yedek bulunamadı: ${inputPath}`, 'BACKUP_NOT_FOUND');

let key = args['key-hex'] || process.env.PP_BACKUP_KEY || null;
if (!key && args['key-file']) {
    try { key = fs.readFileSync(args['key-file'], 'utf8').trim(); } catch (err) { fail(`Anahtar okunamadı: ${err.message}`, 'BACKUP_KEY_MISSING'); }
}
if (!key) fail('Yedek anahtarı yok (--key-hex, --key-file veya PP_BACKUP_KEY).', 'BACKUP_KEY_MISSING');

try {
    const result = restoreDatabase({
        inputPath,
        dbPath,
        key,
        quarantineDir: args['quarantine-dir'] ? path.resolve(args['quarantine-dir']) : null
    });
    const check = quickCheck(dbPath);
    if (check !== 'ok') fail(`Geri yüklenen DB quick_check başarısız: ${check}`, 'RESTORE_DB_CORRUPT');
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, quickCheck: check })}\n`);
} catch (err) {
    fail(err.message, err.code || 'RESTORE_FAILED');
}
