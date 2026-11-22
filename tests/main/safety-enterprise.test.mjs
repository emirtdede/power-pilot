/**
 * safety-enterprise.test.mjs - FAZ B
 * Konsol görevlerinde muafiyet + bakım-penceresi kapıları; yerel görev etkilenmez.
 */
import { describe, it, expect } from 'vitest';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';

function makeEngine({ exemptions = [], windows = [], agentId = 'agent-pc-01' } = {}) {
    const storage = {
        getSettings: () => ({ agentId }),
        getExemptions: () => exemptions,
        saveExemptions: () => {},
        getMaintenanceWindows: () => windows,
        saveMaintenanceWindows: () => {}
    };
    // exec hiç çağrılmamalı (güvenlik dalları kapalı) - çağrılırsa patlar.
    const execFn = () => { throw new Error('exec çağrılmamalıydı'); };
    return new SafetyPolicyEngine(storage, execFn, () => 9999);
}

const OFF = {
    checkProtectedApps: false,
    checkUserActivity: false,
    checkFullscreen: false,
    checkSystemLoad: false
};
const EX = {
    id: 'ex-1', deviceId: 'agent-pc-01', policyId: 'pol-gece',
    from: new Date(Date.now() - 3600000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
    reason: 'Render', approvedBy: 'IT'
};

describe('SafetyPolicyEngine FAZ B kapıları', () => {
    it('muaf cihazda konsol görevi engellenir', async () => {
        const eng = makeEngine({ exemptions: [EX] });
        const r = await eng.evaluate({ action: 'shutdown', source: 'console', policyId: 'pol-gece', safetyPolicy: OFF });
        expect(r.allowed).toBe(false);
        expect(r.reason).toContain('Muafiyet');
    });

    it('muafiyet yerel görevi etkilemez', async () => {
        const eng = makeEngine({ exemptions: [{ ...EX, policyId: null }] });
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: OFF });
        expect(r.allowed).toBe(true);
    });

    it('bakım-penceresi bayraklı görev pencere dışında engellenir', async () => {
        const eng = makeEngine({ windows: [] });
        const r = await eng.evaluate({ action: 'restart', source: 'console', requiresMaintenanceWindow: true, safetyPolicy: OFF });
        expect(r.allowed).toBe(false);
        expect(r.reason).toContain('Bakım penceresi');
    });

    it('bakım-penceresi içinde izin verilir', async () => {
        const eng = makeEngine({ windows: [{ id: 'mw', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }] });
        const r = await eng.evaluate({ action: 'restart', source: 'console', requiresMaintenanceWindow: true, safetyPolicy: OFF });
        expect(r.allowed).toBe(true);
    });

    it('bayraksız konsol görevi pencereye takılmaz', async () => {
        const eng = makeEngine({ windows: [] });
        const r = await eng.evaluate({ action: 'shutdown', source: 'console', policyId: 'pol-gece', safetyPolicy: OFF });
        expect(r.allowed).toBe(true);
    });
});
