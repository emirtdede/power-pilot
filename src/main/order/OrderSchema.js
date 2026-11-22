/**
 * OrderSchema.js - WP-01.T1
 * OrderV2 yapısal doğrulayıcısı. İmza doğrulamasından ÖNCE çalışır; amaç
 * imza katmanına yalnızca dar, tipli ve sınırlı bir nesne ulaştırmaktır.
 *
 * İlkeler:
 * - Bilinmeyen alan kabul edilmez (yazım hatası sessizce imza dışı kalmasın).
 * - `__proto__`, `constructor`, `prototype` anahtarları derinlemesine yasak.
 * - Derinlik, anahtar sayısı, string uzunluğu ve params boyutu sınırlıdır.
 * - `targets` boş olamaz ve tekil olmalıdır.
 */

const { NONCE_RE } = require('./Nonce');

const ORDER_VERSION = 2;
const MAX_DEPTH = 8;
const MAX_KEYS = 64;
const MAX_ARRAY = 64;
const MAX_STRING = 4096;
const MAX_PARAMS_BYTES = 64 * 1024;

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const ACTION_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ISSUER = 'console';

const ALLOWED_FIELDS = new Set([
    'version', 'action', 'params', 'targets', 'nonce',
    'issuedAt', 'expiresAt', 'issuer', 'keyId'
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(code, error) {
    return { ok: false, code, error };
}

function inspectValue(value, depth) {
    if (depth > MAX_DEPTH) return fail('ORDER_TOO_DEEP', `Emir en fazla ${MAX_DEPTH} katman olabilir.`);
    if (value === null) return { ok: true };
    const type = typeof value;
    if (type === 'string') {
        if (value.length > MAX_STRING) return fail('ORDER_TOO_LARGE', `Metin alanı en fazla ${MAX_STRING} karakter olabilir.`);
        return { ok: true };
    }
    if (type === 'number') {
        if (!Number.isFinite(value)) return fail('INVALID_ORDER', 'Sayısal alan sonlu olmalı.');
        return { ok: true };
    }
    if (type === 'boolean') return { ok: true };
    if (Array.isArray(value)) {
        if (value.length > MAX_ARRAY) return fail('ORDER_TOO_LARGE', `Dizi en fazla ${MAX_ARRAY} öğe içerebilir.`);
        for (const item of value) {
            const r = inspectValue(item, depth + 1);
            if (!r.ok) return r;
        }
        return { ok: true };
    }
    if (type === 'object') {
        const keys = Object.keys(value);
        if (keys.length > MAX_KEYS) return fail('ORDER_TOO_LARGE', `Nesne en fazla ${MAX_KEYS} anahtar içerebilir.`);
        for (const key of keys) {
            if (FORBIDDEN_KEYS.has(key)) return fail('FORBIDDEN_KEY', `Yasaklı anahtar: ${key}.`);
            const r = inspectValue(value[key], depth + 1);
            if (!r.ok) return r;
        }
        return { ok: true };
    }
    return fail('INVALID_ORDER', `Desteklenmeyen değer tipi: ${type}.`);
}

function validateOrder(order) {
    if (!order || typeof order !== 'object' || Array.isArray(order)) {
        return fail('INVALID_ORDER', 'Emir bir nesne olmalı.');
    }
    for (const key of Object.keys(order)) {
        if (!ALLOWED_FIELDS.has(key)) return fail('UNKNOWN_ORDER_FIELD', `Bilinmeyen emir alanı: ${key}.`);
    }
    const deep = inspectValue(order, 0);
    if (!deep.ok) return deep;

    if (order.version !== ORDER_VERSION) {
        return fail('INVALID_VERSION', `Emir sürümü ${ORDER_VERSION} olmalı.`);
    }
    if (order.issuer !== ISSUER) {
        return fail('BAD_ISSUER', 'Emir yalnızca konsol tarafından yayınlanabilir.');
    }
    if (typeof order.action !== 'string' || !ACTION_RE.test(order.action)) {
        return fail('INVALID_ACTION', 'Emir eylemi geçersiz.');
    }
    if (!Array.isArray(order.targets) || order.targets.length === 0) {
        return fail('INVALID_TARGET', 'Emir en az bir hedef içermelidir.');
    }
    if (order.targets.length > 16) {
        return fail('INVALID_TARGET', 'Emir en fazla 16 hedef içerebilir.');
    }
    const seenTargets = new Set();
    for (const t of order.targets) {
        if (typeof t !== 'string' || !TARGET_RE.test(t)) {
            return fail('INVALID_TARGET', 'Hedef kimliği geçersiz.');
        }
        if (seenTargets.has(t)) return fail('INVALID_TARGET', 'Hedefler tekil olmalıdır.');
        seenTargets.add(t);
    }
    if (!NONCE_RE.test(order.nonce || '')) {
        return fail('INVALID_NONCE', 'Emir nonce değeri geçersiz.');
    }
    if (!Number.isInteger(order.issuedAt) || order.issuedAt <= 0) {
        return fail('INVALID_TIME', 'issuedAt geçersiz.');
    }
    if (!Number.isInteger(order.expiresAt) || order.expiresAt <= 0) {
        return fail('INVALID_EXPIRY', 'expiresAt geçersiz.');
    }
    if (order.expiresAt <= order.issuedAt) {
        return fail('INVALID_EXPIRY', 'expiresAt issuedAt sonrasında olmalı.');
    }
    if (typeof order.keyId !== 'string' || !KEY_ID_RE.test(order.keyId)) {
        return fail('INVALID_KEY_ID', 'keyId geçersiz.');
    }
    if (order.params !== undefined) {
        if (!order.params || typeof order.params !== 'object' || Array.isArray(order.params)) {
            return fail('INVALID_PARAMS', 'params bir nesne olmalı.');
        }
        let bytes = 0;
        try {
            bytes = Buffer.byteLength(JSON.stringify(order.params), 'utf8');
        } catch (_) {
            return fail('INVALID_PARAMS', 'params serileştirilemedi.');
        }
        if (bytes > MAX_PARAMS_BYTES) {
            return fail('ORDER_TOO_LARGE', `params en fazla ${MAX_PARAMS_BYTES} bayt olabilir.`);
        }
    }
    return { ok: true };
}

module.exports = {
    ORDER_VERSION,
    ISSUER,
    MAX_DEPTH,
    MAX_PARAMS_BYTES,
    ALLOWED_FIELDS,
    FORBIDDEN_KEYS,
    validateOrder
};
