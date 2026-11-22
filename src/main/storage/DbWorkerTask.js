/**
 * DbWorkerTask.js - WP-11.T11 / WP-03.T8
 * utilityProcess içinde çalışan yedek görevi. Ana süreç yalnızca kısa
 * mesajlaşır; VACUUM/şifreleme burada yapılır.
 */

const { backupDatabase, restoreDatabase } = require('./Backup');

function readArgs() {
    try {
        return JSON.parse(process.env.PP_DB_BACKUP_ARGS || '{}');
    } catch (_) {
        return {};
    }
}

async function main() {
    const args = readArgs();
    delete process.env.PP_DB_BACKUP_ARGS;
    const key = process.env.PP_DB_BACKUP_KEY || null;
    delete process.env.PP_DB_BACKUP_KEY;
    const post = (msg) => {
        if (process.parentPort && typeof process.parentPort.postMessage === 'function') {
            process.parentPort.postMessage(msg);
        } else {
            process.stdout.write(`${JSON.stringify(msg)}\n`);
        }
    };
    try {
        const result = args.restore
            ? restoreDatabase({
                inputPath: args.inputPath,
                dbPath: args.dbPath,
                key,
                quarantineDir: args.quarantineDir || null
            })
            : backupDatabase({
                dbPath: args.dbPath,
                backupDir: args.backupDir,
                key,
                prefix: args.prefix || 'powerpilot',
                keep: args.keep || 7,
                keepDays: args.keepDays || 7
            });
        post({ ok: true, ...result });
    } catch (err) {
        post({ ok: false, code: err.code || 'BACKUP_FAILED', error: err.message });
        process.exitCode = 1;
    }
}

main();
