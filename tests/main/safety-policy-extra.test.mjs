/**
 * safety-policy-extra.test.mjs - SafetyPolicyEngine kalan dallar
 *
 * Süreç listesi/komutlar enjekte edilir; OS güç eylemi ve gerçek spawn yok.
 */
import { describe, it, expect, vi } from 'vitest';
import Engine from '../../src/main/services/SafetyPolicyEngine.js';

const POWERCFG_IDLE = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\nNone.\r\n\r\nAWAYMODE:\r\nNone.\r\n';

function store(settings = {}) {
    return { getSettings: () => settings, getExemptions: () => [], getMaintenanceWindows: () => [] };
}

const base = { checkProtectedApps: false, checkUserActivity: false, checkFullscreen: false, checkSystemLoad: false };

describe('SafetyPolicyEngine - korunan uygulamalar / süreç listesi', () => {
    it('processProvider sonuçlarından korunan uygulama bulunur', async () => {
        const eng = new Engine(store(), vi.fn(), null, { processProvider: async () => ['C:\\Apps\\Code.EXE'] });
        const r = await eng.evaluate({ action: 'shutdown', source: 'ui', safetyPolicy: { ...base, checkProtectedApps: true } });
        expect(r).toMatchObject({ allowed: false, reasonCode: 'PROTECTED_APP_RUNNING' });
        expect(r.reason).toMatch(/code\.exe/);
    });

    it('processProvider hata verirse fail-closed', async () => {
        const eng = new Engine(store(), vi.fn(), null, { processProvider: async () => { throw new Error('yok'); } });
        const r = await eng.evaluate({ action: 'shutdown', source: 'ui', safetyPolicy: { ...base, checkProtectedApps: true } });
        expect(r).toMatchObject({ allowed: false, reasonCode: 'PROCESS_LIST_UNAVAILABLE' });
    });

    it('processProvider dizi döndürmezse fail-closed', async () => {
        const eng = new Engine(store(), vi.fn(), null, { processProvider: async () => 'x' });
        const r = await eng.evaluate({ action: 'shutdown', source: 'ui', safetyPolicy: { ...base, checkProtectedApps: true } });
        expect(r.reasonCode).toBe('PROCESS_LIST_UNAVAILABLE');
    });

    it('rawProcessNames yol/nesne/normalizasyon', () => {
        expect(Engine.rawProcessNames(null)).toEqual([]);
        expect(Engine.rawProcessNames(['A/Code.EXE', { name: ' C:\\x\\Teams.exe ' }, { processName: 'zoom.exe' }, {}, 5])).toEqual(['code.exe', 'teams.exe', 'zoom.exe']);
        expect(Engine.rawProcessNames([{ name: '' }])).toEqual([]);
    });
});

describe('SafetyPolicyEngine - ayarlar ve kill-switch', () => {
    it('ayar okunamazsa POLICY_UNAVAILABLE', async () => {
        const eng = new Engine({ getSettings: () => { throw new Error('db'); } });
        await expect(eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: base })).resolves.toMatchObject({ allowed: false, reasonCode: 'POLICY_UNAVAILABLE' });
    });

    it('agentDisabled tüm eylemleri durdurur', async () => {
        const eng = new Engine(store({ agentDisabled: true }));
        await expect(eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: base })).resolves.toMatchObject({ allowed: false, reasonCode: 'AGENT_DISABLED' });
    });

    it('uzaktan kapatma aktif kullanıcıda engellenir; idle sağlayıcı yoksa fail-closed', async () => {
        const active = new Engine(store({ blockRemoteShutdownWhenActive: true }), vi.fn(), null, { idleProvider: () => 5 });
        await expect(active.evaluate({ action: 'shutdown', source: 'local_api', safetyPolicy: base })).resolves.toMatchObject({ allowed: false, reasonCode: 'USER_ACTIVE' });

        const idle = new Engine(store({ blockRemoteShutdownWhenActive: true }), vi.fn(), null, { idleProvider: () => 600 });
        await expect(idle.evaluate({ action: 'shutdown', source: 'n8n', safetyPolicy: base })).resolves.toMatchObject({ allowed: true });

        const noProvider = new Engine(store({ blockRemoteShutdownWhenActive: true }));
        await expect(noProvider.evaluate({ action: 'restart', source: 'console', safetyPolicy: base })).resolves.toMatchObject({ allowed: false, reasonCode: 'USER_ACTIVE' });

        const local = new Engine(store({ blockRemoteShutdownWhenActive: true }), vi.fn(), null, { idleProvider: () => 0 });
        await expect(local.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: base })).resolves.toMatchObject({ allowed: true });
    });

    it('powerMonitor kaynağı ve hata durumu', async () => {
        const pm = new Engine(store({ blockRemoteShutdownWhenActive: true }), vi.fn(), null, { powerMonitor: { getSystemIdleTime: () => 900 } });
        await expect(pm.evaluate({ action: 'shutdown', source: 'local_api', safetyPolicy: base })).resolves.toMatchObject({ allowed: true });

        const broken = new Engine(store({ blockRemoteShutdownWhenActive: true }), vi.fn(), null, { powerMonitor: { getSystemIdleTime: () => { throw new Error('x'); } } });
        await expect(broken.evaluate({ action: 'shutdown', source: 'local_api', safetyPolicy: base })).resolves.toMatchObject({ allowed: false });
    });
});

describe('SafetyPolicyEngine - güç istekleri ve tam ekran dalları', () => {
    it('aktif güç isteği POWER_REQUEST_ACTIVE; 5 sn sonuç önbelleği', async () => {
        const busy = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\n[DRIVER] \\FileSystem\\srvnet\r\n';
        const exec = vi.fn((file, args, opts, cb) => cb(null, busy));
        const eng = new Engine(store(), exec);
        const policy = { ...base, checkSystemLoad: true };
        await expect(eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: policy })).resolves.toMatchObject({ reasonCode: 'POWER_REQUEST_ACTIVE' });
        const calls = exec.mock.calls.length;
        await eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: policy });
        expect(exec.mock.calls.length).toBe(calls); // önbellek
    });

    it('komut yetkili ama çıktı çözülemezse fail-closed', async () => {
        const eng = new Engine(store(), (file, args, opts, cb) => cb(null, 'anlaşılmaz çıktı'));
        const r = await eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: { ...base, checkSystemLoad: true } });
        expect(r).toMatchObject({ reasonCode: 'POWER_REQUESTS_UNAVAILABLE', loadCheck: 'ok' });
        expect(eng.getPowerRequestCapability().available).toBe(true);
    });

    it('güç isteği doğrulanamazsa (yetenek var) tam ekran kapısı da fail-closed', async () => {
        let powercfgCalls = 0;
        const eng = new Engine(store(), (file, args, opts, cb) => {
            if (String(file).includes('powercfg')) {
                powercfgCalls += 1;
                return powercfgCalls === 1 ? cb(null, POWERCFG_IDLE) : cb(new Error('yok'), '');
            }
            return cb(null, 'windowed');
        });
        await eng.probePowerRequestCapability();
        eng._powerCache = null;
        const r = await eng.evaluate({
            action: 'lock', source: 'ui',
            safetyPolicy: { ...base, checkFullscreen: true }
        });
        expect(r).toMatchObject({ allowed: false, reasonCode: 'POWER_REQUESTS_UNAVAILABLE' });
    });

    it('tam ekran ölçümü hata verirse fail-closed', async () => {
        const eng = new Engine(store(), (file, args, opts, cb) => (String(file).includes('powercfg') ? cb(null, POWERCFG_IDLE) : cb(new Error('ps'), '')));
        const r = await eng.evaluate({ action: 'lock', source: 'ui', safetyPolicy: { ...base, checkFullscreen: true } });
        expect(r).toMatchObject({ reasonCode: 'FULLSCREEN_STATE_UNAVAILABLE' });
    });

    it('parsePowerRequests tanınmayan .exe satırını UNKNOWN sayar', () => {
        expect(Engine.parsePowerRequests('C:\\x\\foo.exe\r\n')).toEqual({ hasActiveRequest: true, categories: ['UNKNOWN'] });
        expect(Engine.parsePowerRequests('DISPLAY:\r\nNone.\r\n')).toEqual({ hasActiveRequest: false, categories: [] });
    });

    it('getFullscreenState geçersiz çıktıda ok:false', async () => {
        const eng = new Engine(store(), (file, args, opts, cb) => cb(null, 'belirsiz'));
        await expect(eng.getFullscreenState()).resolves.toMatchObject({ ok: false, code: 'FULLSCREEN_STATE_UNAVAILABLE' });
    });
});

describe('SafetyPolicyEngine - kurumsal / sunucu profili', () => {
    it('konsol görevi muafiyetle engellenir', async () => {
        const eng = new Engine({
            getSettings: () => ({ agentId: 'a1' }),
            getExemptions: () => [{
                id: 'ex1', deviceId: 'a1', policyId: null,
                from: new Date(Date.now() - 60000).toISOString(),
                to: new Date(Date.now() + 60000).toISOString(),
                reason: 'test', approvedBy: 'admin'
            }],
            getMaintenanceWindows: () => []
        });
        const r = await eng.evaluate({ action: 'lock', source: 'console', safetyPolicy: base });
        expect(r).toMatchObject({ allowed: false, reasonCode: 'EXEMPTION_ACTIVE' });
    });

    it('muafiyet servisi hata verirse POLICY_UNAVAILABLE', async () => {
        const eng = new Engine({ getSettings: () => ({}), getExemptions: () => { throw new Error('x'); } });
        const r = await eng.evaluate({ action: 'lock', source: 'console', safetyPolicy: base });
        expect(r).toMatchObject({ reasonCode: 'POLICY_UNAVAILABLE' });
    });

    it('bakım penceresi dışındaki görev engellenir; pencere içinde geçer', async () => {
        const day = new Date().getDay();
        const out = new Engine({ getSettings: () => ({}), getMaintenanceWindows: () => [] });
        await expect(out.evaluate({ action: 'restart', source: 'console', requiresMaintenanceWindow: true, safetyPolicy: base }))
            .resolves.toMatchObject({ reasonCode: 'OUTSIDE_MAINTENANCE_WINDOW' });

        const inside = new Engine({
            getSettings: () => ({}),
            getExemptions: () => [],
            getMaintenanceWindows: () => [{ id: 'w', name: 'w', days: [day], start: '00:00', end: '23:59' }]
        });
        await expect(inside.evaluate({ action: 'restart', source: 'console', requiresMaintenanceWindow: true, safetyPolicy: base }))
            .resolves.toMatchObject({ allowed: true });
    });

    it('bakım penceresi okunamazsa POLICY_UNAVAILABLE', async () => {
        const eng = new Engine({ getSettings: () => ({}), getMaintenanceWindows: () => { throw new Error('x'); } });
        const r = await eng.evaluate({ action: 'restart', source: 'console', requiresMaintenanceWindow: true, safetyPolicy: base });
        expect(r).toMatchObject({ reasonCode: 'POLICY_UNAVAILABLE' });
    });

    it('sunucu profilinde yasak eylemler ve pencere dışı restart', async () => {
        const eng = new Engine({ getSettings: () => ({ deviceRole: 'server' }), getExemptions: () => [], getMaintenanceWindows: () => [] });
        for (const action of ['sleep', 'hibernate', 'shutdown']) {
            await expect(eng.evaluate({ action, source: 'console', safetyPolicy: base }))
                .resolves.toMatchObject({ reasonCode: 'SERVER_PROFILE_FORBIDDEN' });
        }
        await expect(eng.evaluate({ action: 'restart', source: 'console', safetyPolicy: base }))
            .resolves.toMatchObject({ reasonCode: 'SERVER_RESTART_OUTSIDE_WINDOW' });

        // yerel görev sunucu profilinden etkilenmez
        await expect(eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: base }))
            .resolves.toMatchObject({ allowed: true });
    });

    it('sunucu profili okunamazsa POLICY_UNAVAILABLE', async () => {
        let first = true;
        const eng = new Engine({
            getSettings: () => {
                if (first) { first = false; return { deviceRole: 'workstation' }; }
                throw new Error('db');
            }
        });
        const r = await eng.evaluate({ action: 'lock', source: 'console', safetyPolicy: base });
        expect(r).toMatchObject({ reasonCode: 'POLICY_UNAVAILABLE' });
    });

    it('sanitizeForConsole .exe adlarını gizler', () => {
        expect(Engine.sanitizeForConsole('Korunan uygulama(lar) çalışıyor: code.exe, teams.exe'))
            .toBe('Korunan uygulama(lar) çalışıyor: korunan-uygulama, korunan-uygulama');
        expect(Engine.sanitizeForConsole(null)).toBe('');
    });

    it('isBootGuardActive ayar ve uptime', () => {
        const eng = new Engine({ getSettings: () => ({ bootGuardSeconds: 60 }) }, null, () => 30);
        expect(eng.isBootGuardActive()).toBe(true);
        const off = new Engine({ getSettings: () => ({ bootGuardSeconds: 0 }) }, null, () => 1);
        expect(off.isBootGuardActive()).toBe(false);
        const broken = new Engine({ getSettings: () => { throw new Error('x'); } }, null, () => { throw new Error('y'); });
        expect(broken.isBootGuardActive()).toBe(false);
    });

    it('getRunningProcessList sağlayıcı yoksa ps-list kullanır (enjekte edilemez → hata yolu)', async () => {
        const eng = new Engine(store());
        // ps-list gerçek modüldür; çağrı en azından dizi döndürmeli veya hata fırlatmalı.
        await expect(eng.getRunningProcessList()).resolves.toBeInstanceOf(Array);
    });

    it('getCurrentUser ve getUserIdleSeconds', async () => {
        const eng = new Engine(store());
        expect(typeof eng.getCurrentUser()).toBe('string');
        await expect(eng.getUserIdleSeconds()).resolves.toBe(0); // sağlayıcı yok → aktif
        const neg = new Engine(store(), null, null, { idleProvider: () => -5 });
        await expect(neg.getUserIdleSeconds()).resolves.toBe(0);
        const thr = new Engine(store(), null, null, { idleProvider: () => { throw new Error('x'); } });
        await expect(thr.getUserIdleSeconds()).resolves.toBe(0);
    });
});
