/**
 * pinGuard.js - WBS-11.2 / WP-04.T4
 * İptal PIN'i doğrulama: Argon2id + 5 yanlış denemede 15 dakika kilit.
 * Eski SHA-256(salt:pin) kayıtları doğrulandıktan sonra çağırana `upgrade`
 * (yeni Argon2id PHC) döner; çağıran atomik olarak kaydeder.
 * Deneme sayacı işlem-içidir; yeniden başlatmada sıfırlanır (hash diskte kalır).
 */

const crypto = require('crypto');
const Pin = require('../security/Pin');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LOCK_MS = 15 * 60 * 1000;

class PinGuard {
    constructor({ nowFn = Date.now, maxAttempts = DEFAULT_MAX_ATTEMPTS, lockMs = DEFAULT_LOCK_MS } = {}) {
        this.nowFn = nowFn;
        this.maxAttempts = maxAttempts;
        this.lockMs = lockMs;
        this.attempts = new Map();
    }

    static validFormat(pin) {
        return typeof pin === 'string' && /^[0-9]{4,8}$/.test(pin);
    }

    /** @deprecated Yalnızca eski kayıtları doğrulamak için; yeni PIN Argon2id. */
    static hashPin(pin, salt) {
        return crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
    }

    /** @deprecated Eski kayıt biçimi; yeni kayıtlar Argon2id salt'ını PHC içinde taşır. */
    static newSalt() {
        return crypto.randomBytes(16).toString('hex');
    }

    registerFail(scope, st, now) {
        st.count += 1;
        if (st.count >= this.maxAttempts) {
            st.lockedUntil = now + this.lockMs;
            st.count = 0;
            this.attempts.set(scope, st);
            return { ok: false, code: 'PIN_LOCKED', retryAfterSec: Math.ceil(this.lockMs / 1000) };
        }
        this.attempts.set(scope, st);
        return { ok: false, code: 'PIN_WRONG', attemptsLeft: this.maxAttempts - st.count };
    }

    /**
     * @param {string} scope - sayaç anahtarı (örn. 'cancel')
     * @param {string|undefined} pin - kullanıcının verdiği PIN
     * @param {string|{hash:string,salt:string}|null} stored - Argon2id PHC veya legacy kayıt
     * @returns {Promise<{ok:boolean, code?:string, upgrade?:string, retryAfterSec?:number, attemptsLeft?:number}>}
     */
    async check(scope, pin, stored) {
        const now = this.nowFn();
        const st = this.attempts.get(scope) || { count: 0, lockedUntil: 0 };
        if (st.lockedUntil > now) {
            return { ok: false, code: 'PIN_LOCKED', retryAfterSec: Math.ceil((st.lockedUntil - now) / 1000) };
        }
        if (st.lockedUntil && st.lockedUntil <= now) {
            st.lockedUntil = 0;
            st.count = 0;
        }
        if (!stored || (typeof stored === 'object' && !stored.hash)) return { ok: true };
        if (pin === undefined || pin === null || pin === '') {
            return { ok: false, code: 'PIN_REQUIRED', message: 'İptal PIN’i gerekli.' };
        }
        if (!PinGuard.validFormat(pin)) {
            return this.registerFail(scope, st, now);
        }
        let verified;
        try {
            verified = await Pin.verifyPin(pin, stored);
        } catch (_) {
            verified = { ok: false };
        }
        if (!verified.ok) {
            return this.registerFail(scope, st, now);
        }
        this.attempts.delete(scope);
        const out = { ok: true };
        if (verified.needsRehash) {
            try {
                out.upgrade = await Pin.hashPin(pin);
            } catch (_) {
                // Yükseltme başarısızsa doğrulama yine geçerli; bir sonraki girişte denenir.
            }
        }
        if (verified.legacy) out.legacy = true;
        return out;
    }
}

module.exports = { PinGuard, DEFAULT_MAX_ATTEMPTS, DEFAULT_LOCK_MS };
