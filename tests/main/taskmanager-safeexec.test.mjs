/**
 * taskmanager-safeexec.test.mjs — P0/BLOCKER-001 uçtan uca
 *
 * Gerçek `SafetyPolicyEngine` (exec enjeksiyonu) + gerçek `TaskManager`.
 * OS güç çağrısı ASLA yapılmaz: `PowerService` yerine sahte nesne verilir.
 * Senaryo: yükseltilmemiş kurulumda (powercfg admin hatası) zamanlanmış görev
 * gerçekten tamamlanır; history/audit sonucu SUCCESS olur.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) {
        if (tm.loopInterval) clearInterval(tm.loopInterval);
    }
});

function spawnWith(execFn) {
    const storage = { getTasks: () => [], saveTask: vi.fn(), deleteTask: vi.fn(), getSettings: () => ({}) };
    const history = { record: vi.fn(), getHistory: () => [], clear: () => {} };
    const webhook = { triggerEvent: vi.fn() };
    const power = { execute: vi.fn(async () => ({ success: true })) };
    const safety = new SafetyPolicyEngine({ getSettings: () => ({}) }, execFn, null, {
        processProvider: async () => []
    });
    const collector = { getMetrics: () => ({ cpuUsagePercent: 3, networkDownloadKbps: 0, networkUploadKbps: 0, diskIops: 0, userIdleSeconds: 900, batteryLevelPercent: 80, isCharging: false, batterySupported: true, runningProcesses: [], stale: false, sampledAt: new Date().toISOString() }) };
    const engine = new SmartFinishEngine(collector);
    const tm = new TaskManager(storage, null, safety, history, webhook, engine, collector, power);
    live.push(tm);
    return { tm, power, history, safety };
}

const flush = async (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskManager + SafetyPolicyEngine (yükseltilmemiş kurulum)', () => {
    it('S-06: powercfg yükseltme istese de timer gerçekten çalışır ve COMPLETED olur', async () => {
        const adminErr = Object.assign(new Error('requires administrator privileges'), { code: 1 });
        const { tm, power, history, safety } = spawnWith((file, args, opts, cb) => cb(adminErr, '', 'requires administrator privileges'));

        const task = tm.createTask({
            name: 'Yükseltmesiz kapatma',
            action: 'shutdown',
            source: 'user_interface',
            safetyPolicy: { checkSystemLoad: true, checkProtectedApps: false, checkUserActivity: false, checkFullscreen: false },
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(150);

        expect(power.execute).toHaveBeenCalledTimes(1);
        expect(power.execute).toHaveBeenCalledWith('shutdown', expect.anything());
        expect(task.status).toBe('completed');
        expect(task.lastResult && task.lastResult.code).toBe('success');
        expect(history.record).toHaveBeenCalled();
        const codes = history.record.mock.calls.map((c) => c[1]);
        expect(codes).toContain('success');
        expect(codes).not.toContain('blocked_by_policy');
        expect(safety.getPowerRequestCapability().available).toBe(false);
    });

    it('S-06b: gerçek aktif güç isteği (yetenek var) görevi BLOCKED yapar', async () => {
        const BUSY = 'DISPLAY:\r\nNone.\r\n\r\nSYSTEM:\r\n[DRIVER] \\FileSystem\\srvnet\r\n\r\nAWAYMODE:\r\nNone.\r\n';
        const { tm, power, history } = spawnWith((file, args, opts, cb) => cb(null, BUSY));

        const task = tm.createTask({
            name: 'Aktif istekte kapatma',
            action: 'shutdown',
            source: 'user_interface',
            safetyPolicy: { checkSystemLoad: true, checkProtectedApps: false, checkUserActivity: false, checkFullscreen: false },
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(150);

        expect(power.execute).not.toHaveBeenCalled();
        expect(task.status).toBe('blocked');
        expect(task.lastResult && task.lastResult.code).toBe('blocked_by_policy');
        const codes = history.record.mock.calls.map((c) => c[1]);
        expect(codes).toContain('blocked_by_policy');
    });
});
