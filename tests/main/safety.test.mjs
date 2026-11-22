/**
 * safety.test.mjs - SafetyPolicyEngine: korunan-app, uzaktan-kapatma kuralı, hata toleransı.
 * exec constructor enjeksiyonuyla verilir (yerleşik modül mock'una güvenilmez) -
 * gerçek tasklist/PowerShell ASLA çalışmaz, testler milisaniyelerdedir.
 */
import { describe, it, expect, vi } from 'vitest';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';

function taskWith(overrides = {}) {
    return Object.assign({
        action: 'shutdown', source: 'user_interface',
        // Y-05: eksik alanlar güvenli varsayılana döner; bu testler yalnızca
        // korunan-app dalını ölçer, diğer ağır kontroller açıkça kapatılır.
        safetyPolicy: {
            checkProtectedApps: true,
            checkUserActivity: false,
            checkFullscreen: false,
            checkSystemLoad: false
        }
    }, overrides);
}

// Sahte exec: komut metnine göre tasklist çıktısı veya idle saniyesi döndürür.
function fakeExec({ tasklist = '', idle = '0', error = null } = {}) {
    return vi.fn((file, args, opts, cb) => {
        if (error) return cb(error, '');
        if (String(file).includes('tasklist')) return cb(null, tasklist);
        return cb(null, idle);
    });
}

function engineWith(execFn, settings = {}) {
    // WP-04/05: motor artık processProvider/idleProvider kullanır.
    // Test sahte exec'ini bu sağlayıcılara köprüler; gerçek tasklist/PowerShell yok.
    const exec = (file, args) => new Promise((resolve) => {
        execFn(file, args, {}, (err, stdout) => resolve({ err, stdout }));
    });
    const processProvider = async () => {
        const { err, stdout } = await exec('tasklist.exe', ['/fo', 'csv', '/nh']);
        if (err) throw err;
        if (!stdout) return [];
        return String(stdout).split(/\r?\n/).map((line) => {
            const m = line.match(/^"([^"]+)"/);
            return m ? m[1] : null;
        }).filter(Boolean);
    };
    const idleProvider = async () => {
        const { err, stdout } = await exec('powershell.exe', ['-NoProfile', '-Command', 'idle']);
        if (err || !stdout) return 0;
        const n = parseInt(String(stdout).trim(), 10);
        return Number.isNaN(n) ? 0 : n;
    };
    return new SafetyPolicyEngine({ getSettings: () => settings }, null, null, { processProvider, idleProvider });
}

describe('SafetyPolicyEngine', () => {
    it('politika kapalıysa ve uzaktan değilse izin verilir (exec çağrılmaz)', async () => {
        const execFn = fakeExec();
        const eng = engineWith(execFn, {});
        const r = await eng.evaluate(taskWith({
            safetyPolicy: {
                checkProtectedApps: false,
                checkUserActivity: false,
                checkFullscreen: false,
                checkSystemLoad: false
            }
        }));
        expect(r.allowed).toBe(true);
        expect(execFn).not.toHaveBeenCalled();
    });

    it('korunan uygulama çalışıyorsa engellenir + gerekçe Türkçe', async () => {
        const eng = engineWith(fakeExec({ tasklist: '"Code.exe","1234","Console","1","10.000 K"\r\n"notepad.exe","5","Console","1","1.000 K"\r\n' }), {});
        const r = await eng.evaluate(taskWith());
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/code\.exe/);
    });

    it('korunan uygulama yoksa izin verilir', async () => {
        const eng = engineWith(fakeExec({ tasklist: '"notepad.exe","5","Console","1","1.000 K"\r\n' }), {});
        const r = await eng.evaluate(taskWith());
        expect(r.allowed).toBe(true);
    });

    it('tasklist hatasında fail-closed (süreç listesi doğrulanamaz)', async () => {
        const eng = engineWith(fakeExec({ error: new Error('yok') }), {});
        const r = await eng.evaluate(taskWith());
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('PROCESS_LIST_UNAVAILABLE');
    });

    it('uzaktan shutdown + aktif kullanıcı (<60sn idle) engellenir', async () => {
        const eng = engineWith(
            fakeExec({ tasklist: '', idle: '10' }),
            { blockRemoteShutdownWhenActive: true }
        );
        const r = await eng.evaluate(taskWith({ source: 'local_api', action: 'shutdown' }));
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/uzaktan kapatma/);
    });

    it('uzaktan sleep aktif kullanıcıda bile izinlidir (sadece shutdown/restart korunur)', async () => {
        const eng = engineWith(
            fakeExec({ tasklist: '', idle: '5' }),
            { blockRemoteShutdownWhenActive: true }
        );
        const r = await eng.evaluate(taskWith({ source: 'n8n', action: 'sleep' }));
        expect(r.allowed).toBe(true);
    });

    it('uzaktan shutdown + kullanıcı uzun süredir boşta (≥60sn) izinlidir', async () => {
        const eng = engineWith(
            fakeExec({ tasklist: '', idle: '3600' }),
            { blockRemoteShutdownWhenActive: true }
        );
        const r = await eng.evaluate(taskWith({ source: 'local_api', action: 'restart' }));
        expect(r.allowed).toBe(true);
    });
});

describe('SafetyPolicyEngine güç-istekleri katmanı (WBS-11.5)', () => {
    const POWERCFG_IDLE = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\nNone.\r\n\r\nAWAYMODE:\r\nNone.\r\n';
    const POWERCFG_BUSY = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\n[DRIVER] \\FileSystem\\srvnet\r\n\r\nAWAYMODE:\r\nNone.\r\n';

    it('parsePowerRequests bölümleri doğru okur', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        expect(Engine.parsePowerRequests(POWERCFG_IDLE)).toEqual({ hasActiveRequest: false, categories: [] });
        expect(Engine.parsePowerRequests(POWERCFG_BUSY)).toEqual({ hasActiveRequest: true, categories: ['SYSTEM'] });
        expect(Engine.parsePowerRequests('')).toEqual({ hasActiveRequest: false, categories: [] });
        expect(Engine.parsePowerRequests(null)).toEqual({ hasActiveRequest: false, categories: [] });
    });

    it('aktif güç isteği engeller (checkSystemLoad)', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        const fake = (file, args, opts, cb) => {
            if (String(file).includes('powercfg')) return cb(null, POWERCFG_BUSY);
            return cb(null, '');
        };
        const eng = new Engine({ getSettings: () => ({}) }, fake);
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: { checkSystemLoad: true, checkProtectedApps: false, checkFullscreen: false } });
        expect(r.allowed).toBe(false);
        expect(r.reason).toMatch(/güç isteği/i);
    });

    it('yetenek VAR + ölçüm hatası → fail-closed (güç istekleri doğrulanamaz)', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        // P0/BLOCKER-001: ilk çağrı yetenek sondası (başarılı), sonraki ölçüm hatası.
        let calls = 0;
        const fake = (file, args, opts, cb) => {
            calls += 1;
            if (calls === 1) return cb(null, POWERCFG_IDLE);
            return cb(new Error('yok'), '');
        };
        const eng = new Engine({ getSettings: () => ({}) }, fake);
        await eng.probePowerRequestCapability();
        eng._powerCache = null;
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: { checkSystemLoad: true, checkProtectedApps: false, checkFullscreen: false } });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('POWER_REQUESTS_UNAVAILABLE');
        expect(r.loadCheck).toBe('ok');
    });

    it('yetenek YOK (yükseltilmemiş kurulum) → kapı görünür biçimde atlanır', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        const fake = (file, args, opts, cb) => cb(Object.assign(new Error('requires administrator privileges'), { code: 1 }), '', 'requires administrator privileges');
        const eng = new Engine({ getSettings: () => ({}) }, fake);
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: { checkSystemLoad: true, checkProtectedApps: false, checkFullscreen: false } });
        expect(r.allowed).toBe(true);
        expect(r.loadCheck).toBe('unavailable');
        expect(eng.getPowerRequestCapability().available).toBe(false);
        expect(eng.getPowerRequestCapability().code).toBe('POWER_REQUESTS_UNAVAILABLE');
    });

    it('tam ekran ölçüm hatasında fail-closed', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        const fake = (file, args, opts, cb) => {
            if (String(file).includes('powercfg')) return cb(null, POWERCFG_IDLE);
            return cb(new Error('powershell yok'), '');
        };
        const eng = new Engine({ getSettings: () => ({}) }, fake);
        const r = await eng.evaluate({ action: 'shutdown', source: 'user_interface', safetyPolicy: { checkFullscreen: true, checkProtectedApps: false, checkSystemLoad: false } });
        expect(r.allowed).toBe(false);
        expect(r.reasonCode).toBe('FULLSCREEN_STATE_UNAVAILABLE');
    });

    it('tam ekran + istek BİRLİKTE engeller; tek başına tam ekran engellemez', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        const mk = (powercfg, fullscreen) => new Engine({ getSettings: () => ({}) }, (file, args, opts, cb) => {
            if (String(file).includes('powercfg')) return cb(null, powercfg);
            if (String(file).includes('powershell')) return cb(null, fullscreen);
            return cb(null, '');
        });
        const both = await mk(POWERCFG_BUSY, 'FULLSCREEN').evaluate({
            action: 'shutdown', source: 'user_interface', safetyPolicy: { checkFullscreen: true, checkProtectedApps: false, checkSystemLoad: false }
        });
        expect(both.allowed).toBe(false);
        const alone = await mk(POWERCFG_IDLE, 'FULLSCREEN').evaluate({
            action: 'shutdown', source: 'user_interface', safetyPolicy: { checkFullscreen: true, checkProtectedApps: false, checkSystemLoad: false }
        });
        expect(alone.allowed).toBe(true);
    });

    it('isBootGuardActive uptime eşiğine uyar', async () => {
        const { default: Engine } = await import('../../src/main/services/SafetyPolicyEngine.js');
        expect(new Engine({ getSettings: () => ({}) }, null, () => 30).isBootGuardActive()).toBe(true);
        expect(new Engine({ getSettings: () => ({}) }, null, () => 500).isBootGuardActive()).toBe(false);
        expect(new Engine({ getSettings: () => ({ bootGuardSeconds: 0 }) }, null, () => 5).isBootGuardActive()).toBe(false);
        expect(new Engine({ getSettings: () => ({ bootGuardSeconds: 10 }) }, null, () => 5).isBootGuardActive()).toBe(true);
    });
});
