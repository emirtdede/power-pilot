/**
 * safeCompare.js - WP-01.T8 / M-01
 * Uzunluk farkından zamanlama oracle'ı sızdırmamak için iki girdi de SHA-256
 * ile 32 bayta normalize edilir ve crypto.timingSafeEqual bir kez çağrılır.
 * Dönüşüm hataları istisna fırlatmaz; yalnızca false döner.
 */

const crypto = require('crypto');

function normalize(value) {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ''), 'utf8');
    return crypto.createHash('sha256').update(input).digest();
}

function safeCompare(a, b) {
    try {
        const left = normalize(a);
        const right = normalize(b);
        return crypto.timingSafeEqual(left, right);
    } catch (_) {
        return false;
    }
}

module.exports = { safeCompare };
