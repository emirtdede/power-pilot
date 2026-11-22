/**
 * server-profile.test.mjs - FAZ D
 * Sunucu profilinde konsoldan uyku/kapatma yasak; restart yalnızca bakım penceresinde.
 */
import { describe, it, expect } from 'vitest';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';

function makeEngine({ role = 'workstation', windows = [] } = {}) {
    const storage = {
        getSettings: () => ({ agentId: 'srv-01', deviceRole: role }),
        getExemptions: () => [],
        saveExemptions: () => {},
        getMaintenanceWindows: () => windows,
        saveMaintenanceWindows: () => {}
    };
    const execFn = () => { throw new Error('exec çağrılmamalıydı'); };
    return new SafetyPolicyEngine(storage, execFn, () => 9999);
}

const OFF = {
    checkProtectedApps: false,
    checkUserActivity: false,
    checkFullscreen: false,
    checkSystemLoad: false
};
const con = (action, extra = {}) => ({ action, source: 'console', safetyPolicy: OFF, ...extra });
const FULL_DAY = [{ id: 'mw', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }];

describe('Sunucu profili kapıları', () => {
    for (const action of ['sleep', 'hibernate', 'shutdown']) {
        it(`sunucuda konsol-${action} yasak`, async () => {
            const r = await makeEngine({ role: 'server' }).evaluate(con(action));
            expect(r.allowed).toBe(false);
            expect(r.reason).toContain('Sunucu profili');
        });
    }

    it('iş-istasyonunda aynı emirler serbest', async () => {
        const r = await makeEngine({ role: 'workstation' }).evaluate(con('shutdown'));
        expect(r.allowed).toBe(true);
    });

    it('yerel görev sunucuda bile serbest (fiziksel yönetici)', async () => {
        const eng = makeEngine({ role: 'server' });
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: OFF });
        expect(r.allowed).toBe(true);
    });

    it('sunucu-restart bayraksız/penceresiz yasak', async () => {
        const eng = makeEngine({ role: 'server', windows: FULL_DAY });
        expect((await eng.evaluate(con('restart'))).allowed).toBe(false);
        expect((await eng.evaluate(con('restart', { requiresMaintenanceWindow: true }))).allowed).toBe(true);
    });

    it('sunucu-restart pencere dışında bayraklı bile yasak', async () => {
        const eng = makeEngine({ role: 'server', windows: [] });
        const r = await eng.evaluate(con('restart', { requiresMaintenanceWindow: true }));
        expect(r.allowed).toBe(false);
    });

    it('lock emri sunucuda da çalışır', async () => {
        const r = await makeEngine({ role: 'server' }).evaluate(con('lock'));
        expect(r.allowed).toBe(true);
    });
});

describe('sanitizeForConsole (KVKK)', () => {
    it('exe adlarını maskeler', () => {
        const out = SafetyPolicyEngine.sanitizeForConsole('Korunan uygulama(lar) çalışıyor: code.exe, zoom.exe');
        expect(out).not.toContain('code.exe');
        expect(out).toContain('korunan-uygulama');
    });
});
