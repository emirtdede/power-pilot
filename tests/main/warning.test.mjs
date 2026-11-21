/**
 * warning.test.mjs — WarningManager: süre sonu proceed, iptal, ertele, event'ler.
 * durationSeconds=1 ile hızlı çalışır (gerçek sayaç, ~1sn/test).
 */
import { describe, it, expect } from 'vitest';
import WarningManager from '../../src/main/services/WarningManager.js';

function warnTask(seconds = 1, extra = {}) {
    return { id: 'task_w1', name: 'Uyarı Testi', action: 'shutdown', mode: 'classic', warningConfig: { durationSeconds: seconds }, ...extra };
}

describe('WarningManager', () => {
    it('full modda süre dolunca proceed:true + tick eventleri (WBS-9.4)', async () => {
        const wm = new WarningManager(null);
        const ticks = [];
        wm.on('warning-tick', (t) => ticks.push(t.secondsLeft));
        let started = null;
        wm.on('warning-started', (s) => { started = s; });
        const res = await wm.showWarning(warnTask(1, { mode: 'full' }));
        expect(res).toEqual({ proceed: true, snoozed: false });
        expect(started.taskId).toBe('task_w1');
        expect(ticks.length).toBeGreaterThanOrEqual(1);
    }, 10000);

    it('süre dolunca kullanıcı iptal etmediyse eylem GERÇEKLEŞİR (P0-2)', async () => {
        // Eski davranış classic modda görevi iptal ediyordu; bu, kullanıcının
        // kendi kurduğu zamanlayıcıyı sabaha kadar açık bırakıyordu.
        const wm = new WarningManager(null);
        const res = await wm.showWarning(warnTask(1));
        expect(res).toEqual({ proceed: true, snoozed: false });
    }, 10000);

    it('requireConfirmation:true ise süre dolunca İPTAL edilir (açık onay modu)', async () => {
        const wm = new WarningManager(null);
        const res = await wm.showWarning(warnTask(1, { warningConfig: { enabled: true, durationSeconds: 1, requireConfirmation: true } }));
        expect(res).toEqual({ proceed: false, snoozed: false });
    }, 10000);

    it('scheduler-ateşlemeli görev moddan bağımsız devam eder (WBS-9.4)', async () => {
        const wm = new WarningManager(null);
        const res = await wm.showWarning(warnTask(1, { _schedulerFired: true }));
        expect(res).toEqual({ proceed: true, snoozed: false });
    }, 10000);

    it('durationSeconds:0 hemen icra eder (30 sn bekletmez; classic ve full modda proceed:true)', async () => {
        const wm = new WarningManager(null);
        let started = null;
        wm.on('warning-started', (s) => { started = s; });
        const t0 = Date.now();
        const resFull = await wm.showWarning(warnTask(0, { mode: 'full' }));
        expect(resFull).toEqual({ proceed: true, snoozed: false });
        expect(started.secondsLeft).toBe(0);
        expect(Date.now() - t0).toBeLessThan(1000);

        const resClassic = await wm.showWarning(warnTask(0, { mode: 'classic' }));
        expect(resClassic).toEqual({ proceed: true, snoozed: false });
    }, 5000);

    it('durationSeconds tanımsızsa 30 saniye varsayılır', async () => {
        const wm = new WarningManager(null);
        const p = wm.showWarning({ id: 'task_w1', name: 'x', action: 'shutdown', mode: 'classic', warningConfig: {} });
        expect(wm.getActiveState().secondsLeft).toBe(30);
        wm.cancelActiveWarning();
        await expect(p).resolves.toEqual({ proceed: false, snoozed: false });
    });

    it('cancelActiveWarning proceed:false çözer', async () => {
        const wm = new WarningManager(null);
        const p = wm.showWarning(warnTask(30));
        wm.cancelActiveWarning();
        await expect(p).resolves.toEqual({ proceed: false, snoozed: false });
    });

    it('snoozeActiveWarning snoozed:true çözer', async () => {
        const wm = new WarningManager(null);
        const p = wm.showWarning(warnTask(30));
        wm.snoozeActiveWarning(10);
        await expect(p).resolves.toEqual({ proceed: false, snoozed: true, minutes: 10 });
    });

    it('aktif uyarı yokken cancel/snooze/finish sessizce çıkar (crash yok)', () => {
        const wm = new WarningManager(null);
        expect(() => { wm.cancelActiveWarning(); wm.snoozeActiveWarning(); wm.finishWarning(true, false); }).not.toThrow();
    });
});
