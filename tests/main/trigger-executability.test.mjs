/**
 * trigger-executability.test.mjs — P1-6 (üçüncü tur) kapısı
 *
 * Denetim kusuru: `TRIGGER_TYPE` 13 tür ilan ediyordu ve `validateTaskData`
 * hepsini kabul ediyordu. Ama `TaskManager.evaluateTasks` yalnızca
 * `duration` ve `scheduled_time` türlerini `targetTime` üzerinden dağıtır.
 *
 * Sonuç: `cpu_threshold`, `process_close`, `file_event`, `directory_event`,
 * `api_call`, `battery_event`, `network_threshold`, `disk_threshold`,
 * `recurring` ve koşulsuz `composite` ile oluşturulan görev `draft` durumunda
 * kalıyor, HİÇ tetiklenmiyor ve HİÇ hata üretmiyordu. Kullanıcı görevi
 * oluşturuyor ("kaydedildi"), ömrü boyunca hiçbir şey olmuyor.
 *
 * Bu kapı iki katmanı da kilitler: doğrulayıcı ve TaskManager.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import {
    TASK_STATUS,
    DISPATCHABLE_TRIGGER_TYPES,
    CONDITION_DRIVEN_TRIGGER_TYPES,
    TRIGGER_TYPE
} from '../../src/main/services/models/AutomationTask.js';
import { validateTaskData } from '../../src/main/ipc/validate.js';

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
        showWarning: async () => ({ proceed: true }),
        cancelActiveWarning() {},
        snoozeActiveWarning() {}
    };
    const history = { record: vi.fn(), getHistory: () => [], clear() {} };
    const webhook = { triggerEvent: vi.fn() };
    const power = { execute: vi.fn(async () => ({ success: true })), isValidAction: () => true };
    const safety = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const collector = { getMetrics: () => ({}) };
    const tm = new TaskManager(storage, warning, safety, history, webhook, null, collector, power);
    live.push(tm);
    return { tm, power };
}

// TaskManager'ın gerçekten dağıtabildiği tek iki tür.
const DISPATCHABLE = ['duration', 'scheduled_time'];

describe('A. Model: dağıtılabilir tür kümesi zamanlayıcıyla uyuşur', () => {
    it('yalnızca duration ve scheduled_time dağıtılabilir', () => {
        expect([...DISPATCHABLE_TRIGGER_TYPES].sort()).toEqual([...DISPATCHABLE].sort());
    });

    it('koşul güdümlü türler dağıtılabilir kümede yer almaz', () => {
        for (const t of CONDITION_DRIVEN_TRIGGER_TYPES) {
            expect(DISPATCHABLE_TRIGGER_TYPES.has(t), `${t} hem koşul güdümlü hem dağıtılabilir olamaz`).toBe(false);
        }
    });

    it('her koşul güdümlü tür gerçek bir TRIGGER_TYPE değeridir', () => {
        const values = new Set(Object.values(TRIGGER_TYPE));
        for (const t of CONDITION_DRIVEN_TRIGGER_TYPES) {
            expect(values.has(t), `${t} TRIGGER_TYPE içinde yok`).toBe(true);
        }
    });
});

describe('B. TaskManager: sessiz no-op görev üretilmez', () => {
    it('koşulsuz koşul-güdümlü trigger reddedilir', () => {
        const { tm } = makeHarness();
        for (const type of ['cpu_threshold', 'process_close', 'file_event',
            'directory_event', 'api_call', 'battery_event',
            'network_threshold', 'disk_threshold', 'composite']) {
            expect(() => tm.createTask({ name: 'x', action: 'lock', trigger: { type } }),
                `${type} koşulsuz kabul edilmemeli`).toThrow(/koşul gerektirir/i);
        }
        expect(tm.tasks.length).toBe(0);
    });

    it('"recurring" trigger türü olarak reddedilir ve çözümü söyler', () => {
        const { tm } = makeHarness();
        expect(() => tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'recurring' } }))
            .toThrow(/recurring.*tetikleyici türü değildir|scheduled_time/i);
        expect(tm.tasks.length).toBe(0);
    });

    it('bilinmeyen trigger türü reddedilir', () => {
        const { tm } = makeHarness();
        expect(() => tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'nope' } }))
            .toThrow(/Desteklenmeyen tetikleyici/i);
    });

    it('koşul verildiğinde koşul-güdümlü trigger MONITORING başlar', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({
            name: 'x', action: 'lock',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }] }
        });
        expect(task.status).toBe(TASK_STATUS.MONITORING);
    });

    it('duration trigger geçerli durationMs ile SCHEDULED olur', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'duration', durationMs: 60000 } });
        expect(task.status).toBe(TASK_STATUS.SCHEDULED);
        expect(task.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('duration trigger durationMs olmadan reddedilir', () => {
        const { tm } = makeHarness();
        expect(() => tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'duration' } }))
            .toThrow(/durationMs/i);
    });

    it('hedefsiz scheduled_time (tekrarlamayan) reddedilir', () => {
        const { tm } = makeHarness();
        expect(() => tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'scheduled_time' } }))
            .toThrow(/targetTime/i);
    });

    it('hedefsiz scheduled_time + recurrence kabul edilir (sunucu hesaplar)', () => {
        const { tm } = makeHarness();
        const task = tm.createTask({
            name: 'x', action: 'lock',
            trigger: { type: 'scheduled_time', targetTime: null },
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '09:00' }
        });
        expect(task.status).toBe(TASK_STATUS.SCHEDULED);
        expect(Number.isInteger(task.trigger.targetTime)).toBe(true);
    });
});

describe('C. Doğrulayıcı: aynı sözleşmeyi uygular', () => {
    const base = { action: 'shutdown', trigger: { type: 'duration', durationMs: 60000 } };

    it('koşulsuz koşul-güdümlü trigger reddedilir', () => {
        for (const type of ['cpu_threshold', 'process_close', 'file_event', 'composite']) {
            const r = validateTaskData({ ...base, trigger: { type } });
            expect(r.ok, `${type} koşulsuz kabul edilmemeli`).toBe(false);
            expect(r.code).toBe('UNSUPPORTED_TRIGGER');
        }
    });

    it('"recurring" ve bilinmeyen tür reddedilir', () => {
        expect(validateTaskData({ ...base, trigger: { type: 'recurring' } }).code).toBe('UNSUPPORTED_TRIGGER');
        expect(validateTaskData({ ...base, trigger: { type: 'nope' } }).code).toBe('INVALID_TRIGGER');
    });

    it('koşul verildiğinde koşul-güdümlü trigger kabul edilir', () => {
        const r = validateTaskData({
            ...base,
            trigger: { type: 'composite' },
            conditionGroup: { conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }] }
        });
        expect(r.ok).toBe(true);
    });

    it('hedefsiz scheduled_time tekrarlamıyorsa reddedilir, tekrarlıyorsa kabul edilir', () => {
        expect(validateTaskData({ ...base, trigger: { type: 'scheduled_time', targetTime: null } }).code)
            .toBe('INVALID_TRIGGER');
        expect(validateTaskData({
            ...base,
            trigger: { type: 'scheduled_time', targetTime: null },
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '09:00' }
        }).ok).toBe(true);
    });
});
