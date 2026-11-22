/**
 * stableStringify sözleşmesi - imza/idempotency determinizmi.
 *
 * Regresyon: fonksiyon ConsoleStore.js ve MigrateV2.js içinde birebir
 * kopyalanmıştı. İki kopyadan biri değişse HMAC imzaları ve migrasyon
 * checksum'ı sessizce uyuşmaz hale gelirdi. Artık tek kaynak var.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stableStringify } = require('../../src/main/util/stableStringify.js');

describe('stableStringify - deterministik JSON', () => {
    it('anahtar sırası farklı iki nesne aynı çıktıyı verir', () => {
        const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
        const b = { m: { b: 4, y: 3 }, a: 2, z: 1 };
        expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it('anahtarları alfabetik sıralar', () => {
        expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('dizi sırasını korur (sıra anlamlıdır)', () => {
        expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
        expect(stableStringify({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
    });

    it('null ve ilkel değerleri JSON.stringify gibi serileştirir', () => {
        expect(stableStringify(null)).toBe('null');
        expect(stableStringify('x')).toBe('"x"');
        expect(stableStringify(42)).toBe('42');
        expect(stableStringify(true)).toBe('true');
    });

    it('iç içe nesne ve dizileri özyinelemeli sıralar', () => {
        const value = { b: [{ z: 1, a: 2 }], a: { d: 4, c: 3 } };
        expect(stableStringify(value)).toBe('{"a":{"c":3,"d":4},"b":[{"a":2,"z":1}]}');
    });

    it('iki modül de aynı fonksiyonu kullanır (kopya yok)', () => {
        const consoleStore = require('fs')
            .readFileSync(new URL('../../src/console/ConsoleStore.js', import.meta.url), 'utf8');
        const migrate = require('fs')
            .readFileSync(new URL('../../src/main/storage/MigrateV2.js', import.meta.url), 'utf8');
        // Kopya tanım kalmamalı; ikisi de paylaşılan modülü require etmeli.
        expect(consoleStore).not.toMatch(/function stableStringify/);
        expect(migrate).not.toMatch(/function stableStringify/);
        expect(consoleStore).toMatch(/require\('\.\.\/main\/util\/stableStringify'\)/);
        expect(migrate).toMatch(/require\('\.\.\/util\/stableStringify'\)/);
    });
});
