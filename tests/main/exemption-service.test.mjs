/**
 * exemption-service.test.mjs - FAZ B
 * Muafiyet CRUD + eşleşme + bakım penceresi.
 */
import { describe, it, expect, vi } from 'vitest';
import { ExemptionService, validateExemption, isInWindow } from '../../src/main/services/ExemptionService.js';

function makeService() {
    const store = { exemptions: [], windows: [] };
    const storage = {
        getExemptions: () => store.exemptions,
        saveExemptions: (l) => { store.exemptions = l; },
        getMaintenanceWindows: () => store.windows,
        saveMaintenanceWindows: (l) => { store.windows = l; }
    };
    return { svc: new ExemptionService(storage), store };
}

const EX = {
    id: 'ex-1', deviceId: 'agent-pc-01', policyId: 'pol-gece',
    from: new Date(Date.now() - 3600000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
    reason: 'Gece render sürüyor', approvedBy: 'IT Müdürü'
};

describe('validateExemption', () => {
    it('gerekçesiz/onaysız muafiyet reddedilir', () => {
        expect(validateExemption({ ...EX, reason: '' }).ok).toBe(false);
        expect(validateExemption({ ...EX, approvedBy: '' }).ok).toBe(false);
        expect(validateExemption({ ...EX, deviceId: undefined, user: undefined }).ok).toBe(false);
        expect(validateExemption({ ...EX, from: EX.to, to: EX.from }).ok).toBe(false);
    });
});

describe('ExemptionService', () => {
    it('ekler, eşleştirir, kaldırır', () => {
        const { svc } = makeService();
        svc.add(EX);
        const hit = svc.findExemption({ deviceId: 'agent-pc-01', policyId: 'pol-gece' });
        expect(hit && hit.id).toBe('ex-1');
        // başka politika etkilenmez
        expect(svc.findExemption({ deviceId: 'agent-pc-01', policyId: 'pol-kilit' })).toBeNull();
        // başka cihaz etkilenmez
        expect(svc.findExemption({ deviceId: 'agent-pc-99', policyId: 'pol-gece' })).toBeNull();
        svc.remove('ex-1');
        expect(svc.findExemption({ deviceId: 'agent-pc-01', policyId: 'pol-gece' })).toBeNull();
    });

    it('policyId=null tüm politikaları kapsar', () => {
        const { svc } = makeService();
        svc.add({ ...EX, id: 'ex-all', policyId: null });
        expect(svc.findExemption({ deviceId: 'agent-pc-01', policyId: 'baska' })).not.toBeNull();
    });

    it('süresi dolmuş muafiyet eşleşmez', () => {
        const { svc } = makeService();
        svc.add({ ...EX, id: 'ex-old', from: new Date(Date.now() - 86400000 * 2).toISOString(), to: new Date(Date.now() - 86400000).toISOString() });
        expect(svc.findExemption({ deviceId: 'agent-pc-01', policyId: 'pol-gece' })).toBeNull();
    });
});

describe('bakım penceresi', () => {
    it('pencere içi/dışı doğru', () => {
        // Her günü kapsayan 02:00-04:00 penceresi
        const w = { id: 'mw', days: [0, 1, 2, 3, 4, 5, 6], start: '02:00', end: '04:00' };
        const inside = new Date(2026, 9, 14, 3, 0, 0).getTime();
        const outside = new Date(2026, 9, 14, 12, 0, 0).getTime();
        expect(isInWindow(w, inside)).toBe(true);
        expect(isInWindow(w, outside)).toBe(false);
    });

    it('inMaintenanceWindow depodan okur', () => {
        const { svc } = makeService();
        expect(svc.inMaintenanceWindow()).toBe(false);
        svc.addWindow({ id: 'mw', name: 'Yama', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' });
        expect(svc.inMaintenanceWindow()).toBe(true);
        svc.removeWindow('mw');
        expect(svc.inMaintenanceWindow()).toBe(false);
    });
});
