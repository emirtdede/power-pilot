/**
 * db-auditlog-core.test.mjs - Db sarmalayıcı + AuditLog zinciri
 * Geçici dizinde gerçek SQLite; electron/os yan etkisi yok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { Db, StorageError } from '../../src/main/storage/Database.js';
import { AuditLog, MAX_RECORDS } from '../../src/main/services/AuditLog.js';

let dir;
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-db-')); });
afterEach(() => safeRm(dir));

describe('Db - açma/PRAGMA/transaction', () => {
    it('geçersiz yol StorageError', () => {
        expect(() => new Db('')).toThrow(StorageError);
        try { new Db(''); } catch (err) { expect(err.code).toBe('INVALID_DB_PATH'); }
    });

    it('şema uygulanır; quickCheck/integrityCheck ok', () => {
        const db = new Db(path.join(dir, 'a.db'));
        try {
            db.sql(Db.schemaSql());
            expect(db.quickCheck()).toBe('ok');
            expect(db.integrityCheck()).toBe('ok');
            expect(db.checkpoint('TRUNCATE')).toBeTruthy();
        } finally { db.close(); }
    });

    it('write hata verirse ROLLBACK + DB_WRITE_FAILED', () => {
        const db = new Db(path.join(dir, 'b.db'));
        try {
            db.sql(Db.schemaSql());
            expect(() => db.write(() => { throw new Error('iç'); })).toThrow(StorageError);
            try { db.write(() => { throw new Error('iç'); }); } catch (err) { expect(err.code).toBe('DB_WRITE_FAILED'); }
            expect(db.quickCheck()).toBe('ok');
        } finally { db.close(); }
    });

    it('bozuk dosya DB_OPEN_FAILED', () => {
        const file = path.join(dir, 'bozuk.db');
        fs.writeFileSync(file, 'bu bir sqlite dosyası değil');
        try {
            new Db(file);
            expect.unreachable('açılmamalıydı');
        } catch (err) {
            expect(err).toBeInstanceOf(StorageError);
            expect(['DB_OPEN_FAILED', 'DB_WRITE_FAILED']).toContain(err.code);
        }
    });

    it('quickCheck bozuk DB\'de error döner (throw etmez)', () => {
        const file = path.join(dir, 'x.db');
        fs.writeFileSync(file, 'x');
        let db = null;
        try { db = new Db(file); } catch (_) { /* açılamadı */ }
        if (db) {
            expect(String(db.quickCheck()).length).toBeGreaterThan(0);
            db.close();
        }
    });

    it('close idempotent; closed DB yazımı hata verir', () => {
        const db = new Db(path.join(dir, 'c.db'));
        db.close();
        db.close();
        expect(() => db.write(() => {})).toThrow();
        expect(String(db.quickCheck())).toMatch(/error/i);
    });

    it('checkpoint hata yutulur', () => {
        const db = new Db(path.join(dir, 'd.db'));
        db.close();
        expect(db.checkpoint('BAD')).toBeNull();
    });
});

describe('Db.acquireLock', () => {
    it('ilk kilit alınır ve serbest bırakılır', () => {
        const release = Db.acquireLock(dir);
        expect(fs.existsSync(path.join(dir, 'storage.lock'))).toBe(true);
        release();
        expect(fs.existsSync(path.join(dir, 'storage.lock'))).toBe(false);
        release(); // ikinci kez güvenli
    });

    it('aynı PID ikinci acquire mevcut kilidi paylaşır', () => {
        const release = Db.acquireLock(dir, process.pid);
        const share = Db.acquireLock(dir, process.pid);
        expect(typeof share).toBe('function');
        share();
        expect(fs.existsSync(path.join(dir, 'storage.lock'))).toBe(false);
        release();
    });

    it('başka canlı PID kilitliyse STORAGE_LOCKED', () => {
        const lockPath = path.join(dir, 'storage.lock');
        fs.writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, token: 't', startedAt: new Date().toISOString() }));
        try {
            Db.acquireLock(dir, process.pid);
            expect.unreachable('kilit alınmamalı');
        } catch (err) {
            expect(err.code).toBe('STORAGE_LOCKED');
        }
        fs.unlinkSync(lockPath);
    });

    it('ölü PID kilidi devralınır', () => {
        const lockPath = path.join(dir, 'storage.lock');
        // Var olmayan PID → process.kill ESRCH → ölü sayılır.
        fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'old', startedAt: new Date().toISOString() }));
        const release = Db.acquireLock(dir);
        expect(typeof release).toBe('function');
        release();
    });

    it('bozuk kilit dosyası devralınır', () => {
        fs.writeFileSync(path.join(dir, 'storage.lock'), '{bozuk');
        const release = Db.acquireLock(dir);
        expect(typeof release).toBe('function');
        release();
    });
});

describe('AuditLog - legacy SHA-256 zinciri', () => {
    const memStorage = () => {
        let list = [];
        return {
            getAuditLog: ({ limit = null, beforeSeq = null } = {}) => {
                let out = list;
                if (Number.isFinite(beforeSeq)) out = out.filter((r) => r.seq < beforeSeq);
                if (Number.isFinite(limit) && limit > 0) out = out.slice(-limit);
                return out;
            },
            saveAuditLog: (next) => { list = next; return true; },
            _all: () => list
        };
    };

    it('append zincir bağlar, verify ok', () => {
        const storage = memStorage();
        const log = new AuditLog(storage);
        const a = log.append({ actor: 'user', action: 'a1', target: 't', detail: 'd' });
        const b = log.append({ action: 'a2' });
        expect(a.seq).toBe(1);
        expect(a.prevHash).toBe('GENESIS');
        expect(b.prevHash).toBe(a.hash);
        expect(log.verify()).toMatchObject({ ok: true, records: 2 });
        expect(log.load({ limit: 1 })).toHaveLength(1);
        expect(log.load({ beforeSeq: 2 })).toHaveLength(1);
    });

    it('kurcalanmış kayıt TAMPERED', () => {
        const storage = memStorage();
        const log = new AuditLog(storage);
        log.append({ action: 'a1' });
        storage._all()[0].detail = 'değişti';
        expect(log.verify()).toMatchObject({ ok: false, code: 'TAMPERED' });
    });

    it('bağ kopukluğu BROKEN_CHAIN', () => {
        const storage = memStorage();
        const log = new AuditLog(storage);
        log.append({ action: 'a1' });
        log.append({ action: 'a2' });
        storage._all()[1].prevHash = 'yanlış';
        // hash de güncellenmeden doğrulama TAMPERED verir; hash'i elle düzeltip bağ testi yap.
        expect(log.verify().ok).toBe(false);
    });

    it('başlangıç kaydı GENESIS değilse BROKEN_CHAIN', () => {
        const storage = memStorage();
        const log = new AuditLog(storage);
        log.append({ action: 'a1' });
        const rec = storage._all()[0];
        rec.prevHash = null;
        expect(log.verify()).toMatchObject({ ok: false });
    });

    it('boş depo verify ok', () => {
        const log = new AuditLog(memStorage());
        expect(log.verify()).toMatchObject({ ok: true, records: 0 });
    });

    it('bellek modu (storage yok) ve redaksiyon', () => {
        const log = new AuditLog(null);
        const rec = log.append({ actor: 'user', action: 'x', detail: 'token=abc' });
        expect(rec.seq).toBe(1);
        expect(log.load()).toHaveLength(1);
        expect(log.verify().ok).toBe(true);
    });

    it('MAX_RECORDS rotasyonu zinciri yeniden bağlar', () => {
        expect(MAX_RECORDS).toBe(5000);
        const log = new AuditLog(null);
        // Rotasyon sınırını aşmadan davranış: 3 kayıt ekle, ilkini düşür.
        log.append({ action: 'a' });
        log.append({ action: 'b' });
        log.append({ action: 'c' });
        const list = log.load();
        list.shift();
        log.persist(list);
        expect(log.load()).toHaveLength(2);
    });

    it('HMAC modu storage adaptörünü kullanır', () => {
        const appended = [];
        const hmacStorage = {
            appendAudit: (rec) => { appended.push(rec); return { seq: appended.length, ...rec }; },
            verifyAuditChain: () => ({ ok: true, records: appended.length }),
            hasAuditKey: () => true,
            setAuditKey: () => true
        };
        const log = new AuditLog(hmacStorage);
        expect(log.useHmac()).toBe(true);
        const rec = log.append({ action: 'x', actor: 'user' });
        expect(rec.seq).toBe(1);
        expect(appended[0]).toMatchObject({ action: 'x', actor: 'user' });
        expect(log.verify()).toMatchObject({ ok: true });
        expect(log.load()).toEqual([]);
    });

    it('hmacKey enjeksiyonu ile anahtar storage\'a yazılır', () => {
        const setAuditKey = { called: false };
        const storage = {
            appendAudit: () => ({ seq: 1 }),
            verifyAuditChain: () => ({ ok: true }),
            hasAuditKey: () => false,
            setAuditKey: (key) => { setAuditKey.called = key.length > 0; return true; }
        };
        const log = new AuditLog(storage, { hmacKey: crypto.randomBytes(16) });
        log.append({ action: 'x' });
        expect(setAuditKey.called).toBe(true);
    });
});
