/**
 * audit-checkpoint.test.mjs - günlük audit checkpoint üretimi/doğrulaması
 *
 * Dosyalar GEÇİCİ dizinde gerçek fs ile yazılır; Event Log yazımı enjekte
 * edilir (PowerShell çalıştırılmaz).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditCheckpoint } from '../../src/main/security/AuditCheckpoint.js';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditcp-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ } });

const day = '2026-01-05';
const rows = (n = 2) => Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    ts: `${day}T10:0${i}:00.000Z`,
    actor: 'user',
    action: 'a',
    recordHmac: `hmac-${i + 1}`
}));

describe('AuditCheckpoint - yazma', () => {
    it('dir yoksa hiçbir şey yazmaz', () => {
        const cp = new AuditCheckpoint({});
        expect(cp.ensureToday(rows())).toBeNull();
        expect(cp.write(rows())).toEqual([]);
        expect(cp.dir).toBeNull();
    });

    it('ensureToday bugünkü kayıt yoksa dosya yazmaz, varsa yazar', () => {
        const cp = new AuditCheckpoint({ dir, nowFn: () => new Date(`${day}T12:00:00Z`).getTime() });
        expect(cp.ensureToday([])).toBeNull();
        expect(cp.ensureToday([{ seq: 1, ts: '2020-01-01T00:00:00Z', recordHmac: 'x' }])).toBeNull();

        const written = cp.ensureToday(rows());
        expect(written).toBe(path.join(dir, `${day}.json`));
        const data = JSON.parse(fs.readFileSync(written, 'utf8'));
        expect(data).toMatchObject({ day, count: 2, lastSeq: 2, lastHmac: 'hmac-2' });
    });

    it('60 saniyelik yazma penceresi (force ile aşılır)', () => {
        let now = new Date(`${day}T12:00:00Z`).getTime();
        const cp = new AuditCheckpoint({ dir, nowFn: () => now });
        cp.ensureToday(rows());
        const first = fs.statSync(cp.filePath(day)).mtimeMs;
        now += 1000;
        cp.ensureToday([{ seq: 3, ts: `${day}T12:00:30Z`, recordHmac: 'h3' }]);
        expect(JSON.parse(fs.readFileSync(cp.filePath(day), 'utf8')).lastSeq).toBe(2);
        cp.ensureToday([{ seq: 3, ts: `${day}T12:00:30Z`, recordHmac: 'h3' }], { force: true });
        expect(JSON.parse(fs.readFileSync(cp.filePath(day), 'utf8')).lastSeq).toBe(3);
        expect(first).toBeGreaterThan(0);
    });

    it('yazma hatası state bırakmaz; geçersiz gün reddedilir', () => {
        const cp = new AuditCheckpoint({ dir });
        expect(cp.writeDay('../evil', rows())).toBeNull();
        expect(cp.writeDay(day, [])).toBeNull();
        expect(cp.writeDay(day, 'x')).toBeNull();
    });

    it('eventLogImpl enjekte edilirse işaret yazılır; hata yazımı bozmaz', () => {
        const ok = new AuditCheckpoint({ dir, eventLog: true, eventLogImpl: vi.fn() });
        ok.writeDay(day, rows());
        expect(ok.eventLogImpl).toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(ok.filePath(day), 'utf8')).eventLogWritten).toBe(true);

        const bad = new AuditCheckpoint({ dir, eventLog: true, eventLogImpl: () => { throw new Error('x'); } });
        bad.writeDay(day, rows());
        expect(JSON.parse(fs.readFileSync(bad.filePath(day), 'utf8')).eventLogWritten).toBe(false);
    });

    it('eventLog açık + impl yoksa yazım denenmez (asenkron varsayılan)', () => {
        const cp = new AuditCheckpoint({ dir, eventLog: true });
        const spy = vi.spyOn(cp, 'defaultEventLogWrite').mockImplementation(() => {});
        cp.writeDay(day, rows());
        expect(spy).toHaveBeenCalled();
        expect(JSON.parse(fs.readFileSync(cp.filePath(day), 'utf8')).eventLogWritten).toBe(false);
        spy.mockRestore();
    });

    it('write tüm günleri gruplar; geçersiz ts atlanır', () => {
        const cp = new AuditCheckpoint({ dir });
        const list = [
            ...rows(2),
            { seq: 3, ts: '2026-01-06T09:00:00Z', recordHmac: 'h3' },
            { seq: 4, ts: 'bozuk', recordHmac: 'h4' }
        ];
        const out = cp.write(list);
        expect(out).toHaveLength(2);
        expect(fs.existsSync(path.join(dir, '2026-01-06.json'))).toBe(true);
    });
});

describe('AuditCheckpoint - doğrulama', () => {
    it('boş girdi ok kabul edilir', () => {
        const cp = new AuditCheckpoint({ dir });
        expect(cp.verify([])).toEqual({ ok: true, records: 0 });
        expect(cp.verify(null)).toEqual({ ok: true, records: 0 });
        expect(new AuditCheckpoint({}).verify(rows())).toEqual({ ok: true, records: 0 });
    });

    it('eksik checkpoint HMAC verisiyle onarılır ve onRepair çağrılır', () => {
        const onRepair = vi.fn();
        const cp = new AuditCheckpoint({ dir, onRepair });
        const out = cp.verify(rows());
        expect(out).toMatchObject({ ok: true, repaired: [day] });
        expect(onRepair).toHaveBeenCalledWith(expect.objectContaining({ day }));
        expect(fs.existsSync(cp.filePath(day))).toBe(true);
    });

    it('eksik checkpoint HMAC verisi yoksa CHECKPOINT_MISSING', () => {
        const cp = new AuditCheckpoint({ dir });
        const out = cp.verify([{ seq: 1, ts: `${day}T10:00:00Z` }]);
        expect(out).toMatchObject({ ok: false, code: 'CHECKPOINT_MISSING' });
        expect(new AuditCheckpoint({ dir }).canRebuild([{ seq: 1 }])).toBe(false);
        expect(new AuditCheckpoint({ dir }).canRebuild([])).toBe(false);
    });

    it('bozuk/geçersiz checkpoint dosyası', () => {
        const cp = new AuditCheckpoint({ dir });
        fs.writeFileSync(cp.filePath(day), '{bozuk');
        expect(cp.verify(rows())).toMatchObject({ ok: false, code: 'CHECKPOINT_CORRUPT' });

        fs.writeFileSync(cp.filePath(day), JSON.stringify({ day: '2026-01-01', lastSeq: 1 }));
        expect(cp.verify(rows())).toMatchObject({ ok: false, code: 'CHECKPOINT_CORRUPT' });
    });

    it('rollback ve HMAC uyuşmazlığı', () => {
        const cp = new AuditCheckpoint({ dir });
        cp.writeDay(day, rows(), { eventLog: false });
        const rollback = cp.verify([{ seq: 1, ts: `${day}T10:00:00Z`, recordHmac: 'hmac-1' }]);
        expect(rollback).toMatchObject({ ok: false, code: 'CHECKPOINT_ROLLBACK' });

        const tampered = cp.verify(rows().map((r) => ({ ...r, recordHmac: `${r.recordHmac}-x` })));
        expect(tampered).toMatchObject({ ok: false, code: 'CHECKPOINT_TAMPERED' });
    });

    it('Event Log özeti uyuşmazsa EVENTLOG_TAMPERED; okunamazsa yokluk kanıtı sayılmaz', () => {
        const good = new AuditCheckpoint({ dir, eventLog: true, eventLogImpl: () => {} });
        good.writeDay(day, rows(), { eventLog: true });

        const bad = new AuditCheckpoint({ dir, readEventLogImpl: () => 'PPAUDIT:baska:hmac' });
        expect(bad.verify(rows())).toMatchObject({ ok: false, code: 'EVENTLOG_TAMPERED' });

        const matching = new AuditCheckpoint({ dir, readEventLogImpl: () => `PPAUDIT:${day}:hmac-2` });
        expect(matching.verify(rows())).toMatchObject({ ok: true });

        const throwing = new AuditCheckpoint({ dir, readEventLogImpl: () => { throw new Error('yok'); } });
        expect(throwing.verify(rows())).toMatchObject({ ok: true });

        const empty = new AuditCheckpoint({ dir, readEventLogImpl: () => '' });
        expect(empty.verify(rows())).toMatchObject({ ok: true });
    });

    it('legacy record_hmac / hash alanları da kabul edilir', () => {
        const cp = new AuditCheckpoint({ dir });
        cp.writeDay(day, [{ seq: 1, ts: `${day}T10:00:00Z`, hash: 'legacy-h' }], { eventLog: false });
        expect(cp.verify([{ seq: 1, ts: `${day}T10:00:00Z`, record_hmac: 'legacy-h' }])).toMatchObject({ ok: true });
    });
});
