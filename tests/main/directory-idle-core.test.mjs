/**
 * directory-idle-core.test.mjs - klasör sabitliği taraması (saf fs)
 * GEÇİCİ dizinlerde; sistem dizinlerine dokunulmaz.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanDirectory, isPartialFile, PARTIAL_EXT, DEFAULT_LIMITS } from '../../src/main/services/conditions/DirectoryIdle.js';

let dir;
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-diridle-')); });
afterEach(() => safeRm(dir));

describe('DirectoryIdle - sabitler ve yardımcılar', () => {
    it('kısmi uzantılar tanınır', () => {
        expect(PARTIAL_EXT.has('.crdownload')).toBe(true);
        expect(isPartialFile('a.CRDOWNLOAD')).toBe(true);
        expect(isPartialFile('a.part')).toBe(true);
        expect(isPartialFile('a.tmp')).toBe(true);
        expect(isPartialFile('a.download')).toBe(true);
        expect(isPartialFile('a.partial')).toBe(true);
        expect(isPartialFile('a.opdownload')).toBe(true);
        expect(isPartialFile('a.txt')).toBe(false);
        expect(isPartialFile('noext')).toBe(false);
        expect(DEFAULT_LIMITS).toMatchObject({ maxDepth: 2, maxEntries: 5000 });
    });
});

describe('DirectoryIdle - scanDirectory', () => {
    it('olmayan yol DIRECTORY_UNAVAILABLE', () => {
        expect(scanDirectory(path.join(dir, 'yok'))).toMatchObject({ ok: false, code: 'DIRECTORY_UNAVAILABLE' });
    });

    it('dosya yolu NOT_A_DIRECTORY', () => {
        const f = path.join(dir, 'f.txt');
        fs.writeFileSync(f, 'x');
        expect(scanDirectory(f)).toMatchObject({ ok: false, code: 'NOT_A_DIRECTORY' });
    });

    it('boş klasör ok:true, fileCount 0', () => {
        const empty = path.join(dir, 'empty');
        fs.mkdirSync(empty);
        const out = scanDirectory(empty);
        expect(out).toMatchObject({ ok: true, fileCount: 0, totalSize: 0, hasPartial: false });
        expect(out.signature).toMatch(/^0:0:0$/);
    });

    it('dosyalar toplanır, imza mtime+boyut+sayı', () => {
        fs.writeFileSync(path.join(dir, 'a.txt'), '12345');
        fs.writeFileSync(path.join(dir, 'b.txt'), '12');
        const out = scanDirectory(dir);
        expect(out.ok).toBe(true);
        expect(out.fileCount).toBe(2);
        expect(out.totalSize).toBe(7);
        expect(out.signature.split(':')).toHaveLength(3);
    });

    it('kısmi indirme dosyası hasPartial işaretler, sayıma girer', () => {
        fs.writeFileSync(path.join(dir, 'x.crdownload'), '123');
        const out = scanDirectory(dir);
        expect(out.hasPartial).toBe(true);
        expect(out.fileCount).toBe(1);
    });

    it('alt klasörler derinlik sınırına kadar taranır', () => {
        const l1 = path.join(dir, 'l1');
        const l2 = path.join(l1, 'l2');
        const l3 = path.join(l2, 'l3');
        fs.mkdirSync(l3, { recursive: true });
        fs.writeFileSync(path.join(l1, 'a.txt'), '1');
        fs.writeFileSync(path.join(l2, 'b.txt'), '1');
        fs.writeFileSync(path.join(l3, 'c.txt'), '1');

        const shallow = scanDirectory(dir, { maxDepth: 0 });
        expect(shallow.fileCount).toBe(0); // yalnız kök: klasörler atlanır

        const deep = scanDirectory(dir, { maxDepth: 5 });
        expect(deep.fileCount).toBe(3);
    });

    it('girdi sınırı aşılırsa SCAN_LIMIT_EXCEEDED', () => {
        for (let i = 0; i < 5; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
        expect(scanDirectory(dir, { maxEntries: 2 })).toMatchObject({ ok: false, code: 'SCAN_LIMIT_EXCEEDED' });
    });

    it('symlink atlanır', () => {
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
        const link = path.join(dir, 'link.txt');
        try {
            fs.symlinkSync(path.join(dir, 'a.txt'), link);
        } catch (_) {
            return; // Windows'ta ayrıcalık yoksa atla
        }
        const out = scanDirectory(dir);
        expect(out.ok).toBe(true);
        expect(out.fileCount).toBe(1);
    });

    it('symlink kök REPARSE_POINT', () => {
        const target = path.join(dir, 'target');
        fs.mkdirSync(target);
        const link = path.join(dir, 'linkdir');
        try {
            fs.symlinkSync(target, link, 'dir');
        } catch (_) {
            return;
        }
        expect(scanDirectory(link)).toMatchObject({ ok: false, code: 'REPARSE_POINT' });
    });

    it('zaman aşımı SCAN_TIMEOUT', () => {
        const out = scanDirectory(dir, { timeoutMs: -1 });
        expect(out).toMatchObject({ ok: false, code: 'SCAN_TIMEOUT' });
    });
});
