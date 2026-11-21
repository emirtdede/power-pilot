/**
 * taskmanager-lifecycle.test.mjs — TaskManager yaşam döngüsü (WP-02/06/08/11)
 *
 * Tüm OS ve UI etkileşimleri enjekte edilir (power, warning, history, webhook,
 * schedulerBridge, storage). Gerçek görev yürütme/kapatma YOK.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';
import { TASK_STATUS } from '../../src/main/services/models/AutomationTask.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) {
        if (tm.loopInterval) clearInterval(tm.loopInterval);
    }
});

function makeHarness(over = {}) {
    const storage = Object.assign({
        tasks: [],
        settings: {},
        saveFail: false,
        updateFail: false,
        getTasks() { return this.tasks; },
        saveTask: vi.fn(function () { return storage.saveFail ? false : true; }),
        deleteTask: vi.fn(() => true),
        getSettings() { return this.settings; },
        updateSettings: vi.fn(function (patch) {
            if (storage.updateFail) return false;
            storage.settings = Object.assign({}, storage.settings, patch);
            return true;
        })
    }, over.storage || {});

    const warning = Object.assign({
        active: null,
        getActiveState() { return this.active; },
        showWarning: vi.fn(async () => ({ proceed: true })),
        cancelActiveWarning: vi.fn(),
        snoozeActiveWarning: vi.fn()
    }, over.warning || {});

    const history = Object.assign({ record: vi.fn(), getHistory: () => [], clear: () => {} }, over.history || {});
    const webhook = Object.assign({ triggerEvent: vi.fn() }, over.webhook || {});
    const power = Object.assign({
        execute: vi.fn(async () => ({ success: true })),
        isValidAction: (a) => ['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout'].includes(a)
    }, over.power || {});
    const safety = Object.assign({ evaluate: vi.fn(async () => ({ allowed: true })) }, over.safety || {});
    const collector = Object.assign({ getMetrics: () => metrics() }, over.collector || {});
    const smart = over.smart || null;

    const tm = new TaskManager(storage, warning, safety, history, webhook, smart, collector, power);
    live.push(tm);
    return { tm, storage, warning, history, webhook, power, safety, collector };
}

function metrics(over = {}) {
    return Object.assign({
        cpuUsagePercent: 3, networkDownloadKbps: 0, networkUploadKbps: 0, diskIops: 0,
        userIdleSeconds: 900, batteryLevelPercent: 90, isCharging: true, batterySupported: true,
        runningProcesses: [], processListStale: false, stale: false, sampledAt: new Date().toISOString()
    }, over);
}

const flush = async (ms = 40) => new Promise((r) => setTimeout(r, ms));
const durationTask = (over = {}) => Object.assign({ name: 'g', action: 'lock', trigger: { type: 'duration', durationMs: 60000 } }, over);

describe('TaskManager — claim yaşam döngüsü', () => {
    it('claimTask: yok/paused/not-runnable/occupied', () => {
        const h = makeHarness();
        expect(h.tm.claimTask('yok')).toEqual({ ok: false, code: 'NOT_FOUND' });

        const t = h.tm.createTask(durationTask());
        expect(h.tm.claimTask(t.id)).toMatchObject({ ok: true, task: t });

        // İkinci claim: başka görev çalışıyorsa ALREADY_RUNNING
        const t2 = h.tm.createTask(durationTask({ name: 'g2' }));
        expect(h.tm.claimTask(t2.id)).toEqual({ ok: false, code: 'ALREADY_RUNNING' });

        const token = h.tm.claims.get(t.id).token;
        expect(h.tm.isClaimValid(t.id, token)).toBe(true);
        expect(h.tm.isClaimValid(t.id, 'yanlış')).toBe(false);
        expect(h.tm.isClaimValid(t.id, null)).toBe(false);
        expect(h.tm.releaseTask(t.id, 'yanlış')).toBe(false);
        expect(h.tm.releaseTask(t.id, token)).toBe(true);
        expect(h.tm.releaseTask(t.id)).toBe(false);
    });

    it('pausedAll iken claim reddedilir; not-runnable durum reddedilir', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        h.tm.pausedAll = true;
        expect(h.tm.claimTask(t.id)).toEqual({ ok: false, code: 'PAUSED' });
        h.tm.pausedAll = false;

        t.status = TASK_STATUS.COMPLETED;
        expect(h.tm.claimTask(t.id)).toEqual({ ok: false, code: 'NOT_RUNNABLE' });

        t.status = TASK_STATUS.SCHEDULED;
        t.enabled = false;
        expect(h.tm.claimTask(t.id)).toEqual({ ok: false, code: 'NOT_FOUND' });
    });

    it('getClaimState kopya döner (tek ve liste)', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        const c = h.tm.claimTask(t.id, 'ui');
        const one = h.tm.getClaimState(t.id);
        expect(one).toMatchObject({ taskId: t.id, token: c.token, source: 'ui' });
        expect(h.tm.getClaimState('yok')).toBeNull();
        expect(h.tm.getClaimState()).toHaveLength(1);
    });
});

describe('TaskManager — açılış kurtarma ve tekrarlama', () => {
    it('EXECUTING/WARNING açılışta FAILED olur ve history yazılır', () => {
        const h = makeHarness();
        const a = h.tm.createTask(durationTask({ name: 'a' }));
        const b = h.tm.createTask(durationTask({ name: 'b' }));
        a.status = TASK_STATUS.EXECUTING;
        b.status = TASK_STATUS.WARNING;
        h.tm.recoverTasksOnStartup();
        expect(a.status).toBe(TASK_STATUS.FAILED);
        expect(b.status).toBe(TASK_STATUS.FAILED);
        expect(a.errorInfo).toMatch(/yarıda kaldı/);
        expect(h.history.record).toHaveBeenCalled();
    });

    it('geçmiş hedefli tek seferlik görev EXPIRED olur (otomatik çalışmaz)', () => {
        const h = makeHarness();
        const t = h.tm.createTask({ name: 'eski', action: 'lock', trigger: { type: 'scheduled_time', targetTime: Date.now() + 1000 } });
        t.trigger.targetTime = Date.now() - 5000;
        h.tm.recoverTasksOnStartup();
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
        expect(h.power.execute).not.toHaveBeenCalled();
    });

    it('tekrarlayan görevde süre dolumu EXPIRED yapmaz, sonraki occurrence hesaplanır', () => {
        const h = makeHarness();
        const t = h.tm.createTask({
            name: 'tekrar',
            action: 'lock',
            trigger: { type: 'scheduled_time', targetTime: Date.now() - 60000 },
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '03:00' }
        });
        h.tm.recoverTasksOnStartup();
        expect(t.status).toBe(TASK_STATUS.SCHEDULED);
        expect(t.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('calculateNextRecurrence: geçersiz saat, weekdays/weekends/weekly/custom', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());

        t.recurrence = { enabled: false };
        h.tm.calculateNextRecurrence(t);
        expect(t.trigger.targetTime).toBeDefined();

        t.recurrence = { enabled: true, timeOfDay: '99:99' };
        const before = t.trigger.targetTime;
        h.tm.calculateNextRecurrence(t);
        expect(t.trigger.targetTime).toBe(before);

        for (const frequency of ['weekdays', 'weekends', 'weekly', 'custom', 'daily']) {
            t.recurrence = { enabled: true, frequency, timeOfDay: '00:00', daysOfWeek: [1, 2, 3] };
            h.tm.calculateNextRecurrence(t);
            expect(t.status).toBe(TASK_STATUS.SCHEDULED);
            expect(t.trigger.targetTime).toBeGreaterThan(Date.now() - 1000);
        }

        // weekly + boş gün listesi her günü kabul eder
        t.recurrence = { enabled: true, frequency: 'weekly', timeOfDay: '00:00', daysOfWeek: [] };
        h.tm.calculateNextRecurrence(t);
        expect(Number.isFinite(t.trigger.targetTime)).toBe(true);

        // weekly + geçersiz gün değerleri filtre edilir
        t.recurrence = { enabled: true, frequency: 'weekly', timeOfDay: '00:00', daysOfWeek: [99, 'x', 2] };
        h.tm.calculateNextRecurrence(t);
        expect(new Date(t.trigger.targetTime).getDay()).toBe(2);
    });
});

describe('TaskManager — değerlendirme döngüsü', () => {
    it('pausedAll iken evaluateTasks hiçbir şey yapmaz', async () => {
        const h = makeHarness();
        h.tm.pausedAll = true;
        const t = h.tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'duration', durationMs: 1 } });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(60);
        expect(h.power.execute).not.toHaveBeenCalled();
    });

    it('reentrancy guard çift değerlendirmeyi engeller', async () => {
        const h = makeHarness();
        h.tm._evaluating = true;
        h.tm.evaluateTasks();
        h.tm._evaluating = false;
        expect(h.power.execute).not.toHaveBeenCalled();
    });

    it('vadesi gelen görev yürütülür; terminal görevler atlanır', async () => {
        const h = makeHarness();
        const done = h.tm.createTask({ name: 'bitti', action: 'lock', trigger: { type: 'duration', durationMs: 60000 } });
        done.status = TASK_STATUS.COMPLETED;
        const blocked = h.tm.createTask({ name: 'blok', action: 'lock', trigger: { type: 'duration', durationMs: 60000 } });
        blocked.status = TASK_STATUS.BLOCKED;

        const t = h.tm.createTask({ name: 'çalış', action: 'lock', trigger: { type: 'duration', durationMs: 1 } });
        await flush(10);
        h.tm.evaluateTasks();
        await flush(120);
        expect(h.power.execute).toHaveBeenCalledTimes(1);
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
    });

    it('çakışan görevler BLOCKED olur ve history/webhook yazılır', async () => {
        const h = makeHarness();
        const first = h.tm.createTask({ name: 'birinci', action: 'lock', trigger: { type: 'duration', durationMs: 3600000 } });
        first.trigger.targetTime = Date.now() - 1;
        const second = h.tm.createTask({ name: 'ikinci', action: 'lock', trigger: { type: 'duration', durationMs: 3600000 } });
        second.trigger.targetTime = Date.now() - 1;

        h.tm.evaluateTasks();
        await flush(120);
        const states = [first.status, second.status];
        expect(states).toContain(TASK_STATUS.COMPLETED);
        expect(states).toContain(TASK_STATUS.BLOCKED);
        expect(h.webhook.triggerEvent).toHaveBeenCalledWith('task_blocked', expect.anything());
    });

    it('koşullu görev MONITORING olur; koşul sağlanınca çalışır', async () => {
        const smart = {
            evaluateTask: vi.fn(() => ({ satisfied: false, progressMessage: 'bekliyor' })),
            prune: vi.fn()
        };
        const h = makeHarness({ smart });
        const t = h.tm.createTask({
            name: 'koşullu', action: 'lock',
            conditionGroup: { conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }] }
        });
        h.tm.evaluateTasks();
        expect(t.status).toBe(TASK_STATUS.MONITORING);
        expect(t.lastProgressMessage).toBe('bekliyor');

        smart.evaluateTask.mockReturnValue({ satisfied: true, progressMessage: 'tamam' });
        h.tm.evaluateTasks();
        await flush(120);
        expect(h.power.execute).toHaveBeenCalledTimes(1);
        expect(smart.prune).toHaveBeenCalled();
    });

    it('notBefore gelmeden koşul değerlendirilmez', async () => {
        const smart = { evaluateTask: vi.fn(() => ({ satisfied: true, progressMessage: '' })), prune: vi.fn() };
        const h = makeHarness({ smart });
        const t = h.tm.createTask({ name: 'ertelenmiş', action: 'lock', conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        t.trigger.notBefore = Date.now() + 60000;
        h.tm.evaluateTasks();
        expect(smart.evaluateTask).not.toHaveBeenCalled();
        expect(t.lastProgressMessage).toMatch(/Erteleme/);
    });

    it('smartFinish yoksa koşullu görev değerlendirilmez (güvenli atlama)', () => {
        const h = makeHarness();
        h.tm.smartFinishEngine = null;
        const t = h.tm.createTask({ name: 'k', action: 'lock', conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        h.tm.evaluateTasks();
        expect(t.status).toBe(TASK_STATUS.MONITORING);
    });

    it('smartFinish hatası görevi FAILED yapar ve history yazar', () => {
        const smart = { evaluateTask: () => { throw new Error('motor patladı'); }, prune: () => {} };
        const h = makeHarness({ smart });
        const t = h.tm.createTask({ name: 'hata', action: 'lock', conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        h.tm.evaluateTasks();
        expect(t.status).toBe(TASK_STATUS.FAILED);
        expect(t.errorInfo).toMatch(/Smart Finish/);
        expect(h.history.record).toHaveBeenCalled();
    });

    it('açılış koruması sessizlik-tipi koşulda değerlendirmeyi atlar', () => {
        const smart = { evaluateTask: vi.fn(() => ({ satisfied: true })), prune: vi.fn() };
        const h = makeHarness({
            smart,
            safety: { evaluate: vi.fn(async () => ({ allowed: true })), isBootGuardActive: () => true }
        });
        const t = h.tm.createTask({ name: 'idle', action: 'lock', conditionGroup: { conditions: [{ type: 'user_idle', idleSeconds: 300 }] } });
        h.tm.evaluateTasks();
        expect(smart.evaluateTask).not.toHaveBeenCalled();
        expect(t.lastProgressMessage).toMatch(/Açılış/);
        expect(h.tm.hasIdleLikeCondition(t)).toBe(true);
        expect(h.tm.hasIdleLikeCondition({ conditionGroup: { conditions: [{ type: 'process_running' }] } })).toBe(false);
    });
});

describe('TaskManager — yürütme akışı', () => {
    async function runTask(over = {}, taskOver = {}, tmPoke = null) {
        const h = makeHarness(over);
        const t = h.tm.createTask(durationTask(taskOver));
        t.trigger.targetTime = Date.now() - 1;
        if (tmPoke) tmPoke(h, t);
        h.tm.evaluateTasks();
        await flush(120);
        return { h, t };
    }

    it('güvenlik reddi → BLOCKED + history + webhook, power çağrılmaz', async () => {
        const { h, t } = await runTask({ safety: { evaluate: vi.fn(async () => ({ allowed: false, reason: 'korunan uygulama' })) } });
        expect(t.status).toBe(TASK_STATUS.BLOCKED);
        expect(h.power.execute).not.toHaveBeenCalled();
        expect(h.history.record).toHaveBeenCalledWith(t, 'blocked_by_policy', expect.any(String));
        expect(h.webhook.triggerEvent).toHaveBeenCalledWith('task_blocked', t);
    });

    it('uyarı onayı ile ilerler (proceed)', async () => {
        const { h, t } = await runTask({}, { warningConfig: { enabled: true, durationSeconds: 1 } });
        expect(h.warning.showWarning).toHaveBeenCalled();
        expect(h.power.execute).toHaveBeenCalledWith('lock', expect.anything());
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
        expect(h.webhook.triggerEvent).toHaveBeenCalledWith('task_warning_started', t);
        expect(h.webhook.triggerEvent).toHaveBeenCalledWith('power_action_started', t);
    });

    it('uyarı iptali → CANCELLED', async () => {
        const { h, t } = await runTask({ warning: { showWarning: vi.fn(async () => ({ proceed: false })) } }, { warningConfig: { enabled: true, durationSeconds: 1 } });
        expect(t.status).toBe(TASK_STATUS.CANCELLED);
        expect(h.history.record).toHaveBeenCalledWith(t, 'cancelled_by_user', 'Kullanıcı İptal Etti');
    });

    it('uyarı ertelemesi → SNOOZED ve sayaç artar', async () => {
        const { t } = await runTask({
            warning: { showWarning: vi.fn(async () => ({ proceed: false, snoozed: true, minutes: 5 })) }
        }, { warningConfig: { enabled: true, durationSeconds: 1 } });
        // P1-6 (üçüncü tur): erteleme artık görünür `snoozed` durumudur.
        expect(t.status).toBe(TASK_STATUS.SNOOZED);
        expect(t.snoozeConfig.currentCount).toBe(1);
        expect(t.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('erteleme reddedilirse (limit) görev CANCELLED olur', async () => {
        const { t } = await runTask({
            warning: { showWarning: vi.fn(async () => ({ proceed: false, snoozed: true, minutes: 5 })) }
        }, { warningConfig: { enabled: true, durationSeconds: 1 }, snoozeConfig: { allowed: true, maxCount: 1, currentCount: 1 } });
        expect(t.status).toBe(TASK_STATUS.CANCELLED);
        expect(t.errorInfo).toMatch(/Erteleme/);
    });

    it('power hatası → FAILED + os_execution_failed', async () => {
        const { t } = await runTask({ power: { execute: vi.fn(async () => ({ success: false, error: 'OS reddetti' })) } });
        expect(t.status).toBe(TASK_STATUS.FAILED);
        expect(t.lastResult.code).toBe('os_execution_failed');
    });

    it('power fırlatırsa yakalanır ve FAILED olur', async () => {
        const { t } = await runTask({ power: { execute: vi.fn(async () => { throw new Error('spawn yok'); }) } });
        expect(t.status).toBe(TASK_STATUS.FAILED);
        expect(t.errorInfo).toMatch(/spawn yok/);
    });

    it('başarılı görev zincir halkası kurar', async () => {
        const { h, t } = await runTask({}, { chain: [{ action: 'sleep', delayMinutes: 2 }, { action: 'lock', delayMinutes: 3 }] });
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
        const spawned = h.tm.tasks.find((x) => x.id !== t.id && x.name.includes('Zincir'));
        expect(spawned).toBeTruthy();
        expect(spawned.action).toBe('sleep');
        expect(spawned.chain).toHaveLength(1);
    });

    it('başarılı tekrarlayan görev sonraki occurrence\'a taşınır', async () => {
        const { t } = await runTask({}, { recurrence: { enabled: true, frequency: 'daily', timeOfDay: '03:00' } });
        expect(t.status).toBe(TASK_STATUS.SCHEDULED);
        expect(t.trigger.targetTime).toBeGreaterThan(Date.now());
    });

    it('uyarı sırasında iptal → power çağrılmaz', async () => {
        const h = makeHarness({
            warning: {
                showWarning: vi.fn(async () => {
                    const task = h.tm.tasks[0];
                    h.tm.cancelTask(task.id);
                    return { proceed: true };
                })
            }
        });
        const t = h.tm.createTask(durationTask({ warningConfig: { enabled: true, durationSeconds: 1 } }));
        t.trigger.targetTime = Date.now() - 1;
        h.tm.evaluateTasks();
        await flush(120);
        expect(h.power.execute).not.toHaveBeenCalled();
        expect(t.status).toBe(TASK_STATUS.CANCELLED);
    });

    it('executeTask claim sahibi değilse çalışmaz; doğrudan çağrı kendi claim\'ini alır', async () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        await h.tm.executeTask(t, 'yanlış-token');
        expect(h.power.execute).not.toHaveBeenCalled();

        await h.tm.executeTask(t);
        expect(h.power.execute).toHaveBeenCalledTimes(1);
    });

    it('doğrudan executeTask claim alınamazsa sessizce döner', async () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        t.status = TASK_STATUS.COMPLETED;
        await h.tm.executeTask(t);
        expect(h.power.execute).not.toHaveBeenCalled();
    });

    it('executeTask içinde beklenmeyen hata handleExecutionError ile FAILED olur', async () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        h.safety.evaluate = vi.fn(async () => { throw Object.assign(new Error('beklenmeyen'), { code: 'X' }); });
        await h.tm.executeTask(t);
        expect(t.status).toBe(TASK_STATUS.FAILED);
    });

    it('handleExecutionError task null güvenli; notifyResult dinleyici hatası yutulur', () => {
        const h = makeHarness();
        expect(() => h.tm.handleExecutionError(null, new Error('x'))).not.toThrow();
        h.tm.setResultListener(() => { throw new Error('dinleyici'); });
        expect(() => h.tm.notifyResult({ id: 'a', name: 'n' }, true)).not.toThrow();
        h.tm.setResultListener('nope');
        expect(h.tm.resultListener).toBeNull();
    });

    it('notifyResult yükü alanları taşır', () => {
        const h = makeHarness();
        const seen = [];
        h.tm.setResultListener((p) => seen.push(p));
        h.tm.notifyResult({ id: 'a', name: 'n', action: 'lock', status: 'completed', lastResult: { code: 'success' } }, true);
        expect(seen[0]).toMatchObject({ taskId: 'a', name: 'n', action: 'lock', success: true, status: 'completed', code: 'success' });
    });
});

describe('TaskManager — iptal / erteleme / duraklatma', () => {
    it('cancelTask: yok / zaten iptal / başarılı / persist hatası', () => {
        const h = makeHarness();
        expect(h.tm.cancelTask('yok')).toMatchObject({ ok: false, code: 'NOT_FOUND' });

        const t = h.tm.createTask(durationTask());
        expect(h.tm.cancelTask(t.id)).toMatchObject({ ok: true, code: 'CANCELLED' });
        expect(t.status).toBe(TASK_STATUS.CANCELLED);
        expect(h.tm.cancelTask(t.id)).toMatchObject({ ok: true, code: 'ALREADY_CANCELLED' });

        const t2 = h.tm.createTask(durationTask({ name: 'p' }));
        h.storage.saveFail = true;
        const res = h.tm.cancelTask(t2.id);
        expect(res).toMatchObject({ ok: false, code: 'TASK_PERSIST_FAILED' });
        expect(t2.status).toBe(TASK_STATUS.SCHEDULED);
    });

    it('OS çağrısı başladıysa CANCEL_TOO_LATE', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        const claim = h.tm.claimTask(t.id);
        const stored = h.tm.claims.get(t.id);
        stored.phase = 'executing';
        stored.powerStarted = true;
        const res = h.tm.cancelTask(t.id);
        expect(res).toMatchObject({ ok: true, code: 'CANCEL_TOO_LATE' });
        expect(h.tm.claims.get(t.id).cancelRequested).toBe(true);
        expect(claim.ok).toBe(true);
    });

    it('uyarı aşamasındaki iptal uyarıyı kapatır', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        h.tm.claimTask(t.id);
        h.tm.claims.get(t.id).phase = 'warning';
        h.warning.active = { taskId: t.id };
        expect(h.tm.cancelTask(t.id).ok).toBe(true);
        expect(h.warning.cancelActiveWarning).toHaveBeenCalledWith(t.id);
    });

    it('cancelActiveTask: aktif uyarı yoksa NO_ACTIVE_WARNING', () => {
        const h = makeHarness();
        expect(h.tm.cancelActiveTask()).toMatchObject({ ok: false, code: 'NO_ACTIVE_WARNING' });
        const t = h.tm.createTask(durationTask());
        h.warning.active = { taskId: t.id };
        expect(h.tm.cancelActiveTask()).toMatchObject({ ok: true, code: 'CANCELLED' });
    });

    it('applySnooze: kapalı / limit / koşullu / koşulsuz / dakika sınırları', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        expect(h.tm.applySnooze(null).ok).toBe(false);

        t.snoozeConfig = { allowed: false };
        expect(h.tm.applySnooze(t, 5)).toMatchObject({ ok: false, code: 'SNOOZE_NOT_ALLOWED' });

        t.snoozeConfig = { allowed: true, maxCount: 1, currentCount: 1 };
        expect(h.tm.applySnooze(t, 5)).toMatchObject({ ok: false, code: 'SNOOZE_LIMIT' });

        t.snoozeConfig = { allowed: true };
        const before = t.trigger.targetTime;
        const okNoCond = h.tm.applySnooze(t, 0);
        expect(okNoCond).toMatchObject({ ok: true, minutes: 1 });
        expect(t.trigger.targetTime).toBeGreaterThan(before);

        const minutesClamp = h.tm.applySnooze(t, 99999);
        expect(minutesClamp.minutes).toBe(1440);

        const cond = h.tm.createTask({ name: 'c', action: 'lock', conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        const r = h.tm.applySnooze(cond, 15);
        expect(r).toMatchObject({ ok: true, minutes: 15 });
        expect(cond.trigger.notBefore).toBeGreaterThan(Date.now());
        expect(cond.trigger.targetTime).toBeNull();
        // P1-6 (üçüncü tur): koşullu erteleme artık görünür `waiting` durumudur.
        expect(cond.status).toBe(TASK_STATUS.WAITING);
    });

    it('snoozeTask: doğrulama, aktif uyarı, çalışan görev, persist hatası', () => {
        const h = makeHarness();
        expect(h.tm.snoozeTask('yok')).toMatchObject({ ok: false, code: 'NOT_FOUND' });

        const t = h.tm.createTask(durationTask());
        t.snoozeConfig = { allowed: false };
        expect(h.tm.snoozeTask(t.id, 5)).toMatchObject({ ok: false, code: 'SNOOZE_NOT_ALLOWED' });

        t.snoozeConfig = { allowed: true };
        h.tm.claimTask(t.id);
        h.tm.claims.get(t.id).phase = 'warning';
        expect(h.tm.snoozeTask(t.id, 7)).toMatchObject({ ok: true, code: 'SNOOZED_ACTIVE', minutes: 7 });
        expect(h.warning.snoozeActiveWarning).toHaveBeenCalledWith(7, t.id);

        h.tm.releaseTask(t.id);
        h.tm.claimTask(t.id);
        expect(h.tm.snoozeTask(t.id, 7)).toMatchObject({ ok: false, code: 'ALREADY_RUNNING' });

        h.tm.releaseTask(t.id);
        h.storage.saveFail = true;
        expect(h.tm.snoozeTask(t.id, 7)).toMatchObject({ ok: false, code: 'TASK_PERSIST_FAILED' });
    });

    it('snoozeTask başarılı yolda history/webhook yazar', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        const r = h.tm.snoozeTask(t.id, 5);
        expect(r).toMatchObject({ ok: true, code: 'SNOOZED', minutes: 5 });
        expect(h.history.record).toHaveBeenCalledWith(t, 'snoozed_by_user', expect.any(String));
        expect(h.webhook.triggerEvent).toHaveBeenCalledWith('task_snoozed', t);
    });

    it('togglePauseAll kalıcı yazar; başarısızsa throw', () => {
        const h = makeHarness();
        expect(h.tm.togglePauseAll()).toBe(true);
        expect(h.storage.settings.automationPaused).toBe(true);
        expect(h.tm.togglePauseAll()).toBe(false);

        h.storage.updateFail = true;
        expect(() => h.tm.togglePauseAll()).toThrow(/Duraklatma/);
    });

    it('togglePauseAll storage yoksa yalnız bellekte çalışır', () => {
        const h = makeHarness();
        h.tm.storage = {};
        expect(h.tm.togglePauseAll()).toBe(true);
    });
});

describe('TaskManager — runTaskNow, zincir, sorgular', () => {
    it('runTaskNow: yok / disabled / paused / expired', async () => {
        const h = makeHarness();
        expect(h.tm.runTaskNow('yok')).toBe(false);

        const t = h.tm.createTask(durationTask());
        t.enabled = false;
        expect(h.tm.runTaskNow(t.id)).toBe(false);

        t.enabled = true;
        h.tm.pausedAll = true;
        expect(h.tm.runTaskNow(t.id)).toBe(false);
        h.tm.pausedAll = false;

        t.status = TASK_STATUS.EXPIRED;
        t.trigger.targetTime = Date.now() - 10000;
        expect(h.tm.runTaskNow(t.id)).toBe(true);
        await flush(120);
        expect(t.status).toBe(TASK_STATUS.COMPLETED);
    });

    it('runTaskNow EXPIRED kalıcılaştırılamazsa false', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        t.status = TASK_STATUS.EXPIRED;
        h.storage.saveFail = true;
        expect(h.tm.runTaskNow(t.id)).toBe(false);
        expect(t.status).toBe(TASK_STATUS.EXPIRED);
    });

    it('runTaskNow claim alınamazsa false', () => {
        const h = makeHarness();
        const a = h.tm.createTask(durationTask({ name: 'a' }));
        const b = h.tm.createTask(durationTask({ name: 'b' }));
        h.tm.claimTask(a.id);
        expect(h.tm.runTaskNow(b.id)).toBe(false);
    });

    it('spawnChainLink: boş / geçersiz eylem / createTask hatası / başarılı', () => {
        const h = makeHarness();
        expect(h.tm.spawnChainLink({ chain: [] })).toBeNull();
        expect(h.tm.spawnChainLink({ chain: [{ action: 'format', delayMinutes: 1 }], name: 'x' })).toBeNull();

        const t = h.tm.createTask(durationTask());
        t.chain = [{ action: 'lock', delayMinutes: 0 }];
        const spawned = h.tm.spawnChainLink(t);
        expect(spawned).toBeTruthy();
        expect(spawned.trigger.durationMs).toBe(60000);

        const failing = makeHarness();
        const t2 = failing.tm.createTask(durationTask());
        failing.storage.saveFail = true;
        t2.chain = [{ action: 'lock', delayMinutes: 1 }];
        expect(failing.tm.spawnChainLink(t2)).toBeNull();
    });

    it('getActiveTasks / hasInFlight / hasProcessConditions', () => {
        const h = makeHarness();
        expect(h.tm.getActiveTasks()).toEqual([]);
        expect(h.tm.hasInFlight()).toBe(false);

        const t = h.tm.createTask({ name: 'p', action: 'lock', conditionGroup: { conditions: [{ type: 'process_running', processName: 'code.exe' }] } });
        expect(h.tm.getActiveTasks().map((x) => x.id)).toContain(t.id);
        expect(h.tm.hasProcessConditions()).toBe(true);

        t.status = TASK_STATUS.COMPLETED;
        expect(h.tm.hasProcessConditions()).toBe(false);
        t.status = TASK_STATUS.MONITORING;
        t.enabled = false;
        expect(h.tm.hasProcessConditions()).toBe(false);

        const e = h.tm.createTask(durationTask({ name: 'e' }));
        e.status = TASK_STATUS.EXECUTING;
        expect(h.tm.hasInFlight()).toBe(true);
    });

    it('getNextTask en yakın hedefli aktif görevi döner', () => {
        const h = makeHarness();
        expect(h.tm.getNextTask()).toBeNull();
        const a = h.tm.createTask(durationTask({ name: 'a' }));
        const b = h.tm.createTask(durationTask({ name: 'b' }));
        a.trigger.targetTime = Date.now() + 900000;
        b.trigger.targetTime = Date.now() + 1000;
        expect(h.tm.getNextTask().id).toBe(b.id);
    });

    it('persistChanges değişenleri yazar; throwOnError hata fırlatır', () => {
        const h = makeHarness();
        expect(h.tm.persistChanges()).toBe(0);
        h.tm.createTask(durationTask());
        expect(h.storage.saveTask).toHaveBeenCalled();
        expect(h.tm.persistChanges({ throwOnError: true })).toBe(0);

        const t = h.tm.tasks[0];
        t.name = 'değişti';
        h.storage.saveFail = true;
        expect(() => h.tm.persistChanges({ throwOnError: true })).toThrow(/kalıcılaştırılamadı/);
    });

    it('persistChanges silinen görevi diskten kaldırır', () => {
        const h = makeHarness();
        const t = h.tm.createTask(durationTask());
        h.tm.tasks = h.tm.tasks.filter((x) => x.id !== t.id);
        h.tm.persistChanges();
        expect(h.storage.deleteTask).toHaveBeenCalledWith(t.id);
    });

    it('setChangeListener ve scheduler köprüsü hataları yutulur', async () => {
        const h = makeHarness();
        const listener = vi.fn();
        h.tm.setChangeListener(listener);
        h.tm.createTask(durationTask());
        expect(listener).toHaveBeenCalled();

        h.tm.setChangeListener(() => { throw new Error('x'); });
        expect(() => h.tm.createTask(durationTask({ name: 'y' }))).not.toThrow();

        h.tm.schedulerBridge = {
            syncTask: async () => false,
            removeTask: async () => { throw new Error('yok'); }
        };
        h.tm.syncScheduler({ id: 'x' });
        h.tm.removeScheduler('x');
        await flush(10);
    });

    it('setTimerRegistry ve startLoop timer kaydını kullanır', () => {
        const intervals = [];
        const registry = { setInterval: (fn, ms) => { intervals.push(ms); return 1; } };
        const h = makeHarness();
        h.tm.setTimerRegistry(registry);
        h.tm.startLoop();
        expect(intervals).toContain(1000);
        h.tm.setTimerRegistry(null);
        expect(h.tm.timerRegistry).toBeNull();
    });

    it('resolveAutonomyMode ayardan okur, hata/eksikte classic', () => {
        const h = makeHarness();
        expect(h.tm.resolveAutonomyMode()).toBe('classic');
        h.storage.settings = { autonomyMode: 'full' };
        expect(h.tm.resolveAutonomyMode()).toBe('full');
        h.tm.storage = { getSettings: () => { throw new Error('x'); } };
        expect(h.tm.resolveAutonomyMode()).toBe('classic');
        h.tm.storage = {};
        expect(h.tm.resolveAutonomyMode()).toBe('classic');
    });

    it('createTask: desteklenmeyen koşul, targetTime temizliği, persist hatası', () => {
        const h = makeHarness();
        expect(() => h.tm.createTask({ action: 'lock', conditionGroup: { conditions: [{ type: 'nope' }] } })).toThrow(/Desteklenmeyen/);

        const t = h.tm.createTask({ action: 'lock', trigger: { type: 'duration', durationMs: 1000, targetTime: Date.now() }, conditionGroup: { conditions: [{ type: 'cpu_usage' }] } });
        expect(t.trigger.targetTime).toBeNull();
        expect(t.status).toBe(TASK_STATUS.MONITORING);

        const scheduled = h.tm.createTask({ action: 'lock', trigger: { type: 'scheduled_time', targetTime: Date.now() + 60000 } });
        expect(scheduled.status).toBe(TASK_STATUS.SCHEDULED);

        const before = h.tm.tasks.length;
        h.storage.saveFail = true;
        expect(() => h.tm.createTask(durationTask({ name: 'yeni' }))).toThrow(/kalıcılaştırılamadı/);
        expect(h.tm.tasks).toHaveLength(before);
    });

    it('createTask consoleOrderId ile idempotent', () => {
        const h = makeHarness();
        const a = h.tm.createTask(durationTask({ name: 'a', consoleOrderId: 'order-1' }));
        const b = h.tm.createTask(durationTask({ name: 'b', consoleOrderId: 'order-1' }));
        expect(b.id).toBe(a.id);
        expect(h.tm.tasks).toHaveLength(1);
    });
});
