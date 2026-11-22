/**
 * ups-supervisor.test.mjs - P1-9
 *
 * UPS düşük-batarya gözetimi. Kanıtlanmış `upsmon` semantiği:
 * - `LB` + `OB` → geri sayım başlar, süre dolunca eylem uygulanır.
 * - Geri sayım sırasında normale dönüş → eylem İPTAL.
 * - Ölçülemeyen durum (reachable:false) ASLA eylem üretmez.
 * - Aynı kesinti için cooldown vardır.
 *
 * GÜVENLİK: hiçbir gerçek OS komutu çalıştırılmaz; powerService enjekte edilir.
 */
import { describe, it, expect, vi } from 'vitest';
import { UpsSupervisor, DEFAULT_COUNTDOWN_MS, DEFAULT_COOLDOWN_MS } from '../../src/main/services/UpsSupervisor.js';

function make({ countdownMs = 1000, cooldownMs = 60000 } = {}) {
    const timers = new Map();
    let seq = 0;
    const setTimer = vi.fn((fn) => {
        seq += 1;
        const handle = { id: `t${seq}`, unref: vi.fn(), fn };
        timers.set(handle.id, handle);
        return handle;
    });
    const clearTimer = vi.fn((handle) => { if (handle) timers.delete(handle.id); });
    const powerService = { execute: vi.fn(async () => ({ success: true })) };
    const events = [];
    let now = 1_000_000;
    const sup = new UpsSupervisor({
        powerService,
        action: 'hibernate',
        countdownMs,
        cooldownMs,
        onEvent: (type, payload) => events.push({ type, payload }),
        setTimer,
        clearTimer,
        nowFn: () => now
    });
    return {
        sup,
        powerService,
        events,
        timers,
        setTimer,
        clearTimer,
        advance: (ms) => { now += ms; },
        fireTimers: () => {
            const pending = [...timers.values()];
            timers.clear();
            for (const t of pending) t.fn();
        }
    };
}

const critical = { reachable: true, lowBattery: true, onBattery: true, charge: 8, status: 'OB LB' };

describe('UpsSupervisor', () => {
    it('varsayılanlar makul (30 sn geri sayım, 10 dk cooldown)', () => {
        expect(DEFAULT_COUNTDOWN_MS).toBe(30000);
        expect(DEFAULT_COOLDOWN_MS).toBe(10 * 60 * 1000);
    });

    it('isCritical yalnızca ulaşılabilir + LB + OB için true', () => {
        expect(UpsSupervisor.isCritical(critical)).toBe(true);
        expect(UpsSupervisor.isCritical({ ...critical, lowBattery: false })).toBe(false);
        expect(UpsSupervisor.isCritical({ ...critical, onBattery: false })).toBe(false);
        expect(UpsSupervisor.isCritical({ ...critical, reachable: false })).toBe(false);
        expect(UpsSupervisor.isCritical(null)).toBe(false);
    });

    it('LB görülünce sayaç kurulur, süre dolunca eylem uygulanır', async () => {
        const h = make({ countdownMs: 30000 });
        const first = h.sup.handleState(critical);
        expect(first).toMatchObject({ critical: true, armed: true, fired: false });
        expect(h.powerService.execute).not.toHaveBeenCalled();
        expect(h.timers.size).toBe(1);

        // Süre dolmadan eylem yok.
        expect(h.sup.isArmed()).toBe(true);
        h.fireTimers();
        await Promise.resolve();
        expect(h.powerService.execute).toHaveBeenCalledTimes(1);
        expect(h.powerService.execute).toHaveBeenCalledWith('hibernate');
        expect(h.sup.isArmed()).toBe(false);
        expect(h.events.map((e) => e.type)).toEqual(['critical', 'executing', 'executed']);
    });

    it('geri sayım sırasında normale dönüş eylemi İPTAL eder', async () => {
        const h = make();
        h.sup.handleState(critical);
        const recovered = h.sup.handleState({ reachable: true, lowBattery: false, onBattery: false, status: 'OL', charge: 60 });
        expect(recovered).toMatchObject({ critical: false, armed: false });
        expect(h.clearTimer).toHaveBeenCalled();
        expect(h.sup.isArmed()).toBe(false);
        h.fireTimers();
        await Promise.resolve();
        expect(h.powerService.execute).not.toHaveBeenCalled();
        expect(h.events.map((e) => e.type)).toContain('recovered');
    });

    it('ölçülemeyen durum (reachable:false) eylem ÜRETMEZ', async () => {
        const h = make();
        const res = h.sup.handleState({ reachable: false });
        expect(res).toMatchObject({ critical: false, armed: false, skipped: 'UNREACHABLE' });
        h.fireTimers();
        await Promise.resolve();
        expect(h.powerService.execute).not.toHaveBeenCalled();
    });

    it('aynı durumun tekrar gelmesi ikinci sayaç açmaz', () => {
        const h = make();
        h.sup.handleState(critical);
        const second = h.sup.handleState(critical);
        expect(second).toMatchObject({ critical: true, armed: true, fired: false });
        expect(h.setTimer).toHaveBeenCalledTimes(1);
    });

    it('cooldown içinde yeni kesinti eylem üretmez', async () => {
        const h = make({ cooldownMs: 60000 });
        h.sup.handleState(critical);
        h.fireTimers();
        await Promise.resolve();
        expect(h.powerService.execute).toHaveBeenCalledTimes(1);

        // Normale dönüş, sonra tekrar kritik: cooldown içinde.
        h.sup.handleState({ reachable: true, lowBattery: false, onBattery: false, status: 'OL', charge: 20 });
        const again = h.sup.handleState(critical);
        expect(again).toMatchObject({ critical: true, armed: false, skipped: 'COOLDOWN' });
        expect(h.powerService.execute).toHaveBeenCalledTimes(1);
    });

    it('güç eylemi başarısızsa failed olayı yayınlanır', async () => {
        const h = make();
        h.powerService.execute.mockResolvedValueOnce({ success: false, error: 'OS reddetti' });
        h.sup.handleState(critical);
        h.fireTimers();
        await Promise.resolve();
        await Promise.resolve();
        const failed = h.events.find((e) => e.type === 'failed');
        expect(failed).toBeTruthy();
        expect(failed.payload.result.error).toBe('OS reddetti');
    });

    it('disarm bekleyen sayacı kaldırır ve eylem üretmez', async () => {
        const h = make();
        h.sup.handleState(critical);
        h.sup.disarm();
        expect(h.sup.isArmed()).toBe(false);
        h.fireTimers();
        await Promise.resolve();
        expect(h.powerService.execute).not.toHaveBeenCalled();
    });
});
