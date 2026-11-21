/**
 * metric.test.mjs — MetricCollector: metrik zarfı, stale ısınma kuralı,
 * timeout'un gerçekten bağlaması.
 *
 * DENETİM KUSURU (P1-6, dördüncü tur): `sampleOnce` içinde `await underlying`
 * vardı. Kaynaklardan biri (WMI/PowerShell tabanlı `disksIO`/`fsStats`)
 * yavaşladığında, 4 sn'lik `sampleTimeoutMs` sınırı yalnızca `stale`
 * bayrağını işaretliyordu; fonksiyon yavaş çağrı bitene kadar DÖNMÜYORDU
 * (bu makinede ölçüldü: tek örnek 27 sn). Sonuç: örnekleyici fiilen en yavaş
 * OS çağrısı hızında çalışıyor ve metrikler kalıcı `stale` kalıyordu — yani
 * ağ/disk koşullu Smart Finish görevleri hiç tetiklenmiyordu.
 *
 * Bu dosya artık:
 *  A) saf kural testlerini ENJEKTE sağlayıcılarla deterministik yapar
 *     (gerçek WMI süresine bağlı değil),
 *  B) asıl kusuru doğrudan yakalayan bir regresyon testi içerir: asılı bir
 *     sağlayıcı bile örneklemeyi timeout'tan fazla bloklayamaz.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import MetricCollector from '../../src/main/services/monitors/MetricCollector.js';

const live = [];
afterEach(() => { for (const mc of live.splice(0)) mc.stopSampling(); });

const fastSi = (over = {}) => Object.assign({
    networkStats: async () => [{ iface: 'eth0', rx_sec: 125000, tx_sec: 62500 }],
    disksIO: async () => ({ rIO_sec: 3.4, wIO_sec: 6.6 }),
    fsStats: async () => ({ rx_sec: 2048, wx_sec: 1024 }),
    battery: async () => ({ hasBattery: true, percent: 77, isCharging: true })
}, over);

function make(options = {}) {
    const mc = new MetricCollector(Object.assign({
        sampleIntervalMs: 60000, sampleTimeoutMs: 5000, si: fastSi()
    }, options));
    live.push(mc);
    return mc;
}

describe('MetricCollector', () => {
    it('ilk zarf stale:true ile başlar', () => {
        const mc = make();
        const m = mc.getMetrics();
        expect(m.stale).toBe(true);
        for (const k of ['cpuUsagePercent', 'networkDownloadKbps', 'networkUploadKbps', 'diskIops', 'userIdleSeconds', 'runningProcesses', 'sampledAt']) {
            expect(m).toHaveProperty(k);
        }
    });

    it('3. örnekten sonra stale:false olur (ısınma kuralı)', async () => {
        const mc = make();
        await mc.sampleOnce();
        expect(mc.getMetrics().stale).toBe(true);
        await mc.sampleOnce();
        expect(mc.getMetrics().stale).toBe(true);
        await mc.sampleOnce();
        expect(mc.getMetrics().stale).toBe(false);
    });

    it('ölçümler sayı aralığındadır (negatif ağ yok)', async () => {
        const mc = make();
        await mc.sampleOnce();
        const m = mc.getMetrics();
        expect(m.cpuUsagePercent).toBeGreaterThanOrEqual(0);
        expect(m.cpuUsagePercent).toBeLessThanOrEqual(100);
        expect(m.networkDownloadKbps).toBeGreaterThanOrEqual(0);
        expect(m.networkUploadKbps).toBeGreaterThanOrEqual(0);
        expect(m.diskIops).toBeGreaterThanOrEqual(0);
        // 125000 B/sn → 1000 Kbps
        expect(m.networkDownloadKbps).toBe(1000);
        expect(m.networkUploadKbps).toBe(500);
    });

    it('stopSampling döngüyü durdurur (idempotent)', () => {
        const mc = make();
        expect(mc.sampleInterval).not.toBeNull();
        mc.stopSampling();
        mc.stopSampling();
        expect(mc.sampleInterval).toBeNull();
    });

    /**
     * REGRESYON: `await underlying` geri gelirse bu test kırılır.
     * Asılı (hiç çözmeyen) bir kaynak, örneklemeyi timeout'tan fazla
     * bekletemez.
     */
    it('asılı kaynak örneklemeyi timeout\'tan fazla bloklamaz', async () => {
        const never = () => new Promise(() => {});
        const mc = make({
            sampleTimeoutMs: 120,
            si: fastSi({ disksIO: never, fsStats: never })
        });

        const t0 = Date.now();
        const ok = await mc.sampleOnce();
        const elapsed = Date.now() - t0;

        expect(ok).toBe(true);
        // 120 ms sınır + makul zamanlayıcı payı. Eski kod burada asla dönmezdi.
        expect(elapsed).toBeLessThan(1000);
        // Kaynak zaman aşımına uğradı → fail-closed.
        expect(mc.getMetrics().stale).toBe(true);
        // Diğer kaynaklar yine de güncellendi.
        expect(mc.getMetrics().networkDownloadKbps).toBe(1000);
    });

    it('uçuştaki kaynak için yeni OS çağrısı başlatılmaz (üst üste çağrı yok)', async () => {
        const disksIO = vi.fn(() => new Promise(() => {}));
        const mc = make({
            sampleTimeoutMs: 80,
            si: fastSi({ disksIO, fsStats: async () => ({ rx_sec: 0, wx_sec: 0 }) })
        });

        await mc.sampleOnce();  // disksIO başlar ve asılı kalır
        const callsAfterFirst = disksIO.mock.calls.length;
        expect(callsAfterFirst).toBe(1);

        await mc.sampleOnce();  // hâlâ uçuşta → ATLANMALI
        await mc.sampleOnce();
        expect(disksIO.mock.calls.length).toBe(callsAfterFirst);
    });

    it('uçuştaki kaynak çözülünce yeniden örneklenir', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const disksIO = vi.fn(async () => {
            await gate;
            return { rIO_sec: 5, wIO_sec: 5 };
        });
        const mc = make({
            sampleTimeoutMs: 60,
            si: fastSi({ disksIO, fsStats: async () => ({ rx_sec: 0, wx_sec: 0 }) })
        });

        await mc.sampleOnce();       // disksIO asılı (timeout)
        await mc.sampleOnce();       // atlanır
        release();                   // asılı çağrı çözülür
        await new Promise((r) => setTimeout(r, 20));
        await mc.sampleOnce();       // artık yeni çağrı başlar
        expect(disksIO.mock.calls.length).toBe(2);
    });
});
