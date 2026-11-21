/**
 * taskmanager.test.mjs — WBS-0.1 / WBS-0.2 / TS-0.2
 * GÜVENLİK: OS çağrısı ASLA gerçek modüle gitmez — sahte `power` nesnesi
 * constructor enjeksiyonuyla verilir (vi.mock kayıt-eşleşmesine güvenilmez).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';

function makeDeps(overrides = {}) {
    return Object.assign({
        storage: { getTasks: () => [], saveTask: vi.fn(), deleteTask: vi.fn(), getSettings: () => ({}) },
        warning: null,
        safety: { evaluate: async () => ({ allowed: true }) },
        history: { record: vi.fn(), getHistory: () => [], clear: () => {} },
        webhook: { triggerEvent: vi.fn() },
        power: { execute: vi.fn(async () => ({ success: true })) }
    }, overrides);
}

function freshMetrics(overrides = {}) {
    return Object.assign({
        cpuUsagePercent: 4, networkDownloadKbps: 5, networkUploadKbps: 2,
        diskIops: 10, userIdleSeconds: 500,
        batteryLevelPercent: 80, isCharging: false, batterySupported: true,
        runningProcesses: [], stale: false, sampledAt: new Date().toISOString()
    }, overrides);
}

const live = [];
afterEach(() => { for (const tm of live.splice(0)) { if (tm.loopInterval) clearInterval(tm.loopInterval); } });

function spawn(deps) {
    const d = makeDeps(deps);
    const collector = (deps && deps.collector) || { getMetrics: () => freshMetrics() };
    const engine = new SmartFinishEngine(collector);
    const tm = new TaskManager(d.storage, d.warning, d.safety, d.history, d.webhook, engine, collector, d.power);
    live.push(tm);
    return { tm, d, engine, collector };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('TaskManager zamanlayıcı (TS-0.2)', () => {
    it('duration görevi targetTime + SCHEDULED ile kurulur', () => {
        const { tm } = spawn();
        const before = Date.now();
        const task = tm.createTask({ name: 'Hızlı', action: 'shutdown', trigger: { type: 'duration', durationMs: 900000 } });
        expect(task.status).toBe('scheduled');
        expect(task.trigger.targetTime).toBeGreaterThanOrEqual(before + 900000 - 1000);
    });

    it('snooze gelecekteki hedefi ileri taşır, geri çekmez', () => {
        const { tm } = spawn();
        const task = tm.createTask({ name: 'Snooze', action: 'sleep', trigger: { type: 'duration', durationMs: 3600000 } });
        const before = task.trigger.targetTime;
        const res = tm.snoozeTask(task.id, 10);
        expect(res.ok).toBe(true);
        expect(task.trigger.targetTime).toBe(before + 10 * 60 * 1000);
        expect(task.status).toBe('scheduled');
    });

    it('gelecekteki görev evaluateTasks ile çalışmaz', async () => {
        const { tm, d } = spawn();
        tm.createTask({ name: 'Gelecek', action: 'shutdown', trigger: { type: 'duration', durationMs: 3600000 } });
        tm.evaluateTasks();
        await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
    });

    it('süresi dolmuş görev çalışır ve COMPLETED olur', async () => {
        const { tm, d } = spawn();
        const task = tm.createTask({
            name: 'Vadesi', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(d.power.execute).toHaveBeenCalledWith('shutdown', expect.anything());
        expect(task.status).toBe('completed');
    });

    it('scheduled_time hedefiyle SCHEDULED başlar (WBS-6.x)', () => {
        const { tm } = spawn();
        const task = tm.createTask({
            name: 'Gece', action: 'sleep',
            trigger: { type: 'scheduled_time', targetTime: Date.now() + 3600000 },
            warningConfig: { enabled: false }
        });
        expect(task.status).toBe('scheduled');
        expect(task.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('mod damgası sunucu ayarından vurulur; istemci mode alanı yok sayılır', () => {
        const { tm } = spawn();
        const a = tm.createTask({ name: 'A', action: 'sleep', trigger: { type: 'duration', durationMs: 60000 } });
        const b = tm.createTask({ name: 'B', action: 'sleep', trigger: { type: 'duration', durationMs: 60000 }, mode: 'full' });
        expect(a.mode).toBe('classic');
        // K-04: istemci gönderdiği mode güvenilir değildir.
        expect(b.mode).toBe('classic');
    });

    it('otonomi modu ayarı full ise yeni görevler full damgalanır', () => {
        const base = makeDeps();
        const { tm } = spawn({
            storage: { ...base.storage, getSettings: () => ({ autonomyMode: 'full' }) }
        });
        const task = tm.createTask({ name: 'F', action: 'sleep', trigger: { type: 'duration', durationMs: 60000 } });
        expect(task.mode).toBe('full');
    });

    it('güvenlik reddi BLOCKED üretir, OS çalışmaz', async () => {
        const { tm, d } = spawn({ safety: { evaluate: async () => ({ allowed: false, reason: 'Korunan uygulama' }) } });
        const task = tm.createTask({
            name: 'Engelli', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
        expect(task.status).toBe('blocked');
    });
});

describe('TaskManager zincir (WBS-11.1)', () => {
    function spawnWithPower(settings = {}) {
        const base = makeDeps();
        const { tm, d } = spawn({
            storage: { ...base.storage, getSettings: () => settings }
        });
        d.power.isValidAction = (a) => ['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout'].includes(a);
        return { tm, d };
    }

    it('biten görev sıradaki halkayı süreli görev olarak kurar', async () => {
        const { tm } = spawnWithPower({ autonomyMode: 'full' });
        const task = tm.createTask({
            name: 'Ana', action: 'sleep',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false },
            mode: 'full',
            chain: [{ action: 'shutdown', delayMinutes: 120 }, { action: 'hibernate', delayMinutes: 60 }]
        });
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(task.status).toBe('completed');
        const link = tm.tasks.find((t) => t.name.startsWith('Zincir:'));
        expect(link).toBeDefined();
        expect(link.action).toBe('shutdown');
        expect(link.trigger.durationMs).toBe(120 * 60000);
        expect(link.status).toBe('scheduled');
        expect(link.mode).toBe('full');
        expect(link.chain).toHaveLength(1);
    });

    it('geçersiz halkada zincir durmaz, halka atlanır', async () => {
        const { tm } = spawnWithPower();
        const task = tm.createTask({
            name: 'Ana', action: 'sleep',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false },
            chain: [{ action: 'format', delayMinutes: 5 }]
        });
        // createTask zinciri ham saklar; spawn anında geçersiz halka elenir.
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(task.status).toBe('completed');
        expect(tm.tasks.some((t) => t.name.startsWith('Zincir:'))).toBe(false);
    });

    it('zincirsiz görevde ek görev kurulmaz', async () => {
        const { tm, d } = spawnWithPower();
        const task = tm.createTask({
            name: 'Tek', action: 'sleep',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(tm.tasks).toHaveLength(1);
        expect(d.power.execute).toHaveBeenCalledTimes(1);
    });
});

describe('TaskManager Smart Finish kablolama (WBS-0.1)', () => {
    it('koşullu görev MONITORING ile başlar', () => {
        const { tm } = spawn();
        const task = tm.createTask({
            name: 'SF', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', stabilitySeconds: 0, conditions: [{ type: 'cpu_usage', thresholdPercent: 90 }] }
        });
        expect(task.status).toBe('monitoring');
    });

    it('desteksiz koşul createTask aşamasında reddedilir (WBS-1.2)', () => {
        const { tm } = spawn();
        expect(() => tm.createTask({
            name: 'Kötü', action: 'shutdown', trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'file_event' }] }
        })).toThrow(/Desteklenmeyen koşul/);
        expect(tm.tasks.length).toBe(0);
    });

    it('koşul sağlanınca görev çalışır (stabilitySeconds=0, iki döngü)', async () => {
        const { tm, d, engine } = spawn();
        const task = tm.createTask({
            name: 'SF-çalış', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', stabilitySeconds: 0, conditions: [{ type: 'cpu_usage', thresholdPercent: 90 }] },
            warningConfig: { enabled: false }
        });
        tm.evaluateTasks(); // 1. döngü: tracker kurulur
        expect(d.power.execute).not.toHaveBeenCalled();
        engine.stabilityTrackers.set(task.id, Date.now() - 1000);
        tm.evaluateTasks(); // 2. döngü: satisfied → çalışır
        await flush(); await flush();
        expect(d.power.execute).toHaveBeenCalledWith('shutdown', expect.anything());
    });

    it('stale metrikle Smart Finish tetiklenmez', async () => {
        const staleCollector = { getMetrics: () => freshMetrics({ stale: true }) };
        const { tm, d } = spawn({ collector: staleCollector });
        tm.createTask({
            name: 'SF-stale', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', stabilitySeconds: 0, conditions: [{ type: 'cpu_usage', thresholdPercent: 90 }] },
            warningConfig: { enabled: false }
        });
        tm.evaluateTasks();
        await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
    });

    it('motor enjekte edilmezse koşullu görev güvenli atlanır (crash yok)', async () => {
        const d = makeDeps();
        // Motor yok (null, null) ama güç sahte — tetikleme olmasa bile OS riski sıfır.
        const tm = new TaskManager(d.storage, d.warning, d.safety, d.history, d.webhook, null, null, d.power);
        live.push(tm);
        const task = tm.createTask({
            name: 'SF-motorsuz', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage' }] }
        });
        // Bu varyantta tetikleme olmadığı için OS çağrısı yapılmaz (güç sahte).
        expect(() => tm.evaluateTasks()).not.toThrow();
        await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
        expect(task.status).toBe('monitoring');
    });

    it('açılış korumasında sessizlik-koşulu pas geçilir (WBS-11.5)', async () => {
        const d = makeDeps();
        d.safety.isBootGuardActive = () => true;
        const collector = { getMetrics: () => freshMetrics() };
        const tm = new TaskManager(d.storage, d.warning, d.safety, d.history, d.webhook, new SmartFinishEngine(collector), collector, d.power);
        live.push(tm);
        const task = tm.createTask({
            name: 'SF-boot', action: 'shutdown',
            trigger: { type: 'composite' },
            conditionGroup: { operator: 'AND', stabilitySeconds: 0, conditions: [{ type: 'network_speed', thresholdKbps: 50 }] },
            warningConfig: { enabled: false }
        });
        tm.evaluateTasks();
        await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
        expect(task.lastProgressMessage).toMatch(/Açılış koruması/);
    });

    it('kill-switch boru hattındaki API görevini engeller + iz bırakır (K3+K4)', async () => {
        const storage = {
            getTasks: () => [],
            saveTask: vi.fn(), deleteTask: vi.fn(),
            getSettings: () => ({ agentDisabled: true }),
            getExemptions: () => [],
            getMaintenanceWindows: () => []
        };
        const safety = new SafetyPolicyEngine(storage, () => { throw new Error('exec yok'); }, () => 9999);
        const history = { record: vi.fn(), getHistory: () => [], clear: () => {} };
        const power = { execute: vi.fn(async () => ({ success: true })) };
        const collector = { getMetrics: () => freshMetrics() };
        const tm = new TaskManager(storage, null, safety, history, { triggerEvent: vi.fn() }, new SmartFinishEngine(collector), collector, power);
        live.push(tm);
        const task = tm.createTask({
            name: 'API Immediate restart', action: 'restart', source: 'local_api',
            warningConfig: { enabled: false },
            trigger: { type: 'duration', durationMs: 5000 }
        });
        await tm.executeTask(task);
        expect(task.status).toBe('blocked');
        expect(power.execute).not.toHaveBeenCalled();
        expect(history.record).toHaveBeenCalled();
        const code = history.record.mock.calls[0][1];
        expect(code).toBe('blocked_by_policy');
    });
});
