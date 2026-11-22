/**
 * secrets-extra.test.mjs - SecretStore kalan dallar (hidrasyon, migrasyon, yazım hataları)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SecretStore, SECRET_SETTING_FIELDS, WEBHOOK_SECRET_FIELDS, webhookKey } from '../../src/main/security/SecretStore.js';

let dir;
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-secret2-')); });
afterEach(() => safeRm(dir));

function backend(over = {}) {
    return Object.assign({
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (p) => Buffer.from(`enc:${p}`, 'utf8'),
        decryptStringAsync: async (b) => b.toString('utf8').replace(/^enc:/, '')
    }, over);
}

const file = () => path.join(dir, 'secrets.v1.json');
const store = (opts = {}) => new SecretStore(Object.assign({ filePath: file(), safeStorage: backend() }, opts));

describe('SecretStore - hidrasyon varyantları', () => {
    it('only seçeneği yalnız belirtilen alanları doldurur', async () => {
        const s = store();
        await s.setSecret('consoleAgentKey', 'k');
        await s.setSecret('localApiKeyPem', 'pem');
        const data = { settings: {}, webhooks: [] };
        await s.hydrateData(data, { only: ['consoleAgentKey'] });
        expect(data.settings.consoleAgentKey).toBe('k');
        expect(data.settings.localApiKeyPem).toBeUndefined();
    });

    it('geçersiz veri nesnesi olduğu gibi döner', async () => {
        const s = store();
        await expect(s.hydrateData(null)).resolves.toBeNull();
    });

    it('webhook sırları yalnız boş alanlara yazılır', async () => {
        const s = store();
        await s.setSecret(webhookKey('https://a/h', 'hmacSecret'), 'hs');
        const data = { settings: {}, webhooks: [{ url: 'https://a/h', hmacSecret: 'elle' }, { url: 'https://a/h' }] };
        await s.hydrateData(data);
        expect(data.webhooks[0].hmacSecret).toBe('elle');
        expect(data.webhooks[1].hmacSecret).toBe('hs');
    });
});

describe('SecretStore - migrasyon doğrulama hatası', () => {
    it('yazılan değer geri okunamıyorsa MIGRATION_VERIFY_FAILED', async () => {
        const s = store();
        const original = s.getSecret.bind(s);
        s.getSecret = vi.fn(async (name) => (name === 'consoleAgentKey' ? 'farklı' : original(name)));
        await expect(s.migrateFromData({ settings: { consoleAgentKey: 'k' }, webhooks: [] }))
            .rejects.toMatchObject({ code: 'MIGRATION_VERIFY_FAILED' });
    });

    it('boş ayar alanları atlanır', async () => {
        const s = store();
        const out = await s.migrateFromData({ settings: { consoleAgentKey: '', localApiKeyPem: null }, webhooks: [{ url: 'https://a/h' }] });
        expect(out.migrated).toEqual([]);
        expect(out.alreadyEncrypted).toEqual([]);
    });

    it('webhook kaydı nesne değilse atlanır', async () => {
        const s = store();
        const out = await s.migrateFromData({ settings: {}, webhooks: [null, 'x'] });
        expect(out.migrated).toEqual([]);
    });
});

describe('SecretStore - yazım hataları', () => {
    it('dizin oluşturulamazsa yazım hatası yükselir', async () => {
        const brokenFs = {
            existsSync: () => false,
            mkdirSync: () => { throw new Error('izin yok'); },
            readFileSync: fs.readFileSync,
            writeFileSync: fs.writeFileSync,
            openSync: fs.openSync,
            closeSync: fs.closeSync,
            fsyncSync: fs.fsyncSync,
            renameSync: fs.renameSync
        };
        const s = store({ fsImpl: brokenFs });
        await expect(s.setSecret('a', 'b')).rejects.toThrow(/izin yok/);
    });

    it('fsync desteklenmezse yazım yine başarılı', async () => {
        const noFsync = Object.assign({}, fs, { fsyncSync: () => { throw new Error('yok'); } });
        const s = store({ fsImpl: noFsync });
        await expect(s.setSecret('a', 'b')).resolves.toBe(true);
        expect(JSON.parse(fs.readFileSync(file(), 'utf8')).entries.a).toBeTruthy();
    });

    it('sır adı sınırları (128 karakter)', async () => {
        const s = store();
        await expect(s.setSecret('a'.repeat(128), 'x')).resolves.toBe(true);
        await expect(s.setSecret('a'.repeat(129), 'x')).rejects.toMatchObject({ code: 'INVALID_SECRET_NAME' });
        await expect(s.setSecret('boşluk lu', 'x')).rejects.toMatchObject({ code: 'INVALID_SECRET_NAME' });
    });
});

describe('SecretStore - webhook senkronu ek dallar', () => {
    it('sırsız hook eski kaydı siler', async () => {
        const s = store();
        await s.setSecret(webhookKey('https://old/h', 'hmacSecret'), 'eski');
        await s.syncWebhooks([{ url: 'https://new/h' }]);
        expect(s.listNames()).toEqual([]);
    });

    it('aynı URL farklı alanlar korunur', async () => {
        const s = store();
        await s.syncWebhooks([{ url: 'https://a/h', bearerToken: 't', hmacSecret: 's' }]);
        expect(s.listNames().sort()).toEqual([
            webhookKey('https://a/h', 'bearerToken'),
            webhookKey('https://a/h', 'hmacSecret')
        ].sort());
        await s.syncWebhooks([{ url: 'https://a/h', hmacSecret: 's' }]);
        // keep kümesi URL bazlıdır: aynı URL'nin diğer sırları korunur.
        expect(s.listNames()).toHaveLength(2);
    });
});

describe('SecretStore - disk kopyası ve tarama', () => {
    it('stripForDisk webhook nesnesi olmayan kayıtları atlar', () => {
        const s = store();
        const out = s.stripForDisk({ settings: {}, webhooks: [null, 'x', { url: 'u', hmacSecret: 's' }] });
        expect(out.webhooks[2].hmacSecret).toBeUndefined();
    });

    it('findPlaintextSecrets boş veri', () => {
        expect(SecretStore.findPlaintextSecrets(undefined)).toEqual([]);
        expect(SecretStore.findPlaintextSecrets({ webhooks: [null] })).toEqual([]);
    });

    it('SECRET_SETTING_FIELDS ve WEBHOOK_SECRET_FIELDS sabitleri', () => {
        expect(SECRET_SETTING_FIELDS.length).toBeGreaterThanOrEqual(5);
        expect(WEBHOOK_SECRET_FIELDS).toContain('hmacSecret');
        expect(Object.isFrozen(WEBHOOK_SECRET_FIELDS)).toBe(true);
    });
});
