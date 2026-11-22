/**
 * SecretStore.js - WP-04.T1/T2/T7
 * Sırları Electron safeStorage (Windows'ta DPAPI) ile şifreleyip ayrı bir
 * `secrets.v1.json` dosyasında tutar. Düz metin fallback YOKTUR:
 * - backend yoksa `SECRET_BACKEND_UNAVAILABLE` fırlar,
 * - çözme başarısızsa `SECRET_DECRYPT_FAILED` fırlar,
 * - dosya bozuksa `SECRETS_FILE_CORRUPT` fırlar.
 *
 * Dosya biçimi: { version: 1, entries: { "<name>": { v: 2, cipher, updatedAt } } }
 * Yazma atomiktir (aynı dizinde tmp + fsync + rename) ve dosya ACL'i kısıtlanır.
 */

const crypto = require('crypto');
const fsDefault = require('fs');
const path = require('path');
const Acl = require('./Acl');

const FILE_VERSION = 1;
const ENTRY_VERSION = 2;
const NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// Düz metin olarak asla diskte kalmaması gereken ayar alanları.
const SECRET_SETTING_FIELDS = Object.freeze([
    'consoleAgentKey',
    'localApiKeyPem',
    'localApiPfxPassphrase',
    'consoleClientKeyPem',
    'consoleClientPfxPassphrase'
]);

// Webhook sırları (WebhookService.secretFields ile aynı).
const WEBHOOK_SECRET_FIELDS = Object.freeze(['bearerToken', 'basicAuthPass', 'hmacSecret']);

function isNonEmptyString(v) {
    return typeof v === 'string' && v.length > 0;
}

function webhookKey(url, field) {
    const id = crypto.createHash('sha256').update(String(url || '')).digest('hex').slice(0, 16);
    return `webhook:${id}:${field}`;
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

class SecretStore {
    /**
     * @param {object} opts
     * @param {string} opts.filePath secrets.v1.json yolu
     * @param {object|null} [opts.safeStorage] test enjeksiyonu (Electron safeStorage)
     * @param {boolean} [opts.applyAcl] Windows ACL sıkılaştırması
     * @param {object} [opts.fsImpl] test enjeksiyonu
     */
    constructor({ filePath, safeStorage = null, applyAcl = false, fsImpl = null, logger = null } = {}) {
        if (typeof filePath !== 'string' || filePath.length === 0) {
            throw Object.assign(new Error('secrets dosya yolu gerekli.'), { code: 'INVALID_PATH' });
        }
        this.filePath = path.resolve(filePath);
        this.injectedBackend = safeStorage;
        this.applyAcl = applyAcl === true;
        this.fs = fsImpl || fsDefault;
        this.logger = logger;
        this._backend = undefined;
        this.corrupt = false;
        this.data = { version: FILE_VERSION, entries: {} };
        this.load();
    }

    // --- backend -----------------------------------------------------------

    resolveBackend() {
        if (this._backend !== undefined) return this._backend;
        if (this.injectedBackend) {
            this._backend = this.injectedBackend;
            return this._backend;
        }
        try {
            // eslint-disable-next-line global-require
            const electron = require('electron');
            const ss = electron && electron.safeStorage;
            this._backend = ss && (typeof ss.encryptString === 'function' || typeof ss.encryptStringAsync === 'function')
                ? ss
                : null;
        } catch (_) {
            this._backend = null;
        }
        return this._backend;
    }

    async isAsyncEncryptionAvailable() {
        const backend = this.resolveBackend();
        if (!backend) return false;
        try {
            if (typeof backend.isAsyncEncryptionAvailable === 'function') {
                return (await backend.isAsyncEncryptionAvailable()) === true;
            }
            if (typeof backend.isEncryptionAvailable === 'function') {
                return backend.isEncryptionAvailable() === true;
            }
        } catch (_) {
            return false;
        }
        return typeof backend.encryptString === 'function' || typeof backend.encryptStringAsync === 'function';
    }

    async encryptStringAsync(plain) {
        if (typeof plain !== 'string' || plain.length === 0) {
            throw Object.assign(new Error('Şifrelenecek değer boş olamaz.'), { code: 'INVALID_SECRET' });
        }
        const backend = this.resolveBackend();
        if (!backend || !(await this.isAsyncEncryptionAvailable())) {
            throw Object.assign(new Error('safeStorage kullanılamıyor; düz metin fallback yok.'), { code: 'SECRET_BACKEND_UNAVAILABLE' });
        }
        let out;
        try {
            if (typeof backend.encryptStringAsync === 'function') {
                out = await backend.encryptStringAsync(plain);
            } else {
                out = await backend.encryptString(plain);
            }
        } catch (err) {
            throw Object.assign(new Error(`Şifreleme başarısız: ${(err && err.message) || 'bilinmeyen hata'}`), { code: 'SECRET_ENCRYPT_FAILED' });
        }
        const buf = Buffer.isBuffer(out) ? out : Buffer.from(out);
        if (buf.length === 0) {
            throw Object.assign(new Error('Şifreleme boş çıktı verdi.'), { code: 'SECRET_ENCRYPT_FAILED' });
        }
        return buf.toString('base64');
    }

    /**
     * @returns {Promise<{result:string, shouldReEncrypt:boolean}>}
     */
    async decryptStringAsync(cipher, meta = {}) {
        if (typeof cipher !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(cipher)) {
            throw Object.assign(new Error('Şifreli değer biçimi geçersiz.'), { code: 'SECRET_DECRYPT_FAILED' });
        }
        const backend = this.resolveBackend();
        if (!backend || !(await this.isAsyncEncryptionAvailable())) {
            throw Object.assign(new Error('safeStorage kullanılamıyor; çözme reddedildi.'), { code: 'SECRET_BACKEND_UNAVAILABLE' });
        }
        let result;
        let backendReEncrypt = false;
        try {
            const buf = Buffer.from(cipher, 'base64');
            let plain;
            if (typeof backend.decryptStringAsync === 'function') {
                plain = await backend.decryptStringAsync(buf);
            } else {
                plain = await backend.decryptString(buf);
            }
            // Electron 43+ safeStorage.decryptStringAsync() `{ result, shouldReEncrypt }`
            // nesnesi döner; eski/senkron backend'ler doğrudan string veya Buffer döner.
            if (plain && typeof plain === 'object' && !Buffer.isBuffer(plain)
                && Object.prototype.hasOwnProperty.call(plain, 'result')) {
                if (typeof plain.result === 'string') {
                    result = plain.result;
                } else if (Buffer.isBuffer(plain.result)) {
                    result = plain.result.toString('utf8');
                } else {
                    throw new Error('beklenmeyen çözme yanıtı');
                }
                backendReEncrypt = plain.shouldReEncrypt === true;
            } else if (Buffer.isBuffer(plain)) {
                result = plain.toString('utf8');
            } else if (typeof plain === 'string') {
                result = plain;
            } else {
                throw new Error('beklenmeyen çözme yanıtı');
            }
        } catch (err) {
            throw Object.assign(new Error(`Çözme başarısız: ${(err && err.message) || 'bozuk cipher'}`), { code: 'SECRET_DECRYPT_FAILED' });
        }
        const version = Number(meta && meta.v);
        return { result, shouldReEncrypt: backendReEncrypt || !Number.isFinite(version) || version < ENTRY_VERSION };
    }

    // --- kalıcılık ---------------------------------------------------------

    load() {
        try {
            if (!this.fs.existsSync(this.filePath)) {
                this.data = { version: FILE_VERSION, entries: {} };
                return;
            }
            const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
                throw new Error('entries eksik');
            }
            this.data = { version: FILE_VERSION, entries: parsed.entries };
        } catch (err) {
            this.corrupt = true;
            this.data = { version: FILE_VERSION, entries: {} };
            if (this.logger) this.logger.error('[SecretStore] dosya okunamadı:', err && err.message);
        }
    }

    writeAtomic() {
        if (this.corrupt) {
            throw Object.assign(new Error('Bozuk secrets dosyası üzerine yazılmaz.'), { code: 'SECRETS_FILE_CORRUPT' });
        }
        const dir = path.dirname(this.filePath);
        this.fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // L-08: ACL yalnızca ilk yazımda uygulanır; her sır yazımında özyinelemeli
        // icacls çalıştırmak ana thread'i gereksiz bloke eder.
        if (this.applyAcl && !this._dirAclSecured) {
            Acl.secureDirectory(dir);
            this._dirAclSecured = true;
        }
        const json = JSON.stringify(this.data, null, 2);
        const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        let fd = null;
        try {
            fd = this.fs.openSync(tmp, 'w', 0o600);
            this.fs.writeFileSync(fd, json, 'utf8');
            try { this.fs.fsyncSync(fd); } catch (_) { /* bazı FS'lerde yok */ }
        } finally {
            if (fd !== null) this.fs.closeSync(fd);
        }
        this.fs.renameSync(tmp, this.filePath);
        if (this.applyAcl && !this._fileAclSecured) {
            Acl.secureFile(this.filePath);
            this._fileAclSecured = true;
        }
    }

    ensureLoaded() {
        if (this.corrupt) {
            throw Object.assign(new Error('secrets.v1.json bozuk; geri yükleme/provisioning gerekli.'), { code: 'SECRETS_FILE_CORRUPT' });
        }
    }

    has(name) {
        return !!(this.data.entries && this.data.entries[name]);
    }

    listNames() {
        return Object.keys(this.data.entries || {});
    }

    async getSecret(name) {
        this.ensureLoaded();
        if (!NAME_RE.test(String(name))) {
            throw Object.assign(new Error('Geçersiz sır adı.'), { code: 'INVALID_SECRET_NAME' });
        }
        const entry = this.data.entries[name];
        if (!entry) return null;
        const { result, shouldReEncrypt } = await this.decryptStringAsync(entry.cipher, entry);
        if (shouldReEncrypt) {
            // T-SEC-07: eski sürüm şifreli değer okunur ve atomik olarak yenilenir.
            const cipher = await this.encryptStringAsync(result);
            this.data.entries[name] = { v: ENTRY_VERSION, cipher, updatedAt: new Date().toISOString() };
            this.writeAtomic();
        }
        return result;
    }

    async setSecret(name, value) {
        this.ensureLoaded();
        if (!NAME_RE.test(String(name))) {
            throw Object.assign(new Error('Geçersiz sır adı.'), { code: 'INVALID_SECRET_NAME' });
        }
        const cipher = await this.encryptStringAsync(value);
        this.data.entries[name] = { v: ENTRY_VERSION, cipher, updatedAt: new Date().toISOString() };
        this.writeAtomic();
        return true;
    }

    async deleteSecret(name) {
        this.ensureLoaded();
        if (!Object.prototype.hasOwnProperty.call(this.data.entries, name)) return false;
        delete this.data.entries[name];
        this.writeAtomic();
        return true;
    }

    /**
     * WP-04: webhook sırlarını senkronlar. Verilen listenin dışında kalan
     * `webhook:*` kayıtları (silinen/URL'si değişen hook'lar) temizlenir;
     * böylece silinen bir webhook'un sırrı diskte öksüz kalmaz.
     */
    async syncWebhooks(webhooks) {
        this.ensureLoaded();
        const list = Array.isArray(webhooks) ? webhooks : [];
        const keep = new Set();
        for (const hook of list) {
            if (!hook || typeof hook !== 'object' || !isNonEmptyString(hook.url)) continue;
            for (const field of WEBHOOK_SECRET_FIELDS) keep.add(webhookKey(hook.url, field));
        }
        // O-18: önce yeni sırları yaz; ancak tümü başarılıysa eski kayıtları sil.
        // Hata halinde yazılan/silinen kayıtlar geri alınır (kimlik bilgisi kaybı yok).
        const written = [];
        const deleted = [];
        try {
            for (const hook of list) {
                if (!hook || typeof hook !== 'object' || !isNonEmptyString(hook.url)) continue;
                for (const field of WEBHOOK_SECRET_FIELDS) {
                    if (!isNonEmptyString(hook[field])) continue;
                    const name = webhookKey(hook.url, field);
                    const had = this.has(name);
                    const previous = had ? await this.getSecret(name) : null;
                    if (!had || previous !== hook[field]) {
                        await this.setSecret(name, hook[field]);
                        written.push({ name, had, previous });
                    }
                }
            }
            for (const name of Object.keys(this.data.entries || {})) {
                if (name.startsWith('webhook:') && !keep.has(name)) {
                    const previous = await this.getSecret(name);
                    await this.deleteSecret(name);
                    deleted.push({ name, previous });
                }
            }
        } catch (err) {
            for (const entry of deleted.reverse()) {
                try { await this.setSecret(entry.name, entry.previous); } catch (_) { /* yut */ }
            }
            for (const entry of written.reverse()) {
                try {
                    if (entry.had) await this.setSecret(entry.name, entry.previous);
                    else await this.deleteSecret(entry.name);
                } catch (_) { /* yut */ }
            }
            throw err;
        }
    }

    // --- düz metin migrasyonu (T2) ----------------------------------------

    /**
     * Veri nesnesindeki bilinen düz metin sırları şifreler ve alanları temizler.
     * Çağıran, işlem sonunda `data`yı diske yazmalıdır (SecretStore yazmaz).
     */
    async migrateFromData(data) {
        this.ensureLoaded();
        if (!data || typeof data !== 'object') return { migrated: [], alreadyEncrypted: [], removedBackups: [] };
        const settings = data.settings || {};
        const webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
        const migrated = [];
        const alreadyEncrypted = [];

        const storeOne = async (name, value) => {
            if (!isNonEmptyString(value)) return;
            if (this.has(name)) {
                const existing = await this.getSecret(name);
                if (existing === value) {
                    alreadyEncrypted.push(name);
                    return;
                }
            }
            await this.setSecret(name, value);
            const check = await this.getSecret(name);
            if (check !== value) {
                throw Object.assign(new Error(`Migrasyon doğrulaması başarısız: ${name}`), { code: 'MIGRATION_VERIFY_FAILED' });
            }
            migrated.push(name);
        };

        for (const field of SECRET_SETTING_FIELDS) {
            if (isNonEmptyString(settings[field])) {
                await storeOne(field, settings[field]);
                settings[field] = null;
            }
        }
        for (const hook of webhooks) {
            if (!hook || typeof hook !== 'object') continue;
            for (const field of WEBHOOK_SECRET_FIELDS) {
                if (isNonEmptyString(hook[field])) {
                    const name = webhookKey(hook.url, field);
                    await storeOne(name, hook[field]);
                    delete hook[field];
                }
            }
        }
        return { migrated, alreadyEncrypted };
    }

    /**
     * Şifreli sırları bellekteki veri nesnesine geri doldurur (diske yazmaz).
     */
    async hydrateData(data, { only = SECRET_SETTING_FIELDS } = {}) {
        this.ensureLoaded();
        if (!data || typeof data !== 'object') return data;
        const settings = data.settings || {};
        for (const field of only) {
            if (isNonEmptyString(settings[field])) continue;
            try {
                const value = await this.getSecret(field);
                if (isNonEmptyString(value)) settings[field] = value;
            } catch (err) {
                throw Object.assign(new Error(`Sır yüklenemedi (${field}): ${err.message}`), { code: err.code || 'SECRET_HYDRATE_FAILED' });
            }
        }
        const webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
        for (const hook of webhooks) {
            if (!hook || typeof hook !== 'object') continue;
            for (const field of WEBHOOK_SECRET_FIELDS) {
                if (isNonEmptyString(hook[field])) continue;
                const value = await this.getSecret(webhookKey(hook.url, field));
                if (isNonEmptyString(value)) hook[field] = value;
            }
        }
        return data;
    }

    /**
     * Diske yazılacak kopyada sırları çıkarır (bellek değişmez).
     */
    stripForDisk(data) {
        const copy = cloneJson(data || {});
        if (copy.settings && typeof copy.settings === 'object') {
            for (const field of SECRET_SETTING_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(copy.settings, field)) copy.settings[field] = null;
            }
        }
        for (const hook of Array.isArray(copy.webhooks) ? copy.webhooks : []) {
            if (!hook || typeof hook !== 'object') continue;
            for (const field of WEBHOOK_SECRET_FIELDS) delete hook[field];
        }
        return copy;
    }

    /**
     * Düz metin sır taraması (T-SEC-01). Değer döndürmez, yalnızca yol listesi.
     */
    static findPlaintextSecrets(data) {
        const hits = [];
        if (!data || typeof data !== 'object') return hits;
        const settings = data.settings || {};
        for (const field of SECRET_SETTING_FIELDS) {
            if (isNonEmptyString(settings[field])) hits.push(`settings.${field}`);
        }
        const webhooks = Array.isArray(data.webhooks) ? data.webhooks : [];
        webhooks.forEach((hook, i) => {
            for (const field of WEBHOOK_SECRET_FIELDS) {
                if (hook && isNonEmptyString(hook[field])) hits.push(`webhooks[${i}].${field}`);
            }
        });
        return hits;
    }

    /**
     * Eski yedeklerde düz metin sır varsa siler (T-SEC-06). Audit için liste döner.
     */
    static purgeSecretBackups(backupDir, { fsImpl = fsDefault } = {}) {
        const removed = [];
        if (typeof backupDir !== 'string' || !fsImpl.existsSync(backupDir)) return removed;
        const secretPattern = /"(?:consoleAgentKey|localApiKeyPem|localApiPfxPassphrase|consoleClientKeyPem|bearerToken|basicAuthPass|hmacSecret)"\s*:\s*"(?!null)[^"]+"|"privateKey"\s*:\s*"-----BEGIN/;
        let entries = [];
        try { entries = fsImpl.readdirSync(backupDir); } catch (_) { return removed; }
        for (const name of entries) {
            const full = path.join(backupDir, name);
            let st;
            try { st = fsImpl.statSync(full); } catch (_) { continue; }
            if (!st.isFile()) continue;
            let text;
            try { text = fsImpl.readFileSync(full, 'utf8'); } catch (_) { continue; }
            if (secretPattern.test(text)) {
                try {
                    fsImpl.unlinkSync(full);
                    removed.push(name);
                } catch (_) { /* kilitli dosya raporlanır */ }
            }
        }
        return removed;
    }
}

module.exports = {
    SecretStore,
    SECRET_SETTING_FIELDS,
    WEBHOOK_SECRET_FIELDS,
    webhookKey,
    FILE_VERSION,
    ENTRY_VERSION
};
