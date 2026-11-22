/**
 * metric-collector-core.test.mjs - MetricCollector (WBS-1.1 / WP-13.T3 / WP-16)
 *
 * Ağır OS sorguları (systeminformation/ps-list) YALNIZCA sağlayıcı
 * enjeksiyonuyla taklit edilir. Gerçek spawn yok; interval'ler unref'li ve
 * afterEach'te durdurulur.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import MetricCollector from '../../src/main/services/monitors/MetricCollector.js';

const fakeSi = (over = {}) => Object.assign({
    networkStats: async () => [{ iface: 'eth0', rx_sec: 125000, tx_sec: 62500 }],
    disksIO: async () => ({ rIO_sec: 3.4, wIO_sec: 6.6 }),
    battery: async () => ({ hasBattery: true, percent: 77, isCharging: true })
}, over);
const live = [];
function make(options = {}) {
    const mc = new MetricCollector(Object.assign({ sampleIntervalMs: 60000, sampleTimeoutMs: 5000, si: fakeSi() }, options));
    live.push(mc);
    return mc;
}
afterEach(() => {
    for (const mc of live.splice(0)) mc.stopSampling();
});

describe('MetricCollector - temel', () => {
    it('constructor güvenli (stale) metriklerle başlar', () => {
        const mc = make();
        const m = mc.getMetrics();
        expect(m.stale).toBe(true);
        expect(m.processListStale).toBe(true);
        expect(m.cpuUsagePercent).toBe(0);
        expect(Array.isArray(m.runningProcesses)).toBe(true);
        expect(m.batteryLevelPercent).toBeNull();
    });

    it('startSampling idempotent, stopSampling interval\'i temizler', () => {
        const mc = make();
        const first = mc.sampleInterval;
        mc.startSampling();
        expect(mc.sampleInterval).toBe(first);
        mc.stopSampling();
        expect(mc.sampleInterval).toBeNull();
        mc.stopSampling();
        expect(mc.sampleInterval).toBeNull();
    });

    it('getCpuTimes toplamı alt alanların toplamıdır', () => {
        const mc = make();
        const t = mc.getCpuTimes();
        expect(t.total).toBe(t.user + t.nice + t.sys + t.idle + t.irq);
        expect(t.total).toBeGreaterThan(0);
    });

    it('sampleCpu 0..100 aralığında değer üretir', () => {
        const mc = make();
        mc.sampleCpu();
        mc.sampleCpu();
        expect(mc.getMetrics().cpuUsagePercent).toBeGreaterThanOrEqual(0);
        expect(mc.getMetrics().cpuUsagePercent).toBeLessThanOrEqual(100);
    });
});

describe('MetricCollector - süreç örnekleme kapıları', () => {
    it('tüketici yoksa (needsProcessList=false) örneklemez', () => {
        const mc = make({ needsProcessList: () => false });
        expect(mc.shouldSampleProcesses()).toBe(false);
    });

    it('tüketici hata verirse spawn etmez', () => {
        const mc = make({ needsProcessList: () => { throw new Error('x'); } });
        expect(mc.shouldSampleProcesses()).toBe(false);
    });

    it('tüketici true + aralık dolmadıysa örneklemez', () => {
        let now = 1000;
        const mc = make({ needsProcessList: () => true, now: () => now, processSampleIntervalMs: 5000 });
        expect(mc.shouldSampleProcesses()).toBe(true);
        mc._lastProcessSampleAt = now;
        expect(mc.shouldSampleProcesses()).toBe(false);
        now += 6000;
        expect(mc.shouldSampleProcesses()).toBe(true);
    });

    it('needsProcessList verilmezse her zaman örnekler', () => {
        const mc = make();
        expect(mc.shouldSampleProcesses()).toBe(true);
    });

    it('getProcessList sağlayıcı dizisi döndürür, dizi olmayan null olur', async () => {
        const ok = make({ processProvider: async () => [{ name: 'a.exe' }] });
        expect(await ok.getProcessList()).toHaveLength(1);
        const bad = make({ processProvider: async () => 'nope' });
        expect(await bad.getProcessList()).toBeNull();
    });

    it('sampleProcesses kanonik isimleri tekilleştirir', async () => {
        const mc = make({ processProvider: async () => ['C:\\x\\Code.exe', { name: 'code.exe' }, { name: '' }, null] });
        await mc.sampleProcesses();
        expect(mc.getMetrics().runningProcesses).toEqual(['code']);
        expect(mc.getMetrics().processListStale).toBe(false);
        expect(mc.getMetrics().processListAt).toBeGreaterThan(0);
    });

    it('boş liste = sağlayıcı hatası → stale (yanlış "kapandı" tetiklemesi yok)', async () => {
        const mc = make({ processProvider: async () => [] });
        await mc.sampleProcesses();
        expect(mc.getMetrics().processListStale).toBe(true);
        expect(mc.getMetrics().runningProcesses).toEqual([]);
    });

    it('sağlayıcı fırlatırsa stale kalır', async () => {
        const mc = make({ processProvider: async () => { throw new Error('yok'); } });
        await mc.sampleProcesses();
        expect(mc.getMetrics().processListStale).toBe(true);
    });

    it('eşzamanlı örnekleme kilitlenir (_processListInFlight)', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const mc = make({ processProvider: async () => { await gate; return ['a.exe']; } });
        const first = mc.sampleProcesses();
        await mc.sampleProcesses(); // in-flight iken hemen döner
        release();
        await first;
        expect(mc.getMetrics().runningProcesses).toEqual(['a']);
        expect(mc._processListInFlight).toBe(false);
    });
});

describe('MetricCollector - idle/uyku', () => {
    it('idleProvider geçerli sayıyı floor\'lar', async () => {
        const mc = make({ idleProvider: async () => 42.7 });
        await mc.sampleIdle();
        expect(mc.getMetrics().userIdleSeconds).toBe(42);
    });

    it('idleProvider NaN/negatif → 0 (fail-closed)', async () => {
        const nan = make({ idleProvider: async () => Number.NaN });
        await nan.sampleIdle();
        expect(nan.getMetrics().userIdleSeconds).toBe(0);
        const neg = make({ idleProvider: async () => -5 });
        await neg.sampleIdle();
        expect(neg.getMetrics().userIdleSeconds).toBe(0);
    });

    it('powerMonitor sağlayıcısı kullanılır', async () => {
        const mc = make({ powerMonitor: { getSystemIdleTime: () => 12 } });
        await mc.sampleIdle();
        expect(mc.getMetrics().userIdleSeconds).toBe(12);
    });

    it('sağlayıcı hata verirse 0 ("kullanıcı aktif")', async () => {
        const mc = make({ idleProvider: async () => { throw new Error('x'); } });
        await mc.sampleIdle();
        expect(mc.getMetrics().userIdleSeconds).toBe(0);
    });

    it('sağlayıcı yoksa 0', async () => {
        const mc = make();
        await mc.sampleIdle();
        expect(mc.getMetrics().userIdleSeconds).toBe(0);
    });
});

describe('MetricCollector - zaman aşımı ve döngü', () => {
    it('withTimeout değeri iletir', async () => {
        const mc = make();
        await expect(mc.withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
    });

    it('withTimeout süre aşımında SAMPLE_TIMEOUT fırlatır', async () => {
        const mc = make();
        await expect(mc.withTimeout(new Promise(() => {}), 20)).rejects.toThrow('SAMPLE_TIMEOUT');
    });

    it('sampleOnce _sampling iken false döner', async () => {
        const mc = make();
        mc._sampling = true;
        await expect(mc.sampleOnce()).resolves.toBe(false);
        mc._sampling = false;
    });

    it('sampleOnce sağlayıcılarla tamamlanır ve stale bayrağını yönetir', async () => {
        let now = 0;
        const mc = make({
            now: () => now,
            needsProcessList: () => true,
            processProvider: async () => ['notepad.exe'],
            idleProvider: async () => 300,
            sampleTimeoutMs: 8000
        });
        now = 1;
        const ok = await mc.sampleOnce();
        expect(ok).toBe(true);
        expect(mc.sampleCount).toBe(1);
        expect(mc.getMetrics().stale).toBe(true); // ilk 2 örnek stale
        now = 2;
        await mc.sampleOnce();
        now = 3;
        await mc.sampleOnce();
        expect(mc.sampleCount).toBe(3);
        expect(mc.getMetrics().stale).toBe(false);
        expect(mc.getMetrics().runningProcesses).toEqual(['notepad']);
        expect(mc.getMetrics().userIdleSeconds).toBe(300);
        expect(mc._sampling).toBe(false);
    });

    it('tüketici yokken eski süreç listesi taze görünmez', async () => {
        const mc = make({ needsProcessList: () => false, processListMaxAgeMs: 10, now: () => 1_000_000 });
        mc.currentMetrics.processListStale = false;
        mc.currentMetrics.processListAt = 0;
        mc.currentMetrics.stale = false;
        await mc.sampleOnce();
        expect(mc.getMetrics().processListStale).toBe(true);
    });
});
