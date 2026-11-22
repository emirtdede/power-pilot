#!/usr/bin/env node
/**
 * db-backup.mjs - WP-11.T11
 * `powerpilot.db` için VACUUM INTO + AES-256-GCM yedek.
 *
 * Kullanım:
 *   node scripts/db-backup.mjs --user-data-dir <dir> --key-hex <64 hex> [--keep 7]
 *   PP_BACKUP_KEY=<hex|base64|32-char> node scripts/db-backup.mjs --user-data-dir <dir>
 *   node scripts/db-backup.mjs --db <path> --backup-dir <dir> --key-file <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backupDatabase } = require('../src/main/storage/Backup.js');

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

function fail(message, code = 'BACKUP_FAILED') {
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const userData = args['user-data-dir'] || process.env.POWERPILOT_USER_DATA || null;
if (!userData && !args.db) fail('--user-data-dir veya --db gerekli.', 'INVALID_ARGS');

const dbPath = path.resolve(args.db || path.join(userData, 'powerpilot.db'));
const backupDir = path.resolve(args['backup-dir'] || path.join(userData || path.dirname(dbPath), 'backups'));

let key = args['key-hex'] || process.env.PP_BACKUP_KEY || null;
if (!key && args['key-file']) {
    try { key = fs.readFileSync(args['key-file'], 'utf8').trim(); } catch (err) { fail(`Anahtar okunamadı: ${err.message}`, 'BACKUP_KEY_MISSING'); }
}
if (!key) fail('Yedek anahtarı yok (--key-hex, --key-file veya PP_BACKUP_KEY).', 'BACKUP_KEY_MISSING');

try {
    const result = backupDatabase({
        dbPath,
        backupDir,
        key,
        prefix: args.prefix || 'powerpilot',
        keep: Number(args.keep || 7),
        keepDays: Number(args['keep-days'] || 7)
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (err) {
    fail(err.message, err.code || 'BACKUP_FAILED');
}
