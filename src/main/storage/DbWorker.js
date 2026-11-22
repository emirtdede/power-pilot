/**
 * DbWorker.js - WP-11.T11 / WP-03.T8
 * Yedek/geri yükleme işlerini ana iş parçacığından ayırır.
 *
 * Electron'da `utilityProcess.fork`; test/CLI/Node ortamında `execFile`
 * ile `scripts/db-backup.mjs` çalıştırılır. Anahtar komut satırına
 * yazılmaz: utilityProcess'e env, CLI'ya env ile geçirilir.
 */

const path = require('path');
const { execFile } = require('child_process');

const TASK_PATH = path.join(__dirname, 'DbWorkerTask.js');
const CLI_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'db-backup.mjs');
const DEFAULT_TIMEOUT_MS = 120000;

function getUtilityProcess() {
    try {
        // Testlerde electron mock'u olabilir; fork yoksa CLI'ya düşeriz.
        const electron = require('electron');
        if (electron && electron.utilityProcess && typeof electron.utilityProcess.fork === 'function') {
            return electron.utilityProcess;
        }
    } catch (_) { /* Electron yok */ }
    return null;
}

function runUtility(args, { key, timeoutMs }) {
    const utilityProcess = getUtilityProcess();
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = utilityProcess.fork(TASK_PATH, [], {
            serviceName: 'PowerPilot-DbBackup',
            env: {
                ...process.env,
                PP_DB_BACKUP_ARGS: JSON.stringify(args),
                PP_DB_BACKUP_KEY: key
            }
        });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch (_) { /* yut */ }
            reject(Object.assign(new Error('Yedek görevi zaman aşımına uğradı.'), { code: 'BACKUP_TIMEOUT' }));
        }, timeoutMs);
        timer.unref?.();
        child.on('message', (msg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (msg && msg.ok) resolve(msg);
            else reject(Object.assign(new Error((msg && msg.error) || 'Yedek görevi başarısız.'), { code: (msg && msg.code) || 'BACKUP_FAILED' }));
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(Object.assign(new Error(`Yedek görevi çıktı (kod ${code}).`), { code: 'BACKUP_WORKER_EXIT' }));
        });
    });
}

function runCli(args, { key, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const cliArgs = [
            CLI_PATH,
            '--db', args.dbPath,
            '--backup-dir', args.backupDir,
            '--prefix', args.prefix || 'powerpilot',
            '--keep', String(args.keep || 7),
            '--keep-days', String(args.keepDays || 7)
        ];
        execFile(process.execPath, cliArgs, {
            env: { ...process.env, PP_BACKUP_KEY: key },
            timeout: timeoutMs,
            windowsHide: true,
            maxBuffer: 1024 * 1024
        }, (err, stdout, stderr) => {
            if (err) {
                let parsed = null;
                try { parsed = JSON.parse(String(stderr).trim().split('\n').pop()); } catch (_) { /* yut */ }
                reject(Object.assign(new Error((parsed && parsed.error) || err.message), {
                    code: (parsed && parsed.code) || 'BACKUP_FAILED'
                }));
                return;
            }
            try {
                resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
            } catch (parseErr) {
                reject(Object.assign(new Error('Yedek çıktısı okunamadı.'), { code: 'BACKUP_BAD_OUTPUT', cause: parseErr }));
            }
        });
    });
}

/**
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {string} opts.backupDir
 * @param {string|Buffer} opts.key
 * @param {string} [opts.prefix]
 * @param {number} [opts.keep]
 * @param {number} [opts.keepDays]
 * @param {number} [opts.timeoutMs]
 * @param {boolean} [opts.forceCli] testler için utilityProcess'i atla
 */
async function runBackup(opts) {
    const {
        dbPath,
        backupDir,
        key,
        prefix = 'powerpilot',
        keep = 7,
        keepDays = 7,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        forceCli = false
    } = opts || {};
    if (!key) throw Object.assign(new Error('Yedek anahtarı gerekli.'), { code: 'BACKUP_KEY_MISSING' });
    if (!dbPath || !backupDir) throw Object.assign(new Error('dbPath ve backupDir gerekli.'), { code: 'INVALID_ARGS' });
    const keyText = Buffer.isBuffer(key) ? key.toString('hex') : String(key);
    const args = { dbPath, backupDir, prefix, keep, keepDays };
    const started = Date.now();
    const result = !forceCli && getUtilityProcess()
        ? await runUtility(args, { key: keyText, timeoutMs })
        : await runCli(args, { key: keyText, timeoutMs });
    return { ...result, durationMs: Date.now() - started };
}

/**
 * utilityProcess üzerinden yedek geri yükleme. Electron yoksa doğrudan
 * kütüphane çağrısına düşer (test/CLI).
 */
async function runRestore(opts) {
    const {
        inputPath,
        dbPath,
        key,
        quarantineDir = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        forceCli = false
    } = opts || {};
    if (!key) throw Object.assign(new Error('Yedek anahtarı gerekli.'), { code: 'BACKUP_KEY_MISSING' });
    const utilityProcess = !forceCli && getUtilityProcess();
    if (!utilityProcess) {
        const { restoreDatabase } = require('./Backup');
        const started = Date.now();
        const result = restoreDatabase({ inputPath, dbPath, key, quarantineDir });
        return { ...result, durationMs: Date.now() - started };
    }
    const keyText = Buffer.isBuffer(key) ? key.toString('hex') : String(key);
    return runUtility({ restore: true, inputPath, dbPath, quarantineDir }, { key: keyText, timeoutMs });
}

module.exports = { runBackup, runRestore, TASK_PATH, CLI_PATH };
