/**
 * order-v2.test.mjs - WP-01 kabul testleri (T-ORD-01..09)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    SignedOrderService,
    generateKeyPair,
    sign,
    initCanonicalizer,
    _resetCanonicalizerForTests
} from '../../src/main/services/SignedOrderService.js';
import { validateOrder } from '../../src/main/order/OrderSchema.js';
import Nonce from '../../src/main/order/Nonce.js';
import { safeCompare } from '../../src/main/security/safeCompare.js';

const NOW = 1_800_000_000_000;

function orderFor(overrides = {}) {
    return {
        version: 2,
        action: 'lock',
        params: { policy: { action: 'sleep' } },
        targets: ['agent_A'],
        nonce: Nonce.generate(NOW),
        issuedAt: NOW,
        expiresAt: NOW + 60_000,
        issuer: 'console',
        keyId: 'default',
        ...overrides
    };
}

function verifier(publicKey, opts = {}) {
    return new SignedOrderService({ publicKeyPem: publicKey, nowFn: () => NOW, ...opts });
}

describe('OrderSchema', () => {
    it('geçerli v2 emri kabul eder', () => {
        expect(validateOrder(orderFor())).toMatchObject({ ok: true });
    });

    it('bilinmeyen alan, yasak anahtar ve sınırları reddeder', () => {
        expect(validateOrder(orderFor({ extra: 1 })).code).toBe('UNKNOWN_ORDER_FIELD');
        expect(validateOrder(orderFor({ params: JSON.parse('{"__proto__":{"x":1}}') })).code).toBe('FORBIDDEN_KEY');
        expect(validateOrder(orderFor({ targets: [] })).code).toBe('INVALID_TARGET');
        expect(validateOrder(orderFor({ targets: ['a', 'a'] })).code).toBe('INVALID_TARGET');
        expect(validateOrder(orderFor({ version: 1 })).code).toBe('INVALID_VERSION');
        expect(validateOrder(orderFor({ issuer: 'agent' })).code).toBe('BAD_ISSUER');
        expect(validateOrder(orderFor({ expiresAt: NOW - 1 })).code).toBe('INVALID_EXPIRY');
        expect(validateOrder(orderFor({ params: { x: 'a'.repeat(70 * 1024) } })).code).toBe('ORDER_TOO_LARGE');
    });
});

describe('SignedOrderService v2', () => {
    let kp;
    beforeEach(() => { kp = generateKeyPair(); });

    it('T-ORD-01 params imza kapsamındadır; değiştirilirse BAD_SIGNATURE', () => {
        const svc = verifier(kp.publicKey);
        const signed = sign(orderFor(), kp.privateKey);
        expect(svc.verify(signed).ok).toBe(true);

        const tampered = JSON.parse(JSON.stringify(signed));
        tampered.order.params.policy.action = 'shutdown';
        const res = verifier(kp.publicKey).verify(tampered);
        expect(res.ok).toBe(false);
        expect(res.code).toBe('BAD_SIGNATURE');
    });

    it('T-ORD-02 başka ajanın emri WRONG_TARGET', () => {
        const svc = verifier(kp.publicKey, { agentId: 'agent_B' });
        const res = svc.verify(sign(orderFor({ targets: ['agent_A'] }), kp.privateKey));
        expect(res.ok).toBe(false);
        expect(res.code).toBe('WRONG_TARGET');
    });

    it('T-ORD-03 süre ve yayıncı', () => {
        const svc = verifier(kp.publicKey);
        const expired = sign(orderFor({ issuedAt: NOW - 600000, expiresAt: NOW - 1000 }), kp.privateKey);
        expect(svc.verify(expired).code).toBe('EXPIRED');

        const badIssuerSigned = sign(orderFor(), kp.privateKey);
        badIssuerSigned.order.issuer = 'agent';
        expect(verifier(kp.publicKey).verify(badIssuerSigned).code).toBe('BAD_ISSUER');
    });

    it('T-ORD-04 aynı nonce ikinci kez REPLAY', () => {
        const svc = verifier(kp.publicKey);
        const signed = sign(orderFor(), kp.privateKey);
        expect(svc.verify(signed).ok).toBe(true);
        const again = svc.verify(signed);
        expect(again.ok).toBe(false);
        expect(again.code).toBe('REPLAY');
    });

    it('T-ORD-07 safeCompare normalize eder, istisna fırlatmaz', () => {
        expect(safeCompare('abc', 'abc')).toBe(true);
        expect(safeCompare('abc', 'abd')).toBe(false);
        expect(safeCompare('kısa', 'çok daha uzun bir değer')).toBe(false);
        expect(safeCompare(null, undefined)).toBe(true); // ikisi de boş string'e normalize olur
        expect(safeCompare(Buffer.from('x'), 'x')).toBe(true);
    });

    it('T-ORD-08 kanonikleştirici hazır değilse CANONICALIZER_NOT_READY', async () => {
        _resetCanonicalizerForTests();
        try {
            expect(() => sign(orderFor(), kp.privateKey)).toThrow(/Kanonikleştirici/);
            let code = null;
            try { sign(orderFor(), kp.privateKey); } catch (err) { code = err.code; }
            expect(code).toBe('CANONICALIZER_NOT_READY');
            await initCanonicalizer();
            expect(verifier(kp.publicKey).verify(sign(orderFor(), kp.privateKey)).ok).toBe(true);
        } finally {
            await initCanonicalizer();
        }
    });

    it('T-ORD-09 saat kayması ve geçersiz ömür', () => {
        const svc = verifier(kp.publicKey);
        const future = sign(orderFor({ issuedAt: NOW + 180000, expiresAt: NOW + 240000 }), kp.privateKey);
        expect(svc.verify(future).code).toBe('CLOCK_SKEW');

        const longLived = sign(orderFor({ issuedAt: NOW, expiresAt: NOW + 11 * 60000 }), kp.privateKey);
        expect(verifier(kp.publicKey).verify(longLived).code).toBe('INVALID_EXPIRY');
    });

    it('keyId rotasyonu: eski anahtar notAfter sonrası reddedilir, yenisi çalışır', () => {
        const newKp = generateKeyPair();
        const svc = new SignedOrderService({
            publicKeys: {
                old: { pem: kp.publicKey, notAfter: NOW - 1 },
                new: newKp.publicKey
            },
            nowFn: () => NOW
        });
        const oldSigned = sign(orderFor({ keyId: 'old' }), kp.privateKey, 'old');
        expect(svc.verify(oldSigned).code).toBe('UNKNOWN_KEY');

        const newSigned = sign(orderFor({ keyId: 'new' }), newKp.privateKey, 'new');
        expect(svc.verify(newSigned).ok).toBe(true);
    });

    it('bilinmeyen keyId UNKNOWN_KEY', () => {
        const svc = verifier(kp.publicKey);
        const signed = sign(orderFor(), kp.privateKey);
        signed.order.keyId = 'baska';
        signed.keyId = 'baska';
        expect(svc.verify(signed).code).toBe('UNKNOWN_KEY');
    });
});
