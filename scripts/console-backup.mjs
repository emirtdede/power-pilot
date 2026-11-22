#!/usr/bin/env node
/**
 * console-backup.mjs - WP-03.T8
 * Şirket konsolu `console.db` için günlük VACUUM INTO + AES-256-GCM yedek
 * ve isteğe bağlı geri yükleme.
 *
 * Kullanım:
 *   node scripts/console-backup.mjs --store <CONSOLE_STORE> --key-hex <64 hex> [--keep 7]
 *   CONSOLE_BACKUP_KEY=<...> node scripts/console-backup.mjs --store ./data/console.json
 *   node scripts/console-backup.mjs --db ./data/console.db --restore --input <yedek>
 *
 * Not: JSON store yolu verilirse DB yolu `console.db` olarak türetilir
 * (ConsoleServer ile aynı kural).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { backupDatabase, restoreDatabase, quickCheck } = require('../src/main/storage/Backup.js');

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

function fail(message, code = 'CONSOLE_BACKUP_FAILED') {
    process.stderr.write(`${JSON.stringify({ ok: false, code, error: message })}\n`);
    process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const storePath = args.store || process.env.CONSOLE_STORE || null;
let dbPath = args.db ? path.resolve(args.db) : null;
if (!dbPath && storePath) {
    dbPath = storePath.toLowerCase().endsWith('.db')
        ? path.resolve(storePath)
        : path.join(path.dirname(path.resolve(storePath)), 'console.db');
}
if (!dbPath) fail('--db veya --store/CONSOLE_STORE gerekli.', 'INVALID_ARGS');
if (!fs.existsSync(dbPath)) fail(`Konsol DB bulunamadı: ${dbPath}`, 'DB_NOT_FOUND');

const backupDir = path.resolve(args['backup-dir'] || path.join(path.dirname(dbPath), 'backups'));

let key = args['key-hex'] || process.env.CONSOLE_BACKUP_KEY || process.env.PP_BACKUP_KEY || null;
if (!key && args['key-file']) {
    try { key = fs.readFileSync(args['key-file'], 'utf8').trim(); } catch (err) { fail(`Anahtar okunamadı: ${err.message}`, 'BACKUP_KEY_MISSING'); }
}
if (!key) fail('Konsol yedek anahtarı yok (--key-hex, --key-file, CONSOLE_BACKUP_KEY).', 'BACKUP_KEY_MISSING');

try {
    if (args.restore) {
        if (!args.input) fail('--restore için --input gerekli.', 'INVALID_ARGS');
        const result = restoreDatabase({
            inputPath: path.resolve(args.input),
            dbPath,
            key,
            quarantineDir: args['quarantine-dir'] ? path.resolve(args['quarantine-dir']) : null
        });
        const check = quickCheck(dbPath);
        if (check !== 'ok') fail(`Geri yüklenen konsol DB bozuk: ${check}`, 'RESTORE_DB_CORRUPT');
        process.stdout.write(`${JSON.stringify({ ok: true, restored: true, ...result, quickCheck: check })}\n`);
    } else {
        const result = backupDatabase({
            dbPath,
            backupDir,
            key,
            prefix: 'console',
            keep: Number(args.keep || 7),
            keepDays: Number(args['keep-days'] || 7)
        });
        process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    }
} catch (err) {
    fail(err.message, err.code || 'CONSOLE_BACKUP_FAILED');
}
