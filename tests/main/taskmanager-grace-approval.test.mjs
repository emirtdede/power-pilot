/**
 * taskmanager-grace-approval.test.mjs - P1-6
 *
 * İki plasebo ayarın artık GERÇEK davranış olduğunu kanıtlar:
 *
 * 1. `graceSeconds` ("Açık Uygulamalar İçin Bekleme Süresi"):
 *    - `shutdown`/`restart`/`signout` için YEREL gecikme (`/t n`) olarak geçer.
 *    - Bekleme penceresinde iptal, `shutdown /a` ile GERÇEKTEN durdurulur.
 *    - Pencere dışındaki iptal hâlâ CANCEL_TOO_LATE.
 *    - Veto doğrulaması gecikme kadar ötelenir (meşru bekleme "engellendi"
 *      diye yanlış raporlanmaz).
 *
 * 2. `remoteApprovalRequired`: uzaktan gelen görev (local_api/n8n/console)
 *    yerel insan onayı olmadan çalışmaz; sayaç dolarsa İPTAL edilir.
 *
 * GÜVENLİK: hiçbir OS güç komutu çalıştırılmaz - `PowerService` sahtedir.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import { TerminalActionVerifier } from '../../src/main/services/TerminalActionVerifier.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) {
        if (tm.loopInterval) clearInterval(tm.loopInterval);
        if (tm.terminalVerifier) tm.terminalVerifier.disarm();
    }
});

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function harness({ settings = {}, warning, power } = {}) {
    const timers = [];
    const storage = {
        getTasks: () => [],
        saveTask: vi.fn(),
        deleteTask: vi.fn(),
        getSettings: () => ({ ...settings }),
        updateSettings: vi.fn()
    };
    const history = { record: vi.fn() };
    const webhook = { triggerEvent: vi.fn() };
    const warningManager = warning || {
        getActiveState: () => null,
        showWarning: vi.fn(async () => ({ proceed: true })),
        cancelActiveWarning: vi.fn(),
        snoozeActiveWarning: vi.fn()
    };
    const powerService = power || {
        execute: vi.fn(async () => ({ success: true })),
        abortScheduledShutdown: vi.fn(async () => ({ success: true }))
    };
    const tm = new TaskManager(storage, warningManager, null, history, webhook, null, null, powerService);
    // Veto doğrulayıcısı: yakalanan timer'lar elle ateşlenir.
    let captured = null;
    tm.terminalVerifier = new TerminalActionVerifier({
        graceMs: 25000,
        setTimer: (fn, ms) => { captured = { fn, ms }; return 1; },
        clearTimer: () => { captured = null; }
    });
    live.push(tm);
    return {
        tm, storage, warningManager, powerService, history,
        capturedTimerMs: () => captured && captured.ms,
        fireVeto: () => { const c = captured; captured = null; if (c) c.fn(); return !!c; }
    };
}

describe('P1-6 graceSeconds - gerçek yerel gecikme', () => {
    it('shutdown için ayarlardaki graceSeconds PowerService’e geçer', async () => {
        const h = harness({ settings: { graceSeconds: 60 } });
        const task = h.tm.createTask({
            name: 'kapat', action: 'shutdown', source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);

        expect(h.powerService.execute).toHaveBeenCalledWith('shutdown', expect.objectContaining({ graceSeconds: 60 }));
        expect(task.status).toBe('completed');
    });

    it('terminal olmayan eylemde (sleep) grace uygulanmaz', async () => {
        const h = harness({ settings: { graceSeconds: 60 } });
        h.tm.createTask({
            name: 'uyku', action: 'sleep', source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        expect(h.powerService.execute).toHaveBeenCalledWith('sleep', expect.objectContaining({ graceSeconds: 0 }));
    });

    it('görev düzeyi safetyPolicy.graceSeconds ayarı ezer', async () => {
        const h = harness({ settings: { graceSeconds: 60 } });
        h.tm.createTask({
            name: 'kapat', action: 'shutdown', source: 'user_interface',
            safetyPolicy: { graceSeconds: 5 },
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        expect(h.powerService.execute).toHaveBeenCalledWith('shutdown', expect.objectContaining({ graceSeconds: 5 }));
    });

    it('graceSeconds 600 sn ile sınırlanır (geçersiz değer 0)', () => {
        const h = harness({ settings: {} });
        expect(h.tm.resolveGraceSeconds({ action: 'shutdown' })).toBe(0);
        expect(h.tm.resolveGraceSeconds({ action: 'shutdown', safetyPolicy: { graceSeconds: 99999 } })).toBe(600);
        expect(h.tm.resolveGraceSeconds({ action: 'shutdown', safetyPolicy: { graceSeconds: -5 } })).toBe(0);
        expect(h.tm.resolveGraceSeconds({ action: 'lock', safetyPolicy: { graceSeconds: 30 } })).toBe(0);
    });

    it('bekleme penceresinde iptal shutdown /a çağırır, görev iptal olur', async () => {
        let resolvePower;
        const power = {
            execute: vi.fn(() => new Promise((r) => { resolvePower = r; })),
            abortScheduledShutdown: vi.fn(async () => ({ success: true }))
        };
        const h = harness({ settings: { graceSeconds: 60 }, power });
        const task = h.tm.createTask({
            name: 'kapat', action: 'shutdown', source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(60);
        expect(power.execute).toHaveBeenCalledTimes(1);

        const res = h.tm.cancelTask(task.id);
        expect(res).toMatchObject({ ok: true, code: 'CANCELLED' });
        expect(power.abortScheduledShutdown).toHaveBeenCalledTimes(1);
        expect(task.status).toBe('cancelled');
        resolvePower({ success: true });
        await flush(20);
    });

    it('pencere dışındaki iptal hâlâ CANCEL_TOO_LATE', async () => {
        let resolvePower;
        const power = {
            execute: vi.fn(() => new Promise((r) => { resolvePower = r; })),
            abortScheduledShutdown: vi.fn(async () => ({ success: true }))
        };
        const h = harness({ settings: { graceSeconds: 0 }, power });
        const task = h.tm.createTask({
            name: 'kapat', action: 'shutdown', source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(60);

        const res = h.tm.cancelTask(task.id);
        expect(res).toMatchObject({ ok: true, code: 'CANCEL_TOO_LATE' });
        expect(power.abortScheduledShutdown).not.toHaveBeenCalled();
        resolvePower({ success: true });
        await flush(20);
    });

    it('veto doğrulaması gecikme kadar ötelenir', async () => {
        const h = harness({ settings: { graceSeconds: 60 } });
        h.tm.createTask({
            name: 'kapat', action: 'shutdown', source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        // 25000 (varsayılan doğrulama) + ~60000 (yerel gecikme)
        expect(h.capturedTimerMs()).toBeGreaterThan(80000);
    });
});

describe('P1-6 remoteApprovalRequired - uzaktan görevde yerel onay', () => {
    it('ayar kapalıyken uzak görev onay penceresi açmaz', async () => {
        const showWarning = vi.fn(async () => ({ proceed: true }));
        const h = harness({ settings: {}, warning: { getActiveState: () => null, showWarning, cancelActiveWarning: vi.fn(), snoozeActiveWarning: vi.fn() } });
        h.tm.createTask({
            name: 'uzak', action: 'shutdown', source: 'local_api',
            warningConfig: { enabled: false, durationSeconds: 0 },
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        expect(showWarning).not.toHaveBeenCalled();
        expect(h.powerService.execute).toHaveBeenCalledWith('shutdown', expect.anything());
    });

    it('ayar açıkken uzak görev zorunlu onay ister; sayaç dolunca İPTAL', async () => {
        const showWarning = vi.fn(async () => ({ proceed: false }));
        const h = harness({
            settings: { remoteApprovalRequired: true },
            warning: { getActiveState: () => null, showWarning, cancelActiveWarning: vi.fn(), snoozeActiveWarning: vi.fn() }
        });
        const task = h.tm.createTask({
            name: 'uzak', action: 'shutdown', source: 'local_api',
            warningConfig: { enabled: false, durationSeconds: 0 },
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);

        expect(showWarning).toHaveBeenCalledTimes(1);
        const passed = showWarning.mock.calls[0][0];
        expect(passed.warningConfig).toMatchObject({ enabled: true, requireConfirmation: true });
        expect(passed.warningConfig.durationSeconds).toBeGreaterThanOrEqual(30);
        // Onay yok → güç eylemi YOK, görev iptal.
        expect(h.powerService.execute).not.toHaveBeenCalled();
        expect(task.status).toBe('cancelled');
    });

    it('ayar açıkken onay verilirse eylem çalışır', async () => {
        const showWarning = vi.fn(async () => ({ proceed: true }));
        const h = harness({
            settings: { remoteApprovalRequired: true },
            warning: { getActiveState: () => null, showWarning, cancelActiveWarning: vi.fn(), snoozeActiveWarning: vi.fn() }
        });
        h.tm.createTask({
            name: 'uzak', action: 'lock', source: 'n8n',
            trigger: { type: 'duration', durationMs: 1 }
        });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        expect(showWarning).toHaveBeenCalledTimes(1);
        expect(h.powerService.execute).toHaveBeenCalledWith('lock', expect.anything());
    });

    it('yerel (UI) görev uzaktan onay ayarından etkilenmez', () => {
        const h = harness({ settings: { remoteApprovalRequired: true } });
        expect(h.tm.resolveRemoteApproval({ source: 'user_interface' })).toBe(false);
        expect(h.tm.resolveRemoteApproval({ source: 'local_api' })).toBe(true);
        expect(h.tm.resolveRemoteApproval({ source: 'console' })).toBe(true);
    });

    it('kısmi nesnede verilen `false` bilinçli tercihtir ve kalıcı ayarı ezer', () => {
        const h = harness({ settings: { remoteApprovalRequired: true } });
        // Ham tam nesne (6/6, maddeleştirilmiş) varsayılana eşit olduğu için
        // "seçim" sayılmaz; kalıcı ayar kazanır (fail-safe).
        expect(h.tm.resolveRemoteApproval({
            source: 'local_api',
            safetyPolicy: {
                checkUserActivity: true, checkProtectedApps: true, checkFullscreen: true,
                checkSystemLoad: true, forceCloseApps: false, remoteApprovalRequired: false
            }
        })).toBe(true);

        // Model üzerinden gelen KISMİ tercih gerçekten ezer.
        const task = h.tm.createTask({
            name: 'uzak', action: 'lock', source: 'local_api',
            safetyPolicy: { remoteApprovalRequired: false },
            trigger: { type: 'duration', durationMs: 60000 }
        });
        expect(task.safetyPolicyExplicit.remoteApprovalRequired).toBe(true);
        expect(h.tm.resolveRemoteApproval(task)).toBe(false);
    });

    it('explicit true, kalıcı ayar kapalıyken bile onay zorunlu kılar', () => {
        const h = harness({ settings: { remoteApprovalRequired: false } });
        const task = h.tm.createTask({
            name: 'uzak', action: 'lock', source: 'local_api',
            safetyPolicy: { remoteApprovalRequired: true },
            trigger: { type: 'duration', durationMs: 60000 }
        });
        expect(task.safetyPolicyExplicit.remoteApprovalRequired).toBe(true);
        expect(h.tm.resolveRemoteApproval(task)).toBe(true);
    });
});
