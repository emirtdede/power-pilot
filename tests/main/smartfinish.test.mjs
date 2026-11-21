/**
 * smartfinish.test.mjs — WBS-0.1 / WBS-1.1 / WBS-1.2
 * SmartFinishEngine: 7 koşul + stabilite + stale-guard + desteksiz-tip throw.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';

function freshMetrics(overrides = {}) {
    return Object.assign({
        cpuUsagePercent: 5,
        networkDownloadKbps: 10,
        networkUploadKbps: 5,
        diskIops: 20,
        userIdleSeconds: 400,
        batteryLevelPercent: 80,
        isCharging: false,
        batterySupported: true,
        runningProcesses: ['steam.exe', 'code.exe'],
        stale: false,
        sampledAt: new Date().toISOString()
    }, overrides);
}

function collectorWith(metrics) {
    return { getMetrics: () => metrics };
}

function taskWith(conditions, operator = 'AND', stabilitySeconds = 15, id = 'task_sf_test') {
    return { id, conditionGroup: { operator, stabilitySeconds, conditions } };
}

describe('SmartFinishEngine koşullar', () => {
    let engine;
    beforeEach(() => {
        engine = new SmartFinishEngine(collectorWith(freshMetrics()));
        // Y-11 testte tarama throttle'ı kapatılır; dosya değişimi hemen görülür.
        engine.directoryScanIntervalMs = 0;
    });

    it('stale metrikle ASLA tetiklenmez (WBS-1.1)', () => {
        engine.collector = collectorWith(freshMetrics({ stale: true }));
        const r = engine.evaluateTask(taskWith([{ type: 'cpu_usage', thresholdPercent: 90 }]));
        expect(r.satisfied).toBe(false);
        expect(r.progressMessage).toMatch(/ısın/i);
    });

    it('PROCESS_RUNNING triggerOnClose: kapanınca satisfied', () => {
        const r = engine.evaluateSingleCondition(
            { type: 'process_running', processName: 'HandBrake.exe', triggerOnClose: true },
            freshMetrics({ runningProcesses: ['code.exe'] })
        );
        expect(r.satisfied).toBe(true);
    });

    it('CPU_USAGE eşik altı satisfied', () => {
        const r = engine.evaluateSingleCondition({ type: 'cpu_usage', thresholdPercent: 10 }, freshMetrics({ cpuUsagePercent: 4 }));
        expect(r.satisfied).toBe(true);
    });

    it('USER_IDLE hedef üstü satisfied', () => {
        const r = engine.evaluateSingleCondition({ type: 'user_idle', idleSeconds: 300 }, freshMetrics({ userIdleSeconds: 900 }));
        expect(r.satisfied).toBe(true);
    });

    it('NETWORK_SPEED toplam eşik altı satisfied (TS-0.1)', () => {
        const r = engine.evaluateSingleCondition(
            { type: 'network_speed', thresholdKbps: 50 },
            freshMetrics({ networkDownloadKbps: 10, networkUploadKbps: 5 })
        );
        expect(r.satisfied).toBe(true);
    });

    it('NETWORK_SPEED spike durumunda satisfied değil', () => {
        const r = engine.evaluateSingleCondition(
            { type: 'network_speed', thresholdKbps: 50 },
            freshMetrics({ networkDownloadKbps: 5000, networkUploadKbps: 100 })
        );
        expect(r.satisfied).toBe(false);
    });

    it('DISK_ACTIVITY eşik altı satisfied', () => {
        const r = engine.evaluateSingleCondition({ type: 'disk_activity', thresholdKbps: 100 }, freshMetrics({ diskKbps: 10 }));
        expect(r.satisfied).toBe(true);
    });

    it('DISK_ACTIVITY disk tam yükteyken eşik üstü satisfied DEĞİL (KB/sn ↔ IOPS karışıklığı regresyonu)', () => {
        // Eski kod `thresholdKbps`'i IOPS sanıyordu: 500 KB/sn eşiği, 900 IOPS
        // yapan dolu bir diskte "boş" sayılabiliyordu.
        const r = engine.evaluateSingleCondition({ type: 'disk_activity', thresholdKbps: 100 }, freshMetrics({ diskKbps: 9000, diskIops: 900 }));
        expect(r.satisfied).toBe(false);
    });

    it('DISK_ACTIVITY verim ölçülemiyorsa fail-closed (erken kapatma yok)', () => {
        const r = engine.evaluateSingleCondition({ type: 'disk_activity', thresholdKbps: 100 }, freshMetrics({ diskKbps: undefined }));
        expect(r.satisfied).toBe(false);
    });

    it('BATTERY_LEVEL belowPercent satisfied', () => {
        const r = engine.evaluateSingleCondition({ type: 'battery_level', belowPercent: 20 }, freshMetrics({ batteryLevelPercent: 15 }));
        expect(r.satisfied).toBe(true);
    });

    it('BATTERY_LEVEL sensör yoksa asla satisfied değil', () => {
        const r = engine.evaluateSingleCondition(
            { type: 'battery_level', belowPercent: 99 },
            freshMetrics({ batterySupported: false, batteryLevelPercent: null })
        );
        expect(r.satisfied).toBe(false);
    });

    it('FILE_STABLE iki örnek aynı imzayı görünce satisfied olur', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-'));
        const oldFile = path.join(dir, 'old.bin');
        fs.writeFileSync(oldFile, 'x');
        const cond = { type: 'file_stable', filePath: oldFile, stableSeconds: 60 };

        // İlk örnek yalnızca imzayı kaydeder; hemen satisfied olmaz.
        const first = engine.evaluateSingleCondition(cond, freshMetrics(), 'task_file_old');
        expect(first.satisfied).toBe(false);
        expect(engine.fileSamples.has('task_file_old')).toBe(true);

        // Örnek başlangıcını geriye al → süre dolmuş sayılır.
        engine.fileSamples.get('task_file_old').since -= 61000;
        const rOld = engine.evaluateSingleCondition(cond, freshMetrics(), 'task_file_old');
        expect(rOld.satisfied).toBe(true);

        // İçerik değişirse imza değişir → yeniden bekleme.
        fs.appendFileSync(oldFile, 'y');
        const changed = engine.evaluateSingleCondition(cond, freshMetrics(), 'task_file_old');
        expect(changed.satisfied).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('O-03: aynı görevde iki FILE_STABLE koşulu ayrı örnek anahtarı kullanır', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-multi-'));
        const a = path.join(dir, 'a.bin');
        const b = path.join(dir, 'b.bin');
        fs.writeFileSync(a, 'a');
        fs.writeFileSync(b, 'b');
        const r = engine.evaluateTask({
            id: 'task_multi',
            conditionGroup: {
                operator: 'AND',
                stabilitySeconds: 0,
                conditions: [
                    { type: 'file_stable', filePath: a, stableSeconds: 60 },
                    { type: 'file_stable', filePath: b, stableSeconds: 60 }
                ]
            }
        });
        expect(r.satisfied).toBe(false);
        expect(engine.fileSamples.has('task_multi:0')).toBe(true);
        expect(engine.fileSamples.has('task_multi:1')).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('FILE_STABLE klasörü, kısmi dosyayı ve symlink\'i reddeder (WP-07.T1)', () => {        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-'));
        const partial = path.join(dir, 'video.mp4.crdownload');
        fs.writeFileSync(partial, 'x');
        const rDir = engine.evaluateSingleCondition({ type: 'file_stable', filePath: dir, stableSeconds: 60 }, freshMetrics(), 't_dir');
        expect(rDir.satisfied).toBe(false);
        expect(rDir.message).toMatch(/NOT_A_FILE/);
        const rPartial = engine.evaluateSingleCondition({ type: 'file_stable', filePath: partial, stableSeconds: 60 }, freshMetrics(), 't_part');
        expect(rPartial.satisfied).toBe(false);
        expect(rPartial.message).toMatch(/Kısmi/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('DIRECTORY_IDLE içerik sabitken satisfied; kısmi dosya varken değil (WP-07.T2)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-'));
        fs.writeFileSync(path.join(dir, 'a.bin'), 'aaa');
        fs.writeFileSync(path.join(dir, 'b.bin'), 'bbb');
        const cond = { type: 'directory_idle', dirPath: dir, stableSeconds: 300 };

        expect(engine.evaluateSingleCondition(cond, freshMetrics(), 'task_dir').satisfied).toBe(false);
        engine.directorySamples.get('task_dir').since -= 301000;
        const stable = engine.evaluateSingleCondition(cond, freshMetrics(), 'task_dir');
        expect(stable.satisfied).toBe(true);
        expect(stable.message).toMatch(/2 dosya/);

        fs.writeFileSync(path.join(dir, 'c.bin.part'), 'x');
        const partial = engine.evaluateSingleCondition(cond, freshMetrics(), 'task_dir');
        expect(partial.satisfied).toBe(false);
        expect(partial.message).toMatch(/Kısmi/);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('DIRECTORY_IDLE boş klasörü sabit saymaz', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sf-empty-'));
        const r = engine.evaluateSingleCondition({ type: 'directory_idle', dirPath: dir, stableSeconds: 300 }, freshMetrics(), 'task_empty');
        expect(r.satisfied).toBe(false);
        expect(r.message).toMatch(/boş/i);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('desteksiz tip throw fırlatır (sessiz geçiş yok, WBS-1.2)', () => {
        expect(() => engine.evaluateSingleCondition({ type: 'file_event' }, freshMetrics())).toThrow(/Desteklenmeyen koşul/);
    });

    it('AND: biri false ise grup false; OR: biri true ise grup true', () => {
        const andTask = taskWith([{ type: 'cpu_usage', thresholdPercent: 90 }, { type: 'network_speed', thresholdKbps: 1 }], 'AND', 0, 'task_sf_and');
        const orTask = taskWith([{ type: 'cpu_usage', thresholdPercent: 90 }, { type: 'network_speed', thresholdKbps: 1 }], 'OR', 0, 'task_sf_or');
        // stabilitySeconds=0 ile ikinci çağrıda satisfied beklenir — önce tracker kurulsun:
        engine.evaluateTask(andTask);
        engine.stabilityTrackers.set(andTask.id, Date.now() - 1000);
        // andTask koşulları: cpu true, network false → grup false
        expect(engine.evaluateTask(andTask).satisfied).toBe(false);
        engine.evaluateTask(orTask);
        engine.stabilityTrackers.set(orTask.id, Date.now() - 1000);
        expect(engine.evaluateTask(orTask).satisfied).toBe(true);
    });

    it('stabilite: ilk true kurar, süre dolmadan satisfied dönmez (TS-0.1 spike senaryosu)', () => {
        const t = taskWith([{ type: 'cpu_usage', thresholdPercent: 90 }], 'AND', 60);
        const first = engine.evaluateTask(t);
        expect(first.satisfied).toBe(false);
        expect(first.progressMessage).toMatch(/kararlılık/i);
        // Spike: koşul bozulunca tracker silinir
        engine.collector = collectorWith(freshMetrics({ cpuUsagePercent: 99 }));
        const broken = engine.evaluateTask(t);
        expect(broken.satisfied).toBe(false);
        expect(engine.stabilityTrackers.has(t.id)).toBe(false);
    });
});
