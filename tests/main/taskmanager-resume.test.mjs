/**
 * taskmanager-resume.test.mjs - uykudan dönüş senkronizasyonu
 *
 * Kullanıcı politikası (wakeMode / wakeToleranceMinutes):
 *  - 'run' + tolerans içinde  → görev hemen çalıştırılır
 *  - 'run' + tolerans dışında → atlanır, geçmişe neden yazılır
 *  - 'skip'                   → hiçbir kaçırılan görev çalışmaz
 * Tekrarlayan görevler takvimden düşmez, sonraki vakte taşınır.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import { TASK_STATUS, EXECUTION_RESULT_CODE } from '../../src/main/services/models/AutomationTask.js';

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
        saveTask: vi.fn(() => true),
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

const flush = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const taskData = (over = {}) => Object.assign({
    name: 'g',
    action: 'lock',
    trigger: { type: 'duration', durationMs: 60000 }
}, over);

describe('TaskManager.resyncAfterResume', () => {
    it('tolerans içindeki kaçırılmış görevi çalıştırır', async () => {
        const { tm, power, history } = harness();
        const t = tm.createTask(taskData({ name: 'tolerans' }));
        t.trigger.targetTime = Date.now() - 60000; // 1 dk gecikme

        const res = tm.resyncAfterResume({ mode: 'run', toleranceMinutes: 10 });
        await flush();

        expect(res.ran).toBe(1);
        expect(res.skipped).toBe(0);
        expect(power.execute).toHaveBeenCalledTimes(1);
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
        expect(history.record).not.toHaveBeenCalledWith(
            t, EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, expect.anything()
        );
    });

    it('tolerans dışındaki tek seferlik görevi atlar ve geçmişe yazar', () => {
        const { tm, history } = harness();
        const t = tm.createTask(taskData({ name: 'eski' }));
        t.trigger.targetTime = Date.now() - 90 * 60000; // 90 dk

        const res = tm.resyncAfterResume({ mode: 'run', toleranceMinutes: 10 });

        expect(res.ran).toBe(0);
        expect(res.skipped).toBe(1);
        expect(res.maxOverdueMinutes).toBeGreaterThanOrEqual(89);
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
        expect(t.lastResult.code).toBe(EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP);
        expect(t.errorInfo).toMatch(/90 dk/);
        expect(history.record).toHaveBeenCalledWith(
            t, EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, expect.stringMatching(/atlandı/)
        );
    });

    it("'skip' modunda tolerans içindeki görev bile çalışmaz", async () => {
        const { tm, power, history } = harness();
        const t = tm.createTask(taskData());
        t.trigger.targetTime = Date.now() - 1000;

        const res = tm.resyncAfterResume({ mode: 'skip', toleranceMinutes: 10 });
        await flush();

        expect(res.ran).toBe(0);
        expect(res.skipped).toBe(1);
        expect(power.execute).not.toHaveBeenCalled();
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
        expect(history.record).toHaveBeenCalled();
    });

    it('tekrarlayan görev atlanınca takvimden düşmez, sonraki vakte taşınır', () => {
        const { tm, history } = harness();
        const t = tm.createTask(taskData({
            name: 'tekrar',
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '03:00' }
        }));
        t.trigger.targetTime = Date.now() - 120 * 60000;

        const res = tm.resyncAfterResume({ mode: 'skip', toleranceMinutes: 10 });

        expect(res.skipped).toBe(1);
        expect(t.status).toBe(TASK_STATUS.SCHEDULED);
        expect(t.trigger.targetTime).toBeGreaterThan(Date.now());
        expect(t.errorInfo).toMatch(/sonraki tekrara taşındı/);
        expect(history.record).toHaveBeenCalledWith(
            t, EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, expect.stringMatching(/tekrara/)
        );
    });

    it('gelecekteki, devre dışı ve koşullu görevlere dokunmaz', async () => {
        const { tm, power, history } = harness();
        const future = tm.createTask(taskData({ name: 'gelecek' }));
        future.trigger.targetTime = Date.now() + 60000;
        const disabled = tm.createTask(taskData({ name: 'kapalı' }));
        disabled.trigger.targetTime = Date.now() - 60000;
        disabled.enabled = false;
        const conditional = tm.createTask(taskData({
            name: 'koşullu',
            conditionGroup: { conditions: [{ type: 'cpu_usage', operator: 'below', value: 10 }] }
        }));
        conditional.trigger.targetTime = Date.now() - 60000;

        const res = tm.resyncAfterResume({ mode: 'run', toleranceMinutes: 60 });
        await flush();

        expect(res.ran).toBe(0);
        expect(res.skipped).toBe(0);
        expect(power.execute).not.toHaveBeenCalled();
        expect(history.record).not.toHaveBeenCalled();
        expect(future.status).toBe(TASK_STATUS.SCHEDULED);
        expect(disabled.status).toBe(TASK_STATUS.SCHEDULED);
    });

    it('geçersiz tolerans değerleri güvenli aralığa kırpılır', () => {
        const { tm } = harness();
        const t = tm.createTask(taskData());
        t.trigger.targetTime = Date.now() - 5000;

        const res = tm.resyncAfterResume({ mode: 'run', toleranceMinutes: Number.NaN });

        expect(res.ran).toBe(0);
        expect(res.skipped).toBe(1);
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
    });
});
