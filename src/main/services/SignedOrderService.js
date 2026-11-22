/**
 * SignedOrderService.js - WP-01 (OrderV2)
 * Konsol → ajan emirleri Ed25519 ile imzalanır. İmza, RFC 8785 (JCS) ile
 * kanonikleştirilmiş TÜM emir nesnesini kapsar; böylece `params` da imza
 * dışında kalamaz (K-01).
 *
 * Doğrulama sırası (WP-01.T3):
 *   şema → sürüm → issuer → hedef → zaman → nonce → keyId → imza → eylem.
 *
 * Fail-closed ilkeler:
 * - Kanonikleştirici yüklenmemişse imza üretilmez/doğrulanmaz
 *   (`CANONICALIZER_NOT_READY`).
 * - `targets` tam olarak `[agentId]` değilse `WRONG_TARGET`.
 * - Replay nonce'ları yalnızca imza doğrulandıktan sonra işaretlenir; geçersiz
 *   imza ile nonce zehirlenemez.
 */

const crypto = require('crypto');
const { validateOrder, ORDER_VERSION, ISSUER } = require('../order/OrderSchema');
const Nonce = require('../order/Nonce');

const MAX_FUTURE_SKEW_MS = 120000;   // issuedAt en fazla 2 dk ileri olabilir
const MAX_TTL_MS = 10 * 60 * 1000;   // emir ömrü en fazla 10 dk
const DEFAULT_TTL_MS = 10 * 60 * 1000;

let canonicalizeFn = null;

function loadCanonicalizerSync() {
    try {
        // Node 24 / Electron 43: require(ESM) senkron çalışır. Daha eski
        // çalışma zamanlarında initCanonicalizer() ile await import kullanılır.
        const mod = require('canonicalize');
        return typeof mod === 'function' ? mod : mod.default;
    } catch (_) {
        return null;
    }
}

// Modül yüklenirken bir kez denenir; runtime'da sessiz fallback yoktur.
canonicalizeFn = loadCanonicalizerSync();

async function initCanonicalizer() {
    if (!canonicalizeFn) {
        const mod = await import('canonicalize');
        canonicalizeFn = typeof mod === 'function' ? mod : mod.default;
    }
    return canonicalizeFn;
}

function canonical(order) {
    if (typeof canonicalizeFn !== 'function') {
        const err = new Error('Kanonikleştirici hazır değil.');
        err.code = 'CANONICALIZER_NOT_READY';
        throw err;
    }
    return Buffer.from(canonicalizeFn(order), 'utf8');
}

/** Yalnızca testler için: başlatma sırasını doğrulamak üzere sıfırlar. */
function _resetCanonicalizerForTests() {
    canonicalizeFn = null;
}

function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
}

/** Test/araç yardımcısı: eksik v2 alanlarını güvenli varsayılanlarla tamamlar. */
function normalizeForSigning(order, keyId) {
    const o = { ...(order || {}) };
    const now = Date.now();
    if (o.version === undefined) o.version = ORDER_VERSION;
    if (o.issuer === undefined) o.issuer = ISSUER;
    if (o.params === undefined) o.params = {};
    if (o.nonce === undefined) o.nonce = Nonce.generate(now);
    if (o.issuedAt === undefined) o.issuedAt = now;
    if (o.expiresAt === undefined) o.expiresAt = o.issuedAt + DEFAULT_TTL_MS;
    if (o.keyId === undefined) o.keyId = keyId || 'default';
    if (Array.isArray(o.targets) ? false : o.targets === undefined) o.targets = [];
    return o;
}

function sign(order, privateKeyPem, keyId = 'default') {
    // KeyObject önbelleği kabul edilir (WP-15.T4): her emirde PEM parse etmek
    // native bellek sızıntısına ve gecikmeye yol açıyordu.
    const full = normalizeForSigning(order, keyId);
    const check = validateOrder(full);
    if (!check.ok) {
        const err = new Error(check.error);
        err.code = check.code;
        throw err;
    }
    const msg = canonical(full);
    const key = privateKeyPem && privateKeyPem.type === 'private'
        ? privateKeyPem
        : crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, msg, key);
    return {
        order: full,
        signature: sig.toString('base64'),
        alg: 'ed25519',
        keyId: full.keyId
    };
}

function normalizePublicKeys(publicKeys, fallbackPem, fallbackKeyId) {
    const map = new Map();
    const add = (keyId, entry) => {
        if (!keyId || !entry) return;
        const pem = typeof entry === 'string' ? entry : entry.pem;
        if (typeof pem !== 'string' || pem.length === 0) return;
        const notAfter = typeof entry === 'object' && Number.isFinite(entry.notAfter) ? entry.notAfter : null;
        map.set(keyId, { pem, notAfter });
    };
    if (publicKeys && typeof publicKeys === 'object') {
        for (const [keyId, entry] of Object.entries(publicKeys)) add(keyId, entry);
    }
    if (fallbackPem) add(fallbackKeyId || 'default', fallbackPem);
    return map;
}

class SignedOrderService {
    /**
     * @param {object} opts
     * @param {string} [opts.publicKeyPem] tek anahtar (legacy)
     * @param {object} [opts.publicKeys] { keyId: pem | { pem, notAfter } }
     * @param {string} [opts.keyId]
     * @param {string} [opts.agentId] hedef bağlama; verilirse targets tam olarak [agentId] olmalı
     * @param {Function} [opts.nowFn]
     * @param {object} [opts.storage] getSeenNonces/saveSeenNonces
     */
    constructor({
        publicKeyPem = null,
        publicKeys = null,
        keyId = null,
        agentId = null,
        nowFn = null,
        storage = null,
        clockSkewMs = MAX_FUTURE_SKEW_MS,
        maxTtlMs = MAX_TTL_MS
    } = {}) {
        this.publicKeys = normalizePublicKeys(publicKeys, publicKeyPem, keyId);
        this.agentId = typeof agentId === 'string' && agentId ? agentId : null;
        this.nowFn = nowFn || (() => Date.now());
        this.storage = storage;
        this.clockSkewMs = clockSkewMs;
        this.maxTtlMs = maxTtlMs;
        this.seenNonces = new Map(); // nonce -> expiresAt
        this.loadPersisted();
    }

    static async initCanonicalizer() {
        await initCanonicalizer();
        return true;
    }

    static isCanonicalizerReady() {
        return typeof canonicalizeFn === 'function';
    }

    loadPersisted() {
        try {
            if (!this.storage || typeof this.storage.getSeenNonces !== 'function') return;
            const list = this.storage.getSeenNonces();
            if (!Array.isArray(list)) return;
            const now = this.nowFn();
            for (const e of list) {
                if (e && Nonce.isValid(e.nonce) && Number.isFinite(e.exp) && e.exp > now) {
                    if (this.seenNonces.size < 1000) this.seenNonces.set(e.nonce, e.exp);
                }
            }
        } catch (_) {
            // Depo okunamazsa bellek modu; doğrulama yine fail-closed kalır.
        }
    }

    persist(nonce, exp) {
        try {
            if (!this.storage || typeof this.storage.saveSeenNonces !== 'function') return;
            const list = this.storage.getSeenNonces();
            const arr = Array.isArray(list) ? list.filter((e) => e && e.nonce !== nonce) : [];
            arr.push({ nonce, exp });
            while (arr.length > 1000) arr.shift();
            this.storage.saveSeenNonces(arr);
        } catch (_) {
            // Yazım hatası doğrulamayı engellemez; bellek kaydı yine tutulur.
        }
    }

    setPublicKey(pem, keyId = 'default', notAfter = null) {
        if (typeof pem !== 'string' || pem.length === 0) return false;
        this.publicKeys.set(keyId, { pem, notAfter: Number.isFinite(notAfter) ? notAfter : null });
        return true;
    }

    hasKey(keyId) {
        return this.publicKeys.has(keyId);
    }

    prune() {
        const now = this.nowFn();
        for (const [nonce, exp] of this.seenNonces) {
            if (exp <= now) this.seenNonces.delete(nonce);
        }
    }

    keyFor(keyId) {
        const entry = this.publicKeys.get(keyId);
        if (!entry || typeof entry.pem !== 'string') return null;
        if (entry.notAfter !== null && this.nowFn() > entry.notAfter) return null;
        return entry.pem;
    }

    verify(signed) {
        // 1) Şema
        if (!signed || typeof signed !== 'object' || !signed.order || typeof signed.signature !== 'string') {
            return { ok: false, code: 'MALFORMED', error: 'Geçersiz imzalı emir gövdesi.' };
        }
        const order = signed.order;
        const schema = validateOrder(order);
        if (!schema.ok) return schema;

        // 2) Sürüm (şemada doğrulandı; açık kod döndürülür)
        if (order.version !== ORDER_VERSION) {
            return { ok: false, code: 'INVALID_VERSION', error: 'Desteklenmeyen emir sürümü.' };
        }
        // 3) Yayıncı
        if (order.issuer !== ISSUER) {
            return { ok: false, code: 'BAD_ISSUER', error: 'Emir yayıncısı konsol değil.' };
        }
        // 4) Hedef bağlama
        if (this.agentId) {
            if (order.targets.length !== 1 || order.targets[0] !== this.agentId) {
                return { ok: false, code: 'WRONG_TARGET', error: 'Emir bu ajana yönelik değil.' };
            }
        }

        // 5) Zaman
        const now = this.nowFn();
        if (order.issuedAt - now > this.clockSkewMs) {
            return { ok: false, code: 'CLOCK_SKEW', error: 'issuedAt gelecekte; saat farkı tolerans dışında.' };
        }
        if (order.expiresAt <= order.issuedAt || order.expiresAt - order.issuedAt > this.maxTtlMs) {
            return { ok: false, code: 'INVALID_EXPIRY', error: 'Emir geçerlilik aralığı geçersiz.' };
        }
        if (now >= order.expiresAt) {
            return { ok: false, code: 'EXPIRED', error: 'Emrin süresi geçmiş.' };
        }

        // 6) Nonce / replay (işaretleme imza sonrası)
        if (!Nonce.isValid(order.nonce)) {
            return { ok: false, code: 'INVALID_NONCE', error: 'Emir nonce değeri geçersiz.' };
        }
        this.prune();
        if (this.seenNonces.has(order.nonce)) {
            return { ok: false, code: 'REPLAY', error: 'Tekrar-gönderim (replay) reddedildi.' };
        }

        // 7) keyId
        const pem = this.keyFor(order.keyId);
        if (!pem) {
            // Hiç anahtar yoksa ayrı kod: yapılandırma eksikliği.
            if (this.publicKeys.size === 0) {
                return { ok: false, code: 'NO_TRUST_ANCHOR', error: 'Konsol anahtarı tanımsız; emir reddedildi.' };
            }
            return { ok: false, code: 'UNKNOWN_KEY', error: 'keyId bilinmiyor veya süresi dolmuş.' };
        }
        if (signed.alg && signed.alg !== 'ed25519') {
            return { ok: false, code: 'UNSUPPORTED_ALG', error: 'Desteklenmeyen imza algoritması.' };
        }
        if (signed.keyId !== undefined && signed.keyId !== order.keyId) {
            return { ok: false, code: 'KEY_ID_MISMATCH', error: 'İmza anahtar kimliği emirle uyuşmuyor.' };
        }

        // 8) İmza (tam emir, params dahil)
        let sigBuf;
        try {
            sigBuf = Buffer.from(signed.signature, 'base64');
        } catch (_) {
            return { ok: false, code: 'MALFORMED', error: 'İmza base64 değil.' };
        }
        let valid = false;
        try {
            valid = crypto.verify(null, canonical(order), crypto.createPublicKey(pem), sigBuf);
        } catch (_) {
            valid = false;
        }
        if (!valid) {
            return { ok: false, code: 'BAD_SIGNATURE', error: 'İmza doğrulanamadı.' };
        }

        // 9) Eylem parametreleri yapısal olarak geçti (şema). İcra katmanı
        // bilinmeyen eylemi kendi tarafında reddeder.
        // WP-11.T10: nonce yalnızca imza doğrulandıktan SONRA atomik işaretlenir.
        if (this.storage && this.storage.maintenanceMode === true) {
            return { ok: false, code: 'STORAGE_MAINTENANCE', error: 'Depo bakım modunda; emir kabul edilmedi.' };
        }
        if (this.storage && typeof this.storage.consumeNonce === 'function') {
            if (!this.storage.consumeNonce(order.nonce, order.expiresAt)) {
                return { ok: false, code: 'REPLAY', error: 'Tekrar-gönderim (replay) reddedildi.' };
            }
        } else {
            this.persist(order.nonce, order.expiresAt);
        }
        this.seenNonces.set(order.nonce, order.expiresAt);
        return { ok: true, order };
    }
}

module.exports = {
    SignedOrderService,
    generateKeyPair,
    sign,
    canonical,
    normalizeForSigning,
    initCanonicalizer,
    _resetCanonicalizerForTests,
    MAX_FUTURE_SKEW_MS,
    MAX_TTL_MS,
    // Geriye uyumluluk (eski test/araçlar sabit adı kullanıyor).
    MAX_SKEW_SEC: Math.floor(MAX_FUTURE_SKEW_MS / 1000)
};
