/**
 * taskmanager-extra.test.mjs - TaskManager kalan dallar
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import TaskManager from '../../src/main/services/TaskManager.js';
import { TASK_STATUS } from '../../src/main/services/models/AutomationTask.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) if (tm.loopInterval) clearInterval(tm.loopInterval);
});

function harness(over = {}) {
    const storage = Object.assign({
        tasks: [],
        settings: {},
        saveFail: false,
        getTasks() { return this.tasks; },
        saveTask: vi.fn(() => storage.saveFail === false),
        deleteTask: vi.fn(() => true),
        getSettings() { return storage.settings; },
        updateSettings: vi.fn(() => true)
    }, over.storage || {});
    const warning = Object.assign({
        active: null,
        getActiveState() { return this.active; },
        showWarning: vi.fn(async () => ({ proceed: true })),
        cancelActiveWarning: vi.fn(),
        snoozeActiveWarning: vi.fn()
    }, over.warning || {});
    const history = Object.assign({ record: vi.fn() }, over.history || {});
    const webhook = Object.assign({ triggerEvent: vi.fn() }, over.webhook || {});
    const power = Object.assign({ execute: vi.fn(async () => ({ success: true })) }, over.power || {});
    const safety = Object.assign({ evaluate: vi.fn(async () => ({ allowed: true })) }, over.safety || {});
    const tm = new TaskManager(storage, warning, safety, history, webhook, null, null, power);
    live.push(tm);
    return { tm, storage, warning, history, webhook, power, safety };
}

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const taskData = (over = {}) => Object.assign({ name: 'g', action: 'lock', trigger: { type: 'duration', durationMs: 60000 } }, over);

describe('TaskManager - ek dallar', () => {
    it('handleTaskExecution boş liste ile güvenli', () => {
        const { tm, power } = harness();
        expect(() => tm.handleTaskExecution([])).not.toThrow();
        expect(() => tm.handleTaskExecution(null)).not.toThrow();
        expect(power.execute).not.toHaveBeenCalled();
    });

    it('başka görev çalışırken tüm adaylar BLOCKED olur', async () => {
        const { tm, power, history } = harness();
        const a = tm.createTask(taskData({ name: 'a' }));
        const b = tm.createTask(taskData({ name: 'b' }));
        tm.claimTask(a.id);
        tm.handleTaskExecution([b]);
        expect(b.status).toBe(TASK_STATUS.BLOCKED);
        expect(power.execute).not.toHaveBeenCalled();
        expect(history.record).toHaveBeenCalled();
    });

    it('UI görevi diğerlerinden önce sıralanır', async () => {
        const { tm, power } = harness();
        const api = tm.createTask(taskData({ name: 'api', source: 'local_api' }));
        const ui = tm.createTask(taskData({ name: 'ui', source: 'user_interface' }));
        api.trigger.targetTime = Date.now() - 1;
        ui.trigger.targetTime = Date.now() - 1;
        tm.evaluateTasks();
        await flush(120);
        expect(ui.status).toBe(TASK_STATUS.COMPLETED);
        expect(api.status).toBe(TASK_STATUS.BLOCKED);
        expect(power.execute).toHaveBeenCalledTimes(1);
    });

    it('uzaktan görevde uyarı zaman aşımı devam eder (_schedulerFired)', async () => {
        const { tm, warning } = harness();
        warning.showWarning = vi.fn(async () => {
            const t = tm.tasks[0];
            expect(t._schedulerFired).toBe(true);
            return { proceed: true };
        });
        const t = tm.createTask(taskData({ source: 'local_api', warningConfig: { enabled: true, durationSeconds: 1 } }));
        t.trigger.targetTime = Date.now() - 1;
        tm.evaluateTasks();
        await flush(120);
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
    });

    it('OS çağrısı öncesi iptal edilirse power çalışmaz', async () => {
        const { tm, power } = harness();
        const t = tm.createTask(taskData());
        const claim = tm.claimTask(t.id);
        const stored = tm.claims.get(t.id);
        stored.cancelRequested = true;
        await tm.executeTask(t, claim.token);
        expect(power.execute).not.toHaveBeenCalled();
        expect(stored.powerStarted).toBe(false);
    });

    it('powerStarted sonrası iptal CANCEL_TOO_LATE notu ile yazılır', async () => {
        const { tm } = harness({
            power: {
                execute: vi.fn(async () => {
                    const task = tm.tasks[0];
                    tm.cancelTask(task.id); // executing + powerStarted
                    return { success: true };
                })
            }
        });
        const t = tm.createTask(taskData());
        t.trigger.targetTime = Date.now() - 1;
        tm.evaluateTasks();
        await flush(120);
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
        expect(t.lastResult.note).toBe('CANCEL_TOO_LATE');
    });

    it('blockTask tekrarlayan görevi yeniden takvime alır', () => {
        const { tm } = harness();
        const t = tm.createTask(taskData({ recurrence: { enabled: true, frequency: 'daily', timeOfDay: '03:00' } }));
        t.trigger.targetTime = null;
        const primary = tm.createTask(taskData({ name: 'p' }));
        tm.blockTask(t, primary);
        expect(t.errorInfo).toMatch(/Çakışan görev/);
        expect(t.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('runTaskNow EXPIRED olmayan görevi doğrudan çalıştırır', async () => {
        const { tm, power } = harness();
        const t = tm.createTask(taskData());
        expect(tm.runTaskNow(t.id)).toBe(true);
        await flush(120);
        expect(power.execute).toHaveBeenCalledTimes(1);
    });

    it('scheduler köprüsü başarı/başarısızlık loglanır', async () => {
        const { tm } = harness();
        const ok = vi.fn(async () => true);
        tm.schedulerBridge = { syncTask: ok, removeTask: async () => true };
        tm.syncScheduler({ id: 'x' });
        tm.removeScheduler('x');
        await flush(20);
        expect(ok).toHaveBeenCalled();

        tm.schedulerBridge = { syncTask: () => { throw new Error('boom'); }, removeTask: () => { throw new Error('boom'); } };
        expect(() => tm.syncScheduler({ id: 'y' })).not.toThrow();
        expect(() => tm.removeScheduler('y')).not.toThrow();
        await flush(20);
    });

    it('EXPIRED görev evaluateTasks tarafından atlanır', async () => {
        const { tm, power } = harness();
        const t = tm.createTask(taskData());
        t.status = TASK_STATUS.EXPIRED;
        t.trigger.targetTime = Date.now() - 1;
        tm.evaluateTasks();
        await flush(60);
        expect(power.execute).not.toHaveBeenCalled();
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
    });

    it('hasInFlight claim varken true', () => {
        const { tm } = harness();
        const t = tm.createTask(taskData());
        expect(tm.hasInFlight()).toBe(false);
        tm.claimTask(t.id);
        expect(tm.hasInFlight()).toBe(true);
    });

    it('createTask file_stable klasör yolunu directory_idle\'a çevirir', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tm-'));
        try {
            const { tm } = harness();
            const t = tm.createTask({
                name: 'klasör',
                action: 'lock',
                conditionGroup: { conditions: [{ type: 'file_stable', filePath: dir }] }
            });
            const cond = t.conditionGroup.conditions[0];
            expect(cond.type).toBe('directory_idle');
            expect(cond.dirPath).toBe(dir);
            expect(cond.filePath).toBeUndefined();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ }
        }
    });

    it('getNextTask hedefi olmayan görevleri yok sayar', () => {
        const { tm } = harness();
        const cond = tm.createTask({ name: 'c', action: 'lock', conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        cond.trigger.targetTime = null;
        expect(tm.getNextTask()).toBeNull();
    });

    it('getClaimState kopyası mutasyona kapalı', () => {
        const { tm } = harness();
        const t = tm.createTask(taskData());
        tm.claimTask(t.id);
        const snap = tm.getClaimState(t.id);
        snap.phase = 'hacked';
        expect(tm.claims.get(t.id).phase).toBe('claimed');
    });

    it('notifyResult dinleyicisi yokken sessiz', () => {
        const { tm } = harness();
        expect(() => tm.notifyResult({ id: 'a' }, true)).not.toThrow();
    });

    it('recoverTasksOnStartup disabled EXECUTING kaydını yine terminalize eder', () => {
        const { tm } = harness();
        const t = tm.createTask(taskData());
        t.status = TASK_STATUS.EXECUTING;
        t.enabled = false;
        tm.recoverTasksOnStartup();
        expect(t.status).toBe(TASK_STATUS.FAILED);
    });
});
