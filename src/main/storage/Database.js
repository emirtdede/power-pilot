/**
 * Database.js - WP-11.T1
 * better-sqlite3 sarmalayıcısı: PRAGMA'lar, IMMEDIATE yazma transaction'ları,
 * quick_check, hata sınıfları ve güvenli kapatma.
 *
 * Tek süreç kuralı: aynı DB dosyasına iki Power Pilot süreci bağlanmaz
 * (requestSingleInstanceLock + storage.lock). WAL yine de çoklu okuyucuya izin verir.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

class StorageError extends Error {
    constructor(message, code, cause = null) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

function applyPragmas(db) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('wal_autocheckpoint = 1000');
    db.pragma('temp_store = MEMORY');
    // Silinen satırların eski sürümleri dosyada kalmaz (sır migrasyonu).
    db.pragma('secure_delete = ON');
}

class Db {
    constructor(filePath, { readonly = false, fileMustExist = false } = {}) {
        if (typeof filePath !== 'string' || filePath.length === 0) {
            throw new StorageError('Veritabanı yolu gerekli.', 'INVALID_DB_PATH');
        }
        this.filePath = path.resolve(filePath);
        try {
            this.raw = new Database(this.filePath, { readonly, fileMustExist, timeout: 5000 });
            applyPragmas(this.raw);
        } catch (err) {
            // PRAGMA sırasında hata (bozuk dosya vb.) açık tanıtıcıyı sızdırmamalı;
            // aksi halde Windows'ta dosya kilitli kalır ve temizlik/geri yükleme
            // EPERM ile başarısız olur.
            if (this.raw) {
                try { this.raw.close(); } catch (_) { /* yut */ }
                this.raw = null;
            }
            throw new StorageError(`Veritabanı açılamadı: ${err.message}`, 'DB_OPEN_FAILED', err);
        }
        this.closed = false;
    }

    static schemaSql() {
        return fs.readFileSync(SCHEMA_PATH, 'utf8');
    }

    /** Şema/toplu SQL çalıştırır. Kabuk exec ile karışmaması için `sql()` adı. */
    sql(sqlText) {
        return this.raw.exec(sqlText);
    }

    prepare(sql) {
        return this.raw.prepare(sql);
    }

    /** Atomik yazma: BEGIN IMMEDIATE … COMMIT. Hata → ROLLBACK. */
    write(fn) {
        const tx = this.raw.transaction(fn);
        try {
            return tx.immediate();
        } catch (err) {
            throw new StorageError(`Yazma işlemi başarısız: ${err.message}`, 'DB_WRITE_FAILED', err);
        }
    }

    quickCheck() {
        try {
            return this.raw.pragma('quick_check', { simple: true });
        } catch (err) {
            return `error: ${err.message}`;
        }
    }

    integrityCheck() {
        try {
            return this.raw.pragma('integrity_check', { simple: true });
        } catch (err) {
            return `error: ${err.message}`;
        }
    }

    /**
     * WAL'ı ana dosyaya taşır ve sıfırlar. Sır temizliği sonrası eski
     * çerçevelerin diskte kalmaması için kullanılır (WP-04 T-SEC-01).
     */
    checkpoint(mode = 'TRUNCATE') {
        try {
            return this.raw.pragma(`wal_checkpoint(${mode})`);
        } catch (err) {
            return null;
        }
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try { this.raw.close(); } catch (_) { /* yut */ }
    }

    /**
     * Dosya kilidi: aynı userData dizinine iki süreç bağlanmasın.
     * O-09: `existsSync` + `writeFileSync` yarışı yerine `wx` ile atomik
     * oluşturma; ölü PID'in kilidi tombstone'a rename edilerek CAS yapılır.
     */
    static acquireLock(dir, pid = process.pid) {
        const lockPath = path.join(dir, 'storage.lock');
        const token = crypto.randomBytes(8).toString('hex');
        const payload = JSON.stringify({ pid, token, startedAt: new Date().toISOString() });
        const release = (ownedToken) => () => {
            try {
                const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                if (current && current.pid === pid && (!ownedToken || current.token === ownedToken)) {
                    fs.unlinkSync(lockPath);
                }
            } catch (_) { /* kilit zaten yok/başkasına ait */ }
        };

        const tryCreate = () => {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            try {
                fs.writeSync(fd, payload, null, 'utf8');
            } finally {
                fs.closeSync(fd);
            }
        };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                tryCreate();
                return release(token);
            } catch (err) {
                if (err && err.code !== 'EEXIST') {
                    throw new StorageError(`Kilit alınamadı: ${err.message}`, 'STORAGE_LOCK_FAILED', err);
                }
            }

            let existing = null;
            try {
                existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            } catch (err) {
                if (err && err.code === 'ENOENT') continue; // yarış: yeniden dene
                // Bozuk kilit dosyası da devralınabilir (aşağıdaki rename).
                existing = null;
            }

            if (existing && Number.isInteger(existing.pid)) {
                if (existing.pid === pid) {
                    // Aynı süreçte ikinci acquire: mevcut kilidi paylaş.
                    return release(existing.token || null);
                }
                let alive = false;
                try {
                    process.kill(existing.pid, 0);
                    alive = true;
                } catch (err) {
                    // EPERM: süreç var ama sinyal izni yok → canlı say.
                    alive = !!(err && err.code === 'EPERM');
                }
                if (alive) {
                    throw new StorageError(
                        `Veri dizini başka bir süreç tarafından kullanılıyor (PID ${existing.pid}).`,
                        'STORAGE_LOCKED'
                    );
                }
            }

            // Ölü/bozuk kilit: atomik rename ile devral. İki süreç aynı anda
            // rename ederse yalnızca biri başarılı olur; diğeri yeniden dener.
            const tombstone = `${lockPath}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            try {
                fs.renameSync(lockPath, tombstone);
            } catch (err) {
                if (err && err.code === 'ENOENT') continue;
                throw new StorageError(`Kilit devralınamadı: ${err.message}`, 'STORAGE_LOCK_FAILED', err);
            }
            try { fs.unlinkSync(tombstone); } catch (_) { /* yut */ }
        }
        throw new StorageError('Veri dizini kilidi alınamadı (eşzamanlı erişim).', 'STORAGE_LOCKED');
    }
}

function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

module.exports = { Db, StorageError, applyPragmas, sha256, SCHEMA_PATH };
