/**
 * order-schema-strict.test.mjs - OrderSchema + SignedOrderService
 *
 * Tümü saf doğrulama/imza kodudur; OS çağrısı yok. Anahtarlar testte üretilir.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';

import {
    ORDER_VERSION,
    ISSUER,
    MAX_DEPTH,
    MAX_PARAMS_BYTES,
    ALLOWED_FIELDS,
    FORBIDDEN_KEYS,
    validateOrder
} from '../../src/main/order/OrderSchema.js';
import orderModule from '../../src/main/services/SignedOrderService.js';

const { SignedOrderService, generateKeyPair, sign, canonical, normalizeForSigning, initCanonicalizer, _resetCanonicalizerForTests, MAX_FUTURE_SKEW_MS, MAX_TTL_MS } = orderModule;

const baseOrder = (over = {}) => Object.assign({
    version: ORDER_VERSION,
    issuer: ISSUER,
    action: 'lock',
    targets: ['agent-1'],
    nonce: 'n-0123456789abcdef',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    keyId: 'default'
}, over);

describe('OrderSchema', () => {
    it('sabitler', () => {
        expect(ORDER_VERSION).toBe(2);
        expect(ISSUER).toBe('console');
        expect(MAX_DEPTH).toBe(8);
        expect(MAX_PARAMS_BYTES).toBe(65536);
        expect(ALLOWED_FIELDS.size).toBe(9);
        expect(FORBIDDEN_KEYS.has('__proto__')).toBe(true);
    });

    it('geçerli emir kabul edilir', () => {
        expect(validateOrder(baseOrder())).toEqual({ ok: true });
        expect(validateOrder(baseOrder({ params: { nested: [1, 'a', true, null] } }))).toEqual({ ok: true });
    });

    it('gövde/sürüm/yayıncı hataları', () => {
        expect(validateOrder(null).code).toBe('INVALID_ORDER');
        expect(validateOrder([]).code).toBe('INVALID_ORDER');
        expect(validateOrder('x').code).toBe('INVALID_ORDER');
        expect(validateOrder(baseOrder({ version: 1 })).code).toBe('INVALID_VERSION');
        expect(validateOrder(baseOrder({ issuer: 'agent' })).code).toBe('BAD_ISSUER');
        expect(validateOrder(baseOrder({ hack: 1 })).code).toBe('UNKNOWN_ORDER_FIELD');
    });

    it('eylem deseni', () => {
        expect(validateOrder(baseOrder({ action: 'Lock' })).code).toBe('INVALID_ACTION');
        expect(validateOrder(baseOrder({ action: '1x' })).code).toBe('INVALID_ACTION');
        expect(validateOrder(baseOrder({ action: 5 })).code).toBe('INVALID_ACTION');
        expect(validateOrder(baseOrder({ action: 'hibernate' })).ok).toBe(true);
    });

    it('targets: boş, fazla, geçersiz, yinelenen', () => {
        expect(validateOrder(baseOrder({ targets: [] })).code).toBe('INVALID_TARGET');
        expect(validateOrder(baseOrder({ targets: Array.from({ length: 17 }, (_, i) => `a${i}`) })).code).toBe('INVALID_TARGET');
        expect(validateOrder(baseOrder({ targets: ['bad target'] })).code).toBe('INVALID_TARGET');
        expect(validateOrder(baseOrder({ targets: ['a', 'a'] })).code).toBe('INVALID_TARGET');
        expect(validateOrder(baseOrder({ targets: [5] })).code).toBe('INVALID_TARGET');
    });

    it('nonce / zaman / keyId', () => {
        expect(validateOrder(baseOrder({ nonce: 'x' })).code).toBe('INVALID_NONCE');
        expect(validateOrder(baseOrder({ issuedAt: 0 })).code).toBe('INVALID_TIME');
        expect(validateOrder(baseOrder({ expiresAt: 'y' })).code).toBe('INVALID_EXPIRY');
        expect(validateOrder(baseOrder({ issuedAt: 5000, expiresAt: 5000 })).code).toBe('INVALID_EXPIRY');
        expect(validateOrder(baseOrder({ keyId: 'a'.repeat(65) })).code).toBe('INVALID_KEY_ID');
        expect(validateOrder(baseOrder({ keyId: '' })).code).toBe('INVALID_KEY_ID');
    });

    it('params türü ve boyutu', () => {
        expect(validateOrder(baseOrder({ params: [] })).code).toBe('INVALID_PARAMS');
        expect(validateOrder(baseOrder({ params: 'x' })).code).toBe('INVALID_PARAMS');
        expect(validateOrder(baseOrder({ params: null })).code).toBe('INVALID_PARAMS');
        const big = { blob: 'a'.repeat(MAX_PARAMS_BYTES + 10) };
        expect(validateOrder(baseOrder({ params: big })).code).toBe('ORDER_TOO_LARGE');
    });

    it('derinlik, anahtar sayısı, dizi boyu, string boyu sınırları', () => {
        let deep = {};
        let cursor = deep;
        for (let i = 0; i < MAX_DEPTH + 2; i += 1) { cursor.next = {}; cursor = cursor.next; }
        expect(validateOrder(baseOrder({ params: deep })).code).toBe('ORDER_TOO_DEEP');

        const manyKeys = {};
        for (let i = 0; i < 70; i += 1) manyKeys[`k${i}`] = 1;
        expect(validateOrder(baseOrder({ params: manyKeys })).code).toBe('ORDER_TOO_LARGE');

        expect(validateOrder(baseOrder({ params: { arr: new Array(70).fill(1) } })).code).toBe('ORDER_TOO_LARGE');
        expect(validateOrder(baseOrder({ params: { s: 'a'.repeat(4097) } })).code).toBe('ORDER_TOO_LARGE');
        expect(validateOrder(baseOrder({ params: { n: Number.NaN } })).code).toBe('INVALID_ORDER');
        expect(validateOrder(baseOrder({ params: { f: () => 1 } })).code).toBe('INVALID_ORDER');
    });

    it('yasaklı anahtarlar derinlemesine reddedilir', () => {
        const protoObj = JSON.parse('{"__proto__":{"x":1}}');
        expect(validateOrder(baseOrder({ params: protoObj })).code).toBe('FORBIDDEN_KEY');
        expect(validateOrder(baseOrder({ params: JSON.parse('{"constructor":{"prototype":{}}}') })).code).toBe('FORBIDDEN_KEY');
    });
});

describe('SignedOrderService - imzalama ve doğrulama', () => {
    it('canonicalizer hazır olmalı', async () => {
        expect(SignedOrderService.isCanonicalizerReady()).toBe(true);
        await expect(SignedOrderService.initCanonicalizer()).resolves.toBe(true);
        expect(typeof initCanonicalizer).toBe('function');
    });

    it('normalizeForSigning eksik alanları doldurur', () => {
        const o = normalizeForSigning({ action: 'lock', targets: ['a'] }, 'k1');
        expect(o.version).toBe(ORDER_VERSION);
        expect(o.issuer).toBe(ISSUER);
        expect(o.params).toEqual({});
        expect(o.keyId).toBe('k1');
        expect(o.expiresAt).toBeGreaterThan(o.issuedAt);
        expect(normalizeForSigning({}, null).keyId).toBe('default');
    });

    it('sign → verify turu; params imza kapsamında', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const signed = sign({ action: 'lock', targets: ['agent-1'], params: { a: 1 } }, privateKey);
        const svc = new SignedOrderService({ publicKeyPem: publicKey, agentId: 'agent-1' });
        expect(svc.verify(signed)).toMatchObject({ ok: true });

        const tampered = JSON.parse(JSON.stringify(signed));
        tampered.order.params.a = 2;
        const fresh = new SignedOrderService({ publicKeyPem: publicKey, agentId: 'agent-1' });
        expect(fresh.verify(tampered).code).toBe('BAD_SIGNATURE');
    });

    it('sign şema hatasını koda çevirir', () => {
        const { privateKey } = generateKeyPair();
        expect(() => sign({ action: 'LOCK', targets: ['a'] }, privateKey)).toThrow();
        try { sign({ action: 'nope!', targets: ['a'] }, privateKey); } catch (err) { expect(err.code).toBe('INVALID_ACTION'); }
    });

    it('verify: malformed / şema / sürüm / yayıncı / hedef', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey, agentId: 'agent-1' });
        expect(svc.verify(null).code).toBe('MALFORMED');
        expect(svc.verify({}).code).toBe('MALFORMED');
        expect(svc.verify({ order: {}, signature: 5 }).code).toBe('MALFORMED');

        const bad = normalizeForSigning({ action: 'bad!', targets: ['agent-1'] });
        expect(svc.verify({ order: bad, signature: 'AA==' }).code).toBe('INVALID_ACTION');

        const wrongTarget = sign({ action: 'lock', targets: ['other'] }, privateKey);
        expect(svc.verify(wrongTarget).code).toBe('WRONG_TARGET');
    });

    it('verify: saat farkı / süre / TTL / expired', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const now = Date.now();
        const svc = new SignedOrderService({ publicKeyPem: publicKey, nowFn: () => now });

        const future = sign({ action: 'lock', targets: ['a'], issuedAt: now + MAX_FUTURE_SKEW_MS + 1000, expiresAt: now + MAX_FUTURE_SKEW_MS + 60000 }, privateKey);
        expect(svc.verify(future).code).toBe('CLOCK_SKEW');

        const ttl = sign({ action: 'lock', targets: ['a'], issuedAt: now, expiresAt: now + MAX_TTL_MS + 60000 }, privateKey);
        expect(svc.verify(ttl).code).toBe('INVALID_EXPIRY');

        const expired = sign({ action: 'lock', targets: ['a'], issuedAt: now - 120000, expiresAt: now - 1000 }, privateKey);
        expect(svc.verify(expired).code).toBe('EXPIRED');
    });

    it('verify: anahtar yok / bilinmeyen keyId / süresi geçmiş anahtar', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const signed = sign({ action: 'lock', targets: ['a'] }, privateKey);

        expect(new SignedOrderService({}).verify(signed).code).toBe('NO_TRUST_ANCHOR');
        expect(new SignedOrderService({ publicKeyPem: publicKey, keyId: 'other' }).verify(signed).code).toBe('UNKNOWN_KEY');

        const now = Date.now();
        const expiring = new SignedOrderService({ publicKeyPem: publicKey, keyId: 'default', nowFn: () => now });
        expiring.setPublicKey(publicKey, 'default', now - 1000);
        expect(expiring.verify(signed).code).toBe('UNKNOWN_KEY');
    });

    it('verify: alg / keyId uyuşmazlığı / bozuk imza', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const signed = sign({ action: 'lock', targets: ['a'] }, privateKey);
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        expect(svc.verify({ ...signed, alg: 'rsa' }).code).toBe('UNSUPPORTED_ALG');
        expect(svc.verify({ ...signed, keyId: 'baska' }).code).toBe('KEY_ID_MISMATCH');
        expect(svc.verify({ ...signed, signature: Buffer.from('sahte').toString('base64') }).code).toBe('BAD_SIGNATURE');
    });

    it('replay: aynı nonce ikinci kez reddedilir; prune süresi geçenleri siler', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const svc = new SignedOrderService({ publicKeyPem: publicKey });
        const signed = sign({ action: 'lock', targets: ['a'] }, privateKey);
        expect(svc.verify(signed).ok).toBe(true);
        expect(svc.verify(signed).code).toBe('REPLAY');

        svc.seenNonces.set('eski', Date.now() - 1000);
        svc.prune();
        expect(svc.seenNonces.has('eski')).toBe(false);
    });

    it('depo bakım modunda emir kabul edilmez; consumeNonce yarışı REPLAY döner', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const signed = sign({ action: 'lock', targets: ['a'] }, privateKey);
        const maintenance = new SignedOrderService({ publicKeyPem: publicKey, storage: { maintenanceMode: true } });
        expect(maintenance.verify(signed).code).toBe('STORAGE_MAINTENANCE');

        const store = { maintenanceMode: false, consumeNonce: vi.fn(() => false) };
        const race = new SignedOrderService({ publicKeyPem: publicKey, storage: store });
        expect(race.verify(signed).code).toBe('REPLAY');
        expect(store.consumeNonce).toHaveBeenCalled();
    });

    it('kalıcı nonce deposu: load/save', () => {
        const { publicKey, privateKey } = generateKeyPair();
        const saved = [];
        const storage = {
            getSeenNonces: () => saved,
            saveSeenNonces: (list) => { saved.length = 0; saved.push(...list); return true; }
        };
        const svc = new SignedOrderService({ publicKeyPem: publicKey, storage });
        const signed = sign({ action: 'lock', targets: ['a'] }, privateKey);
        expect(svc.verify(signed).ok).toBe(true);
        expect(saved.length).toBe(1);

        const reloaded = new SignedOrderService({ publicKeyPem: publicKey, storage });
        expect(reloaded.verify(signed).code).toBe('REPLAY');
    });

    it('bozuk depo okuması bellek moduna düşer (fail-closed doğrulama sürer)', () => {
        const storage = { getSeenNonces: () => { throw new Error('bozuk'); }, saveSeenNonces: () => { throw new Error('x'); } };
        const svc = new SignedOrderService({ publicKeyPem: null, storage });
        expect(svc.verify({ order: null, signature: 'x' }).code).toBe('MALFORMED');
    });

    it('setPublicKey / hasKey / keyFor', () => {
        const { publicKey } = generateKeyPair();
        const svc = new SignedOrderService({});
        expect(svc.hasKey('default')).toBe(false);
        expect(svc.setPublicKey('', 'x')).toBe(false);
        expect(svc.setPublicKey(publicKey, 'default')).toBe(true);
        expect(svc.hasKey('default')).toBe(true);
        expect(svc.keyFor('default')).toBe(publicKey);
        expect(svc.keyFor('yok')).toBeNull();
        expect(svc.setPublicKey(publicKey, 'temp', Date.now() - 1)).toBe(true);
        expect(svc.keyFor('temp')).toBeNull();
    });

    it('canonicalizer yoksa fail-closed hata kodu', () => {
        _resetCanonicalizerForTests();
        try {
            expect(SignedOrderService.isCanonicalizerReady()).toBe(false);
            expect(() => canonical({ a: 1 })).toThrow();
            try { canonical({ a: 1 }); } catch (err) { expect(err.code).toBe('CANONICALIZER_NOT_READY'); }
        } finally {
            // Diğer testler için geri yükle
            return initCanonicalizer().then(() => {
                expect(SignedOrderService.isCanonicalizerReady()).toBe(true);
            });
        }
    });
});
