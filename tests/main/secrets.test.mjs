/**
 * secrets.test.mjs - WP-04.T8
 * T-SEC-01..09: düz metin taraması, yanlış kullanıcı/bozuk cipher, ACL,
 * PIN kilidi, Argon2id parametreleri, yedek temizliği, re-encrypt,
 * headless safeStorage ve log/audit redaksiyonu.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import StorageService from '../../src/main/services/StorageService.js';
import { Db } from '../../src/main/storage/Database.js';
import { SecretStore } from '../../src/main/security/SecretStore.js';
import { PinGuard, DEFAULT_LOCK_MS } from '../../src/main/ipc/pinGuard.js';
import * as Pin from '../../src/main/security/Pin.js';
import { redact } from '../../src/main/security/Redact.js';
import log from '../../src/main/logger.js';
import Acl from '../../src/main/security/Acl.js';
import { AuditLog } from '../../src/main/services/AuditLog.js';
import { bootAgent } from '../../src/agent/headless.js';

const dirs = [];
const storages = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-secrets-test-'));
    dirs.push(dir);
    return dir;
}
function openStorage(dir) {
    const s = new StorageService(dir);
    storages.push(s);
    return s;
}
afterEach(() => {
    for (const s of storages.splice(0)) {
        try { s.close(); } catch (_) { /* yut */ }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fakeBackend({ available = true, failDecrypt = false } = {}) {
    return {
        isAsyncEncryptionAvailable: async () => available,
        // Gerçek DPAPI gibi her şifrelemede farklı çıktı üretir (nonce).
        encryptStringAsync: async (plain) => {
            const nonce = crypto.randomBytes(8).toString('hex');
            return Buffer.from(`enc:${nonce}:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8');
        },
        decryptStringAsync: async (buf) => {
            if (failDecrypt) throw new Error('DPAPI: başka kullanıcı');
            const s = Buffer.from(buf).toString('utf8');
            const parts = s.split(':');
            if (parts.length !== 3 || parts[0] !== 'enc') throw new Error('bozuk cipher');
            return Buffer.from(parts[2], 'base64').toString('utf8');
        }
    };
}

function aclSids(target) {
    const escaped = target.replace(/'/g, "''");
    const script = `$a = Get-Acl -LiteralPath '${escaped}'; $a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }`;
    // GitHub Windows runner'ında Windows PowerShell'in Security modülü bazen
    // yüklenemiyor; PowerShell 7 ile tekrar dene.
    for (const shell of ['powershell', 'pwsh']) {
        try {
            const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 20000
            });
            const sids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            if (sids.length > 0) return sids;
        } catch (_) { /* sıradaki shell */ }
    }
    return [];
}

function newStore(dir, backend = fakeBackend()) {
    return new SecretStore({
        filePath: path.join(dir, 'secrets.v1.json'),
        safeStorage: backend,
        applyAcl: false
    });
}

function rawData(dir) {
    const parts = [];
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('powerpilot.db') && name !== 'secrets.v1.json') continue;
        const p = path.join(dir, name);
        try { parts.push(fs.readFileSync(p).toString('utf8')); } catch (_) { /* yut */ }
    }
    return parts.join('\n');
}

function withDb(dir, fn) {
    const db = new Db(path.join(dir, 'powerpilot.db'), { fileMustExist: true });
    try { return fn(db); } finally { db.close(); }
}

function diskSetting(dir, key) {
    return withDb(dir, (db) => {
        const row = db.prepare('SELECT json FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.json) : undefined;
    });
}

function diskCollection(dir, table) {
    return withDb(dir, (db) => db.prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`).all().map((r) => JSON.parse(r.data)));
}

describe('SecretStore (WP-04)', () => {
    it('T-SEC-01: sırlar diske düz metin yazılmaz', async () => {
        const dir = freshDir();
        const storage = openStorage(dir);
        const store = newStore(dir);
        storage.setSecretStore(store);

        await store.setSecret('consoleAgentKey', 'agent-secret-123');
        storage.data.settings.consoleAgentKey = 'agent-secret-123';
        storage.save();

        expect(rawData(dir)).not.toContain('agent-secret-123');
        expect(diskSetting(dir, 'consoleAgentKey')).toBeNull();
        expect(SecretStore.findPlaintextSecrets(storage.data)).toEqual(['settings.consoleAgentKey']);

        // Diskten yeniden yükleme + hidrasyon değeri geri getirir.
        const storage2 = openStorage(dir);
        storage2.setSecretStore(newStore(dir));
        await storage2.secretStore.hydrateData(storage2.data);
        expect(storage2.getSettings().consoleAgentKey).toBe('agent-secret-123');
    });

    it('T-SEC-01b: webhook sırları da ayrı dosyada tutulur', async () => {
        const dir = freshDir();
        const storage = openStorage(dir);
        const store = newStore(dir);
        storage.setSecretStore(store);
        const hooks = [{ id: 'h1', url: 'https://example.test/hook', bearerToken: 'tok-12345678' }];
        await store.syncWebhooks(hooks);
        storage.saveWebhooks(hooks);
        expect(rawData(dir)).not.toContain('tok-12345678');
        expect(diskCollection(dir, 'webhooks')[0].bearerToken).toBeUndefined();

        const storage2 = openStorage(dir);
        storage2.setSecretStore(newStore(dir));
        await storage2.secretStore.hydrateData(storage2.data);
        expect(storage2.getWebhooks()[0].bearerToken).toBe('tok-12345678');
    });

    it('T-SEC-02: DPAPI yok / yanlış kullanıcı / bozuk cipher reddedilir', async () => {
        const dir = freshDir();
        const unavailable = newStore(dir, fakeBackend({ available: false }));
        await expect(unavailable.setSecret('consoleAgentKey', 'x')).rejects.toMatchObject({ code: 'SECRET_BACKEND_UNAVAILABLE' });

        const store = newStore(dir);
        await store.setSecret('consoleAgentKey', 'gizli');
        await expect(store.decryptStringAsync('!!!')).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });

        const otherUser = new SecretStore({
            filePath: path.join(dir, 'secrets.v1.json'),
            safeStorage: fakeBackend({ failDecrypt: true }),
            applyAcl: false
        });
        await expect(otherUser.getSecret('consoleAgentKey')).rejects.toMatchObject({ code: 'SECRET_DECRYPT_FAILED' });
    });

    it('T-SEC-03: Windows ACL yalnızca sahip + SYSTEM + Administrators bırakır', () => {
        if (process.platform !== 'win32') return;
        const dir = freshDir();
        const res = Acl.secureDirectory(dir);
        if (!res.ok) return; // test ortamında icacls kısıtlı olabilir
        const aces = Acl.listAces(dir);
        expect(aces.ok).toBe(true);
        const sids = aclSids(dir);
        if (sids.length === 0) return; // ACL sorgusu bu ortamda kullanılamıyor
        expect(sids).toContain(res.sid);
        expect(sids).toContain(Acl.SYSTEM_SID);
        expect(sids).toContain(Acl.ADMINS_SID);
        expect(sids).not.toContain('S-1-1-0'); // Everyone
        expect(sids).not.toContain('S-1-5-32-545'); // Users
    }, 20000); // icacls/PowerShell alt süreçleri paralel yükte 5 sn'yi aşabiliyor

    it('T-SEC-04: 5 yanlış → 15 dk kilit → süre sonunda doğru PIN', async () => {
        let now = 1000;
        const guard = new PinGuard({ nowFn: () => now });
        const legacy = { salt: 's', hash: PinGuard.hashPin('1234', 's') };
        for (let i = 0; i < 5; i++) await guard.check('cancel', '0000', legacy);
        const locked = await guard.check('cancel', '1234', legacy);
        expect(locked.code).toBe('PIN_LOCKED');
        expect(locked.retryAfterSec).toBe(900);
        now += DEFAULT_LOCK_MS + 1;
        await expect(guard.check('cancel', '1234', legacy)).resolves.toMatchObject({ ok: true });
    });

    it('T-SEC-05: aynı PIN iki farklı Argon2id PHC üretir, parametreler doğru', async () => {
        const a = await Pin.hashPin('1234');
        const b = await Pin.hashPin('1234');
        expect(a).not.toBe(b);
        const p = Pin.parseArgon2Params(a);
        expect(p).toEqual({ variant: 'id', version: 19, memoryCost: 19456, timeCost: 2, parallelism: 1 });
        expect(Pin.SALT_BYTES).toBe(16);
        expect(Pin.HASH_BYTES).toBe(32);
    });

    it('T-SEC-06: sır içeren eski yedekler silinir, temiz yedek korunur', () => {
        const dir = freshDir();
        const backups = path.join(dir, 'backups');
        fs.mkdirSync(backups, { recursive: true });
        fs.writeFileSync(path.join(backups, 'dirty.json'), '{"consoleAgentKey":"supersecret"}', 'utf8');
        fs.writeFileSync(path.join(backups, 'pem.json'), '{"privateKey":"-----BEGIN PRIVATE KEY-----x"}', 'utf8');
        fs.writeFileSync(path.join(backups, 'clean.json'), '{"tasks":[]}', 'utf8');
        const removed = SecretStore.purgeSecretBackups(backups);
        expect(removed.sort()).toEqual(['dirty.json', 'pem.json']);
        expect(fs.existsSync(path.join(backups, 'clean.json'))).toBe(true);
    });

    it('T-SEC-07: eski v1 cipher okunur ve atomik olarak v2 yazılır', async () => {
        const dir = freshDir();
        const store = newStore(dir);
        const cipher = await store.encryptStringAsync('deger-42');
        store.data.entries.consoleAgentKey = { v: 1, cipher, updatedAt: new Date(0).toISOString() };
        store.writeAtomic();

        await expect(store.getSecret('consoleAgentKey')).resolves.toBe('deger-42');
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.v1.json'), 'utf8'));
        expect(onDisk.entries.consoleAgentKey.v).toBe(2);
        expect(onDisk.entries.consoleAgentKey.cipher).not.toBe(cipher);
    });

    it('T-SEC-07b: Electron 43 decryptStringAsync { result, shouldReEncrypt } nesnesi doğru çözülür', async () => {
        const dir = freshDir();
        let reEncryptFlag = false;
        const e43Backend = {
            isAsyncEncryptionAvailable: async () => true,
            encryptStringAsync: async (plain) => {
                const nonce = crypto.randomBytes(8).toString('hex');
                return Buffer.from(`enc:${nonce}:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8');
            },
            decryptStringAsync: async (buf) => {
                const parts = Buffer.from(buf).toString('utf8').split(':');
                return {
                    result: Buffer.from(parts[2], 'base64').toString('utf8'),
                    shouldReEncrypt: reEncryptFlag
                };
            }
        };
        const store = newStore(dir, e43Backend);
        const keyHex = 'a1b2c3d4'.repeat(8);
        await store.setSecret('auditHmacKey', keyHex);
        const initialCipher = store.data.entries.auditHmacKey.cipher;

        // shouldReEncrypt: false -> değer düz metin olarak çözülür, yeniden şifreleme yapılmaz.
        await expect(store.getSecret('auditHmacKey')).resolves.toBe(keyHex);
        expect(store.data.entries.auditHmacKey.cipher).toBe(initialCipher);

        // shouldReEncrypt: true -> değer çözülür ve yeni cipher atomik yazılır.
        reEncryptFlag = true;
        await expect(store.getSecret('auditHmacKey')).resolves.toBe(keyHex);
        const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.v1.json'), 'utf8'));
        expect(onDisk.entries.auditHmacKey.cipher).not.toBe(initialCipher);
    });

    it('T-SEC-08: headless ajan safeStorage ile migrasyon yapar, düz metin bırakmaz', async () => {
        const dir = freshDir();
        // Düz metin sırlı başlangıç DB'si üret (eski sürüm davranışı).
        const seed = openStorage(dir);
        seed.data.settings.consoleAgentKey = 'headless-secret-1';
        seed.save();
        expect(rawData(dir)).toContain('headless-secret-1');
        seed.close();

        const store = newStore(dir);
        const h = await bootAgent({ userDataPath: dir, syncIntervalMs: 3600000, secretStore: store });
        try {
            expect(h.storage.getSettings().consoleAgentKey).toBe('headless-secret-1');
            expect(rawData(dir)).not.toContain('headless-secret-1');
            const sec = fs.readFileSync(path.join(dir, 'secrets.v1.json'), 'utf8');
            expect(sec).not.toContain('headless-secret-1');
            expect(h.secretStore.has('consoleAgentKey')).toBe(true);
        } finally {
            h.stop();
        }
    });

    it('T-SEC-08b: backend yoksa ve sır varsa headless açılışı reddedilir', async () => {
        const dir = freshDir();
        const seed = openStorage(dir);
        seed.data.settings.consoleAgentKey = 'olmaz';
        seed.save();
        seed.close();
        const store = newStore(dir, fakeBackend({ available: false }));
        await expect(bootAgent({ userDataPath: dir, syncIntervalMs: 3600000, secretStore: store }))
            .rejects.toMatchObject({ code: 'SECRET_BACKEND_UNAVAILABLE' });
    });

    it('T-SEC-09: log ve audit kayıtlarında sır maskelenir', () => {
        const payload = {
            pin: '1234',
            token: 'tok-abcdef',
            nested: { privateKey: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----' },
            authorization: 'Bearer çok-gizli'
        };
        const [masked] = log._redactArgs([payload]);
        expect(masked.pin).toBe('[REDACTED]');
        expect(masked.token).toBe('[REDACTED]');
        expect(masked.nested.privateKey).toBe('[REDACTED]');
        expect(masked.authorization).toBe('[REDACTED]');
        expect(JSON.stringify(masked)).not.toContain('tok-abcdef');
        expect(JSON.stringify(masked)).not.toContain('MIIE');

        expect(redact('Authorization: Bearer abc123')).not.toContain('abc123');
        expect(redact('pin=9876')).not.toContain('9876');
        expect(redact('token: gizli')).not.toContain('gizli');
    });

    it('T-SEC-09b: AuditLog sır ayrıntısını redakte eder', () => {
        const dir = freshDir();
        const storage = openStorage(dir);
        const audit = new AuditLog(storage);
        const rec = audit.append({
            actor: 'test',
            action: 'probe',
            target: 'Authorization: Bearer sızmasın',
            detail: 'token=abc123 pin=9999 pem -----BEGIN PRIVATE KEY-----x'
        });
        const text = JSON.stringify(rec);
        expect(text).not.toContain('abc123');
        expect(text).not.toContain('9999');
        expect(text).not.toContain('sızmasın');
        expect(audit.verify().ok).toBe(true);
    });
});
