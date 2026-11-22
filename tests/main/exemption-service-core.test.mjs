/**
 * exemption-service-core.test.mjs - muafiyet + bakım penceresi kuralları
 * (Electron bağımsız; depo sahte, saf fonksiyonlar doğrudan test edilir.)
 */
import { describe, it, expect, vi } from 'vitest';
import { ExemptionService, validateExemption, validateWindow, isInWindow } from '../../src/main/services/ExemptionService.js';

const NOW = Date.now();
const validEx = (over = {}) => Object.assign({
    id: 'ex_1',
    deviceId: 'pc-1',
    policyId: null,
    from: new Date(NOW - 60000).toISOString(),
    to: new Date(NOW + 60000).toISOString(),
    reason: 'yedek penceresi',
    approvedBy: 'admin'
}, over);

function makeStorage() {
    return {
        exemptions: [],
        windows: [],
        getExemptions() { return this.exemptions; },
        saveExemptions(list) { this.exemptions = list; return true; },
        getMaintenanceWindows() { return this.windows; },
        saveMaintenanceWindows(list) { this.windows = list; return true; }
    };
}

describe('validateExemption', () => {
    it('geçerli kayıt', () => {
        expect(validateExemption(validEx())).toEqual({ ok: true });
        expect(validateExemption(validEx({ deviceId: undefined, user: 'emir' }))).toEqual({ ok: true });
    });

    it('gövde/id/özne', () => {
        expect(validateExemption(null).code).toBe('INVALID_BODY');
        expect(validateExemption(validEx({ id: '' })).code).toBe('INVALID_ID');
        expect(validateExemption(validEx({ id: 'a'.repeat(65) })).code).toBe('INVALID_ID');
        expect(validateExemption(validEx({ deviceId: undefined })).code).toBe('INVALID_SUBJECT');
        expect(validateExemption(validEx({ deviceId: 'a'.repeat(129) })).code).toBe('INVALID_SUBJECT');
        expect(validateExemption(validEx({ deviceId: undefined, user: 'x'.repeat(129) })).code).toBe('INVALID_SUBJECT');
    });

    it('policyId / tarih / gerekçe / onaylayan', () => {
        expect(validateExemption(validEx({ policyId: '' })).code).toBe('INVALID_POLICY');
        expect(validateExemption(validEx({ policyId: 'p'.repeat(65) })).code).toBe('INVALID_POLICY');
        expect(validateExemption(validEx({ policyId: 'p1' }))).toEqual({ ok: true });
        expect(validateExemption(validEx({ from: 'x' })).code).toBe('INVALID_RANGE');
        expect(validateExemption(validEx({ from: new Date(NOW).toISOString(), to: new Date(NOW).toISOString() })).code).toBe('INVALID_RANGE');
        expect(validateExemption(validEx({ reason: '  ' })).code).toBe('INVALID_REASON');
        expect(validateExemption(validEx({ reason: 'a'.repeat(201) })).code).toBe('INVALID_REASON');
        expect(validateExemption(validEx({ approvedBy: '' })).code).toBe('INVALID_APPROVER');
    });
});

describe('validateWindow / isInWindow', () => {
    const win = (over = {}) => Object.assign({ id: 'mw_1', days: [1, 2, 3], start: '23:00', end: '02:00' }, over);

    it('geçerli pencere ve hatalar', () => {
        expect(validateWindow(win())).toEqual({ ok: true });
        expect(validateWindow(null).code).toBe('INVALID_BODY');
        expect(validateWindow(win({ id: '' })).code).toBe('INVALID_ID');
        expect(validateWindow(win({ days: [] })).code).toBe('INVALID_DAYS');
        expect(validateWindow(win({ days: [7] })).code).toBe('INVALID_DAYS');
        expect(validateWindow(win({ days: 'mon' })).code).toBe('INVALID_DAYS');
        expect(validateWindow(win({ start: '24:00' })).code).toBe('INVALID_TIME');
        expect(validateWindow(win({ end: '2:00' })).code).toBe('INVALID_TIME');
        expect(validateWindow(win({ start: '10:00', end: '10:00' })).code).toBe('INVALID_WINDOW');
    });

    it('gündüz penceresi', () => {
        const w = { days: [new Date(NOW).getDay()], start: '00:00', end: '23:59' };
        expect(isInWindow(w, NOW)).toBe(true);
        expect(isInWindow({ ...w, days: [(new Date(NOW).getDay() + 1) % 7] }, NOW)).toBe(false);
        expect(isInWindow({ days: w.days, start: '00:00', end: '00:01' }, NOW)).toBe(false);
    });

    it('gece yarısını aşan pencere: önceki gün kaydı', () => {
        // 2026-01-06 01:00 (Salı=2); pencere Pazartesi(1) 23:00-02:00
        const t = new Date('2026-01-06T01:00:00').getTime();
        expect(new Date(t).getDay()).toBe(2);
        expect(isInWindow({ days: [1], start: '23:00', end: '02:00' }, t)).toBe(true);
        expect(isInWindow({ days: [2], start: '23:00', end: '02:00' }, t)).toBe(false);

        // Aynı gün 23:30 → kendi günü
        const late = new Date('2026-01-05T23:30:00').getTime();
        expect(isInWindow({ days: [1], start: '23:00', end: '02:00' }, late)).toBe(true);
        // 03:00 → pencere dışı
        expect(isInWindow({ days: [1], start: '23:00', end: '02:00' }, new Date('2026-01-06T03:00:00').getTime())).toBe(false);
    });
});

describe('ExemptionService', () => {
    it('depo yoksa boş liste döner', () => {
        const svc = new ExemptionService(null);
        expect(svc.list()).toEqual([]);
        expect(svc.windows()).toEqual([]);
        expect(svc.inMaintenanceWindow()).toBe(false);
    });

    it('add/remove muafiyet; aynı id üzerine yazar', () => {
        const storage = makeStorage();
        const svc = new ExemptionService(storage);
        const rec = svc.add(validEx());
        expect(rec.policyId).toBeNull();
        expect(rec.reason).toBe('yedek penceresi');
        expect(svc.list()).toHaveLength(1);

        svc.add(validEx({ reason: 'güncel' }));
        expect(svc.list()).toHaveLength(1);
        expect(svc.list()[0].reason).toBe('güncel');

        expect(svc.remove('ex_1')).toBe(true);
        expect(svc.list()).toEqual([]);
    });

    it('add geçersiz kayıtta kod ile fırlatır', () => {
        const svc = new ExemptionService(makeStorage());
        expect(() => svc.add({})).toThrow();
        try { svc.add({}); } catch (err) { expect(err.code).toBe('INVALID_ID'); }
    });

    it('pencere ekle/sil; ad kimlikten türetilir ve kırpılır', () => {
        const storage = makeStorage();
        const svc = new ExemptionService(storage);
        const rec = svc.addWindow({ id: 'mw_1', days: [1], start: '01:00', end: '02:00' });
        expect(rec.name).toBe('mw_1');
        const named = svc.addWindow({ id: 'mw_2', name: 'x'.repeat(100), days: [2], start: '01:00', end: '02:00' });
        expect(named.name).toHaveLength(80);
        expect(svc.windows()).toHaveLength(2);
        expect(svc.removeWindow('mw_1')).toBe(true);
        expect(svc.windows()).toHaveLength(1);
        expect(() => svc.addWindow({})).toThrow();
    });

    it('findExemption: cihaz/kullanıcı, politika ve tarih eşleşmesi', () => {
        const storage = makeStorage();
        const svc = new ExemptionService(storage);
        svc.add(validEx({ id: 'ex_dev', deviceId: 'pc-1', policyId: null }));
        svc.add(validEx({ id: 'ex_pol', deviceId: 'pc-1', policyId: 'p1' }));
        svc.add(validEx({ id: 'ex_user', deviceId: undefined, user: 'emir', policyId: null }));

        expect(svc.findExemption({ deviceId: 'pc-1' }).id).toBe('ex_dev');
        expect(svc.findExemption({ deviceId: 'pc-1', policyId: 'p1' }).id).toBe('ex_dev');
        expect(svc.findExemption({ deviceId: 'pc-1', policyId: 'p2' }).id).toBe('ex_dev');
        expect(svc.findExemption({ deviceId: 'pc-2' })).toBeNull();
        expect(svc.findExemption({ user: 'emir' }).id).toBe('ex_user');
        expect(svc.findExemption({ user: 'baska' })).toBeNull();
        expect(svc.findExemption({ deviceId: 'pc-1', nowMs: NOW + 120000 })).toBeNull();

        // Politikaya özel muafiyet yalnız aynı policyId ile (O-04)
        storage.exemptions = [validEx({ id: 'only_pol', policyId: 'p1' })];
        expect(svc.findExemption({ deviceId: 'pc-1' })).toBeNull();
        expect(svc.findExemption({ deviceId: 'pc-1', policyId: 'p1' }).id).toBe('only_pol');
    });

    it('inMaintenanceWindow güncel pencereyi bulur', () => {
        const storage = makeStorage();
        const svc = new ExemptionService(storage);
        const day = new Date(NOW).getDay();
        svc.addWindow({ id: 'w', days: [day], start: '00:00', end: '23:59' });
        expect(svc.inMaintenanceWindow(NOW)).toBe(true);
        expect(svc.inMaintenanceWindow(NOW + 86400000 * 2)).toBe(false);
    });
});
