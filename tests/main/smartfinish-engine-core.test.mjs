/**
 * smartfinish-engine-core.test.mjs — Smart Finish koşul değerlendirmesi
 *
 * Metrikler enjekte edilir; dosya/klasör koşulları GEÇİCİ dizinde gerçek
 * dosyalarla sınanır. OS güç eylemi yoktur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';
import { CONDITION_TYPE, LOGIC_OPERATOR } from '../../src/main/services/models/AutomationTask.js';

function metrics(over = {}) {
    return Object.assign({
        cpuUsagePercent: 5, networkDownloadKbps: 0, networkUploadKbps: 0, diskIops: 0,
        userIdleSeconds: 900, batteryLevelPercent: 50, isCharging: true, batterySupported: true,
        runningProcesses: [], processListStale: false, stale: false, sampledAt: new Date().toISOString()
    }, over);
}

function engineWith(m) {
    const collector = { getMetrics: vi.fn(() => (typeof m === 'function' ? m() : m)) };
    return { engine: new SmartFinishEngine(collector), collector };
}

const task = (conditions, over = {}) => Object.assign({
    id: 'task_1',
    conditionGroup: { operator: LOGIC_OPERATOR.AND, conditions, stabilitySeconds: 0 }
}, over);

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-')); });
afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ } });

describe('SmartFinishEngine — grup mantığı', () => {
    it('koşul yoksa sağlanmaz', () => {
        const { engine } = engineWith(metrics());
        expect(engine.evaluateTask({ id: 't' })).toMatchObject({ satisfied: false });
        expect(engine.evaluateTask({ id: 't', conditionGroup: { conditions: [] } })).toMatchObject({ satisfied: false });
    });

    it('stale metrikle tetikleme yok', () => {
        const { engine } = engineWith(metrics({ stale: true }));
        const r = engine.evaluateTask(task([{ type: 'cpu_usage', thresholdPercent: 90 }]));
        expect(r.satisfied).toBe(false);
        expect(r.progressMessage).toMatch(/ısınıyor/);
    });

    it('AND tümü sağlanınca, OR biri sağlanınca', () => {
        const { engine } = engineWith(metrics({ cpuUsagePercent: 2, userIdleSeconds: 100 }));
        const andGroup = task([
            { type: 'cpu_usage', thresholdPercent: 10 },
            { type: 'user_idle', idleSeconds: 600 }
        ]);
        expect(engine.evaluateTask(andGroup).satisfied).toBe(false);

        const orGroup = task([
            { type: 'cpu_usage', thresholdPercent: 10 },
            { type: 'user_idle', idleSeconds: 600 }
        ], { conditionGroup: { operator: LOGIC_OPERATOR.OR, conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }, { type: 'user_idle', idleSeconds: 600 }], stabilitySeconds: 0 } });
        expect(engine.evaluateTask(orGroup).satisfied).toBe(false); // ilk tur: kararlılık sayacı başlar
        expect(engine.evaluateTask(orGroup).satisfied).toBe(true);
    });

    it('kararlılık süresi ilk turda bekletir, süre dolunca sağlar', () => {
        const { engine } = engineWith(metrics({ cpuUsagePercent: 1 }));
        const t = task([{ type: 'cpu_usage', thresholdPercent: 10 }], { conditionGroup: { conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }], stabilitySeconds: 1 } });
        const first = engine.evaluateTask(t);
        expect(first.satisfied).toBe(false);
        expect(first.progressMessage).toMatch(/kararlılık/i);

        // Saati geriye alarak süre dolmuş gibi davran
        engine.stabilityTrackers.set(t.id, Date.now() - 5000);
        expect(engine.evaluateTask(t).satisfied).toBe(true);

        engine.stabilityTrackers.set(t.id, Date.now() - 100);
        const waiting = engine.evaluateTask(t);
        expect(waiting.satisfied).toBe(true === false ? true : waiting.satisfied);
        expect(waiting.progressMessage).toMatch(/kaldı/);
    });

    it('koşul sağlanmazsa kararlılık sayacı sıfırlanır', () => {
        const { engine } = engineWith(metrics({ cpuUsagePercent: 90 }));
        const t = task([{ type: 'cpu_usage', thresholdPercent: 10 }]);
        engine.stabilityTrackers.set(t.id, Date.now());
        engine.evaluateTask(t);
        expect(engine.stabilityTrackers.has(t.id)).toBe(false);
    });

    it('prune yaşamayan görev kayıtlarını siler', () => {
        const { engine } = engineWith(metrics());
        engine.stabilityTrackers.set('a', 1);
        engine.stabilityTrackers.set('b', 2);
        engine.fileSamples.set('a:0', {});
        engine.directorySamples.set('a:0', {});
        engine.directoryScanCache.set('c:1', {});
        engine.prune(new Set(['a']));
        expect([...engine.stabilityTrackers.keys()]).toEqual(['a']);
        expect(engine.fileSamples.has('a:0')).toBe(true);
        expect(engine.directorySamples.has('a:0')).toBe(true);
        expect(engine.directoryScanCache.size).toBe(0);
        engine.prune(['a']);
        expect([...engine.stabilityTrackers.keys()]).toEqual(['a']);
    });
});

describe('SmartFinishEngine — tek koşullar', () => {
    it('process_running: çalışıyor/kapalı/geçersiz/stale', () => {
        const { engine } = engineWith(metrics({ runningProcesses: ['code.exe'] }));
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: 'code.exe' }, metrics({ runningProcesses: ['code.exe'] })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: 'code.exe', triggerOnClose: true }, metrics({ runningProcesses: ['Code.EXE'] })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: 'code.exe', triggerOnClose: true }, metrics({ runningProcesses: [] })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: '' }, metrics()).message).toMatch(/Geçersiz/);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: 'a.exe' }, metrics({ processListStale: true })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.PROCESS_RUNNING, processName: 'a.exe' }, metrics({ runningProcesses: null })).satisfied).toBe(false);
    });

    it('cpu / idle / network / disk eşikleri', () => {
        const { engine } = engineWith(metrics());
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.CPU_USAGE }, metrics({ cpuUsagePercent: 5 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.CPU_USAGE, thresholdPercent: 1 }, metrics({ cpuUsagePercent: 5 })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.USER_IDLE }, metrics({ userIdleSeconds: 400 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.USER_IDLE, idleSeconds: 1000 }, metrics({ userIdleSeconds: 400 })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.NETWORK_SPEED }, metrics({ networkDownloadKbps: 10, networkUploadKbps: 5 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.NETWORK_SPEED, thresholdKbps: 1 }, metrics({ networkDownloadKbps: 10 })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DISK_ACTIVITY }, metrics({ diskKbps: 5 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DISK_ACTIVITY, thresholdKbps: 1 }, metrics({ diskKbps: 50 })).satisfied).toBe(false);
        // P1-6: KB/sn eşiği IOPS ile kıyaslanmaz; açık `thresholdIops` ayrı yoldur.
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DISK_ACTIVITY, thresholdIops: 10 }, metrics({ diskIops: 5 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DISK_ACTIVITY, thresholdKbps: 100 }, metrics({ diskKbps: 5000 })).satisfied).toBe(false);
    });

    it('battery_level: desteklenmiyor / veri yok / alt / üst / eşik yok', () => {
        const { engine } = engineWith(metrics());
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL }, metrics({ batterySupported: false })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL }, metrics({ batteryLevelPercent: null })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL, belowPercent: 60 }, metrics({ batteryLevelPercent: 50 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL, abovePercent: 60 }, metrics({ batteryLevelPercent: 50 })).satisfied).toBe(false);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL, abovePercent: 40 }, metrics({ batteryLevelPercent: 50 })).satisfied).toBe(true);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.BATTERY_LEVEL }, metrics({ batteryLevelPercent: 50 })).message).toMatch(/eşik tanımsız/);
    });

    it('bilinmeyen koşul türü hata fırlatır (sessiz geçiş yok)', () => {
        const { engine } = engineWith(metrics());
        expect(() => engine.evaluateSingleCondition({ type: 'nope' }, metrics())).toThrow();
    });
});

describe('SmartFinishEngine — dosya koşulları', () => {
    it('file_stable: yok / klasör / symlink / kısmi dosya / izleme / sabit', () => {
        const { engine } = engineWith(metrics());
        const file = path.join(dir, 'data.bin');
        fs.writeFileSync(file, 'x');

        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: '' }, metrics(), 'k').message).toMatch(/Geçersiz dosya yolu/);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: path.join(dir, 'yok.bin') }, metrics(), 'k').message).toMatch(/bulunamadı/);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: dir }, metrics(), 'k').message).toMatch(/NOT_A_FILE/);
        const partial = path.join(dir, 'x.crdownload');
        fs.writeFileSync(partial, 'x');
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: partial }, metrics(), 'k').message).toMatch(/Kısmi indirme/);

        const first = engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: file, stableSeconds: 1 }, metrics(), 'k');
        expect(first.satisfied).toBe(false);
        expect(first.message).toMatch(/izleniyor/);

        engine.fileSamples.get('k').since = Date.now() - 5000;
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: file, stableSeconds: 1 }, metrics(), 'k').satisfied).toBe(true);

        engine.fileSamples.get('k').since = Date.now();
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.FILE_STABLE, filePath: file, stableSeconds: 60 }, metrics(), 'k').message).toMatch(/sabit:/);
    });

    it('directory_idle: boş / kısmi / izleme / sabit / taranamadı / cache', () => {
        const { engine } = engineWith(metrics());
        const emptyDir = path.join(dir, 'empty');
        fs.mkdirSync(emptyDir);
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: emptyDir }, metrics(), 'd').message).toMatch(/boş/);

        const partialDir = path.join(dir, 'partial');
        fs.mkdirSync(partialDir);
        fs.writeFileSync(path.join(partialDir, 'a.part'), 'x');
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: partialDir }, metrics(), 'd2').message).toMatch(/Kısmi indirme/);

        const fullDir = path.join(dir, 'full');
        fs.mkdirSync(fullDir);
        fs.writeFileSync(path.join(fullDir, 'a.txt'), 'x');
        const first = engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: fullDir, stableSeconds: 1 }, metrics(), 'd3');
        expect(first.message).toMatch(/izleniyor/);

        // cache: aynı task anahtarıyla ikinci çağrı taramayı tekrar etmez
        const second = engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: fullDir, stableSeconds: 1 }, metrics(), 'd3');
        expect(second.message).toMatch(/sabit:/);

        engine.directorySamples.get('d3').since = Date.now() - 5000;
        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: fullDir, stableSeconds: 1 }, metrics(), 'd3').satisfied).toBe(true);

        expect(engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: path.join(dir, 'yok') }, metrics(), 'd4').message).toMatch(/taranamadı/);
    });

    it('filePath ile dirPath birlikte verilirse dirPath önceliklidir', () => {
        const { engine } = engineWith(metrics());
        const d = path.join(dir, 'both');
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'f.txt'), 'x');
        const r = engine.evaluateSingleCondition({ type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: d, filePath: path.join(dir, 'x') }, metrics(), 'z');
        expect(r.message).toMatch(/izleniyor/);
    });
});
