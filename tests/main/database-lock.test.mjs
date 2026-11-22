/**
 * database-lock.test.mjs - O-09
 * Veri dizini kilidi: atomik oluşturma, canlı PID reddi, ölü/bozuk kilit devralma.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Db } from '../../src/main/storage/Database.js';

const dirs = [];

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lock-'));
    dirs.push(dir);
    return dir;
}

function lockPath(dir) {
    return path.join(dir, 'storage.lock');
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Database.acquireLock (O-09)', () => {
    it('atomik kilit oluşturur ve release temizler', () => {
        const dir = freshDir();
        const release = Db.acquireLock(dir);
        const rec = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
        expect(rec.pid).toBe(process.pid);
        expect(typeof rec.token).toBe('string');
        release();
        expect(fs.existsSync(lockPath(dir))).toBe(false);
    });

    it('canlı PID kilidi devralınmaz (STORAGE_LOCKED)', () => {
        const dir = freshDir();
        fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
        expect(() => Db.acquireLock(dir, process.pid + 1)).toThrowError(/kullanılıyor/);
        expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
    });

    it('ölü PID kilidi atomik olarak devralınır', () => {
        const dir = freshDir();
        const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10000 });
        const deadPid = child.pid;
        expect(Number.isInteger(deadPid)).toBe(true);
        fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));

        const release = Db.acquireLock(dir);
        expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
        expect(fs.readdirSync(dir).some((name) => name.includes('.stale-'))).toBe(false);
        release();
    });

    it('bozuk kilit dosyası devralınır', () => {
        const dir = freshDir();
        fs.writeFileSync(lockPath(dir), 'bozuk-json');
        const release = Db.acquireLock(dir);
        expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid);
        release();
    });

    it('release yalnızca kendi token’ını siler', () => {
        const dir = freshDir();
        const first = Db.acquireLock(dir);
        const other = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'));
        other.token = 'baska-token';
        fs.writeFileSync(lockPath(dir), JSON.stringify(other));
        first();
        expect(fs.existsSync(lockPath(dir))).toBe(true);
        fs.rmSync(lockPath(dir), { force: true });
    });
});
