/**
 * task-pause-resume.test.mjs - P1-6 (üçüncü tur) duraklat/sürdür kapısı
 *
 * Denetim kusuru: `task.enabled` beş yürütme yolunda GERÇEK bir kapıydı
 * (`evaluateTasks`, `getActiveTasks`, `hasInFlight`, `runScheduledTask`,
 * `TaskSchedulerBridge`), `statusDisabled` 17 dilde çeviriye sahipti,
 * renderer `task.enabled !== false` kontrolünü yapıyordu - ama hiçbir kod
 * yolu `enabled` alanını ASLA false yapmıyordu ve `disabled` durumu hiçbir
 * yerde atanmıyordu.
 *
 * Sonuç: kullanıcı bir görevi geçici olarak durduramıyordu; tek seçenek
 * iptal etmekti (geri dönüşü olmayan terminal durum). Altyapı tamdı, kapı
 * yoktu - `directory_idle` ile aynı sınıf kusur.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import { TASK_STATUS, TRIGGER_TYPE } from '../../src/main/services/models/AutomationTask.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) {
        if (tm.loopInterval) clearInterval(tm.loopInterval);
    }
});

function makeHarness() {
    const storage = {
        tasks: [],
        settings: {},
        getTasks() { return this.tasks; },
        saveTask: () => true,
        deleteTask: () => true,
        getSettings() { return this.settings; },
        updateSettings() { return true; }
    };
    const warning = {
        getActiveState: () => null,
        showWarning: vi.fn(async () => ({ proceed: true })),
        cancelActiveWarning: vi.fn(),
        snoozeActiveWarning: vi.fn()
    };
    const history = { record: vi.fn(), getHistory: () => [], clear() {} };
    const webhook = { triggerEvent: vi.fn() };
    const power = { execute: vi.fn(async () => ({ success: true })), isValidAction: () => true };
    const safety = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const collector = { getMetrics: () => ({}) };
    const schedulerBridge = { syncTask: vi.fn(async () => true), removeTask: vi.fn(async () => true) };
    const tm = new TaskManager(storage, warning, safety, history, webhook, null, collector, power, null);
    tm.schedulerBridge = schedulerBridge;
    live.push(tm);
    return { tm, schedulerBridge };
}

const durationTask = (over = {}) => Object.assign({
    name: 'p', action: 'lock', trigger: { type: 'duration', durationMs: 60000 }
}, over);

describe('A. pauseTask', () => {
    it('zamanlı görevi DISABLED yapar ve enabled=false işaretler', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        expect(task.status).toBe(TASK_STATUS.SCHEDULED);

        const res = tm.pauseTask(task.id);
        expect(res).toMatchObject({ ok: true, code: 'PAUSED' });
        expect(task.status).toBe(TASK_STATUS.DISABLED);
        expect(task.enabled).toBe(false);
        expect(task.pausedFromStatus).toBe(TASK_STATUS.SCHEDULED);
    });

    it('duraklatılan görev zamanlayıcıdan çıkarılır (uygulama kapalıyken çalışmaz)', () => {
        const { tm, schedulerBridge } = makeHarness();
        const task = tm.createTask(durationTask());
        tm.pauseTask(task.id);
        expect(schedulerBridge.removeTask).toHaveBeenCalledWith(task.id);
    });

    it('duraklatılan görev evaluateTasks tarafından çalıştırılmaz', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        // Vadeyi geçmişe al; yine de çalışmamalı.
        task.trigger.targetTime = Date.now() - 1000;
        tm.pauseTask(task.id);
        tm.evaluateTasks();
        expect(task.status).toBe(TASK_STATUS.DISABLED);
    });

    it('duraklatılan görev getActiveTasks içinde yer almaz', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        expect(tm.getActiveTasks().some(t => t.id === task.id)).toBe(true);
        tm.pauseTask(task.id);
        expect(tm.getActiveTasks().some(t => t.id === task.id)).toBe(false);
    });

    it('ikinci duraklatma ALREADY_PAUSED döner (idempotent)', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        tm.pauseTask(task.id);
        expect(tm.pauseTask(task.id)).toMatchObject({ ok: true, code: 'ALREADY_PAUSED' });
    });

    it('terminal görev duraklatılamaz', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        task.status = TASK_STATUS.COMPLETED;
        expect(tm.pauseTask(task.id)).toMatchObject({ ok: false, code: 'TASK_NOT_PAUSABLE' });
    });

    it('olmayan görev NOT_FOUND döner', () => {
        const { tm } = makeHarness();
        expect(tm.pauseTask('task_yok')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('koşullu görev de duraklatılabilir', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({
            name: 'c', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage', thresholdPercent: 90 }] }
        });
        expect(task.status).toBe(TASK_STATUS.MONITORING);
        expect(tm.pauseTask(task.id).ok).toBe(true);
        expect(task.status).toBe(TASK_STATUS.DISABLED);
    });
});

describe('B. resumeTask', () => {
    it('zamanlı görevi SCHEDULED durumuna döndürür ve enabled=true yapar', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask({ trigger: { type: 'duration', durationMs: 600000 } }));
        tm.pauseTask(task.id);
        const res = tm.resumeTask(task.id);
        expect(res).toMatchObject({ ok: true, code: 'RESUMED' });
        expect(task.status).toBe(TASK_STATUS.SCHEDULED);
        expect(task.enabled).toBe(true);
        expect(task.pausedFromStatus).toBeNull();
    });

    it('koşullu görevi MONITORING durumuna döndürür', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({
            name: 'c', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage', thresholdPercent: 90 }] }
        });
        tm.pauseTask(task.id);
        tm.resumeTask(task.id);
        expect(task.status).toBe(TASK_STATUS.MONITORING);
        expect(task.enabled).toBe(true);
    });

    it('duraklatma sırasında zamanı geçen görev EXPIRED olur (asla otomatik çalışmaz)', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        tm.pauseTask(task.id);
        task.trigger.targetTime = Date.now() - 60000;
        tm.resumeTask(task.id);
        expect(task.status).toBe(TASK_STATUS.EXPIRED);
        expect(task.errorInfo).toMatch(/zamanı geçti/i);
    });

    it('tekrarlayan görev sürdürülünce sonraki occurrence hesaplanır', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({
            name: 'r', action: 'shutdown',
            trigger: { type: 'scheduled_time', targetTime: null },
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '09:00' }
        });
        tm.pauseTask(task.id);
        tm.resumeTask(task.id);
        expect(task.status).toBe(TASK_STATUS.SCHEDULED);
        expect(task.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('duraklatılmamış görev TASK_NOT_PAUSED döner', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        expect(tm.resumeTask(task.id)).toMatchObject({ ok: false, code: 'TASK_NOT_PAUSED' });
    });

    it('sürdürülen görev zamanlayıcıya yeniden bağlanır', () => {
        const { tm, schedulerBridge } = makeHarness();
        const task = tm.createTask(durationTask({ trigger: { type: 'duration', durationMs: 600000 } }));
        tm.pauseTask(task.id);
        schedulerBridge.syncTask.mockClear();
        tm.resumeTask(task.id);
        expect(schedulerBridge.syncTask).toHaveBeenCalled();
    });
});

describe('C. Kalıcılık', () => {
    it('pausedFromStatus toJSON ile korunur (yeniden başlatmada sürdürülebilir)', () => {
        const { tm } = makeHarness();
        const task = tm.createTask(durationTask());
        tm.pauseTask(task.id);
        const json = task.toJSON();
        expect(json.enabled).toBe(false);
        expect(json.status).toBe('disabled');
        expect(json.pausedFromStatus).toBe('scheduled');
    });
});
