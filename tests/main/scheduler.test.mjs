/**
 * scheduler.test.mjs — WBS-2.2 / TS-2.2
 * TaskSchedulerBridge: komut inşası, Store yasağı, lead-time, argv ayrıştırma.
 * Gerçek schtasks ASLA çalışmaz (sahte exec enjeksiyonu).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import TaskSchedulerBridge from '../../src/main/services/TaskSchedulerBridge.js';
import TaskManager from '../../src/main/services/TaskManager.js';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';
import { validateTaskData, validateTaskId } from '../../src/main/ipc/validate.js';

function fakeExecFileImpl(calls, { fail = false, exitCode = 0 } = {}) {
    return vi.fn((file, args, options, cb) => {
        calls.push({ file, args, options });
        if (fail) {
            const err = new Error('schtasks yok');
            err.code = exitCode || 1;
            cb(err, '', '');
        } else {
            cb(null, 'SUCCESS', '');
        }
    });
}

function bridgeWith(calls, overrides = {}) {
    return new TaskSchedulerBridge(Object.assign(
        { execFileFn: fakeExecFileImpl(calls), exePath: 'C:\\App\\Power Pilot.exe', isStoreApp: false },
        overrides
    ));
}

function timedTask(overrides = {}) {
    return Object.assign({
        id: 'task_abc123', enabled: true, status: 'scheduled',
        trigger: { type: 'duration', durationMs: 3600000, targetTime: Date.now() + 3600000 }
    }, overrides);
}

describe('paketlenmemiş electron.exe koruması', () => {
    it('ham electron.exe (dev/E2E) ile Windows Görev Zamanlayıcıya kayıt yazmaz', async () => {
        const calls = [];
        const b = bridgeWith(calls, {
            exePath: 'D:\\SOFTWARE DEVELOPMENT\\Tools\\Power_Pilot\\node_modules\\electron\\dist\\electron.exe'
        });
        expect(b.isSupported()).toBe(false);
        expect(b.shouldSync(timedTask())).toBe(false);
        const res = await b.syncTask(timedTask());
        expect(res).toBe(false);
        expect(calls).toHaveLength(0);
    });
});

describe('removeAllTasks — sahipsiz kayıt temizliği (P1)', () => {
    it('yalnızca \\PowerPilot klasöründeki görevleri siler, başkalarına dokunmaz', async () => {
        const calls = [];
        const queryOutput = [
            '"\\PowerPilot\\task_aaa","19.11.2026 09:00:00","Ready"',
            '"\\PowerPilot\\task_bbb","19.11.2026 09:05:00","Ready"',
            '"\\Microsoft\\Windows\\Defrag\\ScheduledDefrag","N/A","Ready"',
            '"" ,"N/A","Ready"'
        ].join('\r\n');
        const bridge = new TaskSchedulerBridge({
            exePath: 'C:\\App\\Power Pilot.exe',
            isStoreApp: false,
            execFileFn: vi.fn((file, args, options, cb) => {
                calls.push(args);
                if (args[0] === '/query') cb(null, queryOutput, '');
                else cb(null, 'SUCCESS', '');
            })
        });
        const result = await bridge.removeAllTasks();
        expect(result).toEqual({ removed: 2, failed: 0 });
        const deletes = calls.filter((a) => a[0] === '/delete');
        expect(deletes).toHaveLength(2);
        expect(deletes.map((a) => a[2])).toEqual(['\\PowerPilot\\task_aaa', '\\PowerPilot\\task_bbb']);
    });

    it('Store sürümünde schtasks hiç çağrılmaz', async () => {
        const calls = [];
        const bridge = bridgeWith(calls, { isStoreApp: true });
        expect(await bridge.removeAllTasks()).toEqual({ removed: 0, failed: 0 });
        expect(calls).toHaveLength(0);
    });

    it('sorgu başarısızsa sessizce boş döner (uygulama hattı durmaz)', async () => {
        const calls = [];
        const bridge = new TaskSchedulerBridge({
            exePath: 'C:\\App\\Power Pilot.exe',
            isStoreApp: false,
            execFileFn: fakeExecFileImpl(calls, { fail: true })
        });
        expect(await bridge.removeAllTasks()).toEqual({ removed: 0, failed: 0 });
    });
});

describe('TaskSchedulerBridge statik yardımcılar', () => {
    it('parseRunTaskArgv bayrağı çözer', () => {
        expect(TaskSchedulerBridge.parseRunTaskArgv(['app.exe', '--run-task=task_1'])).toBe('task_1');
        expect(TaskSchedulerBridge.parseRunTaskArgv(['app.exe'])).toBeNull();
        expect(TaskSchedulerBridge.parseRunTaskArgv(['app.exe', '--run-task='])).toBeNull();
    });

    it('sanitize güvensiz karakterleri temizler', () => {
        expect(TaskSchedulerBridge.sanitizeTaskId('a/b\\c:d e')).toBe('a_b_c_d_e');
        expect(TaskSchedulerBridge.taskName('task_1')).toBe('PowerPilot\\task_1');
    });

    it('formatTriggerDate yerel ISO 8601 + HH:mm üretir (yerel ayardan bağımsız)', () => {
        const target = new Date(2026, 5, 9, 8, 5).getTime(); // 9 Haz 2026 08:05 yerel
        const { iso, time } = TaskSchedulerBridge.formatTriggerDate(target);
        expect(iso).toBe('2026-06-09T08:05:00');
        expect(time).toBe('08:05');
    });

    it('formatTriggerDate saniyeleri bir sonraki dakikaya yuvarlar (O-13)', () => {
        const target = new Date(2026, 5, 9, 8, 5, 30).getTime();
        expect(TaskSchedulerBridge.formatTriggerDate(target).iso).toBe('2026-06-09T08:06:00');
    });
});

describe('TaskSchedulerBridge kayıt/silme', () => {
    it('geçerli görev ONCE kaydı üretir (argüman dizisi, kabuk yok)', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        const ok = await bridge.syncTask(timedTask());
        expect(ok).toBe(true);
        expect(calls).toHaveLength(1);
        const { file, args, options } = calls[0];
        expect(file).toBe('schtasks.exe');
        expect(Array.isArray(args)).toBe(true);
        expect(args.slice(0, 3)).toEqual(['/create', '/tn', 'PowerPilot\\task_abc123']);
        expect(args[3]).toBe('/xml');
        expect(String(args[4])).toMatch(/pp-task-task_abc123-.*\.xml$/);
        expect(args).toContain('/f');
        expect(options.windowsHide).toBe(true);
        expect(options.shell).toBeUndefined();
        expect(typeof options.timeout).toBe('number');
        expect(options.timeout).toBeGreaterThan(0);
        // Yerel ayara bağımlı /sd, /st, /tr, /sc, /rl bayrakları artık yok.
        expect(args).not.toContain('/sd');
        expect(args).not.toContain('/st');
        expect(args).not.toContain('/tr');
        // Geçici tanım dosyası iş bitince silinir.
        expect(fs.existsSync(args[4])).toBe(false);
    });

    it('Store uygulamasında kayıt yapılmaz', async () => {
        const calls = [];
        const bridge = bridgeWith(calls, { isStoreApp: true });
        expect(bridge.isSupported()).toBe(false);
        expect(await bridge.syncTask(timedTask())).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('60sn altı hedef kaydedilmez', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        expect(await bridge.syncTask(timedTask({ trigger: { type: 'duration', targetTime: Date.now() + 10000 } }))).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('devre dışı görev kaydedilmez', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        expect(await bridge.syncTask(timedTask({ enabled: false }))).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('schtasks hatası false döner, fırlatmaz', async () => {
        const calls = [];
        const bridge = new TaskSchedulerBridge({
            execFileFn: fakeExecFileImpl(calls, { fail: true }),
            exePath: 'C:\\App\\Power Pilot.exe',
            isStoreApp: false
        });
        expect(await bridge.syncTask(timedTask())).toBe(false);
        expect(calls).toHaveLength(1);
    });

    it('removeTask /delete /tn ... /f argümanları üretir', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        expect(await bridge.removeTask('task_abc123')).toBe(true);
        expect(calls[0].file).toBe('schtasks.exe');
        expect(calls[0].args).toEqual(['/delete', '/tn', 'PowerPilot\\task_abc123', '/f']);
    });

    it('exe yolu yoksa desteklenmez', () => {
        expect(new TaskSchedulerBridge({ exePath: '' }).isSupported()).toBe(false);
    });
});

describe('WP-05 güvenlik kabul testleri (T-SCH-01..04)', () => {
    it('T-SCH-01 zararlı kimlik reddedilir; schtasks çağrılmaz', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        const malicious = 'x" & calc.exe & "';
        expect(TaskSchedulerBridge.isValidTaskId(malicious)).toBe(false);
        expect(await bridge.syncTask(timedTask({ id: malicious }))).toBe(false);
        expect(calls).toHaveLength(0);
        expect(() => bridge.buildCreateArgs(timedTask({ id: malicious }))).toThrow(/Geçersiz görev kimliği/);
    });

    it('T-SCH-02 geçerli görev args dizisini birebir üretir', () => {
        const bridge = bridgeWith([]);
        const target = new Date(2026, 5, 9, 8, 5).getTime();
        const args = bridge.buildCreateArgs(
            timedTask({ trigger: { type: 'duration', targetTime: target } }),
            'C:\\Temp\\pp-task.xml'
        );
        expect(args).toEqual([
            '/create', '/tn', 'PowerPilot\\task_abc123',
            '/xml', 'C:\\Temp\\pp-task.xml',
            '/f'
        ]);
        // Kabuk yorumlanabilecek tek birleşik komut string'i yoktur.
        expect(args.every(a => typeof a === 'string')).toBe(true);
    });

    it('buildXml yerel ayardan bağımsız ISO 8601 + pil/uyku politikası içerir', () => {
        const bridge = bridgeWith([]);
        const target = new Date(2026, 5, 9, 8, 5).getTime();
        const xml = TaskSchedulerBridge.buildXml(
            timedTask({ trigger: { type: 'duration', targetTime: target } }),
            'C:\\Program Files\\Power Pilot\\Power Pilot.exe'
        );
        expect(xml).toContain('<StartBoundary>2026-06-09T08:05:00</StartBoundary>');
        expect(xml).not.toMatch(/\d{2}\/\d{2}\/\d{4}/); // eski yerel tarih biçimi yok
        expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
        expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
        expect(xml).toContain('--run-task=task_abc123');
        expect(xml).toContain('C:\\Program Files\\Power Pilot\\Power Pilot.exe');
    });

    it('buildXml XML özel karakterlerini kaçırır', () => {
        const bridge = new TaskSchedulerBridge({
            execFileFn: fakeExecFileImpl([]),
            exePath: 'C:\\A & B\\<app>.exe',
            isStoreApp: false
        });
        const xml = TaskSchedulerBridge.buildXml(timedTask(), bridge.exePath);
        expect(xml).toContain('C:\\A &amp; B\\&lt;app&gt;.exe');
    });

    it('T-SCH-03 65 karakter, boşluk ve Unicode kimlikler reddedilir', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        const bad = ['a'.repeat(65), 'task with space', 'görev_çalıştır'];
        for (const id of bad) {
            expect(TaskSchedulerBridge.isValidTaskId(id)).toBe(false);
            expect(await bridge.removeTask(id)).toBe(false);
        }
        expect(TaskSchedulerBridge.isValidTaskId('a'.repeat(64))).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it('T-SCH-04 monitoring görev Windows\'a yazılmaz', async () => {
        const calls = [];
        const bridge = bridgeWith(calls);
        const monitoring = timedTask({
            status: 'monitoring',
            conditionGroup: { operator: 'AND', conditions: [{ type: 'process_running', processName: 'x' }] }
        });
        expect(bridge.shouldSync(monitoring)).toBe(false);
        expect(await bridge.syncTask(monitoring)).toBe(false);
        expect(calls).toHaveLength(0);
    });

    it('koşullu scheduled görev de yazılmaz (ikinci savunma)', () => {
        const bridge = bridgeWith([]);
        expect(bridge.shouldSync(timedTask({
            conditionGroup: { operator: 'AND', conditions: [{ type: 'process_running', processName: 'x' }] }
        }))).toBe(false);
    });

    it('notBefore gelecekteyse kayıt ertelenir; süre dolunca yazılır', () => {
        const now = Date.now();
        const bridge = new TaskSchedulerBridge({
            execFileFn: fakeExecFileImpl([]),
            exePath: 'C:\\App\\Power Pilot.exe',
            nowFn: () => now
        });
        expect(bridge.shouldSync(timedTask({ trigger: { type: 'duration', targetTime: now + 3600000, notBefore: now + 60000 } }))).toBe(false);
        expect(bridge.shouldSync(timedTask({ trigger: { type: 'duration', targetTime: now + 3600000, notBefore: now - 1000 } }))).toBe(true);
    });
});

describe('forwardRunTask — second-instance iletimi (P0-2)', () => {
    it('Chromium bayrakları arasından id bulunur ve çalıştırılır', () => {
        const runTaskNow = vi.fn(() => true);
        const removeTask = vi.fn(async () => true);
        const argv = [
            'C:\\App\\Power Pilot.exe',
            '--allow-file-access-from-files',
            '--run-task=task_x1',
            '--original-process-start-time=13213718723637733'
        ];
        expect(TaskSchedulerBridge.forwardRunTask(argv, { runTaskNow, schedulerBridge: { removeTask } })).toBe('task_x1');
        expect(runTaskNow).toHaveBeenCalledWith('task_x1');
        expect(removeTask).toHaveBeenCalledWith('task_x1');
    });

    it('bayrak yoksa null döner, hiçbir şey çağrılmaz', () => {
        const runTaskNow = vi.fn();
        expect(TaskSchedulerBridge.forwardRunTask(['C:\\App\\a.exe'], { runTaskNow })).toBeNull();
        expect(runTaskNow).not.toHaveBeenCalled();
    });

    it('taskManager yoksa veya runTaskNow yoksa null döner (crash yok)', () => {
        expect(TaskSchedulerBridge.forwardRunTask(['--run-task=t'], null)).toBeNull();
        expect(TaskSchedulerBridge.forwardRunTask(['--run-task=t'], {})).toBeNull();
        expect(TaskSchedulerBridge.forwardRunTask(null, { runTaskNow: vi.fn() })).toBeNull();
    });

    it('runTaskNow fırlatsa bile null dönmez, odak engellenmez', () => {
        const runTaskNow = vi.fn(() => { throw new Error('x'); });
        expect(TaskSchedulerBridge.forwardRunTask(['--run-task=t'], { runTaskNow })).toBe('t');
    });
});

describe('TaskManager scheduler bağlantısı (TS-2.2)', () => {
    function spawn(deps = {}) {
        const storage = Object.assign(
            { getTasks: () => [], saveTask: vi.fn(), deleteTask: vi.fn(), getSettings: () => ({}), updateSettings: vi.fn() },
            deps.storage
        );
        const d = {
            storage,
            warning: null,
            safety: { evaluate: async () => ({ allowed: true }) },
            history: { record: vi.fn() },
            webhook: { triggerEvent: vi.fn() },
            power: { execute: vi.fn(async () => ({ success: true })) }
        };
        const collector = { getMetrics: () => ({ stale: false, cpuUsagePercent: 1 }) };
        const tm = new TaskManager(d.storage, d.warning, d.safety, d.history, d.webhook, new SmartFinishEngine(collector), collector, d.power);
        tm.schedulerBridge = {
            syncTask: vi.fn(async () => true),
            removeTask: vi.fn(async () => true)
        };
        return { tm, d };
    }
    const flush = () => new Promise((r) => setImmediate(r));
    const stop = (tm) => { if (tm.loopInterval) clearInterval(tm.loopInterval); };

    it('createTask zamanlanmış görevi köprüye bildirir', () => {
        const { tm } = spawn();
        tm.createTask({ name: 'X', action: 'shutdown', trigger: { type: 'duration', durationMs: 3600000 } });
        expect(tm.schedulerBridge.syncTask).toHaveBeenCalledTimes(1);
        stop(tm);
    });

    it('cancelTask kaydı sildirir', () => {
        const { tm } = spawn();
        const task = tm.createTask({ name: 'X', action: 'shutdown', trigger: { type: 'duration', durationMs: 3600000 } });
        tm.cancelTask(task.id);
        expect(tm.schedulerBridge.removeTask).toHaveBeenCalledWith(task.id);
        stop(tm);
    });

    it('runTaskNow EXPIRED görevi boru hattından çalıştırır', async () => {
        const { tm, d } = spawn();
        const task = tm.createTask({
            name: 'Vadesi', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.status = 'expired'; // uygulama kapalıyken vade dolmuş
        expect(tm.runTaskNow(task.id)).toBe(true);
        await flush(); await flush();
        expect(d.power.execute).toHaveBeenCalledWith('shutdown', expect.anything());
        stop(tm);
    });

    it('runTaskNow bilinmeyen görevde false döner', () => {
        const { tm } = spawn();
        expect(tm.runTaskNow('yok')).toBe(false);
        stop(tm);
    });

    it('runTaskNow kalıcı duraklatmada reddedilir', async () => {
        const { tm, d } = spawn({ storage: { getSettings: () => ({ automationPaused: true }) } });
        expect(tm.pausedAll).toBe(true);
        const task = tm.createTask({
            name: 'V', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.trigger.targetTime = Date.now() - 10;
        expect(tm.runTaskNow(task.id)).toBe(false);
        await flush();
        expect(d.power.execute).not.toHaveBeenCalled();
        stop(tm);
    });

    it('togglePauseAll kalıcı bayrağı yazar', () => {
        const { tm, d } = spawn();
        expect(tm.togglePauseAll()).toBe(true);
        expect(d.storage.updateSettings).toHaveBeenCalledWith({ automationPaused: true });
        expect(tm.togglePauseAll()).toBe(false);
        expect(d.storage.updateSettings).toHaveBeenCalledWith({ automationPaused: false });
        stop(tm);
    });

    it('başarılı çalıştırma kaydı sildirir', async () => {
        const { tm } = spawn();
        const task = tm.createTask({
            name: 'V', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 1000 },
            warningConfig: { enabled: false }
        });
        task.trigger.targetTime = Date.now() - 10;
        tm.evaluateTasks();
        await flush(); await flush();
        expect(tm.schedulerBridge.removeTask).toHaveBeenCalledWith(task.id);
        stop(tm);
    });

    it('createTask istemciden gelen id\'yi yok sayar (ADR-08)', () => {
        const { tm } = spawn();
        const task = tm.createTask({
            id: 'x" & calc.exe & "',
            name: 'X', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 3600000 }
        });
        expect(task.id).not.toBe('x" & calc.exe & "');
        expect(TaskSchedulerBridge.isValidTaskId(task.id)).toBe(true);
        expect(tm.tasks).toHaveLength(1);
        stop(tm);
    });

    it('validateTaskData istemci id\'sini reddeder; validateTaskId deseni uygular', () => {
        expect(validateTaskData({ id: 'task_custom', action: 'shutdown' })).toMatchObject({ ok: false, code: 'INVALID_TASK_ID' });
        expect(validateTaskData({ action: 'shutdown' }).ok).toBe(true);
        expect(validateTaskId('task_abc123').ok).toBe(true);
        expect(validateTaskId('x" & calc.exe & "').code).toBe('INVALID_TASK_ID');
        expect(validateTaskId('a'.repeat(65)).code).toBe('INVALID_TASK_ID');
        expect(validateTaskId('görev').code).toBe('INVALID_TASK_ID');
    });
});
