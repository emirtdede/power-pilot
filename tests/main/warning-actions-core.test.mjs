/**
 * warning-actions-core.test.mjs - uyarı bannerı eylemleri (TOCTOU + PIN)
 */
import { describe, it, expect, vi } from 'vitest';
import { cancelWarningAction, snoozeWarningAction, confirmWarningAction, activeTaskId } from '../../src/main/ipc/warningActions.js';

const t = (k) => k;

function warning(active = { taskId: 't1' }) {
    const state = { active };
    return {
        state,
        getActiveState: () => state.active,
        cancelActiveWarning: vi.fn(() => { state.active = null; return true; }),
        snoozeActiveWarning: vi.fn(() => { state.active = null; return true; }),
        finishWarning: vi.fn(() => { state.active = null; return true; })
    };
}

const okPin = async () => null;

describe('warningActions - activeTaskId', () => {
    it('manager yok/boş durumda null', () => {
        expect(activeTaskId(null)).toBeNull();
        expect(activeTaskId({})).toBeNull();
        expect(activeTaskId({ getActiveState: () => null })).toBeNull();
        expect(activeTaskId({ getActiveState: () => ({}) })).toBeNull();
        expect(activeTaskId({ getActiveState: () => ({ taskId: 'x' }) })).toBe('x');
    });
});

describe('cancelWarningAction', () => {
    it('PIN reddi olduğu gibi döner (eylem uygulanmaz)', async () => {
        const wm = warning();
        const tm = { cancelActiveTask: vi.fn() };
        const res = await cancelWarningAction({ pin: '1', requireCancelPin: async () => ({ success: false, code: 'PIN_WRONG' }), taskManager: tm, warningManager: wm, t });
        expect(res).toEqual({ success: false, code: 'PIN_WRONG' });
        expect(tm.cancelActiveTask).not.toHaveBeenCalled();
    });

    it('PIN beklerken uyarı değişirse WARNING_CHANGED', async () => {
        const wm = warning();
        const slowPin = async () => { wm.state.active = { taskId: 't2' }; return null; };
        const res = await cancelWarningAction({ requireCancelPin: slowPin, taskManager: { cancelActiveTask: vi.fn() }, warningManager: wm, t });
        expect(res.code).toBe('WARNING_CHANGED');
    });

    it('taskManager CANCEL_TOO_LATE dönerse hata kodu', async () => {
        const wm = warning();
        const tm = { cancelActiveTask: () => ({ ok: true, code: 'CANCEL_TOO_LATE' }) };
        const res = await cancelWarningAction({ requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res).toEqual({ success: false, code: 'CANCEL_TOO_LATE', message: 'errorCancelTooLate' });
    });

    it('taskManager başarılı iptal', async () => {
        const wm = warning();
        const tm = { cancelActiveTask: () => ({ ok: true, code: 'CANCELLED' }) };
        const res = await cancelWarningAction({ requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res).toEqual({ success: true, code: 'CANCELLED' });
    });

    it('taskManager yoksa warningManager kapatır', async () => {
        const wm = warning();
        const res = await cancelWarningAction({ requireCancelPin: okPin, taskManager: null, warningManager: wm, t });
        expect(res).toEqual({ success: true, code: 'CANCELLED' });
        expect(wm.cancelActiveWarning).toHaveBeenCalled();
    });

    it('aktif uyarı yoksa NO_ACTIVE_WARNING', async () => {
        const wm = warning(null);
        wm.cancelActiveWarning = vi.fn(() => false);
        const res = await cancelWarningAction({ requireCancelPin: okPin, taskManager: null, warningManager: wm, t });
        expect(res).toEqual({ success: false, code: 'NO_ACTIVE_WARNING' });
    });

    it('taskManager sonucu başarısızsa warningManager yoluna düşer', async () => {
        const wm = warning();
        const tm = { cancelActiveTask: () => ({ ok: false, code: 'X' }) };
        const res = await cancelWarningAction({ requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res.success).toBe(true);
        expect(wm.cancelActiveWarning).toHaveBeenCalled();
    });
});

describe('snoozeWarningAction', () => {
    it('payload nesne/sayı biçimleri', async () => {
        const wm = warning();
        const tm = { snoozeTask: vi.fn(() => ({ ok: true, code: 'SNOOZED' })) };
        const res = await snoozeWarningAction({ payload: { minutes: 5, pin: '1' }, requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res).toMatchObject({ success: true, minutes: 5 });
        expect(tm.snoozeTask).toHaveBeenCalledWith('t1', 5);

        const wm2 = warning();
        const tm2 = { snoozeTask: vi.fn(() => ({ ok: true })) };
        const res2 = await snoozeWarningAction({ payload: 15, requireCancelPin: okPin, taskManager: tm2, warningManager: wm2, t });
        expect(res2.minutes).toBe(15);
    });

    it('geçersiz dakika 10\'a düşer', async () => {
        const wm = warning();
        const tm = { snoozeTask: vi.fn(() => ({ ok: true })) };
        const res = await snoozeWarningAction({ payload: { minutes: 9999 }, requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res.minutes).toBe(10);
    });

    it('PIN beklerken uyarı değişirse WARNING_CHANGED', async () => {
        const wm = warning();
        const slowPin = async () => { wm.state.active = null; return null; };
        const res = await snoozeWarningAction({ payload: 5, requireCancelPin: slowPin, taskManager: { snoozeTask: vi.fn() }, warningManager: wm, t });
        expect(res.code).toBe('WARNING_CHANGED');
    });

    it('ALREADY_RUNNING/CANCEL_TOO_LATE hata olarak döner', async () => {
        const wm = warning();
        const tm = { snoozeTask: () => ({ ok: false, code: 'ALREADY_RUNNING' }) };
        const res = await snoozeWarningAction({ payload: 5, requireCancelPin: okPin, taskManager: tm, warningManager: wm, t });
        expect(res).toEqual({ success: false, code: 'ALREADY_RUNNING', message: 'taskSnoozeFailed' });

        const wm2 = warning();
        const tm2 = { snoozeTask: () => ({ ok: false, code: 'CANCEL_TOO_LATE' }) };
        expect((await snoozeWarningAction({ payload: 5, requireCancelPin: okPin, taskManager: tm2, warningManager: wm2, t })).code).toBe('CANCEL_TOO_LATE');
    });

    it('aktif görev yoksa warningManager kullanılır', async () => {
        const wm = warning(null);
        wm.snoozeActiveWarning = vi.fn(() => true);
        const res = await snoozeWarningAction({ payload: 5, requireCancelPin: okPin, taskManager: { snoozeTask: vi.fn() }, warningManager: wm, t });
        expect(res).toEqual({ success: true, code: 'SNOOZED' });

        const wm2 = warning(null);
        wm2.snoozeActiveWarning = vi.fn(() => false);
        expect((await snoozeWarningAction({ payload: 5, requireCancelPin: okPin, taskManager: null, warningManager: wm2, t })).code).toBe('NO_ACTIVE_WARNING');
    });
});

describe('confirmWarningAction', () => {
    it('aktif uyarı yoksa NO_ACTIVE_WARNING', () => {
        expect(confirmWarningAction({ taskId: null, warningManager: warning(null), t })).toEqual({ success: false, code: 'NO_ACTIVE_WARNING' });
        expect(confirmWarningAction({ taskId: null, warningManager: null, t })).toEqual({ success: false, code: 'NO_ACTIVE_WARNING' });
    });

    it('farklı görev kimliği WARNING_CHANGED', () => {
        const wm = warning({ taskId: 't1' });
        expect(confirmWarningAction({ taskId: 't2', warningManager: wm, t })).toMatchObject({ code: 'WARNING_CHANGED' });
        expect(wm.finishWarning).not.toHaveBeenCalled();
    });

    it('aynı/verilmeyen kimlikte uyarı onaylanır', () => {
        const wm = warning({ taskId: 't1' });
        expect(confirmWarningAction({ taskId: 't1', warningManager: wm, t })).toEqual({ success: true });
        expect(wm.finishWarning).toHaveBeenCalledWith(true, false, 't1');

        const wm2 = warning({ taskId: 't9' });
        expect(confirmWarningAction({ taskId: null, warningManager: wm2, t })).toEqual({ success: true });
        expect(wm2.finishWarning).toHaveBeenCalledWith(true, false, 't9');
    });

    it('kapanmayan uyarı NO_ACTIVE_WARNING', () => {
        const wm = warning({ taskId: 't1' });
        wm.finishWarning = vi.fn(() => false);
        expect(confirmWarningAction({ taskId: 't1', warningManager: wm, t }).code).toBe('NO_ACTIVE_WARNING');
    });
});
