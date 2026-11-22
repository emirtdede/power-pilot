/**
 * secrets-core.test.mjs - SecretStore (WP-04 / T-SEC-01/06/07)
 *
 * safeStorage enjekte edilir (sahte backend); dosya sistemi geçici dizinde
 * gerçek fs ile çalışır. Düz metin fallback yollarının reddedildiği doğrulanır.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    SecretStore,
    SECRET_SETTING_FIELDS,
    WEBHOOK_SECRET_FIELDS,
    webhookKey,
    FILE_VERSION,
    ENTRY_VERSION
} from '../../src/main/security/SecretStore.js';

function makeBackend(over = {}) {
    return Object.assign({
        isAsyncEncryptionAvailable: async () => true,
        encryptStringAsync: async (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
        decryptStringAsync: async (buf) => buf.toString('utf8').replace(/^enc:/, '')
    }, over);
}

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-secrets-'));
});
afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ }
});

const fileFor = (name = 'secrets.v1.json') => path.join(dir, name);
const newStore = (opts = {}) => new SecretStore(Object.assign({ filePath: fileFor(), safeStorage: makeBackend() }, opts));

describe('SecretStore - kurulum ve backend', () => {
    it('dosya yolu zorunlu', () => {
        expect(() => new SecretStore({})).toThrow(/dosya yolu/);
        expect(() => new SecretStore()).toThrow(/dosya yolu/);
    });

    it('başlangıçta boş sözlük', () => {
        const s = newStore();
        expect(s.data.version).toBe(FILE_VERSION);
        expect(s.listNames()).toEqual([]);
        expect(s.has('x')).toBe(false);
    });

    it('backend yoksa isAsyncEncryptionAvailable false', async () => {
        const s = new SecretStore({ filePath: fileFor() });
        await expect(s.isAsyncEncryptionAvailable()).resolves.toBe(false);
    });

    it('isEncryptionAvailable (senkron API) desteklenir', async () => {
        const s = new SecretStore({ filePath: fileFor(), safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('x'), decryptString: () => 'x' } });
        await expect(s.isAsyncEncryptionAvailable()).resolves.toBe(true);
        const off = new SecretStore({ filePath: fileFor(), safeStorage: { isEncryptionAvailable: () => false } });
        await expect(off.isAsyncEncryptionAvailable()).resolves.toBe(false);
        const broken = new SecretStore({ filePath: fileFor(), safeStorage: { isAsyncEncryptionAvailable: async () => { throw new Error('yok'); } } });
        await expect(broken.isAsyncEncryptionAvailable()).resolves.toBe(false);
    });

    it('yalnız encryptString olan backend kabul edilir', async () => {
        const s = new SecretStore({ filePath: fileFor(), safeStorage: { encryptString: () => Buffer.from('x'), decryptString: () => 'x' } });
        await expect(s.isAsyncEncryptionAvailable()).resolves.toBe(true);
    });
});

describe('SecretStore - şifreleme/çözme hataları', () => {
    it('boş değer INVALID_SECRET', async () => {
        await expect(newStore().encryptStringAsync('')).rejects.toMatchObject({ code: 'INVALID_SECRET' });
        await expect(newStore().encryptStringAsync(5)).rejects.toMatchObject({ code: 'INVALID_SECRET' });
    });

    it('backend yok METİN DÜZ YAZILMAZ', async () => {
        const s = new SecretStore({ filePath: fileFor() });
        await expect(s.encryptStringAsync('gizli')).rejects.toMatchObject({ code: 'SECRET_BACKEND_UNAVAILABLE' });
        await expect(s.setSecret('a', 'gizli')).rejects.toMatchObject({ code: 'SECRET_BACKEND_UNAVAILABLE' });
        expect(fs.existsSync(fileFor())).toBe(false);
    });

    it('şifreleme hatası SECRET_ENCRYPT_FAILED', async () => {
        const s = newStore({ safeStorage: makeBackend({ encryptStringAsync: async () => { throw new Error('boom'); } }) });
        await expect(s.encryptStringAsync('x')).rejects.toMatchObject({ code: 'SECRET_ENCRYPT_FAILED' });
    });

    it('boş şifreleme çıktısı reddedilir', async () => {
        const s = newStore({ safeStorage: makeBackend({ encryptStringAsync: async () => Buffer.alloc(0) }) });
        await expect(s.encryptStringAsync('x')).rejects.toMatchObject({ code: 'SECRET_ENCRYPT_FAILED' });
    });

    it('senkron encryptString yolu kullanılır', async () => {
        const s = newStore({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p, 'utf8'), decryptString: (b) => b.toString('utf8') } });
        await expect(s.encryptStringAsync('abc')).resolves.toBe(Buffer.from('abc').toString('base64'));
    });

    it('geçersiz cipher biçimi SECRET_DECRYPT_FAILED', async () => {
        await expect(newStore().decryptStringAsync('***')).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });
        await expect(newStore().decryptStringAsync(null)).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });
    });

    it('çözme hatası SECRET_DECRYPT_FAILED; eski sürüm shouldReEncrypt', async () => {
        const s = newStore({ safeStorage: makeBackend({ decryptStringAsync: async () => { throw new Error('bozuk'); } }) });
        await expect(s.decryptStringAsync(Buffer.from('enc:x').toString('base64'))).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });

        const ok = newStore();
        await expect(ok.decryptStringAsync(Buffer.from('enc:vr').toString('base64'), { v: 1 })).resolves.toEqual({ result: 'vr', shouldReEncrypt: true });
        await expect(ok.decryptStringAsync(Buffer.from('enc:vr').toString('base64'), { v: ENTRY_VERSION })).resolves.toEqual({ result: 'vr', shouldReEncrypt: false });
        await expect(ok.decryptStringAsync(Buffer.from('enc:vr').toString('base64'))).resolves.toMatchObject({ shouldReEncrypt: true });
    });

    it('string döndüren decryptStringAsync de kabul edilir', async () => {
        const s = newStore({ safeStorage: makeBackend({ decryptStringAsync: async () => 'düz' }) });
        await expect(s.decryptStringAsync(Buffer.from('enc:x').toString('base64'))).resolves.toMatchObject({ result: 'düz' });
    });
});

describe('SecretStore - kalıcılık', () => {
    it('dosya yoksa boş yüklenir', () => {
        expect(newStore().corrupt).toBe(false);
    });

    it('bozuk JSON corrupt işaretler ve logger çağrılır', () => {
        fs.writeFileSync(fileFor(), '{not json');
        const logger = { error: vi.fn() };
        const s = newStore({ logger });
        expect(s.corrupt).toBe(true);
        expect(logger.error).toHaveBeenCalled();
        expect(s.listNames()).toEqual([]);
    });

    it('entries alanı yoksa corrupt', () => {
        fs.writeFileSync(fileFor(), JSON.stringify({ version: 1 }));
        expect(newStore().corrupt).toBe(true);
    });

    it('corrupt dosya üzerine yazılmaz ve okuma reddedilir', async () => {
        fs.writeFileSync(fileFor(), 'bozuk');
        const s = newStore();
        expect(() => s.writeAtomic()).toThrow(/Bozuk/);
        await expect(s.getSecret('a')).rejects.toMatchObject({ code: 'SECRETS_FILE_CORRUPT' });
        expect(fs.readFileSync(fileFor(), 'utf8')).toBe('bozuk');
    });

    it('set/get/delete turu ve atomik yazım (0600, geçici dosya kalmaz)', async () => {
        const s = newStore();
        await expect(s.setSecret('localApiKeyPem', 'PEM-DEĞERİ')).resolves.toBe(true);
        expect(fs.existsSync(fileFor())).toBe(true);
        const disk = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
        expect(disk.entries.localApiKeyPem.v).toBe(ENTRY_VERSION);
        expect(disk.entries.localApiKeyPem.cipher).not.toContain('PEM-DEĞERİ');

        const reread = newStore();
        expect(reread.has('localApiKeyPem')).toBe(true);
        await expect(reread.getSecret('localApiKeyPem')).resolves.toBe('PEM-DEĞERİ');

        await expect(reread.deleteSecret('localApiKeyPem')).resolves.toBe(true);
        await expect(reread.deleteSecret('localApiKeyPem')).resolves.toBe(false);
        expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('geçersiz sır adı reddedilir', async () => {
        const s = newStore();
        await expect(s.setSecret('kötü ad', 'x')).rejects.toMatchObject({ code: 'INVALID_SECRET_NAME' });
        await expect(s.getSecret('a'.repeat(129))).rejects.toMatchObject({ code: 'INVALID_SECRET_NAME' });
    });

    it('olmayan sır null döner', async () => {
        await expect(newStore().getSecret('yok')).resolves.toBeNull();
    });

    it('eski sürüm (v1) sır okunurken yeniden şifrelenir', async () => {
        const s = newStore();
        fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
        const legacyCipher = Buffer.from('enc:eski').toString('base64');
        fs.writeFileSync(fileFor(), JSON.stringify({ version: 1, entries: { a: { v: 1, cipher: legacyCipher } } }));
        const store = newStore();
        await expect(store.getSecret('a')).resolves.toBe('eski');
        const disk = JSON.parse(fs.readFileSync(fileFor(), 'utf8'));
        expect(disk.entries.a.v).toBe(ENTRY_VERSION);
    });

    it('applyAcl:true ilk yazımda ACL uygular, ikinci yazımda tekrar etmez', async () => {
        const s = newStore({ applyAcl: true });
        await s.setSecret('a', '1');
        expect(s._dirAclSecured).toBe(true);
        await s.setSecret('b', '2');
        expect(s.has('b')).toBe(true);
    });
});

describe('SecretStore - webhook senkronu', () => {
    const hook = (url, extra = {}) => Object.assign({ url }, extra);

    it('yeni sırları yazar, kaldırılan hook sırlarını temizler', async () => {
        const s = newStore();
        await s.syncWebhooks([hook('https://a/h', { hmacSecret: 's1' }), hook('https://b/h', { bearerToken: 't1' })]);
        expect(s.listNames()).toEqual([webhookKey('https://a/h', 'hmacSecret'), webhookKey('https://b/h', 'bearerToken')].sort());

        await s.syncWebhooks([hook('https://a/h', { hmacSecret: 's1' })]);
        expect(s.listNames()).toEqual([webhookKey('https://a/h', 'hmacSecret')]);
    });

    it('değişmeyen sır yeniden yazılmaz, değişen güncellenir', async () => {
        const s = newStore();
        await s.syncWebhooks([hook('https://a/h', { hmacSecret: 's1' })]);
        const firstCipher = s.data.entries[webhookKey('https://a/h', 'hmacSecret')].cipher;
        await s.syncWebhooks([hook('https://a/h', { hmacSecret: 's1' })]);
        expect(s.data.entries[webhookKey('https://a/h', 'hmacSecret')].cipher).toBe(firstCipher);
        await s.syncWebhooks([hook('https://a/h', { hmacSecret: 's2' })]);
        expect(s.data.entries[webhookKey('https://a/h', 'hmacSecret')].cipher).not.toBe(firstCipher);
    });

    it('geçersiz girdiler atlanır (boş liste dahil)', async () => {
        const s = newStore();
        await s.syncWebhooks(null);
        await s.syncWebhooks([null, 5, { url: '' }, { }, 'x']);
        expect(s.listNames()).toEqual([]);
    });

    it('hata halinde yazılan/silinen kayıtlar geri alınır (O-18)', async () => {
        const s = newStore();
        await s.syncWebhooks([hook('https://old/h', { hmacSecret: 'eski' })]);
        const oldName = webhookKey('https://old/h', 'hmacSecret');
        // 2. hook yazılırken şifreleme patlar → ilk yazım ve silme geri alınmalı.
        let calls = 0;
        s.encryptStringAsync = async (plain) => {
            calls += 1;
            if (calls === 2) throw Object.assign(new Error('patladı'), { code: 'SECRET_ENCRYPT_FAILED' });
            return Buffer.from(`enc:${plain}`).toString('base64');
        };
        await expect(s.syncWebhooks([hook('https://new/h', { hmacSecret: 'yeni', bearerToken: 'b' })])).rejects.toBeTruthy();
        s.encryptStringAsync = async (plain) => Buffer.from(`enc:${plain}`).toString('base64');
        // Eski kayıt korunmuş olmalı (silme geri alındı), yeni kayıt geri alındı.
        expect(s.has(oldName)).toBe(true);
        await expect(s.getSecret(oldName)).resolves.toBe('eski');
        expect(s.has(webhookKey('https://new/h', 'hmacSecret'))).toBe(false);
    });
});

describe('SecretStore - migrasyon / hidrasyon / disk kopyası', () => {
    it('migrateFromData düz metin sırları şifreler ve alanları null\'lar', async () => {
        const s = newStore();
        const data = {
            settings: { consoleAgentKey: 'k1', localApiKeyPem: 'PEM', theme: 'dark' },
            webhooks: [{ url: 'https://a/h', hmacSecret: 'hs', enabled: true }]
        };
        const out = await s.migrateFromData(data);
        expect(out.migrated.sort()).toEqual(['consoleAgentKey', 'localApiKeyPem', webhookKey('https://a/h', 'hmacSecret')].sort());
        expect(data.settings.consoleAgentKey).toBeNull();
        expect(data.settings.localApiKeyPem).toBeNull();
        expect(data.settings.theme).toBe('dark');
        expect(data.webhooks[0].hmacSecret).toBeUndefined();
        expect(data.webhooks[0].enabled).toBe(true);
    });

    it('aynı değer ikinci kez alreadyEncrypted olarak raporlanır', async () => {
        const s = newStore();
        await s.setSecret('consoleAgentKey', 'k1');
        const data = { settings: { consoleAgentKey: 'k1' }, webhooks: [] };
        const out = await s.migrateFromData(data);
        expect(out.alreadyEncrypted).toEqual(['consoleAgentKey']);
        expect(out.migrated).toEqual([]);
    });

    it('geçersiz veri güvenli varsayılan döner', async () => {
        const out = await newStore().migrateFromData(null);
        expect(out.migrated).toEqual([]);
        expect(out.alreadyEncrypted).toEqual([]);
    });

    it('hidrasyon ayarları ve webhook sırlarını geri doldurur', async () => {
        const s = newStore();
        await s.setSecret('consoleAgentKey', 'k1');
        await s.setSecret(webhookKey('https://a/h', 'bearerToken'), 't1');
        const data = { settings: { consoleAgentKey: null }, webhooks: [{ url: 'https://a/h' }] };
        const out = await s.hydrateData(data);
        expect(out.settings.consoleAgentKey).toBe('k1');
        expect(out.webhooks[0].bearerToken).toBe('t1');
        // Zaten dolu alan ezilmez
        const data2 = { settings: { consoleAgentKey: 'elle' }, webhooks: [] };
        await s.hydrateData(data2);
        expect(data2.settings.consoleAgentKey).toBe('elle');
    });

    it('hidrasyon hatası kod ile yükselir', async () => {
        const s = newStore({ safeStorage: makeBackend({ decryptStringAsync: async () => { throw new Error('bozuk'); } }) });
        fs.writeFileSync(fileFor(), JSON.stringify({ version: 1, entries: { consoleAgentKey: { v: 2, cipher: Buffer.from('enc:z').toString('base64') } } }));
        const broken = newStore({ safeStorage: makeBackend({ decryptStringAsync: async () => { throw new Error('bozuk'); } }) });
        await expect(broken.hydrateData({ settings: {}, webhooks: [] })).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });
    });

    it('stripForDisk belleği değiştirmez, sırları çıkarır', async () => {
        const s = newStore();
        const data = {
            settings: { consoleAgentKey: 'k', localApiPfxPassphrase: 'p', theme: 'dark' },
            webhooks: [{ url: 'https://a/h', hmacSecret: 'hs', enabled: true }]
        };
        const copy = s.stripForDisk(data);
        expect(copy.settings.consoleAgentKey).toBeNull();
        expect(copy.settings.localApiPfxPassphrase).toBeNull();
        expect(copy.settings.theme).toBe('dark');
        expect(copy.webhooks[0].hmacSecret).toBeUndefined();
        expect(data.settings.consoleAgentKey).toBe('k');
        expect(data.webhooks[0].hmacSecret).toBe('hs');
        expect(s.stripForDisk(null)).toEqual({});
    });

    it('findPlaintextSecrets yol listesi döner (değer sızdırmaz)', () => {
        expect(SecretStore.findPlaintextSecrets(null)).toEqual([]);
        const hits = SecretStore.findPlaintextSecrets({
            settings: { consoleAgentKey: 'k', localApiKeyPem: '' },
            webhooks: [{ hmacSecret: 'x' }, { bearerToken: 'y' }, null]
        });
        expect(hits).toEqual(['settings.consoleAgentKey', 'webhooks[0].hmacSecret', 'webhooks[1].bearerToken']);
    });

    it('purgeSecretBackups düz metin sır içeren yedeği siler, temiz olanı korur', () => {
        const backupDir = path.join(dir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, 'dirty.json'), '{"settings":{"consoleAgentKey":"ÇOK-GİZLİ"}}');
        fs.writeFileSync(path.join(backupDir, 'clean.json'), '{"settings":{"theme":"dark"}}');
        fs.writeFileSync(path.join(backupDir, 'nulled.json'), '{"settings":{"consoleAgentKey":null}}');
        fs.mkdirSync(path.join(backupDir, 'subdir'));

        const removed = SecretStore.purgeSecretBackups(backupDir);
        expect(removed).toEqual(['dirty.json']);
        expect(fs.existsSync(path.join(backupDir, 'clean.json'))).toBe(true);
        expect(fs.existsSync(path.join(backupDir, 'nulled.json'))).toBe(true);
        expect(fs.existsSync(path.join(backupDir, 'subdir'))).toBe(true);
    });

    it('purgeSecretBackups olmayan dizinde boş liste', () => {
        expect(SecretStore.purgeSecretBackups(path.join(dir, 'yok'))).toEqual([]);
        expect(SecretStore.purgeSecretBackups(null)).toEqual([]);
    });

    it('purgeSecretBackups privateKey PEM içeren dosyayı da siler', () => {
        const backupDir = path.join(dir, 'b2');
        fs.mkdirSync(backupDir, { recursive: true });
        fs.writeFileSync(path.join(backupDir, 'pem.json'), '{"privateKey":"-----BEGIN PRIVATE KEY-----"}');
        expect(SecretStore.purgeSecretBackups(backupDir)).toEqual(['pem.json']);
    });
});

describe('SecretStore - sabitler', () => {
    it('sır alan listeleri beklenen değerleri içerir', () => {
        expect(SECRET_SETTING_FIELDS).toContain('localApiKeyPem');
        expect(SECRET_SETTING_FIELDS).toContain('consoleAgentKey');
        expect(WEBHOOK_SECRET_FIELDS).toEqual(['bearerToken', 'basicAuthPass', 'hmacSecret']);
        expect(Object.isFrozen(SECRET_SETTING_FIELDS)).toBe(true);
    });

    it('webhookKey deterministik ve URL\'ye özgü', () => {
        expect(webhookKey('https://a', 'hmacSecret')).toBe(webhookKey('https://a', 'hmacSecret'));
        expect(webhookKey('https://a', 'hmacSecret')).not.toBe(webhookKey('https://b', 'hmacSecret'));
        expect(webhookKey('https://a', 'hmacSecret')).toMatch(/^webhook:[0-9a-f]{16}:hmacSecret$/);
        expect(webhookKey(null, 'x')).toMatch(/^webhook:[0-9a-f]{16}:x$/);
    });
});
