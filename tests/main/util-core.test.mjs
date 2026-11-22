/**
 * util-core.test.mjs - küçük yardımcı modüller (Redact/safeCompare/processNames/TimerRegistry)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { redact, redactText, shouldMaskKey, REDACTED } from '../../src/main/security/Redact.js';
import { safeCompare } from '../../src/main/security/safeCompare.js';
import { canonicalProcessName, processNamesEqual, toProcessSet } from '../../src/main/services/processNames.js';
import { TimerRegistry } from '../../src/main/util/TimerRegistry.js';

const registries = [];
afterEach(() => { for (const r of registries.splice(0)) { try { r.clearAll(); } catch (_) {} } });
const registry = () => { const r = new TimerRegistry(); registries.push(r); return r; };

describe('Redact', () => {
    it('redactText PEM/authorization/pin maskeler', () => {
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----';
        expect(redactText(pem)).toBe('[REDACTED_PEM]');
        expect(redactText('authorization: Bearer abc.def')).toBe(`authorization: ${REDACTED}`);
        expect(redactText('pin=1234')).toBe(`pin=${REDACTED}`);
        expect(redactText('token: abc')).toBe(`token: ${REDACTED}`);
        expect(redactText('api_key = xyz')).toBe(`api_key = ${REDACTED}`);
        expect(redactText('normal metin')).toBe('normal metin');
    });

    it('shouldMaskKey hassas anahtarları tanır', () => {
        expect(shouldMaskKey('hasSecret')).toBe(false);
        expect(shouldMaskKey('localApiKeyPem')).toBe(true);
        expect(shouldMaskKey('privateKey')).toBe(true);
        expect(shouldMaskKey('clientSecret')).toBe(true);
        expect(shouldMaskKey('theme')).toBe(false);
        expect(shouldMaskKey(5)).toBe(false);
    });

    it('redact derin kopyada hassas alanları maskeler; skalerler korunur', () => {
        const out = redact({
            theme: 'dark',
            localApiKeyPem: 'PEM',
            emptySecret: '',
            nested: { hmacSecret: 'x', list: [1, 'authorization: abc'] }
        });
        expect(out.theme).toBe('dark');
        expect(out.localApiKeyPem).toBe(REDACTED);
        expect(out.emptySecret).toBe('');
        expect(out.nested.hmacSecret).toBe(REDACTED);
        expect(out.nested.list[0]).toBe(1);
        expect(out.nested.list[1]).toContain(REDACTED);
    });

    it('redact özel tipleri güvenli temsil eder', () => {
        expect(redact(null)).toBeNull();
        expect(redact(5)).toBe(5);
        expect(redact(true)).toBe(true);
        expect(redact(() => 1)).toBe('[function]');
        expect(redact(Symbol('s'))).toBe('[symbol]');
        expect(redact(Buffer.from('ab'))).toBe('[Buffer 2B]');
        expect(redact(new Error('pin=1'))).toMatchObject({ name: 'Error', message: `pin=${REDACTED}` });
    });

    it('redact derinlik ve dizi sınırı uygular', () => {
        let deep = { v: 1 };
        for (let i = 0; i < 12; i += 1) deep = { deep };
        expect(JSON.stringify(redact(deep))).toContain('[DEPTH_LIMIT]');
        expect(redact(new Array(300).fill('x'))).toHaveLength(200);
    });
});

describe('safeCompare', () => {
    it('eşit değerler true, farklı false', () => {
        expect(safeCompare('abc', 'abc')).toBe(true);
        expect(safeCompare('abc', 'abd')).toBe(false);
        expect(safeCompare('abc', 'abcd')).toBe(false);
    });

    it('buffer ve null/undefined normalize edilir', () => {
        expect(safeCompare(Buffer.from('x'), 'x')).toBe(true);
        expect(safeCompare(null, '')).toBe(true);
        expect(safeCompare(undefined, '')).toBe(true);
        expect(safeCompare(42, '42')).toBe(true);
    });
});

describe('processNames', () => {
    it('yol, .exe, büyük harf ve ADS ekleri temizlenir', () => {
        expect(canonicalProcessName('C:\\Program Files\\Code.EXE')).toBe('code');
        expect(canonicalProcessName('  Chrome  ')).toBe('chrome');
        expect(canonicalProcessName('a.exe:stream')).toBe('a');
        expect(canonicalProcessName('/usr/bin/bash')).toBe('bash');
        expect(canonicalProcessName(null)).toBe('');
        expect(canonicalProcessName('   ')).toBe('');
    });

    it('processNamesEqual', () => {
        expect(processNamesEqual('Code.exe', 'code')).toBe(true);
        expect(processNamesEqual('code', 'chrome')).toBe(false);
        expect(processNamesEqual('', '')).toBe(false);
    });

    it('toProcessSet dizi olmayan girdide boş küme', () => {
        expect(toProcessSet(null).size).toBe(0);
        expect(toProcessSet('x').size).toBe(0);
        const set = toProcessSet(['A.exe', { name: 'b.exe' }, { processName: 'C' }, null, 5]);
        expect([...set].sort()).toEqual(['a', 'b', 'c']);
    });
});

describe('TimerRegistry', () => {
    it('timeout çalışır ve kayıttan düşer', async () => {
        const r = registry();
        const fn = vi.fn();
        r.setTimeout(fn, 5, 'a');
        expect(r.size).toBe(1);
        await new Promise((res) => setTimeout(res, 30));
        expect(fn).toHaveBeenCalledWith('a');
        expect(r.size).toBe(0);
    });

    it('setInterval kaydedilir, clear tek tek siler', () => {
        const r = registry();
        const id = r.setInterval(() => {}, 1000);
        expect(r.size).toBe(1);
        r.clear(id);
        expect(r.size).toBe(0);
        r.clear(null); // güvenli
        expect(r.size).toBe(0);
    });

    it('clearAll kapanışta hepsini temizler ve kapatır', () => {
        const r = registry();
        r.setTimeout(() => {}, 1000);
        r.setInterval(() => {}, 1000);
        r.clearAll();
        expect(r.size).toBe(0);
        expect(() => r.setTimeout(() => {}, 1)).toThrow(/CLOSED/);
        expect(() => r.setInterval(() => {}, 1)).toThrow(/CLOSED/);
    });
});
