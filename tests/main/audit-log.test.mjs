/**
 * audit-log.test.mjs - FAZ B
 * Hash zinciri: ekleme, doğrulama, kurcalama tespiti.
 */
import { describe, it, expect } from 'vitest';
import { AuditLog, MAX_RECORDS } from '../../src/main/services/AuditLog.js';

describe('AuditLog', () => {
    it('kayıtlar zincirlenir ve doğrulanır', () => {
        const log = new AuditLog(null);
        log.append({ actor: 'console', action: 'order_queued', target: 'lock' });
        log.append({ actor: 'agent', action: 'order_executed', target: 'lock' });
        const v = log.verify();
        expect(v.ok).toBe(true);
        expect(v.records).toBe(2);
        const list = log.load();
        expect(list[1].prevHash).toBe(list[0].hash);
        expect(list[0].prevHash).toBe('GENESIS');
    });

    it('kurcalama yakalanır', () => {
        const log = new AuditLog(null);
        log.append({ actor: 'console', action: 'order_queued' });
        log.append({ actor: 'agent', action: 'order_executed' });
        log.load()[0].detail = 'sonradan değiştirildi';
        const v = log.verify();
        expect(v.ok).toBe(false);
        expect(v.code).toBe('TAMPERED');
    });

    it('sıra atlaması yakalanır', () => {
        const log = new AuditLog(null);
        log.append({ actor: 'a', action: 'x' });
        log.append({ actor: 'a', action: 'y' });
        log.load()[1].seq = 99;
        // seq değişimi hash'i de bozar → TAMPERED veya BROKEN_CHAIN
        expect(log.verify().ok).toBe(false);
    });

    it('boş günlük geçerli', () => {
        expect(new AuditLog(null).verify()).toEqual({ ok: true, records: 0 });
    });

    it('O-10: rotasyonda rotatedFrom hash kapsamına girer; değiştirilirse TAMPERED', () => {
        const log = new AuditLog(null);
        for (let i = 0; i < MAX_RECORDS + 1; i += 1) {
            log.append({ actor: 'system', action: 'rotate', detail: String(i) });
        }
        const list = log.load();
        expect(list).toHaveLength(MAX_RECORDS);
        expect(list[0].seq).toBe(2);
        expect(typeof list[0].rotatedFrom).toBe('string');
        expect(log.verify()).toEqual({ ok: true, records: MAX_RECORDS });

        list[0].rotatedFrom = 'sahte-rotasyon';
        const v = log.verify();
        expect(v.ok).toBe(false);
        expect(v.code).toBe('TAMPERED');
    });
});
