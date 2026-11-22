/**
 * Pin.js - WP-04.T4
 * PIN türetimi/doğrulaması: Argon2id (m=19456 KiB, t=2, p=1, 16 bayt salt,
 * 32 bayt çıktı, PHC string). Eski SHA-256(salt:pin) kayıtları doğrulandıktan
 * sonra Argon2id'e yükseltilir. scrypt fallback YOKTUR.
 */

const crypto = require('crypto');
const argon2 = require('@node-rs/argon2');
const { safeCompare } = require('./safeCompare');

const PIN_PARAMS = Object.freeze({
    algorithm: argon2.Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
});
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function isArgon2Hash(stored) {
    return typeof stored === 'string' && stored.startsWith('$argon2');
}

function isArgon2id(stored) {
    return typeof stored === 'string' && stored.startsWith('$argon2id$');
}

function legacyParts(stored) {
    if (!stored) return null;
    if (typeof stored === 'string') {
        const m = stored.match(/^sha256:([0-9a-f]{8,64}):([0-9a-f]{64})$/i);
        return m ? { salt: m[1], hash: m[2] } : null;
    }
    if (typeof stored === 'object' && typeof stored.hash === 'string' && typeof stored.salt === 'string') {
        return { salt: stored.salt, hash: stored.hash };
    }
    return null;
}

function parseArgon2Params(stored) {
    if (!isArgon2Hash(stored)) return null;
    const m = stored.match(/^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/);
    if (!m) return null;
    return { variant: m[1], version: Number(m[2]), memoryCost: Number(m[3]), timeCost: Number(m[4]), parallelism: Number(m[5]) };
}

function needsRehash(stored) {
    if (!isArgon2id(stored)) return true;
    const p = parseArgon2Params(stored);
    if (!p) return true;
    return p.memoryCost !== PIN_PARAMS.memoryCost
        || p.timeCost !== PIN_PARAMS.timeCost
        || p.parallelism !== PIN_PARAMS.parallelism;
}

async function hashPin(pin) {
    if (typeof pin !== 'string') {
        throw Object.assign(new Error('PIN metin olmalı.'), { code: 'INVALID_PIN' });
    }
    return argon2.hash(pin, {
        ...PIN_PARAMS,
        salt: crypto.randomBytes(SALT_BYTES),
        outputLen: HASH_BYTES
    });
}

/**
 * @returns {Promise<{ok:boolean, legacy:boolean, needsRehash:boolean, code?:string}>}
 */
async function verifyPin(pin, stored) {
    if (typeof pin !== 'string' || pin.length === 0) {
        return { ok: false, legacy: false, needsRehash: false, code: 'PIN_REQUIRED' };
    }
    if (isArgon2Hash(stored)) {
        let ok = false;
        try {
            ok = await argon2.verify(stored, pin);
        } catch (_) {
            ok = false;
        }
        return { ok, legacy: false, needsRehash: ok && needsRehash(stored) };
    }
    const legacy = legacyParts(stored);
    if (!legacy) {
        return { ok: false, legacy: false, needsRehash: false, code: 'PIN_HASH_INVALID' };
    }
    const expected = crypto.createHash('sha256').update(`${legacy.salt}:${pin}`).digest('hex');
    const ok = safeCompare(expected, legacy.hash);
    return { ok, legacy: true, needsRehash: ok };
}

module.exports = {
    PIN_PARAMS,
    SALT_BYTES,
    HASH_BYTES,
    hashPin,
    verifyPin,
    needsRehash,
    isArgon2Hash,
    isArgon2id,
    parseArgon2Params,
    legacyParts
};
