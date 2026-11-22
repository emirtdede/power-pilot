/**
 * terminal-action-verifier.test.mjs - A6 kapatma vetosu tespiti
 *
 * Saf mantık: timer fonksiyonları enjekte edilir, gerçek bekleme yok,
 * hiçbir OS güç komutu çalıştırılmaz.
 */
import { describe, it, expect, vi } from 'vitest';
import { TerminalActionVerifier, TERMINAL_ACTIONS, DEFAULT_GRACE_MS } from '../../src/main/services/TerminalActionVerifier.js';

function fakeTimers() {
    let seq = 0;
    const pending = new Map();
    return {
        setTimer: (fn, ms) => {
            const id = ++seq;
            pending.set(id, { fn, ms });
            return id;
        },
        clearTimer: (id) => pending.delete(id),
        fire: () => {
            const entries = [...pending.entries()];
            pending.clear();
            for (const [, item] of entries) item.fn();
            return entries.length;
        },
        pending,
        count: () => pending.size
    };
}

describe('TerminalActionVerifier', () => {
    it('yalnızca kapatma/yeniden başlatma/oturum kapatmayı terminal sayar', () => {
        expect([...TERMINAL_ACTIONS].sort()).toEqual(['restart', 'shutdown', 'signout']);
        expect(TerminalActionVerifier.isTerminalAction('shutdown')).toBe(true);
        expect(TerminalActionVerifier.isTerminalAction('restart')).toBe(true);
        expect(TerminalActionVerifier.isTerminalAction('signout')).toBe(true);
        expect(TerminalActionVerifier.isTerminalAction('sleep')).toBe(false);
        expect(TerminalActionVerifier.isTerminalAction('hibernate')).toBe(false);
        expect(TerminalActionVerifier.isTerminalAction('lock')).toBe(false);
        expect(TerminalActionVerifier.isTerminalAction(null)).toBe(false);
    });

    it('sleep/lock için doğrulama kurmaz', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        expect(v.arm('sleep', () => {})).toBe(false);
        expect(v.arm('lock', () => {})).toBe(false);
        expect(t.count()).toBe(0);
        expect(v.isArmed()).toBe(false);
    });

    it('kapatmada pencere dolarsa veto raporlanır', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier({ ...t, graceMs: 25000 });
        const onVetoed = vi.fn();
        expect(v.arm('shutdown', onVetoed)).toBe(true);
        expect(v.isArmed()).toBe(true);
        expect(t.count()).toBe(1);
        expect(onVetoed).not.toHaveBeenCalled();
        t.fire();
        expect(onVetoed).toHaveBeenCalledWith('shutdown');
        expect(v.isArmed()).toBe(false);
    });

    it('varsayılan pencere DEFAULT_GRACE_MS', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        v.arm('restart', () => {});
        expect(t.pending.get(1).ms).toBe(DEFAULT_GRACE_MS);
    });

    it('disarm timer\'ı temizler ve rapor üretmez', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        const onVetoed = vi.fn();
        v.arm('shutdown', onVetoed);
        v.disarm();
        expect(t.count()).toBe(0);
        expect(v.isArmed()).toBe(false);
        expect(onVetoed).not.toHaveBeenCalled();
    });

    it('yeniden arm önceki pencereyi iptal eder (tek rapor)', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        const first = vi.fn();
        const second = vi.fn();
        v.arm('shutdown', first);
        v.arm('shutdown', second);
        expect(t.count()).toBe(1);
        t.fire();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('geri çağırım hatası yutulur', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        v.arm('shutdown', () => { throw new Error('patladı'); });
        expect(() => t.fire()).not.toThrow();
    });

    it('geri çağırım hatası süreç akışını bozmaz (arm sarmalayıcısı)', () => {
        let captured = null;
        const v = new TerminalActionVerifier({
            graceMs: 5,
            setTimer: (fn) => { captured = fn; return 1; },
            clearTimer: () => {}
        });
        v.arm('shutdown', () => { throw new Error('patladı'); });
        expect(() => captured()).not.toThrow();
    });

    it('geçersiz geri çağırım arm etmez', () => {
        const t = fakeTimers();
        const v = new TerminalActionVerifier(t);
        expect(v.arm('shutdown', null)).toBe(false);
        expect(t.count()).toBe(0);
    });

    it('negatif/geçersiz graceMs varsayılana düşer', () => {
        const v1 = new TerminalActionVerifier({ graceMs: -5 });
        expect(v1.graceMs).toBe(DEFAULT_GRACE_MS);
        const v2 = new TerminalActionVerifier({ graceMs: 'abc' });
        expect(v2.graceMs).toBe(DEFAULT_GRACE_MS);
        const v3 = new TerminalActionVerifier({ graceMs: 0 });
        expect(v3.graceMs).toBe(0);
    });
});
