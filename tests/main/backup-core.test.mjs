/**
 * backup-core.test.mjs - yedekleme/şifreleme/geri yükleme (PPBK1)
 * Gerçek SQLite + AES-GCM, GEÇİCİ dizinde. Ağ yok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

import Backup from '../../src/main/storage/Backup.js';

const {
    MAGIC, VERSION, normalizeKey, sha256File, vacuumInto, encryptFile, decryptFile,
    quickCheck, pruneBackups, backupDatabase, restoreDatabase
} = Backup;

let dir;
const KEY = crypto.randomBytes(32);
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-backup-')); });
afterEach(() => safeRm(dir));

function makeDb(file = path.join(dir, 'src.db')) {
    const db = new Database(file);
    db.exec('CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t(v) VALUES (?)').run('merhaba');
    db.close();
    return file;
}

describe('Backup - anahtar normalizasyonu', () => {
    it('32 bayt buffer, 64 hex, base64 ve ham metin', () => {
        expect(normalizeKey(KEY)).toHaveLength(32);
        expect(normalizeKey(KEY.toString('hex'))).toHaveLength(32);
        expect(normalizeKey(KEY.toString('base64'))).toHaveLength(32);
        const raw = 'a'.repeat(32);
        expect(normalizeKey(raw).toString('utf8')).toBe(raw);
        expect(normalizeKey(Buffer.from(KEY.toString('hex')))).toHaveLength(32);
    });

    it('geçersiz anahtar kodları', () => {
        expect(() => normalizeKey(null)).toThrow();
        try { normalizeKey(undefined); } catch (err) { expect(err.code).toBe('BACKUP_KEY_MISSING'); }
        try { normalizeKey('kısa'); } catch (err) { expect(err.code).toBe('BACKUP_KEY_INVALID'); }
        try { normalizeKey(Buffer.alloc(10)); } catch (err) { expect(err.code).toBe('BACKUP_KEY_INVALID'); }
    });
});

describe('Backup - vacuumInto ve şifreleme', () => {
    it('vacuumInto kopya üretir; DB yoksa DB_NOT_FOUND', () => {
        const src = makeDb();
        const target = path.join(dir, 'copy.db');
        const out = vacuumInto(src, target);
        expect(out.bytes).toBeGreaterThan(0);
        expect(out.sha256).toBe(sha256File(target));
        expect(() => vacuumInto(path.join(dir, 'yok.db'), path.join(dir, 'x.db'))).toThrow();
    });

    it('encryptFile → decryptFile turu', () => {
        const src = makeDb();
        const enc = path.join(dir, 'b.ppbk');
        const out = encryptFile(src, enc, KEY);
        expect(out.bytes).toBeGreaterThan(fs.statSync(src).size);
        const buf = fs.readFileSync(enc);
        expect(buf.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
        expect(buf[MAGIC.length]).toBe(VERSION);

        const restored = path.join(dir, 'restored.db');
        const dec = decryptFile(enc, restored, KEY);
        expect(dec.bytes).toBe(fs.statSync(restored).size);
        expect(fs.readFileSync(restored).subarray(0, 16).toString('utf8')).toBe('SQLite format 3\u0000');
    });

    it('yanlış anahtar → BACKUP_DECRYPT_FAILED', () => {
        const src = makeDb();
        const enc = path.join(dir, 'b.ppbk');
        encryptFile(src, enc, KEY);
        try {
            decryptFile(enc, path.join(dir, 'x.db'), crypto.randomBytes(32));
            expect.unreachable('çözülmemeli');
        } catch (err) {
            expect(err.code).toBe('BACKUP_DECRYPT_FAILED');
        }
    });

    it('kısa dosya / yanlış magic / sürüm / SQLite olmayan içerik', () => {
        const short = path.join(dir, 'short.ppbk');
        fs.writeFileSync(short, 'x');
        try { decryptFile(short, path.join(dir, 'o1.db'), KEY); } catch (err) { expect(err.code).toBe('BACKUP_CORRUPT'); }

        const badMagic = path.join(dir, 'magic.ppbk');
        fs.writeFileSync(badMagic, Buffer.concat([Buffer.from('XXXXX'), Buffer.alloc(40)]));
        try { decryptFile(badMagic, path.join(dir, 'o2.db'), KEY); } catch (err) { expect(err.code).toBe('BACKUP_BAD_FORMAT'); }

        const badVersion = path.join(dir, 'ver.ppbk');
        fs.writeFileSync(badVersion, Buffer.concat([MAGIC, Buffer.from([9]), Buffer.alloc(40)]));
        try { decryptFile(badVersion, path.join(dir, 'o3.db'), KEY); } catch (err) { expect(err.code).toBe('BACKUP_BAD_VERSION'); }

        // Geçerli şifreli ama içerik SQLite değil
        const notSqlite = path.join(dir, 'plain.bin');
        fs.writeFileSync(notSqlite, 'bu sqlite değil');
        const encNot = path.join(dir, 'notsqlite.ppbk');
        encryptFile(notSqlite, encNot, KEY);
        try { decryptFile(encNot, path.join(dir, 'o4.db'), KEY); } catch (err) { expect(err.code).toBe('BACKUP_NOT_SQLITE'); }
    });

    it('quickCheck sağlam DB için ok döner; bozuk dosyada fırlatır', () => {
        const src = makeDb();
        expect(quickCheck(src)).toBe('ok');
        const broken = path.join(dir, 'broken.db');
        fs.writeFileSync(broken, 'bozuk');
        expect(() => quickCheck(broken)).toThrow();
    });
});

describe('Backup - prune / backupDatabase / restoreDatabase', () => {
    it('pruneBackups yaş ve sayı sınırı uygular', () => {
        const bdir = path.join(dir, 'backups');
        fs.mkdirSync(bdir, { recursive: true });
        const now = Date.now();
        const files = ['a', 'b', 'c'].map((n, i) => {
            const p = path.join(bdir, `powerpilot_${n}.db.enc`);
            fs.writeFileSync(p, 'x');
            const t = new Date(now - i * 3600000);
            fs.utimesSync(p, t, t);
            return p;
        });
        // 2 dosya tutulur, en eski silinir
        const removed = pruneBackups(bdir, { keep: 2, keepDays: 7, nowMs: now });
        expect(removed.length).toBe(1);
        expect(fs.existsSync(files[2])).toBe(false);

        // keepDays dışı silinir
        const old = path.join(bdir, 'powerpilot_old.db.enc');
        fs.writeFileSync(old, 'x');
        const t = new Date(now - 40 * 86400000);
        fs.utimesSync(old, t, t);
        expect(pruneBackups(bdir, { keep: 10, keepDays: 7, nowMs: now })).toContain('powerpilot_old.db.enc');

        expect(pruneBackups(path.join(dir, 'yok'), {})).toEqual([]);
    });

    it('backupDatabase → restoreDatabase turu', () => {
        const src = makeDb();
        const out = backupDatabase({ dbPath: src, backupDir: path.join(dir, 'backups'), key: KEY, prefix: 'powerpilot' });
        expect(fs.existsSync(out.path)).toBe(true);
        expect(out.encBytes).toBeGreaterThan(0);
        expect(out.rawBytes).toBeGreaterThan(0);
        expect(out.quickCheck).toBe('ok');

        const target = path.join(dir, 'restored.db');
        const r = restoreDatabase({ inputPath: out.path, dbPath: target, key: KEY });
        expect(fs.existsSync(target)).toBe(true);
        expect(r.quickCheck).toBe('ok');

        const db = new Database(target, { readonly: true });
        try { expect(db.prepare('SELECT v FROM t').get().v).toBe('merhaba'); } finally { db.close(); }
    });

    it('restoreDatabase bozuk yedeği reddeder ve mevcut DB korunur', () => {
        const target = makeDb(path.join(dir, 'live.db'));
        const bad = path.join(dir, 'bad.ppbk');
        fs.writeFileSync(bad, 'bozuk');
        expect(() => restoreDatabase({ inputPath: bad, dbPath: target, key: KEY, quarantineDir: path.join(dir, 'q') })).toThrow();
        expect(fs.existsSync(target)).toBe(true);

        const noInput = path.join(dir, 'yok.ppbk');
        expect(() => restoreDatabase({ inputPath: noInput, dbPath: target, key: KEY })).toThrow();
    });
});
