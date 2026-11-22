/**
 * safety-power-capability.test.mjs - P0/BLOCKER-001
 *
 * `powercfg.exe /requests` yükseltilmiş yetki ister; paketlenmiş uygulama
 * `asInvoker` çalışır. Motor bu farkı yetenek sondasıyla ölçer:
 *  - yetenek VAR  → eski fail-closed davranışı AYNEN korunur,
 *  - yetenek YOK  → yalnız bu kapı görünür biçimde atlanır (loadCheck).
 * Hiçbir test gerçek powercfg/PowerShell çalıştırmaz (exec enjeksiyonu).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Engine from '../../src/main/services/SafetyPolicyEngine.js';

const POWERCFG_IDLE = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\nNone.\r\n\r\nAWAYMODE:\r\nNone.\r\n';
const POWERCFG_BUSY = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\n[DRIVER] \\FileSystem\\srvnet\r\n\r\nAWAYMODE:\r\nNone.\r\n';
const ADMIN_ERR = Object.assign(new Error('powercfg requires administrator privileges'), { code: 1 });

const fullscreenOk = (file) => String(file).includes('powershell');

function engine(execFn, settings = {}) {
    return new Engine({ getSettings: () => settings }, execFn);
}

const loadOnly = { checkSystemLoad: true, checkProtectedApps: false, checkUserActivity: false, checkFullscreen: false };
const screenOnly = { checkSystemLoad: false, checkProtectedApps: false, checkUserActivity: false, checkFullscreen: true };

afterEach(() => {
    vi.useRealTimers();
});

describe('SafetyPolicyEngine yetenek sondası (P0)', () => {
    it('S-02: yetenek var + aktif güç isteği → POWER_REQUEST_ACTIVE', async () => {
        const exec = vi.fn((file, args, opts, cb) => cb(null, POWERCFG_BUSY));
        const r = await engine(exec).evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: loadOnly });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('POWER_REQUEST_ACTIVE');
        expect(r.loadCheck).toBe('active');
    });

    it('S-03: yetenek var + geçici hata → fail-closed korunur', async () => {
        let calls = 0;
        const exec = vi.fn((file, args, opts, cb) => {
            calls += 1;
            return calls === 1 ? cb(null, POWERCFG_IDLE) : cb(new Error('geçici'), '');
        });
        const eng = engine(exec);
        await eng.probePowerRequestCapability();
        eng._powerCache = null;
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: loadOnly });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('POWER_REQUESTS_UNAVAILABLE');
        expect(r.loadCheck).toBe('ok');
    });

    it('S-04a: yetenek yok → yalnız güç-isteği kapısı atlanır', async () => {
        const exec = vi.fn((file, args, opts, cb) => cb(ADMIN_ERR, '', 'requires administrator privileges'));
        const eng = engine(exec);
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: loadOnly });
        expect(r.allowed).toBe(true);
        expect(r.loadCheck).toBe('unavailable');
        expect(exec).toHaveBeenCalledTimes(1);
    });

    it('S-04b: yetenek yok ama korunan uygulama açık → yine engellenir', async () => {
        const exec = vi.fn((file, args, opts, cb) => cb(ADMIN_ERR, ''));
        const eng = new Engine(
            { getSettings: () => ({}) },
            exec,
            null,
            { processProvider: async () => ['code.exe'] }
        );
        const r = await eng.evaluate({
            action: 'shutdown',
            source: 'user_interface',
            safetyPolicy: { ...loadOnly, checkProtectedApps: true }
        });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('PROTECTED_APP_RUNNING');
    });

    it('S-05: yetenek sondası TTL içinde yeniden çalışmaz, TTL sonrası yeniden çalışır', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const exec = vi.fn((file, args, opts, cb) => cb(ADMIN_ERR, ''));
        const eng = engine(exec);

        await eng.probePowerRequestCapability();
        expect(exec).toHaveBeenCalledTimes(1);

        // TTL içinde (59 sn) tekrar sonda → yeni exec YOK
        vi.setSystemTime(new Date('2026-01-01T00:00:59Z'));
        const again = await eng.probePowerRequestCapability();
        expect(again.available).toBe(false);
        expect(exec).toHaveBeenCalledTimes(1);

        // TTL dışında (61 sn) → yeni sonda
        vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
        await eng.probePowerRequestCapability();
        expect(exec).toHaveBeenCalledTimes(2);
    });

    it('S-07b: yetenek var + tam ekran + aktif istek → FULLSCREEN_POWER_ACTIVE', async () => {
        const exec = (file, args, opts, cb) => {
            if (fullscreenOk(file)) return cb(null, 'FULLSCREEN');
            return cb(null, POWERCFG_BUSY);
        };
        const r = await engine(exec).evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: screenOnly });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('FULLSCREEN_POWER_ACTIVE');
    });

    it('S-07a: yetenek yok + tam ekran → tek başına engellemez, loadCheck unavailable', async () => {
        const exec = (file, args, opts, cb) => {
            if (fullscreenOk(file)) return cb(null, 'FULLSCREEN');
            return cb(ADMIN_ERR, '');
        };
        const r = await engine(exec).evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: screenOnly });
        expect(r.allowed).toBe(true);
        expect(r.loadCheck).toBe('unavailable');
    });

    it('S-07c: yetenek var + tam ekran + istek yok → izin verilir', async () => {
        const exec = (file, args, opts, cb) => {
            if (fullscreenOk(file)) return cb(null, 'FULLSCREEN');
            return cb(null, POWERCFG_IDLE);
        };
        const r = await engine(exec).evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: screenOnly });
        expect(r.allowed).toBe(true);
        expect(r.loadCheck).toBe('ok');
    });

    it('S-08: yetenek var + tam ekran ölçülemez → FULLSCREEN_STATE_UNAVAILABLE', async () => {
        const exec = (file, args, opts, cb) => {
            if (fullscreenOk(file)) return cb(new Error('powershell yok'), '');
            return cb(null, POWERCFG_IDLE);
        };
        const r = await engine(exec).evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: screenOnly });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('FULLSCREEN_STATE_UNAVAILABLE');
    });

    it('S-09: getPowerRequestCapability sözleşmesi (available/checkedAt/code)', async () => {
        const exec = vi.fn((file, args, opts, cb) => cb(ADMIN_ERR, ''));
        const eng = engine(exec);
        expect(eng.getPowerRequestCapability()).toEqual({ available: null, checkedAt: null, code: null });
        await eng.probePowerRequestCapability();
        const cap = eng.getPowerRequestCapability();
        expect(cap.available).toBe(false);
        expect(cap.code).toBe('POWER_REQUESTS_UNAVAILABLE');
        expect(Number.isFinite(cap.checkedAt)).toBe(true);
    });

    it('S-05b: yetenek var ise capabilities TTL 10 dk (tekrar sonda yok)', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const exec = vi.fn((file, args, opts, cb) => cb(null, POWERCFG_IDLE));
        const eng = engine(exec);
        await eng.probePowerRequestCapability();
        vi.setSystemTime(new Date('2026-01-01T00:09:00Z'));
        await eng.probePowerRequestCapability();
        expect(exec).toHaveBeenCalledTimes(1);
    });
});
