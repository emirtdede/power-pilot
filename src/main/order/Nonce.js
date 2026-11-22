/**
 * Nonce.js - WP-01 / WP-03 / WP-11 ortak nonce semantiği.
 * Nonce yalnızca sunucu tarafında üretilir; istemciden gelen değer biçim
 * doğrulamasından geçmeden kuyruğa/işaretlemeye alınmaz.
 */

const crypto = require('crypto');

const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;

function generate(nowMs = Date.now()) {
    return `${nowMs.toString(36)}-${crypto.randomBytes(16).toString('hex')}`;
}

function isValid(nonce) {
    return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

function isExpired(nonceRecord, nowMs = Date.now()) {
    if (!nonceRecord || typeof nonceRecord !== 'object') return true;
    const exp = Number(nonceRecord.expiresAt ?? nonceRecord.exp);
    return !Number.isFinite(exp) || exp <= nowMs;
}

module.exports = { NONCE_RE, generate, isValid, isExpired };
