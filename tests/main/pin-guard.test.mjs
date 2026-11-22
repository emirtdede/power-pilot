/**
 * pin-guard.test.mjs - WBS-11.2 / WP-04.T4
 * PIN doğrulama: format, başarı, yanlış-sayacı, kilit (5/15dk),
 * Argon2id parametreleri, eski SHA-256 kaydının yükseltilmesi.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { PinGuard, DEFAULT_LOCK_MS } from '../../src/main/ipc/pinGuard.js';
import * as Pin from '../../src/main/security/Pin.js';

function guardAt(now) {
    let t = now;
    const g = new PinGuard({ nowFn: () => t });
    return { g, advance: (ms) => { t += ms; } };
}

// Eski kayıt biçimi: hızlı doğrulanır (yanlış-deneme testleri için).
const LEGACY = (() => {
    const salt = 'sabit-tuz-test';
    return { salt, hash: PinGuard.hashPin('1234', salt) };
})();

let ARGON = null;
beforeAll(async () => {
    ARGON = await Pin.hashPin('1234');
});

describe('PinGuard (WBS-11.2 / WP-04)', () => {
    it('PIN kurulu değilse serbest', async () => {
        const { g } = guardAt(1000);
        await expect(g.check('cancel', undefined, null)).resolves.toEqual({ ok: true });
    });

    it('doğru PIN geçer, sayaç temizlenir', async () => {
        const { g } = guardAt(1000);
        expect((await g.check('cancel', '0000', LEGACY)).code).toBe('PIN_WRONG');
        await expect(g.check('cancel', '1234', LEGACY)).resolves.toEqual({ ok: true, legacy: true, upgrade: expect.any(String) });
        // Temizlendi: sonraki yanlış yine 4 hak bırakır
        expect(await g.check('cancel', '0000', LEGACY)).toMatchObject({ code: 'PIN_WRONG', attemptsLeft: 4 });
    });

    it('Argon2id kayıt doğrulanır ve upgrade dönmez', async () => {
        const { g } = guardAt(1000);
        await expect(g.check('cancel', '1234', ARGON)).resolves.toEqual({ ok: true });
        expect(Pin.isArgon2id(ARGON)).toBe(true);
        const p = Pin.parseArgon2Params(ARGON);
        expect(p).toMatchObject({ variant: 'id', version: 19, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    });

    it('PIN verilmezse PIN_REQUIRED', async () => {
        const { g } = guardAt(1000);
        expect((await g.check('cancel', undefined, LEGACY)).code).toBe('PIN_REQUIRED');
        expect((await g.check('cancel', '', LEGACY)).code).toBe('PIN_REQUIRED');
    });

    it('5 yanlışta kilitlenir (PIN_LOCKED + 15dk)', async () => {
        const { g } = guardAt(1000);
        for (let i = 0; i < 4; i++) {
            expect((await g.check('cancel', '0000', LEGACY)).code).toBe('PIN_WRONG');
        }
        const locked = await g.check('cancel', '0000', LEGACY);
        expect(locked.code).toBe('PIN_LOCKED');
        expect(locked.retryAfterSec).toBe(Math.ceil(DEFAULT_LOCK_MS / 1000));
        expect(locked.retryAfterSec).toBe(900);
        // Kilitliyken doğru PIN bile geçemez
        expect((await g.check('cancel', '1234', ARGON)).code).toBe('PIN_LOCKED');
    });

    it('kilit süresi dolunca sayaç sıfırlanır ve doğru PIN geçer', async () => {
        const { g, advance } = guardAt(1000);
        for (let i = 0; i < 5; i++) await g.check('cancel', '0000', LEGACY);
        advance(DEFAULT_LOCK_MS + 1000);
        await expect(g.check('cancel', '1234', ARGON)).resolves.toEqual({ ok: true });
    });

    it('farklı kapsamlar ayrı sayılır', async () => {
        const { g } = guardAt(1000);
        for (let i = 0; i < 5; i++) await g.check('a', '0000', LEGACY);
        expect((await g.check('a', '1234', ARGON)).code).toBe('PIN_LOCKED');
        await expect(g.check('b', '1234', ARGON)).resolves.toEqual({ ok: true });
    });

    it('format ve legacy hash kuralları', () => {
        expect(PinGuard.validFormat('1234')).toBe(true);
        expect(PinGuard.validFormat('12345678')).toBe(true);
        expect(PinGuard.validFormat('123')).toBe(false);
        expect(PinGuard.validFormat('123456789')).toBe(false);
        expect(PinGuard.validFormat('abcd')).toBe(false);
        expect(PinGuard.validFormat(1234)).toBe(false);
        expect(PinGuard.hashPin('1234', 's')).toHaveLength(64);
        expect(PinGuard.newSalt().length).toBeGreaterThanOrEqual(16);
    });

    it('bozuk kayıt doğrulamayı reddeder ve sayaç işler', async () => {
        const { g } = guardAt(1000);
        const res = await g.check('cancel', '1234', 'bozuk');
        expect(res.code).toBe('PIN_WRONG');
        expect(res.attemptsLeft).toBe(4);
    });
});
