/**
 * Backup.js - WP-11.T11 / WP-03.T8
 * SQLite `VACUUM INTO` + AES-256-GCM yedek/geri yükleme yardımcıları.
 *
 * Format (PPBK1):
 *   magic(5) | version(1) | iv(12) | tag(16) | ciphertext
 * Anahtar yalnızca SecretStore'da (`backupAesKey`) tutulur; yedek dosyası
 * düz metin görev/audit içermez.
 *
 * Bu modül Electron'a bağımlı değildir; hem script'ler hem utilityProcess
 * hem de birim testleri tarafından kullanılır.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const MAGIC = Buffer.from('PPBK1', 'utf8');
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function logRestoreRollbackError(dbPath, err) {
    try {
        // eslint-disable-next-line no-console
        console.error(`[Backup] Geri yükleme rollback başarısız (${dbPath}):`, err && err.message);
    } catch (_) { /* yut */ }
}

function normalizeKey(key) {
    if (Buffer.isBuffer(key)) {
        if (key.length === 32) return key;
        if (key.length === 64 && /^[0-9a-fA-F]+$/.test(key.toString('utf8'))) {
            return Buffer.from(key.toString('utf8'), 'hex');
        }
        return key;
    }
    if (typeof key !== 'string') throw Object.assign(new Error('Yedek anahtarı gerekli.'), { code: 'BACKUP_KEY_MISSING' });
    const s = key.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 32) return buf;
    const raw = Buffer.from(s, 'utf8');
    if (raw.length === 32) return raw;
    throw Object.assign(new Error('Yedek anahtarı 32 bayt olmalı (hex/base64/raw).'), { code: 'BACKUP_KEY_INVALID' });
}

function vacuumInto(dbPath, targetPath) {
    if (!fs.existsSync(dbPath)) throw Object.assign(new Error(`Veritabanı yok: ${dbPath}`), { code: 'DB_NOT_FOUND' });
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    try { fs.rmSync(targetPath, { force: true }); } catch (_) { /* yut */ }
    const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
    try {
        db.pragma('busy_timeout = 5000');
        const escaped = targetPath.replace(/'/g, "''");
        db.exec(`VACUUM INTO '${escaped}'`);
    } finally {
        try { db.close(); } catch (_) { /* yut */ }
    }
    return { path: targetPath, bytes: fs.statSync(targetPath).size, sha256: sha256File(targetPath) };
}

function encryptFile(sourcePath, targetPath, key) {
    const keyBuf = normalizeKey(key);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
    const plain = fs.readFileSync(sourcePath);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, tag, ciphertext]);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, out, { mode: 0o600 });
    fs.renameSync(tmp, targetPath);
    return { path: targetPath, bytes: out.length, sha256: sha256File(targetPath) };
}

function decryptFile(sourcePath, targetPath, key) {
    const keyBuf = normalizeKey(key);
    const buf = fs.readFileSync(sourcePath);
    if (buf.length < MAGIC.length + 1 + IV_BYTES + TAG_BYTES) {
        throw Object.assign(new Error('Yedek dosyası çok kısa.'), { code: 'BACKUP_CORRUPT' });
    }
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw Object.assign(new Error('Yedek biçimi tanınmadı.'), { code: 'BACKUP_BAD_FORMAT' });
    }
    if (buf[MAGIC.length] !== VERSION) {
        throw Object.assign(new Error(`Desteklenmeyen yedek sürümü: ${buf[MAGIC.length]}`), { code: 'BACKUP_BAD_VERSION' });
    }
    const ivStart = MAGIC.length + 1;
    const tagStart = ivStart + IV_BYTES;
    const dataStart = tagStart + TAG_BYTES;
    const iv = buf.subarray(ivStart, tagStart);
    const tag = buf.subarray(tagStart, dataStart);
    const ciphertext = buf.subarray(dataStart);
    let plain;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
        decipher.setAuthTag(tag);
        plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
        throw Object.assign(new Error('Yedek çözülemedi (yanlış anahtar veya bozuk dosya).'), {
            code: 'BACKUP_DECRYPT_FAILED',
            cause: err
        });
    }
    if (plain.subarray(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
        throw Object.assign(new Error('Yedek içeriği SQLite değil.'), { code: 'BACKUP_NOT_SQLITE' });
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, plain, { mode: 0o600 });
    return { path: targetPath, bytes: plain.length, sha256: crypto.createHash('sha256').update(plain).digest('hex') };
}

function quickCheck(dbPath) {
    const db = new Database(dbPath, { fileMustExist: true, timeout: 5000 });
    try {
        return db.pragma('quick_check', { simple: true });
    } finally {
        try { db.close(); } catch (_) { /* yut */ }
    }
}

/**
 * `backups/` içindeki `<prefix>_*.db.enc` yedeklerinden en yeni `keep`
 * tanesini bırakır (yaş: `keepDays` gün).
 */
function pruneBackups(dir, { prefix = 'powerpilot', keep = 7, keepDays = 7, nowMs = Date.now() } = {}) {
    if (!fs.existsSync(dir)) return [];
    const cutoff = nowMs - keepDays * 86400000;
    const entries = fs.readdirSync(dir)
        .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith('.db.enc'))
        .map((name) => {
            const full = path.join(dir, name);
            let mtime = nowMs;
            try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* yut */ }
            return { name, full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
    const removed = [];
    entries.forEach((entry, index) => {
        if (index < keep && entry.mtime >= cutoff) return;
        try {
            fs.rmSync(entry.full, { force: true });
            removed.push(entry.name);
        } catch (_) { /* yut */ }
    });
    return removed;
}

/**
 * Tek çağrıda: VACUUM INTO → AES-256-GCM → eski yedekleri temizle.
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {string} opts.backupDir
 * @param {string|Buffer} opts.key
 * @param {string} [opts.prefix]
 * @param {number} [opts.keep]
 * @param {number} [opts.keepDays]
 */
function backupDatabase({ dbPath, backupDir, key, prefix = 'powerpilot', keep = 7, keepDays = 7, nowMs = Date.now() }) {
    if (!key) throw Object.assign(new Error('Yedek anahtarı gerekli.'), { code: 'BACKUP_KEY_MISSING' });
    const stamp = timestamp();
    const rawPath = path.join(backupDir, `.${prefix}_${stamp}.db.tmp`);
    try {
        const vacuum = vacuumInto(dbPath, rawPath);
        const check = quickCheck(rawPath);
        if (check !== 'ok') {
            throw Object.assign(new Error(`Yedek quick_check başarısız: ${check}`), { code: 'BACKUP_DB_CORRUPT' });
        }
        const encPath = path.join(backupDir, `${prefix}_${stamp}.db.enc`);
        const enc = encryptFile(rawPath, encPath, key);
        return {
            path: encPath,
            rawBytes: vacuum.bytes,
            encBytes: enc.bytes,
            sha256: enc.sha256,
            quickCheck: check,
            pruned: pruneBackups(backupDir, { prefix, keep, keepDays, nowMs })
        };
    } finally {
        try { fs.rmSync(rawPath, { force: true }); } catch (_) { /* yut */ }
    }
}

/**
 * Yedeği geçici dosyaya açar, quick_check doğrular, mevcut DB'yi karantinaya
 * alıp yeni dosyayı yerine koyar. Hata durumunda mevcut DB'ye dokunmaz.
 */
function restoreDatabase({ inputPath, dbPath, key, quarantineDir = null }) {
    if (!key) throw Object.assign(new Error('Yedek anahtarı gerekli.'), { code: 'BACKUP_KEY_MISSING' });
    const tmp = `${dbPath}.restoring-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let quarantined = null;
    let installed = false;
    try {
        decryptFile(inputPath, tmp, key);
        const check = quickCheck(tmp);
        if (check !== 'ok') {
            throw Object.assign(new Error(`Geri yükleme quick_check başarısız: ${check}`), { code: 'RESTORE_DB_CORRUPT' });
        }
        const qDir = quarantineDir || path.join(path.dirname(dbPath), 'quarantine');
        fs.mkdirSync(qDir, { recursive: true });
        if (fs.existsSync(dbPath)) {
            quarantined = path.join(qDir, `powerpilot_${timestamp()}.db`);
            fs.renameSync(dbPath, quarantined);
        }
        for (const suffix of ['-wal', '-shm']) {
            try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch (_) { /* yut */ }
        }
        fs.renameSync(tmp, dbPath);
        installed = true;
        // Y-09: yerine konan dosya da doğrulanır; bozuksa eski DB geri gelir.
        const installedCheck = quickCheck(dbPath);
        if (installedCheck !== 'ok') {
            throw Object.assign(
                new Error(`Geri yükleme sonrası quick_check başarısız: ${installedCheck}`),
                { code: 'RESTORE_DB_CORRUPT' }
            );
        }
        return { ok: true, dbPath, quarantined, quickCheck: check };
    } catch (err) {
        // Y-09: yarıda kalan geri yükleme mevcut veriyi kaybetmez.
        if (installed) {
            try { fs.rmSync(dbPath, { force: true }); } catch (_) { /* yut */ }
        }
        if (quarantined) {
            try { fs.renameSync(quarantined, dbPath); } catch (rollbackErr) {
                logRestoreRollbackError(dbPath, rollbackErr);
            }
        }
        throw err;
    } finally {
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* yut */ }
    }
}

module.exports = {
    MAGIC,
    VERSION,
    normalizeKey,
    sha256File,
    vacuumInto,
    encryptFile,
    decryptFile,
    quickCheck,
    pruneBackups,
    backupDatabase,
    restoreDatabase
};
