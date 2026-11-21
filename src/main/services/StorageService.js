/**
 * StorageService.js — WP-11.T3/T5/T6/T7/T9
 * Uygulama deposu v3: SQLite (`powerpilot.db`) tek gerçek kaynak; `this.data`
 * yalnızca API uyumluluğu için hidratlanmış bellek görünümüdür.
 *
 * - Yazmalar BEGIN IMMEDIATE transaction'ı içinde, yalnızca DEĞİŞEN satırlar.
 * - v2 JSON açılışta atomik migrate edilir (MigrateV2); bozuk JSON'da bakım
 *   modu — kaynak dosya üzerine ASLA yazılmaz.
 * - Audit log HMAC-SHA256 zinciri + günlük checkpoint (WP-11.T7).
 * - Boot kayıtları dakika anahtarıyla tekilleştirilir, 365 gün saklanır.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const log = require('../logger');
const ipaddr = require('ipaddr.js');
const { Db, StorageError } = require('../storage/Database');
const { migrateV2, cleanStaleTemps, sanitizeLegacyData, LEGACY_FILE } = require('../storage/MigrateV2');
const { AuditCheckpoint } = require('../security/AuditCheckpoint');
const StorageRecovery = require('./StorageRecovery');

const CURRENT_SCHEMA_VERSION = 3;
const DB_FILE = 'powerpilot.db';
const MAX_HISTORY = 500;
const MAX_BOOT_DAYS = 365;

let canonicalizeFn = null;
try {
    // eslint-disable-next-line global-require
    const mod = require('canonicalize');
    canonicalizeFn = typeof mod === 'function' ? mod : mod.default;
} catch (_) {
    canonicalizeFn = null;
}

function nowIso() {
    return new Date().toISOString();
}

function bootKeyOf(iso) {
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 60000);
}

function hmac(key, text) {
    return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function auditCanonical(rec) {
    if (typeof canonicalizeFn !== 'function') {
        throw Object.assign(new Error('Kanonikleştirici yüklenemedi; audit yazılmadı.'), { code: 'CANONICALIZER_NOT_READY' });
    }
    return canonicalizeFn({
        seq: rec.seq,
        ts: rec.ts,
        actor: rec.actor,
        action: rec.action,
        target: rec.target,
        detail: rec.detail,
        prev_hmac: rec.prev_hmac
    });
}

function auditRecordHmac(key, rec) {
    return hmac(key, auditCanonical(rec));
}

function legacyAuditHash(rec) {
    const slim = { seq: rec.seq, ts: rec.ts, actor: rec.actor, action: rec.action, target: rec.target, detail: rec.detail, prevHash: rec.prevHash };
    return crypto.createHash('sha256').update(JSON.stringify(slim), 'utf8').digest('hex');
}

class StorageService {
    // userDataPathOverride: yalnızca test izolasyonu için (üretimde verilmez,
    // app.getPath('userData') kullanılır). Açık DI — sessiz fallback yok.
    constructor(userDataPathOverride = null) {
        this.userDataPath = userDataPathOverride || app.getPath('userData');
        this.dbPath = path.join(this.userDataPath, DB_FILE);
        this.legacyPath = path.join(this.userDataPath, LEGACY_FILE);
        // Geriye uyum: eski kod dataPath'i yedek/tanılama için okur.
        this.dataPath = this.legacyPath;
        this.backupDir = path.join(this.userDataPath, 'backups');
        this.data = this.getDefaultData();
        this.secretStore = null;
        this.db = null;
        this.maintenanceMode = false;
        this.maintenanceReason = null;
        // Bozuk DB karantinaya alınıp temiz depoyla devam edildiyse dolu olur.
        this.recoveredFrom = null;
        this.auditTampered = false;
        this.auditHmacKey = null;
        this._stmts = new Map();
        this._snapshots = {};
        this.auditCheckpoint = null;

        this.init();
    }

    setSecretStore(secretStore) {
        this.secretStore = secretStore || null;
    }

    getDefaultData() {
        return {
            version: CURRENT_SCHEMA_VERSION,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            tasks: [],
            history: [],
            settings: {
                autostart: false,
                theme: 'dark',
                themeId: 'obsidian',
                appIcon: 'monochrome-dark',
                sidebarCollapsed: false,
                notifications: true,
                language: null, // null = kullanıcı seçmedi → ilk çalıştırmada sistem dili
                localApiEnabled: false,
                localApiPort: 18456,
                localApiKeyHash: null,
                localApiKeyMasked: null,
                localApiKeyCreatedAt: null,
                localApiKeyRole: 'admin',
                localApiTlsEnabled: false,
                localApiTlsStrict: false,
                localApiRequireClientCert: false,
                localApiCertPem: null,
                localApiKeyPem: null,
                localApiCaPem: null,
                localApiCertFile: null,
                localApiKeyFile: null,
                localApiCaFile: null,
                localApiPfxFile: null,
                localApiClientFingerprints: [],
                agentDisabled: false,
                consolePublicKeyPem: null,
                agentId: null,
                consoleUrl: null,
                consoleAgentKey: null,
                // P1-6: ajan→konsol mTLS materyali. `TlsConfig.buildClientOptions`
                // bu alanları okuyordu ama hiçbiri depoda yoktu; konsol istemci
                // sertifikası istediğinde ajan hiçbir zaman sunamıyordu.
                consoleClientCertPem: null,
                consoleClientCertFile: null,
                consoleClientKeyPem: null,
                consoleClientKeyFile: null,
                consoleClientPfxFile: null,
                consoleClientCaFile: null,
                consoleClientCaPem: null,
                deviceRole: 'workstation',
                upsEnabled: false,
                upsHost: '127.0.0.1',
                upsName: 'ups',
                // P1-9: UPS düşük-batarya eylemi. Varsayılan KAPALI; açıksa
                // `LB` görüldüğünde geri sayım sonrası seçilen güç eylemi uygulanır.
                upsAutoActionEnabled: false,
                upsAutoAction: 'hibernate',
                upsCountdownSeconds: 30,
                assumedOffHours: null,
                lanModeEnabled: false,
                lanAllowedIps: [],
                blockRemoteShutdownWhenActive: true,
                lanModeWarning: null,
                statsEnabled: true,
                deviceWattage: null,
                wattSource: 'unset',
                wattMeasuredAt: null,
                electricityCostPerKwh: null,
                priceSource: 'unset',
                priceEffectiveFrom: null,
                currency: 'TL',
                automationPaused: false,
                autonomyMode: 'classic',
                cancelPinHash: null,
                cancelPinSalt: null,
                bootGuardSeconds: 120,
                maintenanceWindowWarning: null,
                // WP-9: Tüm arayüz ayarları için kalıcı varsayılanlar
                closeToTray: true,
                startMinimized: false,
                autoMiniWidget: true,
                defaultAction: 'shutdown',
                defaultMinutes: 30,
                clockFormat: '24h',
                soundMode: 'auto',
                uiDensity: 'comfortable',
                toastPosition: 'bottom-right',
                desktopNotifyStart: true,
                desktopNotifyWarn: true,
                desktopNotifySkip: true,
                prewarnSeconds: 30,
                quietHoursEnabled: false,
                quietStart: '22:00',
                quietEnd: '08:00',
                fallbackAction: 'none',
                graceSeconds: 15,
                protectFullscreen: true,
                protectActiveIo: true,
                // P1-6: artık gerçekten uygulanan güvenlik/UX ayarları.
                forceCloseApps: false,
                remoteApprovalRequired: false,
                // P0-3: Kullanıcı düzenleyebilir korunan uygulama listesi (null = kod
                // içindeki güvenli varsayılan kullanılır). .exe adları, en fazla 50.
                protectedApps: null,
                pinLengthMode: 'flex',
                autoBackupEnabled: true,
                wakeMode: 'run',
                wakeToleranceMinutes: 10,
                shortcuts: {
                    theme: 'Ctrl+T',
                    quickstart: 'Ctrl+Enter',
                    cancel: 'Escape',
                    settings: 'Ctrl+,',
                    docs: 'F1'
                },
                templateOverrides: {},
                hiddenBuiltInTemplates: []
            },
            webhooks: [],
            deviceProfiles: [],
            templates: [],
            exemptions: [],
            maintenanceWindows: [],
            orders: [],
            auditLog: [],
            inventory: null,
            bootHistory: [],
            seenNonces: []
        };
    }

    // --- açılış / migrasyon ------------------------------------------------

    init() {
        try {
            fs.mkdirSync(this.backupDir, { recursive: true });
            this.cleanStaleTmps();
            cleanStaleTemps(this.dbPath);

            if (fs.existsSync(this.dbPath)) {
                this.openExisting();
                return;
            }

            if (fs.existsSync(this.legacyPath)) {
                this.migrateLegacy();
                return;
            }

            this.openFresh();
        } catch (err) {
            this.enterMaintenance(`Açılış hatası: ${(err && err.message) || 'bilinmeyen'}`, err);
        }
    }

    openFresh() {
        this.db = new Db(this.dbPath);
        this.db.sql(Db.schemaSql());
        this.data = this.getDefaultData();
        this.db.write(() => {
            this._writeAll(this.db, this.data);
        });
        this._primeSnapshots();
    }

    openExisting() {
        // Bozuk dosya `quickCheck`'ten ÖNCE, `new Db` aşamasında da hata
        // verebilir (SQLite başlığı bozuk, yarım yazılmış sayfa...). Bu yol
        // yakalanmazsa `init()` catch'i doğrudan bakım moduna düşürür ve
        // kurtarma hiç denenmez → kullanıcı kalıcı olarak kilitlenir.
        try {
            this.db = new Db(this.dbPath, { fileMustExist: true });
        } catch (err) {
            log.warn(`[StorageService] Veritabanı açılamadı, kurtarma denenecek: ${err && err.message}`);
            this.db = null;
            this.recoverCorruptDatabase(err && err.code ? err.code : 'DB_OPEN_FAILED');
            return;
        }
        const check = this.db.quickCheck();
        if (check !== 'ok') {
            this.db.close();
            this.db = null;
            this.recoverCorruptDatabase(check);
            return;
        }
        this._loadAll();
        // Yarıda kalmış migrasyon: DB yazıldı, eski JSON işaretlenemedi.
        if (fs.existsSync(this.legacyPath)) this._markLegacyMigrated();
        this.normalizeLoaded();
        this._primeSnapshots();
        // Normalizasyon değişikliklerini kalıcılaştır (yalnızca farklar).
        this.save();
    }

    /**
     * Bozuk veritabanından kurtarma.
     *
     * Öncesinde yalnızca bakım moduna düşülüyordu: uygulama açılıyor ama HİÇBİR
     * görev oluşturulamıyor ("Task could not be created") ve kullanıcıya çıkış
     * yolu gösterilmiyordu — son kullanıcı için "program bozuk" demekti.
     *
     * Burada bozuk dosya SİLİNMEZ: `quarantine/` altına taşınır (destek/veri
     * kurtarma umudu korunur) ve temiz bir veritabanıyla devam edilir. Karantina
     * taşıması başarısız olursa sessiz veri kaybı riskine girmemek için bakım
     * moduna düşülür.
     */
    recoverCorruptDatabase(reason) {
        try {
            const result = StorageRecovery.quarantineDatabase(this.dbPath);
            this.recoveredFrom = {
                reason: String(reason || 'quick_check'),
                quarantinePath: result.quarantined,
                at: new Date().toISOString()
            };
            log.warn(`[StorageService] Bozuk veritabanı karantinaya alındı: ${result.quarantined || 'yok'} (${reason})`);
            this.openFresh();
            return true;
        } catch (err) {
            log.error('[StorageService] Karantina başarısız; bakım modu:', err && err.message);
            this.enterMaintenance(
                `Veritabanı bozuk (quick_check: ${reason}) ve karantinaya alınamadı.`,
                err
            );
            return false;
        }
    }

    migrateLegacy() {
        const result = migrateV2({
            userDataPath: this.userDataPath,
            jsonPath: this.legacyPath,
            dbPath: this.dbPath,
            normalize: (parsed) => this.migrate(parsed, parsed && parsed.version ? parsed.version : 0),
            writeAll: (db, data) => this._writeAll(db, data)
        });
        if (result.status === 'migrated') {
            log.info(`[StorageService] v2 JSON → v3 SQLite migrasyonu tamam (${JSON.stringify(result.counts)}).`);
            this.openExisting();
            return;
        }
        if (result.status === 'no-source') {
            this.openFresh();
            return;
        }
        // T-STO-03 SÖZLEŞMESİ (tests/main/storage*.test.mjs): bozuk eski JSON
        // kaynağı ASLA değiştirilmez/taşınmaz. Migrasyon dosyanın üzerine
        // yazmaz ve `backups/powerpilot_data_corrupted_*.json` yedeğini alır.
        // Kullanıcıyı kilitli bırakmamak için bakım modunda "veri klasörünü aç"
        // çıkışı sunulur (arayüz: #btn-storage-open-folder).
        this.enterMaintenance(result.error || 'Migrasyon tamamlanamadı; bakım modu.', null, result.backupPath);
    }

    _markLegacyMigrated() {
        try {
            const target = `${this.legacyPath}.migrated`;
            if (!fs.existsSync(target)) {
                const parsed = JSON.parse(fs.readFileSync(this.legacyPath, 'utf8'));
                fs.writeFileSync(target, JSON.stringify(sanitizeLegacyData(parsed), null, 2), { encoding: 'utf8', mode: 0o600 });
            }
            fs.unlinkSync(this.legacyPath);
        } catch (err) {
            log.warn('[StorageService] Eski JSON işaretlenemedi:', err && err.message);
        }
    }

    enterMaintenance(reason, err = null, backupPath = null) {
        this.maintenanceMode = true;
        this.maintenanceReason = reason;
        this.maintenanceBackupPath = backupPath || null;
        this.data = this.getDefaultData();
        if (err) log.error('[StorageService] Bakım modu:', reason, err);
        else log.error('[StorageService] Bakım modu:', reason);
    }

    /** Bakım modu görünürlüğü için (IPC/UI) salt-okunur erişim. */
    isMaintenanceMode() {
        return this.maintenanceMode === true;
    }

    /** Kullanıcıya gösterilecek teknik olmayan gerekçe (varsa). */
    getMaintenanceReason() {
        if (!this.maintenanceMode) return null;
        return this.maintenanceReason || null;
    }

    _loadAll() {
        const defaults = this.getDefaultData();
        const meta = {};
        for (const row of this.db.prepare('SELECT key, value FROM meta').all()) meta[row.key] = row.value;

        const settings = { ...defaults.settings };
        for (const row of this.db.prepare('SELECT key, json FROM settings').all()) {
            try { settings[row.key] = JSON.parse(row.json); } catch (_) { /* bozuk satır atlanır */ }
        }

        const parseRows = (sql) => {
            const out = [];
            for (const row of this.db.prepare(sql).all()) {
                try { out.push(JSON.parse(row.data)); } catch (_) { /* bozuk satır atlanır */ }
            }
            return out;
        };

        const tasks = parseRows('SELECT data FROM tasks ORDER BY rowid ASC');
        const history = parseRows('SELECT data FROM history ORDER BY timestamp DESC, rowid DESC');
        const templates = parseRows('SELECT data FROM templates ORDER BY rowid ASC');
        const webhooks = parseRows('SELECT data FROM webhooks ORDER BY rowid ASC');
        const exemptions = parseRows('SELECT data FROM exemptions ORDER BY rowid ASC');
        const maintenanceWindows = parseRows('SELECT data FROM maintenance_windows ORDER BY rowid ASC');
        const deviceProfiles = parseRows('SELECT data FROM device_profiles ORDER BY rowid ASC');
        const orders = parseRows('SELECT data FROM orders ORDER BY rowid ASC');
        const bootHistory = this.db.prepare('SELECT boot_at FROM boot_history ORDER BY boot_key ASC').all().map((r) => r.boot_at);
        const seenNonces = this.db.prepare('SELECT nonce, expires_at FROM seen_nonces ORDER BY seen_at ASC').all()
            .map((r) => ({ nonce: r.nonce, exp: r.expires_at }));
        const inventoryRow = this.db.prepare('SELECT data FROM inventory WHERE id = 1').get();
        let inventory = null;
        if (inventoryRow) {
            try { inventory = JSON.parse(inventoryRow.data); } catch (_) { inventory = null; }
        }
        const auditLog = this.db.prepare('SELECT * FROM (SELECT * FROM audit_log ORDER BY seq DESC LIMIT 5000) ORDER BY seq ASC').all().map((r) => ({
            seq: r.seq,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            target: r.target,
            detail: r.detail,
            prevHash: r.prev_hmac,
            hash: r.record_hmac,
            prevHmac: r.prev_hmac,
            recordHmac: r.record_hmac
        }));

        this.data = {
            version: CURRENT_SCHEMA_VERSION,
            createdAt: meta.created_at || defaults.createdAt,
            updatedAt: meta.updated_at || defaults.updatedAt,
            settings,
            tasks,
            history,
            templates,
            webhooks,
            exemptions,
            maintenanceWindows,
            deviceProfiles,
            orders,
            auditLog,
            inventory,
            bootHistory,
            seenNonces
        };
        this._meta = meta;
    }

    normalizeLoaded() {
        this.data.version = CURRENT_SCHEMA_VERSION;
        this.normalizeEnergySettings();
        this.normalizeSecuritySettings();
        this.normalizeMaintenanceWindows();
        if (!Array.isArray(this.data.tasks)) this.data.tasks = [];
        if (!Array.isArray(this.data.history)) this.data.history = [];
        if (!Array.isArray(this.data.orders)) this.data.orders = [];
        if (!Array.isArray(this.data.templates)) this.data.templates = [];
        if (!Array.isArray(this.data.webhooks)) this.data.webhooks = [];
        if (!Array.isArray(this.data.exemptions)) this.data.exemptions = [];
        if (!Array.isArray(this.data.maintenanceWindows)) this.data.maintenanceWindows = [];
        if (!Array.isArray(this.data.deviceProfiles)) this.data.deviceProfiles = [];
        if (!Array.isArray(this.data.bootHistory)) this.data.bootHistory = [];
        if (!Array.isArray(this.data.seenNonces)) this.data.seenNonces = [];
        this.pruneBootHistory();
    }

    /**
     * WP-11.T9: ölü pencereler (start === end) devre dışı bırakılır; sessiz
     * silme yok — kullanıcıya uyarı metni taşınır.
     */
    normalizeMaintenanceWindows() {
        const list = Array.isArray(this.data.maintenanceWindows) ? this.data.maintenanceWindows : [];
        const invalid = list.filter((w) => w && typeof w.start === 'string' && w.start === w.end);
        if (invalid.length > 0) {
            this.data.maintenanceWindows = list.filter((w) => !(w && typeof w.start === 'string' && w.start === w.end));
            const s = this.data.settings;
            s.maintenanceWindowWarning = `${invalid.length} bakım penceresi geçersiz (start === end) olduğu için devre dışı bırakıldı.`;
            log.warn(`[StorageService] ${s.maintenanceWindowWarning}`);
        } else if (this.data.settings && !this.data.settings.maintenanceWindowWarning) {
            this.data.settings.maintenanceWindowWarning = null;
        }
    }

    createBackup(tag = 'auto') {
        try {
            if (fs.existsSync(this.legacyPath)) {
                const timestamp = nowIso().replace(/[:.]/g, '-');
                const backupPath = path.join(this.backupDir, `powerpilot_data_${tag}_${timestamp}.json`);
                fs.copyFileSync(this.legacyPath, backupPath);
                log.info(`[StorageService] Yedek: ${backupPath}`);
                return backupPath;
            }
        } catch (err) {
            log.error('[StorageService] Yedek alınamadı:', err);
        }
        return null;
    }

    /**
     * WP-04.T1: sırlar yalnızca secrets.v1.json'da şifreli durur; DB'ye düz
     * metin yazılmaz (stripForDisk kopyası kullanılır, bellek değişmez).
     */
    save() {
        if (this.maintenanceMode || !this.db) {
            if (this.maintenanceMode) log.warn('[StorageService] Bakım modu: yazma reddedildi.');
            return false;
        }
        try {
            const now = nowIso();
            this.data.updatedAt = now;
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this.db.write(() => {
                this._setMeta('updated_at', now);
                this._setMeta('created_at', this.data.createdAt || now);
                this._flushSettings(payload.settings || {});
                this._flushTasks(payload.tasks || []);
                this._flushHistory(payload.history || []);
                this._flushCollection('templates', payload.templates || []);
                this._flushCollection('webhooks', payload.webhooks || []);
                this._flushCollection('exemptions', payload.exemptions || []);
                this._flushCollection('maintenance_windows', payload.maintenanceWindows || []);
                this._flushCollection('device_profiles', payload.deviceProfiles || []);
                this._flushOrders(payload.orders || []);
                this._flushSeenNonces(payload.seenNonces || []);
                this._flushInventory(payload.inventory || null);
                this._flushBoot(payload.bootHistory || []);
            });
            return true;
        } catch (err) {
            log.error('[StorageService] Yazma hatası:', err);
            return false;
        }
    }

    // --- satır yazımı (yalnızca değişenler) --------------------------------

    _prepare(sql) {
        let stmt = this._stmts.get(sql);
        if (!stmt) {
            stmt = this.db.prepare(sql);
            this._stmts.set(sql, stmt);
        }
        return stmt;
    }

    _setMeta(key, value) {
        this._prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
        if (!this._meta) this._meta = {};
        this._meta[key] = String(value);
    }

    _flushRows(table, list, keyOf, keyCol, upsertSql, rowOf, snapshotKey = table) {
        const prev = this._snapshots[snapshotKey] || new Map();
        const next = new Map();
        list.forEach((item, index) => {
            const key = keyOf(item, index);
            if (key === null || key === undefined) return;
            next.set(String(key), item);
        });
        const del = this._prepare(`DELETE FROM ${table} WHERE ${keyCol} = ?`);
        const upsert = this._prepare(upsertSql);
        let changed = 0;
        for (const key of prev.keys()) {
            if (!next.has(key)) {
                del.run(key);
                changed += 1;
            }
        }
        for (const [key, item] of next) {
            const json = JSON.stringify(item);
            if (prev.get(key) === json) continue;
            upsert.run(...rowOf(key, item, json));
            changed += 1;
        }
        this._snapshots[snapshotKey] = new Map([...next.entries()].map(([k, v]) => [k, JSON.stringify(v)]));
        return changed;
    }

    _flushSettings(settings) {
        const prev = this._snapshots.settings || new Map();
        const next = new Map(Object.entries(settings || {}));
        const now = nowIso();
        const del = this._prepare('DELETE FROM settings WHERE key = ?');
        const upsert = this._prepare('INSERT OR REPLACE INTO settings(key, json, updated_at) VALUES (?, ?, ?)');
        let changed = 0;
        for (const key of prev.keys()) {
            if (!next.has(key)) { del.run(key); changed += 1; }
        }
        for (const [key, value] of next) {
            const json = JSON.stringify(value === undefined ? null : value);
            if (prev.get(key) === json) continue;
            upsert.run(key, json, now);
            changed += 1;
        }
        this._snapshots.settings = new Map([...next.entries()].map(([k, v]) => [k, JSON.stringify(v === undefined ? null : v)]));
        return changed;
    }

    _flushTasks(tasks) {
        return this._flushRows(
            'tasks', tasks,
            (t) => (t && t.id) || null,
            'id',
            `INSERT OR REPLACE INTO tasks(id, status, action, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)`,
            (key, item, json) => [
                key,
                item.status || null,
                item.action || null,
                item.createdAt || null,
                item.updatedAt || nowIso(),
                json
            ]
        );
    }

    _flushHistory(history) {
        // Bellek sözleşmesi: en yeni başta, en fazla 500.
        return this._flushRows(
            'history', history.slice(0, MAX_HISTORY),
            (h, i) => (h && h.id) || `row_${i}`,
            'id',
            `INSERT OR REPLACE INTO history(id, timestamp, result_code, action, data) VALUES (?, ?, ?, ?, ?)`,
            (key, item, json) => [
                key,
                item.timestamp || nowIso(),
                item.resultCode || null,
                item.action || null,
                json
            ]
        );
    }

    _flushCollection(table, list) {
        return this._flushRows(
            table, list,
            (item, i) => (item && item.id) || `${table}_${i}`,
            'row_id',
            `INSERT OR REPLACE INTO ${table}(row_id, id, updated_at, data) VALUES (?, ?, ?, ?)`,
            (key, item, json) => [
                key,
                (item && item.id) || null,
                nowIso(),
                json
            ]
        );
    }

    _flushOrders(orders) {
        return this._flushRows(
            'orders', orders,
            (o, i) => (o && (o.key || (o.order && o.order.nonce))) || `order_${i}`,
            'key',
            `INSERT OR REPLACE INTO orders(key, nonce, state, expires_at, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            (key, item, json) => {
                const nonce = (item && item.order && item.order.nonce) || null;
                const expires = Number.isFinite(item && item.order && item.order.expiresAt) ? item.order.expiresAt : null;
                return [
                    key,
                    nonce,
                    (item && item.status) || 'pending',
                    expires,
                    (item && item.receivedAt) || nowIso(),
                    (item && item.ackedAt) || nowIso(),
                    json
                ];
            }
        );
    }

    _flushSeenNonces(list) {
        const prev = this._snapshots.seenNonces || new Map();
        const next = new Map();
        for (const e of list || []) {
            if (!e || typeof e.nonce !== 'string' || !Number.isFinite(e.exp)) continue;
            next.set(e.nonce, e.exp);
        }
        const del = this._prepare('DELETE FROM seen_nonces WHERE nonce = ?');
        const upsert = this._prepare('INSERT OR REPLACE INTO seen_nonces(nonce, expires_at, seen_at) VALUES (?, ?, ?)');
        let changed = 0;
        for (const nonce of prev.keys()) {
            if (!next.has(nonce)) { del.run(nonce); changed += 1; }
        }
        for (const [nonce, exp] of next) {
            if (prev.get(nonce) === exp) continue;
            upsert.run(nonce, exp, nowIso());
            changed += 1;
        }
        this._snapshots.seenNonces = new Map(next);
        return changed;
    }

    _flushInventory(inventory) {
        const prev = this._snapshots.inventory || null;
        if (!inventory) {
            if (prev !== null) {
                this._prepare('DELETE FROM inventory WHERE id = 1').run();
                this._snapshots.inventory = null;
            }
            return;
        }
        const json = JSON.stringify(inventory);
        if (prev === json) return 0;
        this._prepare('INSERT OR REPLACE INTO inventory(id, data, updated_at) VALUES (1, ?, ?)').run(json, nowIso());
        this._snapshots.inventory = json;
        return 1;
    }

    _flushBoot(bootHistory) {
        this._flushRows(
            'boot_history', (bootHistory || []).map((b) => ({ bootAt: b })),
            (item) => bootKeyOf(item.bootAt),
            'boot_key',
            `INSERT OR REPLACE INTO boot_history(boot_key, boot_at, recorded_at) VALUES (?, ?, ?)`,
            (key, item) => [Number(key), item.bootAt, nowIso()],
            'bootHistory'
        );
    }

    _primeSnapshots() {
        this._snapshots = {
            settings: new Map(Object.entries(this.data.settings || {}).map(([k, v]) => [k, JSON.stringify(v === undefined ? null : v)])),
            tasks: new Map((this.data.tasks || []).filter((t) => t && t.id).map((t) => [String(t.id), JSON.stringify(t)])),
            history: new Map((this.data.history || []).map((h, i) => [String((h && h.id) || `row_${i}`), JSON.stringify(h)])),
            templates: new Map((this.data.templates || []).map((x, i) => [String((x && x.id) || `templates_${i}`), JSON.stringify(x)])),
            webhooks: new Map((this.data.webhooks || []).map((x, i) => [String((x && x.id) || `webhooks_${i}`), JSON.stringify(x)])),
            exemptions: new Map((this.data.exemptions || []).map((x, i) => [String((x && x.id) || `exemptions_${i}`), JSON.stringify(x)])),
            maintenance_windows: new Map((this.data.maintenanceWindows || []).map((x, i) => [String((x && x.id) || `maintenance_windows_${i}`), JSON.stringify(x)])),
            device_profiles: new Map((this.data.deviceProfiles || []).map((x, i) => [String((x && x.id) || `device_profiles_${i}`), JSON.stringify(x)])),
            orders: new Map((this.data.orders || []).map((o, i) => [String((o && (o.key || (o.order && o.order.nonce))) || `order_${i}`), JSON.stringify(o)])),
            seenNonces: new Map((this.data.seenNonces || []).filter((e) => e && e.nonce && Number.isFinite(e.exp)).map((e) => [e.nonce, e.exp])),
            inventory: this.data.inventory ? JSON.stringify(this.data.inventory) : null,
            bootHistory: new Map((this.data.bootHistory || []).filter(Boolean).map((b) => [String(bootKeyOf(b)), JSON.stringify({ bootAt: b })]))
        };
    }

    /** Migrasyon ve ilk kurulum: tüm satırları tek transaction'da yazar. */
    _writeAll(db, data) {
        const now = nowIso();
        const insertMeta = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
        insertMeta.run('schema_version', String(CURRENT_SCHEMA_VERSION));
        insertMeta.run('created_at', data.createdAt || now);
        insertMeta.run('updated_at', data.updatedAt || now);
        insertMeta.run('audit_chain', 'legacy-pending');

        const insSetting = db.prepare('INSERT OR REPLACE INTO settings(key, json, updated_at) VALUES (?, ?, ?)');
        for (const [key, value] of Object.entries(data.settings || {})) {
            insSetting.run(key, JSON.stringify(value === undefined ? null : value), now);
        }
        const insTask = db.prepare('INSERT OR REPLACE INTO tasks(id, status, action, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)');
        for (const t of data.tasks || []) {
            if (!t || !t.id) continue;
            insTask.run(t.id, t.status || null, t.action || null, t.createdAt || null, t.updatedAt || now, JSON.stringify(t));
        }
        const insHistory = db.prepare('INSERT OR REPLACE INTO history(id, timestamp, result_code, action, data) VALUES (?, ?, ?, ?, ?)');
        (data.history || []).slice(0, MAX_HISTORY).forEach((h, i) => {
            const id = (h && h.id) || `row_${i}`;
            insHistory.run(id, (h && h.timestamp) || now, (h && h.resultCode) || null, (h && h.action) || null, JSON.stringify(h));
        });
        const insCollection = (table, list) => {
            const stmt = db.prepare(`INSERT OR REPLACE INTO ${table}(row_id, id, updated_at, data) VALUES (?, ?, ?, ?)`);
            (list || []).forEach((item, i) => {
                stmt.run((item && item.id) || `${table}_${i}`, (item && item.id) || null, now, JSON.stringify(item));
            });
        };
        insCollection('templates', data.templates);
        insCollection('webhooks', data.webhooks);
        insCollection('exemptions', data.exemptions);
        insCollection('maintenance_windows', data.maintenanceWindows);
        insCollection('device_profiles', data.deviceProfiles);

        const insOrder = db.prepare('INSERT OR REPLACE INTO orders(key, nonce, state, expires_at, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
        (data.orders || []).forEach((o, i) => {
            const key = (o && (o.key || (o.order && o.order.nonce))) || `order_${i}`;
            insOrder.run(
                key,
                (o && o.order && o.order.nonce) || null,
                (o && o.status) || 'pending',
                Number.isFinite(o && o.order && o.order.expiresAt) ? o.order.expiresAt : null,
                (o && o.receivedAt) || now,
                (o && o.ackedAt) || now,
                JSON.stringify(o)
            );
        });

        const insNonce = db.prepare('INSERT OR IGNORE INTO seen_nonces(nonce, expires_at, seen_at) VALUES (?, ?, ?)');
        for (const e of data.seenNonces || []) {
            if (e && typeof e.nonce === 'string' && Number.isFinite(e.exp)) insNonce.run(e.nonce, e.exp, now);
        }

        if (data.inventory) {
            db.prepare('INSERT OR REPLACE INTO inventory(id, data, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(data.inventory), now);
        }

        const insBoot = db.prepare('INSERT OR IGNORE INTO boot_history(boot_key, boot_at, recorded_at) VALUES (?, ?, ?)');
        for (const iso of data.bootHistory || []) {
            const key = bootKeyOf(iso);
            if (key !== null) insBoot.run(key, new Date(iso).toISOString(), now);
        }

        // Eski audit kayıtları sıralanır; HMAC anahtarı açılışta hazır olunca
        // rebuildAuditChain() zinciri yeniden hesaplar (WP-11 risk azaltımı).
        const insAudit = db.prepare('INSERT OR REPLACE INTO audit_log(seq, ts, actor, action, target, detail, prev_hmac, record_hmac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        const legacy = Array.isArray(data.auditLog) ? data.auditLog.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)) : [];
        legacy.forEach((rec, i) => {
            const seq = Number.isFinite(rec.seq) ? rec.seq : i + 1;
            insAudit.run(
                seq,
                rec.ts || now,
                rec.actor || 'system',
                rec.action || 'unknown',
                rec.target === undefined ? null : rec.target,
                rec.detail === undefined ? null : rec.detail,
                rec.prevHash || rec.prevHmac || 'GENESIS',
                rec.hash || rec.recordHmac || '',
                now
            );
        });
    }

    // --- normalizasyon / v2 mantığı (korunur) ------------------------------

    normalizeEnergySettings() {
        const s = this.data.settings || {};
        if (s.deviceWattage === undefined) s.deviceWattage = null;
        if (s.electricityCostPerKwh === undefined) s.electricityCostPerKwh = null;
        if (s.wattMeasuredAt === undefined) s.wattMeasuredAt = null;
        if (s.priceEffectiveFrom === undefined) s.priceEffectiveFrom = null;
        const isLegacyPair = s.deviceWattage === 150 && s.electricityCostPerKwh === 2.5;
        if (!s.wattSource || s.wattSource === 'unset') {
            s.wattSource = isLegacyPair ? 'legacy' : (s.deviceWattage == null ? 'unset' : 'manual');
        }
        if (!s.priceSource || s.priceSource === 'unset') {
            s.priceSource = isLegacyPair ? 'legacy' : (s.electricityCostPerKwh == null ? 'unset' : 'manual');
        }
        this.data.settings = s;
    }

    normalizeSecuritySettings() {
        const s = this.data.settings || {};
        if (!['viewer', 'operator', 'admin'].includes(s.localApiKeyRole)) s.localApiKeyRole = 'viewer';
        if (typeof s.localApiTlsEnabled !== 'boolean') s.localApiTlsEnabled = false;
        if (typeof s.localApiTlsStrict !== 'boolean') s.localApiTlsStrict = false;
        if (typeof s.localApiRequireClientCert !== 'boolean') s.localApiRequireClientCert = false;
        if (typeof s.agentDisabled !== 'boolean') s.agentDisabled = false;
        if (typeof s.lanModeEnabled !== 'boolean') s.lanModeEnabled = false;
        if (!Array.isArray(s.lanAllowedIps)) s.lanAllowedIps = [];
        if (s.lanModeEnabled === true && s.lanAllowedIps.length === 0) {
            s.lanModeEnabled = false;
            s.lanModeWarning = 'LAN modu kapatıldı: geçerli IP/CIDR allowlist kaydı yok.';
            log.warn('[StorageService] LAN modu allowlist boş olduğu için kapatıldı.');
        }
        if (s.lanModeWarning === undefined) s.lanModeWarning = null;
        if (typeof s.blockRemoteShutdownWhenActive !== 'boolean') s.blockRemoteShutdownWhenActive = true;
        for (const k of ['localApiCertFile', 'localApiKeyFile', 'localApiCaFile']) {
            if (s[k] !== null && typeof s[k] !== 'string') s[k] = null;
            if (s[k] === undefined) s[k] = null;
        }
        // P1-6: ajan→konsol mTLS dosya yolları.
        for (const k of ['consoleClientCertFile', 'consoleClientKeyFile', 'consoleClientPfxFile', 'consoleClientCaFile']) {
            if (s[k] !== null && typeof s[k] !== 'string') s[k] = null;
            if (s[k] === undefined) s[k] = null;
        }
        for (const k of ['localApiCertPem', 'localApiKeyPem', 'localApiCaPem', 'consolePublicKeyPem', 'agentId', 'consoleUrl', 'consoleAgentKey', 'consoleClientCertPem', 'consoleClientKeyPem', 'consoleClientCaPem']) {
            if (s[k] === undefined) s[k] = null;
        }
        if (s.consoleAgentKey !== null && typeof s.consoleAgentKey !== 'string') s.consoleAgentKey = null;
        if (!['workstation', 'server'].includes(s.deviceRole)) s.deviceRole = 'workstation';
        if (typeof s.upsEnabled !== 'boolean') s.upsEnabled = false;
        if (typeof s.upsHost !== 'string' || !s.upsHost) s.upsHost = '127.0.0.1';
        if (typeof s.upsName !== 'string' || !s.upsName) s.upsName = 'ups';
        if (s.assumedOffHours !== null && !(typeof s.assumedOffHours === 'number' && s.assumedOffHours > 0 && s.assumedOffHours <= 24)) {
            s.assumedOffHours = null;
        }
        this.data.settings = s;
    }

    static isIpOrCidr(value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 64) return false;
        try {
            const s = value.trim();
            if (s.includes('/')) {
                const [addr, prefix] = ipaddr.parseCIDR(s);
                const max = addr.kind() === 'ipv4' ? 32 : 128;
                return Number.isInteger(prefix) && prefix >= 0 && prefix <= max;
            }
            ipaddr.parse(s);
            return true;
        } catch (_) {
            return false;
        }
    }

    migrate(oldData, fromVersion) {
        let migrated = { ...oldData };

        if (fromVersion < 1) {
            migrated.version = 1;
            migrated.tasks = migrated.tasks || [];
            migrated.history = migrated.history || [];
            migrated.settings = Object.assign(this.getDefaultData().settings, migrated.settings || {});
            migrated.webhooks = migrated.webhooks || [];
            migrated.deviceProfiles = migrated.deviceProfiles || [];
            migrated.templates = migrated.templates || [];
        }

        if (fromVersion < 2) {
            const defaults = this.getDefaultData().settings;
            const oldSettings = migrated.settings || {};
            const s = Object.assign({}, defaults, oldSettings);
            if (!Object.prototype.hasOwnProperty.call(oldSettings, 'wattSource')) delete s.wattSource;
            if (!Object.prototype.hasOwnProperty.call(oldSettings, 'priceSource')) delete s.priceSource;
            const rawList = Array.isArray(s.lanAllowedIps) ? s.lanAllowedIps : [];
            s.lanAllowedIps = rawList
                .filter((v) => StorageService.isIpOrCidr(v))
                .map((v) => v.trim())
                .slice(0, 16);
            if (s.lanModeEnabled === true && s.lanAllowedIps.length === 0) {
                s.lanModeEnabled = false;
                s.lanModeWarning = 'LAN modu kapatıldı: eski allowlist yalnızca hostname içeriyordu.';
                log.warn('[StorageService] LAN allowlist geçersiz hostname içeriyordu; LAN modu kapatıldı.');
            }
            if (typeof s.blockRemoteShutdownWhenActive !== 'boolean') s.blockRemoteShutdownWhenActive = true;
            migrated.settings = s;
            migrated.version = 2;
        }

        // WP-11.T6: eski boot listesini dakika anahtarıyla dedupe et.
        if (Array.isArray(migrated.bootHistory)) {
            const seen = new Set();
            migrated.bootHistory = migrated.bootHistory
                .filter((iso) => {
                    const key = bootKeyOf(iso);
                    if (key === null || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                })
                .sort((a, b) => new Date(a) - new Date(b));
        }

        // WP-07.T3: klasör hedefli file_stable görevleri directory_idle'a çevrilir.
        if (Array.isArray(migrated.tasks)) {
            for (const task of migrated.tasks) {
                const conds = task && task.conditionGroup && Array.isArray(task.conditionGroup.conditions)
                    ? task.conditionGroup.conditions : [];
                for (const c of conds) {
                    if (c && c.type === 'file_stable' && c.params && c.params.isDirectory === true) {
                        c.type = 'directory_idle';
                        if (!Number.isFinite(c.params.stableSeconds)) c.params.stableSeconds = 300;
                    }
                }
            }
        }

        migrated.version = CURRENT_SCHEMA_VERSION;
        migrated.updatedAt = nowIso();
        return migrated;
    }

    // --- genel yardımcılar -------------------------------------------------

    atomicWrite(targetPath, content, durable = true) {
        const dir = path.dirname(targetPath);
        const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.tmp`);
        fs.writeFileSync(tmp, content, 'utf8');
        try {
            if (durable) {
                try {
                    const fd = fs.openSync(tmp, 'r');
                    try { fs.fsyncSync(fd); } catch (_) { /* yut */ }
                    fs.closeSync(fd);
                } catch (_) { /* yut */ }
            }
            this.renameWithRetry(tmp, targetPath);
        } catch (err) {
            try { fs.unlinkSync(tmp); } catch (_) {}
            throw err;
        }
    }

    renameWithRetry(tmp, targetPath) {
        try {
            fs.renameSync(tmp, targetPath);
            return;
        } catch (err) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
            let last = err;
            for (let i = 0; i < 3; i++) {
                StorageService.sleepSync(50);
                try { fs.renameSync(tmp, targetPath); return; } catch (retryErr) { last = retryErr; }
            }
            throw last;
        }
    }

    static sleepSync(ms) {
        try {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        } catch (_) {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) { /* bekle */ }
        }
    }

    cleanStaleTmps() {
        try {
            const base = `.${path.basename(this.legacyPath)}.`;
            for (const entry of fs.readdirSync(path.dirname(this.legacyPath))) {
                if (entry.startsWith(base) && entry.endsWith('.tmp')) {
                    try { fs.unlinkSync(path.join(path.dirname(this.legacyPath), entry)); } catch (_) {}
                }
            }
        } catch (_) {}
    }

    close() {
        try {
            if (this.db) this.db.close();
        } finally {
            this.db = null;
            this._stmts.clear();
        }
    }

    /** Sır migrasyonu sonrası eski WAL çerçevelerini diskten temizler. */
    checkpoint() {
        if (!this.db || this.maintenanceMode) return null;
        return this.db.checkpoint('TRUNCATE');
    }

    // --- Tasks API ---------------------------------------------------------

    getTasks() {
        return this.data.tasks || [];
    }

    /**
     * Toplu kayıt API'si korunur; yalnızca değişen satırlar yazılır.
     * (T-STO-01: 1000 görevden biri güncellenince 1 satır.)
     */
    saveTasks(tasks) {
        if (!Array.isArray(tasks)) return false;
        this.data.tasks = tasks;
        return this._persist(() => this._flushTasks(this._diskTasks()));
    }

    saveTask(task) {
        if (!task || !task.id) return false;
        const index = this.data.tasks.findIndex((t) => t && t.id === task.id);
        if (index >= 0) this.data.tasks[index] = task;
        else this.data.tasks.push(task);
        return this._persist(() => this._flushTasks(this._diskTasks()));
    }

    deleteTask(taskId) {
        this.data.tasks = this.data.tasks.filter((t) => !t || t.id !== taskId);
        return this._persist(() => this._flushTasks(this._diskTasks()));
    }

    _diskTasks() {
        const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
        return payload.tasks || [];
    }

    _persist(fn) {
        if (this.maintenanceMode || !this.db) return false;
        try {
            this.db.write(() => {
                this._setMeta('updated_at', nowIso());
                fn();
            });
            return true;
        } catch (err) {
            log.error('[StorageService] Kalıcılaştırma hatası:', err);
            return false;
        }
    }

    addTask(task) {
        return this.saveTask(task);
    }

    removeTask(taskId) {
        return this.deleteTask(taskId);
    }

    // --- History API -------------------------------------------------------

    getHistory() {
        return this.data.history || [];
    }

    addHistoryRecord(record) {
        this.data.history.unshift(record);
        if (this.data.history.length > MAX_HISTORY) this.data.history = this.data.history.slice(0, MAX_HISTORY);
        return this._persist(() => this._flushHistory(this._historyForDisk()));
    }

    _historyForDisk() {
        const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
        return payload.history || [];
    }

    clearHistory() {
        this.data.history = [];
        return this._persist(() => this._flushHistory([]));
    }

    // --- Settings API ------------------------------------------------------

    getSettings() {
        // Savunmacı kopya: çağıranlar iç ayar nesnesini yanlışlıkla
        // değiştirerek kalıcı durumu bozamaz.
        const settings = this.data.settings || {};
        try {
            if (typeof structuredClone === 'function') return structuredClone(settings);
        } catch (_) { /* düş */ }
        try {
            return JSON.parse(JSON.stringify(settings));
        } catch (_) {
            return { ...settings };
        }
    }

    updateSettings(newSettings) {
        if (!newSettings || typeof newSettings !== 'object' || Array.isArray(newSettings)) return false;
        const safe = {};
        for (const [key, value] of Object.entries(newSettings)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            safe[key] = value;
        }
        // Y-06: kalıcılaştırma başarısızsa bellekteki değişikliği geri al ve
        // çağırana açık hata ver; sessiz "başarılı" yanıt üretilmez.
        const previous = this.data.settings;
        this.data.settings = Object.assign({}, previous, safe);
        const ok = this._persist(() => this._flushSettings(this._settingsForDisk()));
        if (!ok) {
            this.data.settings = previous;
            throw Object.assign(new Error('Ayarlar kalıcılaştırılamadı.'), { code: 'SETTINGS_PERSIST_FAILED' });
        }
        return true;
    }

    _settingsForDisk() {
        const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
        return payload.settings || {};
    }

    getSchemaVersion() {
        return this.data.version;
    }

    getMeta(key) {
        const row = this.db ? this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) : null;
        return row ? row.value : null;
    }

    // --- Webhooks API ------------------------------------------------------

    getWebhooks() {
        return this.data.webhooks || [];
    }

    saveWebhooks(webhooks) {
        this.data.webhooks = Array.isArray(webhooks) ? webhooks : [];
        return this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushCollection('webhooks', payload.webhooks || []);
        });
    }

    // --- Templates / profiles / kurumsal koleksiyonlar ---------------------

    getTemplates() {
        return this.data.templates || [];
    }

    saveTemplates(templates) {
        this.data.templates = Array.isArray(templates) ? templates : [];
        return this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushCollection('templates', payload.templates || []);
        });
    }

    getDeviceProfiles() {
        return this.data.deviceProfiles || [];
    }

    saveDeviceProfiles(profiles) {
        this.data.deviceProfiles = Array.isArray(profiles) ? profiles : [];
        return this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushCollection('device_profiles', payload.deviceProfiles || []);
        });
    }

    getExemptions() {
        return Array.isArray(this.data.exemptions) ? this.data.exemptions : [];
    }

    saveExemptions(list) {
        this.data.exemptions = Array.isArray(list) ? list : [];
        return this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushCollection('exemptions', payload.exemptions || []);
        });
    }

    getMaintenanceWindows() {
        return Array.isArray(this.data.maintenanceWindows) ? this.data.maintenanceWindows : [];
    }

    saveMaintenanceWindows(list) {
        this.data.maintenanceWindows = Array.isArray(list) ? list : [];
        return this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushCollection('maintenance_windows', payload.maintenanceWindows || []);
        });
    }

    // --- Orders / nonce ----------------------------------------------------

    getOrders() {
        return Array.isArray(this.data.orders) ? this.data.orders : [];
    }

    saveOrders(list) {
        const previous = this.data.orders;
        this.data.orders = Array.isArray(list) ? list : [];
        const ok = this._persist(() => {
            const payload = this.secretStore ? this.secretStore.stripForDisk(this.data) : this.data;
            this._flushOrders(payload.orders || []);
        });
        // Y-06: disk yazımı başarısızsa bellek diskten ileri gitmez.
        if (!ok) this.data.orders = previous;
        return ok;
    }

    /**
     * WP-11.T10: atomik replay koruması. Nonce daha önce görüldüyse false.
     * INSERT OR IGNORE tek satırda yarışı çözer; bellek listesi de güncellenir.
     */
    consumeNonce(nonce, expiresAt) {
        if (typeof nonce !== 'string' || !nonce || !Number.isFinite(expiresAt)) return false;
        if (this.maintenanceMode || !this.db) return false;
        let inserted = false;
        this.db.write(() => {
            const res = this._prepare('INSERT OR IGNORE INTO seen_nonces(nonce, expires_at, seen_at) VALUES (?, ?, ?)')
                .run(nonce, expiresAt, nowIso());
            inserted = res.changes === 1;
            this._setMeta('updated_at', nowIso());
        });
        if (inserted) {
            this.data.seenNonces = (this.data.seenNonces || []).filter((e) => e && e.nonce !== nonce);
            this.data.seenNonces.push({ nonce, exp: expiresAt });
            this._snapshots.seenNonces = this._snapshots.seenNonces || new Map();
            this._snapshots.seenNonces.set(nonce, expiresAt);
        }
        return inserted;
    }

    purgeExpiredNonces(nowMs = Date.now()) {
        if (!this.db || this.maintenanceMode) return 0;
        let removed = 0;
        this.db.write(() => {
            const res = this._prepare('DELETE FROM seen_nonces WHERE expires_at <= ?').run(nowMs);
            removed = res.changes;
        });
        if (removed > 0) {
            this.data.seenNonces = (this.data.seenNonces || []).filter((e) => e && e.exp > nowMs);
            this._snapshots.seenNonces = new Map((this.data.seenNonces || []).map((e) => [e.nonce, e.exp]));
        }
        return removed;
    }

    // --- Envanter / boot ---------------------------------------------------

    getInventory() {
        return this.data.inventory || null;
    }

    saveInventory(inv) {
        this.data.inventory = inv || null;
        return this._persist(() => this._flushInventory(this.data.inventory));
    }

    getBootHistory() {
        return Array.isArray(this.data.bootHistory) ? this.data.bootHistory : [];
    }

    /** WP-11.T6: boot_key = floor(ms/60000); aynı dakika tek kayıt. */
    appendBoot(bootAtIso) {
        const key = bootKeyOf(bootAtIso);
        if (key === null) return false;
        const iso = new Date(bootAtIso).toISOString();
        if (!this.db || this.maintenanceMode) return false;
        try {
            this.db.write(() => {
                this._prepare('INSERT OR IGNORE INTO boot_history(boot_key, boot_at, recorded_at) VALUES (?, ?, ?)')
                    .run(key, iso, nowIso());
                this._setMeta('updated_at', nowIso());
            });
        } catch (err) {
            log.warn('[StorageService] Boot kaydı yazılamadı:', err && err.message);
            return false;
        }
        const list = this.getBootHistory().filter((b) => bootKeyOf(b) !== key);
        list.push(iso);
        list.sort((a, b) => new Date(a) - new Date(b));
        this.data.bootHistory = list;
        this._snapshots.bootHistory = this._snapshots.bootHistory || new Map();
        this._snapshots.bootHistory.set(String(key), JSON.stringify({ bootAt: iso }));
        this.pruneBootHistory();
        return true;
    }

    pruneBootHistory(nowMs = Date.now()) {
        const cutoff = nowMs - MAX_BOOT_DAYS * 86400000;
        const list = this.getBootHistory();
        const kept = list.filter((b) => new Date(b).getTime() >= cutoff);
        if (kept.length === list.length) return 0;
        this.data.bootHistory = kept;
        if (this.db && !this.maintenanceMode) {
            try {
                this.db.write(() => {
                    this._prepare('DELETE FROM boot_history WHERE boot_key < ?').run(Math.floor(cutoff / 60000));
                });
            } catch (_) { /* yut */ }
        }
        this._snapshots.bootHistory = new Map(kept.filter(Boolean).map((b) => [String(bootKeyOf(b)), JSON.stringify({ bootAt: b })]));
        return list.length - kept.length;
    }

    // --- Audit (HMAC zinciri) ---------------------------------------------

    hasAuditKey() {
        return !!(this.auditHmacKey && this.auditHmacKey.length > 0);
    }

    /**
     * WP-11.T7: anahtar SecretStore'dan gelir. Kayıt varsa ve zincir legacy ise
     * HMAC zinciri yeniden hesaplanır; checkpoint yazılır.
     */
    setAuditKey(key, { checkpointDir = null, eventLog = false } = {}) {
        if (!key) throw Object.assign(new Error('Audit HMAC anahtarı gerekli.'), { code: 'AUDIT_KEY_MISSING' });
        this.auditHmacKey = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
        this.auditCheckpoint = new AuditCheckpoint({
            dir: checkpointDir || path.join(this.userDataPath, 'audit-checkpoints'),
            eventLog,
            // O-22: onarım sessiz kalmaz; denetim kaydı üretir.
            onRepair: ({ day, file }) => {
                try {
                    this.appendAudit({
                        actor: 'system',
                        action: 'audit_checkpoint_repaired',
                        target: day,
                        detail: path.basename(file || '')
                    });
                } catch (err) {
                    log.warn('[StorageService] Checkpoint onarım kaydı yazılamadı:', err && err.message);
                }
            }
        });
        const chain = this.getMeta('audit_chain');
        if (chain !== 'hmac-v1') {
            this.rebuildAuditChain();
        }
        this.auditCheckpoint.ensureToday(this.getAuditLog());
        return true;
    }

    /** Legacy kayıtları sıralar, HMAC zincirini sıfırdan kurar (tek transaction). */
    rebuildAuditChain() {
        if (!this.db || !this.hasAuditKey()) {
            throw Object.assign(new Error('Audit zinciri için DB ve anahtar gerekli.'), { code: 'AUDIT_KEY_MISSING' });
        }
        const rows = this.db.prepare('SELECT seq, ts, actor, action, target, detail FROM audit_log ORDER BY seq ASC').all();
        this.db.write(() => {
            const del = this.db.prepare('DELETE FROM audit_log');
            del.run();
            const ins = this.db.prepare('INSERT INTO audit_log(seq, ts, actor, action, target, detail, prev_hmac, record_hmac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            const now = nowIso();
            let prev = 'GENESIS';
            rows.forEach((row, i) => {
                const seq = i + 1;
                const rec = {
                    seq,
                    ts: row.ts,
                    actor: row.actor,
                    action: row.action,
                    target: row.target,
                    detail: row.detail,
                    prev_hmac: prev
                };
                const mac = auditRecordHmac(this.auditHmacKey, rec);
                ins.run(seq, rec.ts, rec.actor, rec.action, rec.target, rec.detail, prev, mac, now);
                prev = mac;
            });
            this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('audit_chain', 'hmac-v1');
        });
        this.data.auditLog = this.getAuditLog();
        if (this.auditCheckpoint) this.auditCheckpoint.write(this.data.auditLog);
        log.info(`[StorageService] Audit zinciri yeniden hesaplandı (${rows.length} kayıt).`);
    }

    getAuditLog({ limit = null, beforeSeq = null } = {}) {
        const mapRow = (r) => ({
            seq: r.seq,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            target: r.target,
            detail: r.detail,
            prevHash: r.prev_hmac,
            hash: r.record_hmac,
            prevHmac: r.prev_hmac,
            recordHmac: r.record_hmac
        });
        if (!this.db) {
            let list = Array.isArray(this.data.auditLog) ? this.data.auditLog : [];
            if (Number.isFinite(beforeSeq)) list = list.filter((r) => r.seq < beforeSeq);
            if (Number.isFinite(limit) && limit > 0) list = list.slice(-limit);
            return list;
        }
        // O-06: sayfalama — en yeni N kayıt, istenirse beforeSeq'ten geriye.
        if (Number.isFinite(limit) && limit > 0) {
            const rows = Number.isFinite(beforeSeq)
                ? this.db.prepare('SELECT * FROM audit_log WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(beforeSeq, limit)
                : this.db.prepare('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?').all(limit);
            return rows.reverse().map(mapRow);
        }
        return this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all().map(mapRow);
    }

    /** AuditLog legacy adaptörü (konsol deposu / anahtarsız gömülü kullanım). */
    saveAuditLog(list) {
        if (!this.db || this.maintenanceMode) return false;
        const rows = Array.isArray(list) ? list.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)) : [];
        return this._persist(() => {
            const del = this.db.prepare('DELETE FROM audit_log');
            del.run();
            const ins = this.db.prepare('INSERT INTO audit_log(seq, ts, actor, action, target, detail, prev_hmac, record_hmac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
            rows.forEach((rec, i) => {
                ins.run(
                    Number.isFinite(rec.seq) ? rec.seq : i + 1,
                    rec.ts || nowIso(),
                    rec.actor || 'system',
                    rec.action || 'unknown',
                    rec.target === undefined ? null : rec.target,
                    rec.detail === undefined ? null : rec.detail,
                    rec.prevHash || rec.prevHmac || 'GENESIS',
                    rec.hash || rec.recordHmac || '',
                    nowIso()
                );
            });
            this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('audit_chain', 'legacy');
        });
    }

    /**
     * HMAC zincirine tek kayıt ekler. Anahtar yoksa fail-closed.
     */
    appendAudit({ actor = 'system', action = 'unknown', target = null, detail = '' } = {}) {
        if (!this.db || this.maintenanceMode) {
            throw Object.assign(new Error('Depo bakım modunda; audit yazılmadı.'), { code: 'STORAGE_MAINTENANCE' });
        }
        if (!this.hasAuditKey()) {
            throw Object.assign(new Error('Audit HMAC anahtarı yok; yeni audit yazılmadı.'), { code: 'AUDIT_KEY_MISSING' });
        }
        const clean = {
            actor: String(actor == null ? 'system' : actor).slice(0, 128),
            action: String(action == null ? 'unknown' : action).slice(0, 64),
            target: target == null ? null : String(target).slice(0, 128),
            detail: String(detail == null ? '' : detail).slice(0, 500)
        };
        let rec = null;
        this.db.write(() => {
            const last = this.db.prepare('SELECT seq, record_hmac FROM audit_log ORDER BY seq DESC LIMIT 1').get();
            const seq = last ? last.seq + 1 : 1;
            const prev = last ? last.record_hmac : 'GENESIS';
            const base = { seq, ts: nowIso(), ...clean, prev_hmac: prev };
            const mac = auditRecordHmac(this.auditHmacKey, base);
            this.db.prepare('INSERT INTO audit_log(seq, ts, actor, action, target, detail, prev_hmac, record_hmac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(seq, base.ts, base.actor, base.action, base.target, base.detail, prev, mac, nowIso());
            this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('updated_at', nowIso());
            rec = { ...base, hash: mac, prevHash: prev, recordHmac: mac, prevHmac: prev };
        });
        // Y-09: her yazımda tüm tabloyu yeniden okuma; bellekte son N kaydı tut.
        if (!Array.isArray(this.data.auditLog)) this.data.auditLog = [];
        this.data.auditLog.push(rec);
        if (this.data.auditLog.length > 5000) this.data.auditLog.shift();
        if (this.auditCheckpoint) {
            try { this.auditCheckpoint.ensureToday(this.data.auditLog); } catch (err) {
                log.warn('[StorageService] Audit checkpoint yazılamadı:', err && err.message);
            }
        }
        return rec;
    }

    /**
     * Zincir + checkpoint doğrulaması. Herhangi bir kopukluk/eksik checkpoint
     * auditTampered=true yapar; çağıran yıkıcı eylemleri bloke etmelidir.
     */
    verifyAuditChain() {
        if (!this.hasAuditKey()) return { ok: false, code: 'AUDIT_KEY_MISSING', error: 'Audit anahtarı yok.' };
        const rows = this.db ? this.db.prepare('SELECT * FROM audit_log ORDER BY seq ASC').all() : [];
        let prev = 'GENESIS';
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.seq !== i + 1) {
                this.auditTampered = true;
                return { ok: false, code: 'BROKEN_CHAIN', at: row.seq, error: 'Sıra numarası atlamalı.' };
            }
            if (row.prev_hmac !== prev) {
                this.auditTampered = true;
                return { ok: false, code: 'BROKEN_CHAIN', at: row.seq, error: `${row.seq}. kayıtta bağ kopuk.` };
            }
            const expected = auditRecordHmac(this.auditHmacKey, {
                seq: row.seq,
                ts: row.ts,
                actor: row.actor,
                action: row.action,
                target: row.target,
                detail: row.detail,
                prev_hmac: row.prev_hmac
            });
            if (row.record_hmac !== expected) {
                this.auditTampered = true;
                return { ok: false, code: 'TAMPERED', at: row.seq, error: `${row.seq}. kayıtta HMAC uyuşmazlığı.` };
            }
            prev = row.record_hmac;
        }
        if (this.auditCheckpoint) {
            const check = this.auditCheckpoint.verify(rows);
            if (!check.ok) {
                this.auditTampered = true;
                return check;
            }
        }
        this.auditTampered = false;
        return { ok: true, records: rows.length };
    }

    /**
     * AuditLog'un depo adaptörü: legacy hash ve HMAC zinciri arasında köprü.
     */
    auditStore() {
        return {
            getAuditLog: () => this.getAuditLog(),
            saveAuditLog: (list) => this.saveAuditLog(list),
            appendAudit: (input) => this.appendAudit(input),
            verifyAuditChain: () => this.verifyAuditChain(),
            hasAuditKey: () => this.hasAuditKey()
        };
    }

    // --- K5: nonce listesi (geriye uyum) ----------------------------------

    getSeenNonces() {
        return Array.isArray(this.data.seenNonces) ? this.data.seenNonces : [];
    }

    saveSeenNonces(list) {
        this.data.seenNonces = Array.isArray(list) ? list.slice(-1000) : [];
        return this._persist(() => this._flushSeenNonces(this.data.seenNonces));
    }
}

module.exports = StorageService;
module.exports.CURRENT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
module.exports.legacyAuditHash = legacyAuditHash;
