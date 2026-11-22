/**
 * metric-collector-wp13.test.mjs - WP-13.T3/T4
 * 5 sn tick, _sampling kilidi, allSettled + 4 sn timeout, stale, diskIops.
 */
import { describe, it, expect } from 'vitest';
import MetricCollector from '../../src/main/services/monitors/MetricCollector.js';

function makeCollector(overrides = {}) {
    const mc = new MetricCollector({
        sampleIntervalMs: 600000,
        sampleTimeoutMs: 4000,
        needsProcessList: () => false,
        ...overrides
    });
    mc.stopSampling();
    mc.sampleNetwork = async () => {};
    mc.sampleDisks = async () => { mc.currentMetrics.diskIops = 17; };
    mc.sampleBattery = async () => {};
    mc.sampleIdle = async () => { mc.currentMetrics.userIdleSeconds = 3; };
    mc.sampleProcesses = async () => {};
    return mc;
}

const tick = () => new Promise((r) => setImmediate(r));

describe('MetricCollector WP-13', () => {
    it('yavaş ölçümde üst üste tick çalışmaz', async () => {
        const mc = makeCollector({ sampleTimeoutMs: 40 });
        mc.sampleNetwork = () => new Promise((r) => setTimeout(r, 120));
        const first = mc.sampleOnce();
        const second = await mc.sampleOnce();
        expect(second).toBe(false);
        const firstResult = await first;
        expect(firstResult).toBe(true);
        expect(mc._sampling).toBe(false);
        expect(mc.currentMetrics.stale).toBe(true); // timeout → stale
    });

    it('Promise.allSettled bir alt ölçüm patlasa da tick’i tamamlar', async () => {
        const mc = makeCollector();
        mc.sampleDisks = async () => { throw new Error('disk yok'); };
        await mc.sampleOnce();
        expect(mc._sampling).toBe(false);
        expect(mc.currentMetrics.stale).toBe(true);
    });

    it('ilk iki örnek stale, üçüncü taze; diskIops korunur', async () => {
        const mc = makeCollector();
        await mc.sampleOnce();
        expect(mc.currentMetrics.stale).toBe(true);
        await mc.sampleOnce();
        expect(mc.currentMetrics.stale).toBe(true);
        await mc.sampleOnce();
        expect(mc.currentMetrics.stale).toBe(false);
        expect(mc.currentMetrics.diskIops).toBe(17);
        expect(mc.currentMetrics).not.toHaveProperty('diskReadWriteKbps');
    });

    /**
     * P1-6 (dördüncü tur): ESKİ SÖZLEŞME YANLIŞTI.
     *
     * Bu test "timeout tetiklendi ama alt iş bitene kadar `_sampling` kapalı
     * kalır" diyordu. Bu, 4 sn'lik sınırın hiçbir şeyi sınırlamaması demekti:
     * örnekleyici fiilen en yavaş OS çağrısı hızında çalışıyordu (ölçüm: tek
     * örnek 27 sn) ve metrikler kalıcı stale kalıyordu.
     *
     * Doğru sözleşme: timeout TICK'i bitirir (`_sampling` açılır), üst üste
     * OS çağrısı ise kaynak bazlı uçuş kaydıyla engellenir. Yani çağrı
     * çakışması yok, bloklama da yok.
     */
    it('timeout tick\'i bitirir; uçuştaki kaynak için yeni çağrı başlamaz', async () => {
        const mc = makeCollector({ sampleTimeoutMs: 20 });
        let calls = 0;
        let release;
        mc.sampleNetwork = () => {
            calls += 1;
            return new Promise((resolve) => { release = resolve; });
        };

        const started = Date.now();
        const first = mc.sampleOnce();
        await new Promise((r) => setTimeout(r, 80));

        // Timeout bağladı: tick bitti, kilit açık.
        expect(await first).toBe(true);
        expect(mc._sampling).toBe(false);
        expect(mc.currentMetrics.stale).toBe(true);

        // Uçuştaki kaynak yeniden başlatılmaz (üst üste WMI/PowerShell yok).
        await mc.sampleOnce();
        expect(calls).toBe(1);

        // Kaynak çözülünce yeniden örneklenir.
        release();
        await new Promise((r) => setTimeout(r, 20));
        await mc.sampleOnce();
        expect(calls).toBe(2);
        expect(Date.now() - started).toBeLessThan(2000);
    });

    it('varsayılan tick 5000 ms', () => {
        const mc = new MetricCollector({ needsProcessList: () => false });
        mc.stopSampling();
        expect(mc.sampleIntervalMs).toBe(5000);
        expect(mc.batteryIntervalMs).toBe(30000);
    });
});
