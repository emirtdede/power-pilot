/**
 * signed-orders.test.mjs - FAZ A
 * Ed25519 imzalı emir: geçerli kabul, imzasız/bozuk/süresi-geçmiş/tekrar red.
 */
import { describe, it, expect } from 'vitest';
import { SignedOrderService, generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';

function makeOrder(overrides = {}) {
    const now = Date.now();
    return Object.assign(
        { action: 'lock', targets: ['pilot-pc-01'], nonce: `n-${Math.random().toString(36).slice(2)}`, issuedAt: now, expiresAt: now + 60000, issuer: 'console' },
        overrides
    );
}

describe('SignedOrderService (FAZ A iskeleti)', () => {
    it('geçerli imzalı emir kabul edilir', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        const res = svc.verify(sign(makeOrder(), privateKey));
        expect(res.ok).toBe(true);
        expect(res.order.action).toBe('lock');
    });

    it('güven kökü yoksa fail-closed (tümü red)', () => {
        const { privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: null });
        const res = svc.verify(sign(makeOrder(), privateKey));
        expect(res.ok).toBe(false);
        expect(res.code).toBe('NO_TRUST_ANCHOR');
    });

    it('yanlış anahtarla imza reddedilir', () => {
        const a = generateKeyPair();
        const b = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: a.publicKey });
        const res = svc.verify(sign(makeOrder(), b.privateKey));
        expect(res.ok).toBe(false);
        expect(res.code).toBe('BAD_SIGNATURE');
    });

    it('süresi geçmiş emir reddedilir', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        const now = Date.now();
        const order = makeOrder({ issuedAt: now - 1000, expiresAt: now - 500 });
        expect(svc.verify(sign(order, privateKey)).code).toBe('EXPIRED');
    });

    it('tekrar-gönderim (replay) reddedilir', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        const order = makeOrder({ nonce: 'sabit-nonce-1' });
        const signed = sign(order, privateKey);
        expect(svc.verify(signed).ok).toBe(true);
        const again = svc.verify(sign(order, privateKey));
        expect(again.ok).toBe(false);
        expect(again.code).toBe('REPLAY');
    });

    it('bozuk gövde reddedilir', () => {
        const { publicKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        expect(svc.verify(null).ok).toBe(false);
        expect(svc.verify({ order: null, signature: 'x' }).code).toBe('MALFORMED');
    });

    it('yeniden başlatma sonrası tekrar reddedilir (K5 kalıcı nonce)', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const store = { seen: [] };
        const storage = {
            getSeenNonces: () => store.seen,
            saveSeenNonces: (l) => { store.seen = l; }
        };
        const now = Date.now();
        const signed = sign({ action: 'lock', targets: ['a1'], nonce: 'persist-1', issuedAt: now, expiresAt: now + 600000, issuer: 'console' }, privateKey);
        const first = new SignedOrderService({ publicKeyPem: publicKey, storage });
        expect(first.verify(signed).ok).toBe(true);
        // "Yeniden başlatma": yepyeni örnek, aynı depo.
        const second = new SignedOrderService({ publicKeyPem: publicKey, storage });
        const again = second.verify(signed);
        expect(again.ok).toBe(false);
        expect(again.code).toBe('REPLAY');
    });

    it('deposuz kip geriye uyumlu çalışır', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        const now = Date.now();
        const signed = sign({ action: 'lock', targets: ['a1'], nonce: 'mem-nonce-0001', issuedAt: now, expiresAt: now + 60000, issuer: 'console' }, privateKey);
        expect(svc.verify(signed).ok).toBe(true);
    });
});
