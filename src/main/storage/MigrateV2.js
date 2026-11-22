/**
 * MigrateV2.js - WP-11.T4
 * v2 JSON deposunu (`powerpilot_data.json`) v3 SQLite deposuna atomik taşır.
 *
 * Güvenlik sırası:
 *   1. Ham JSON yedeği + SHA-256 (yedek olmadan migrasyon başlamaz)
 *   2. Parse hatası → bakım modu; kaynak dosya ASLA üzerine yazılmaz
 *   3. Ayrı geçici DB + tek transaction
 *   4. Koleksiyon sayımı + içerik checksum doğrulaması
 *   5. quick_check = ok
 *   6. Geçici DB'yi hedefe rename; eski JSON'u `.migrated` yap
 *
 * Yarıda kalan migrasyonda geçici DB açılışta silinir; JSON korunur ve
 * ikinci deneme başarılı olur.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Db, StorageError, sha256 } = require('./Database');
// Tek kaynak: src/main/util/stableStringify.js (ConsoleStore + MigrateV2 ortak).
const { stableStringify } = require('../util/stableStringify');

const LEGACY_FILE = 'powerpilot_data.json';
const MIGRATION_MARK = '.migrated';
const MIGRATION_VERSION = 3;

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function fileSha256(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function contentChecksum(value) {
    // Deterministik anahtar sıralı JSON - doğrulama için yeterli.
    return sha256(stableStringify(value));
}

/**
 * WP-04.T2 / T-SEC-01: `.migrated` kopyasında düz metin sır bırakılmaz.
 * Rollback için tüm iş verisi kalır; sırlar SecretStore'da yeniden
 * provisioning edilir (DPAPI başka kullanıcıda çözülemez).
 */
function sanitizeLegacyData(data) {
    if (!data || typeof data !== 'object') return data;
    const copy = JSON.parse(JSON.stringify(data));
    const SECRET_SETTINGS = [
        'consoleAgentKey',
        'localApiKeyPem',
        'localApiPfxPassphrase',
        'consoleClientKeyPem',
        'consoleClientPfxPassphrase'
    ];
    const WEBHOOK_SECRETS = ['bearerToken', 'basicAuthPass', 'hmacSecret'];
    if (copy.settings && typeof copy.settings === 'object') {
        for (const field of SECRET_SETTINGS) {
            if (Object.prototype.hasOwnProperty.call(copy.settings, field)) copy.settings[field] = null;
        }
    }
    for (const hook of Array.isArray(copy.webhooks) ? copy.webhooks : []) {
        if (!hook || typeof hook !== 'object') continue;
        for (const field of WEBHOOK_SECRETS) delete hook[field];
    }
    return copy;
}

function expectedCounts(data) {
    const arr = (v) => (Array.isArray(v) ? v.length : 0);
    const bootKeys = new Set();
    for (const iso of Array.isArray(data && data.bootHistory) ? data.bootHistory : []) {
        const ms = new Date(iso).getTime();
        if (Number.isFinite(ms)) bootKeys.add(Math.floor(ms / 60000));
    }
    return {
        tasks: (Array.isArray(data && data.tasks) ? data.tasks : []).filter((t) => t && t.id).length,
        history: Math.min(500, arr(data && data.history)),
        templates: arr(data && data.templates),
        webhooks: arr(data && data.webhooks),
        exemptions: arr(data && data.exemptions),
        maintenanceWindows: arr(data && data.maintenanceWindows),
        deviceProfiles: arr(data && data.deviceProfiles),
        orders: arr(data && data.orders),
        auditLog: arr(data && data.auditLog),
        bootHistory: bootKeys.size
    };
}

/** Açılışta yarım kalmış geçici DB artıklarını temizler. */
function cleanStaleTemps(dbPath) {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    let removed = 0;
    try {
        for (const entry of fs.readdirSync(dir)) {
            if (entry.startsWith(`${base}.migrating-`) || entry.startsWith(`.${base}.migrating-`)) {
                try {
                    fs.rmSync(path.join(dir, entry), { force: true });
                    removed += 1;
                } catch (_) { /* yut */ }
            }
        }
    } catch (_) { /* dizin yoksa yok */ }
    return removed;
}

/**
 * Y-10: Hedef DB zaten varsa içeriği doğrulanmadan geçici kopya silinmez ve
 * kaynak JSON `.migrated` işaretlenmez. Aksi halde yarım/eski bir DB yüzünden
 * tek kopya veri sessizce kaybolur.
 * @returns {{ok:boolean, code?:string, detail?:string}}
 */
function validateMigratedTarget(target, { sourceSha, checksum }) {
    let db = null;
    try {
        db = new Db(target);
        const check = db.quickCheck();
        if (check !== 'ok') {
            return { ok: false, code: 'MIGRATION_TARGET_CORRUPT', detail: `Hedef DB bozuk: ${check}` };
        }
        const row = (key) => {
            const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
            return r ? r.value : null;
        };
        if (row('schema_version') !== String(MIGRATION_VERSION)) {
            return { ok: false, code: 'MIGRATION_TARGET_SCHEMA', detail: 'Hedef DB şema sürümü uyuşmuyor.' };
        }
        if (row('source_sha256') !== sourceSha) {
            return { ok: false, code: 'MIGRATION_TARGET_SOURCE', detail: 'Hedef DB farklı bir kaynaktan üretilmiş.' };
        }
        if (row('content_checksum') !== checksum) {
            return { ok: false, code: 'MIGRATION_TARGET_CHECKSUM', detail: 'Hedef DB içerik checksum doğrulaması başarısız.' };
        }
        const migration = db.prepare('SELECT detail FROM migrations WHERE id = ?').get('v2-json-to-v3');
        if (!migration) {
            return { ok: false, code: 'MIGRATION_TARGET_INCOMPLETE', detail: 'Hedef DB migrasyon kaydı eksik.' };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, code: 'MIGRATION_TARGET_UNREADABLE', detail: (err && err.message) || 'Hedef DB açılamadı.' };
    } finally {
        if (db) {
            try { db.close(); } catch (_) { /* yut */ }
        }
    }
}

/**
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {string} [opts.jsonPath]
 * @param {string} [opts.dbPath]
 * @param {Function} opts.writeAll (db, data) => void - tek transaction içinde tüm satırları yazar
 * @param {Function} [opts.normalize] (data) => data - StorageService normalizasyonu
 * @returns {{status:string, counts?:object, sha256?:string, backupPath?:string, error?:string}}
 */
function migrateV2({ userDataPath, jsonPath = null, dbPath = null, writeAll, normalize = null } = {}) {
    if (typeof writeAll !== 'function') {
        throw new StorageError('Migrasyon yazıcısı gerekli.', 'INVALID_MIGRATION_WRITER');
    }
    const source = jsonPath || path.join(userDataPath, LEGACY_FILE);
    const target = dbPath || path.join(userDataPath, 'powerpilot.db');
    const backupDir = path.join(userDataPath, 'backups');
    cleanStaleTemps(target);

    if (!fs.existsSync(source)) return { status: 'no-source' };

    let raw;
    try {
        raw = fs.readFileSync(source, 'utf8');
    } catch (err) {
        return { status: 'maintenance', error: `Kaynak okunamadı: ${err.message}` };
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('kök nesne değil');
        }
    } catch (err) {
        // T-STO-03: bozuk JSON üzerine yazılmaz. Yedek alınır, bakım modu.
        let backupPath = null;
        try {
            fs.mkdirSync(backupDir, { recursive: true });
            backupPath = path.join(backupDir, `powerpilot_data_corrupted_${timestamp()}.json`);
            fs.copyFileSync(source, backupPath);
        } catch (_) { /* yedek alınamasa da üzerine yazma yok */ }
        return { status: 'maintenance', error: `JSON parse hatası: ${err.message}`, backupPath };
    }

    // 1) Zorunlu yedek + checksum.
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = timestamp();
    const backupPath = path.join(backupDir, `powerpilot_data_pre_v3_${stamp}.json`);
    fs.copyFileSync(source, backupPath);
    const sourceSha = fileSha256(source);

    const data = normalize ? normalize(parsed) : parsed;
    const counts = expectedCounts(data);

    // 2) Geçici DB + tek transaction.
    const tmpPath = `${target}.migrating-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    let tmpDb = null;
    try {
        try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* yok */ }
        tmpDb = new Db(tmpPath);
        tmpDb.sql(Db.schemaSql());
        tmpDb.write(() => {
            writeAll(tmpDb, data);
            tmpDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(MIGRATION_VERSION));
            tmpDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('migrated_from', 'json-v2');
            tmpDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('source_sha256', sourceSha);
            tmpDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('content_checksum', contentChecksum(data));
            tmpDb.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('migrated_at', new Date().toISOString());
            tmpDb.prepare('INSERT OR REPLACE INTO migrations(id, applied_at, detail) VALUES (?, ?, ?)')
                .run('v2-json-to-v3', new Date().toISOString(), JSON.stringify({ counts, sha256: sourceSha }));
        });

        // 3) Sayım + checksum doğrulaması.
        const actual = {
            tasks: tmpDb.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
            history: tmpDb.prepare('SELECT COUNT(*) AS n FROM history').get().n,
            templates: tmpDb.prepare('SELECT COUNT(*) AS n FROM templates').get().n,
            webhooks: tmpDb.prepare('SELECT COUNT(*) AS n FROM webhooks').get().n,
            exemptions: tmpDb.prepare('SELECT COUNT(*) AS n FROM exemptions').get().n,
            maintenanceWindows: tmpDb.prepare('SELECT COUNT(*) AS n FROM maintenance_windows').get().n,
            deviceProfiles: tmpDb.prepare('SELECT COUNT(*) AS n FROM device_profiles').get().n,
            orders: tmpDb.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
            auditLog: tmpDb.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,
            bootHistory: tmpDb.prepare('SELECT COUNT(*) AS n FROM boot_history').get().n
        };
        for (const key of Object.keys(counts)) {
            if (actual[key] !== counts[key]) {
                throw new StorageError(
                    `Migrasyon sayım uyuşmazlığı (${key}: beklenen ${counts[key]}, yazılan ${actual[key]}).`,
                    'MIGRATION_COUNT_MISMATCH'
                );
            }
        }
        const storedChecksum = tmpDb.prepare('SELECT value FROM meta WHERE key = ?').get('content_checksum');
        if (!storedChecksum || storedChecksum.value !== contentChecksum(data)) {
            throw new StorageError('Migrasyon içerik checksum doğrulaması başarısız.', 'MIGRATION_CHECKSUM_MISMATCH');
        }
        if (tmpDb.quickCheck() !== 'ok') {
            throw new StorageError('Migrasyon sonrası quick_check başarısız.', 'MIGRATION_DB_CORRUPT');
        }
        tmpDb.close();
        tmpDb = null;

        // 4) Hedef yoksa rename. Varsa (yarım kalmış/önceki deneme) yalnızca
        // bu kaynağa ait ve sağlam olduğu doğrulandıktan sonra korunur.
        if (fs.existsSync(target)) {
            const targetCheck = validateMigratedTarget(target, {
                sourceSha,
                checksum: contentChecksum(data)
            });
            if (!targetCheck.ok) {
                try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* yut */ }
                return {
                    status: 'maintenance',
                    code: targetCheck.code,
                    error: targetCheck.detail,
                    backupPath,
                    sha256: sourceSha
                };
            }
            try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* yut */ }
        } else {
            fs.renameSync(tmpPath, target);
        }
        // `.migrated` kopyası sırsız yazılır; kaynak dosya kaldırılır.
        try {
            const migratedPath = `${source}${MIGRATION_MARK}`;
            const sanitized = sanitizeLegacyData(parsed);
            fs.writeFileSync(migratedPath, JSON.stringify(sanitized, null, 2), { encoding: 'utf8', mode: 0o600 });
            fs.unlinkSync(source);
        } catch (_) { /* kilit: DB kullanılabilir; sonraki açılışta tamamlanır */ }

        return { status: 'migrated', counts, sha256: sourceSha, backupPath };
    } catch (err) {
        if (tmpDb) {
            try { tmpDb.close(); } catch (_) { /* yut */ }
        }
        try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* yut */ }
        return { status: 'maintenance', error: (err && err.message) || 'Migrasyon başarısız.', backupPath, sha256: sourceSha };
    }
}

module.exports = {
    migrateV2,
    cleanStaleTemps,
    stableStringify,
    contentChecksum,
    expectedCounts,
    sanitizeLegacyData,
    LEGACY_FILE,
    MIGRATION_MARK
};
