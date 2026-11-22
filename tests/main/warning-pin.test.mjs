/**
 * warning-pin.test.mjs - C-01/C-02 regresyon testi.
 *
 * Denetim bulgusu: `warning-cancel` / `warning-snooze` IPC gövdeleri async
 * olmadığı için `requireCancelPin(...)` await edilmiyordu. Dönen Promise her
 * zaman truthy olduğundan `if (pinCheck) return pinCheck` koşulsuz erken
 * dönüyor; `cancelActiveTask()` / `snoozeTask()` hiç çalışmıyordu. Renderer da
 * yanıtı kontrol etmeden bannerı gizlediği için kullanıcı iptal ettiğini
 * sanıyordu (PIN ayarlanmamış olsa bile).
 *
 * Test iki katmanı doğrular:
 *  1) main.js gövdeleri ortak eylemi await ediyor (kaynak sözleşmesi).
 *  2) Eylemler PIN kapısını bekliyor, TOCTOU'da yeni uyarıyı iptal etmiyor.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelWarningAction, snoozeWarningAction, confirmWarningAction } from '../../src/main/ipc/warningActions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.resolve(here, '../../main.js'), 'utf8');

function handlerBody(channel) {
    const start = mainSource.indexOf(`ipcHandle('${channel}'`);
    expect(start, `${channel} handler bulunamadı`).toBeGreaterThan(-1);
    return mainSource.slice(start, start + 700);
}

/** PIN kapısı: doğru PIN'de null, aksi halde hata nesnesi döner (gerçek sözleşme). */
function pinGate(result) {
    return vi.fn(async () => result);
}

function makeManagers({ activeTaskId = 'task_1', cancelResult = { ok: true, code: 'CANCELLED' } } = {}) {
    const warningManager = {
        state: activeTaskId ? { taskId: activeTaskId } : null,
        getActiveState() { return this.state; },
        cancelActiveWarning: vi.fn(function (taskId = null) {
            if (!this.state) return false;
            if (taskId && this.state.taskId !== taskId) return false;
            this.state = null;
            return true;
        }),
        snoozeActiveWarning: vi.fn(function (minutes = 10, taskId = null) {
            if (!this.state) return false;
            if (taskId && this.state.taskId !== taskId) return false;
            this.state = null;
            return true;
        }),
        finishWarning: vi.fn(function (confirmed = true, apply = false, taskId = null) {
            if (!this.state) return false;
            if (taskId && this.state.taskId !== taskId) return false;
            this.state = null;
            return true;
        })
    };
    const taskManager = {
        cancelActiveTask: vi.fn(() => cancelResult),
        snoozeTask: vi.fn(() => ({ ok: true, code: 'SNOOZED_ACTIVE', minutes: 10 }))
    };
    return { warningManager, taskManager };
}

const t = (key) => `tr:${key}`;

describe('C-01 warning-cancel: PIN kapısı await edilir', () => {
    it('main.js handler async ve ortak eylemi await ediyor', () => {
        const body = handlerBody('warning-cancel');
        expect(body).toMatch(/async/);
        expect(body).toMatch(/await\s+cancelWarningAction\(/);
    });

    it('doğru PIN ile cancelActiveTask tam bir kez çağrılır', async () => {
        const { warningManager, taskManager } = makeManagers();
        const res = await cancelWarningAction({
            pin: '1234', requireCancelPin: pinGate(null), taskManager, warningManager, t
        });
        expect(taskManager.cancelActiveTask).toHaveBeenCalledTimes(1);
        expect(res).toEqual({ success: true, code: 'CANCELLED' });
    });

    it('PIN yoksa/yanlışsa görev iptal edilmez, PIN hatası döner', async () => {
        const { warningManager, taskManager } = makeManagers();
        const challenge = { success: false, code: 'PIN_REQUIRED', message: 'tr:pinPromptCancel' };
        const res = await cancelWarningAction({
            pin: '', requireCancelPin: pinGate(challenge), taskManager, warningManager, t
        });
        expect(taskManager.cancelActiveTask).not.toHaveBeenCalled();
        expect(warningManager.cancelActiveWarning).not.toHaveBeenCalled();
        expect(res).toEqual(challenge);
    });

    it('PIN beklerken uyarı başka göreve geçtiyse yeni görev iptal edilmez (TOCTOU)', async () => {
        const { warningManager, taskManager } = makeManagers();
        const requireCancelPin = vi.fn(async () => {
            warningManager.state = { taskId: 'task_2' };
            return null;
        });
        const res = await cancelWarningAction({
            pin: '1234', requireCancelPin, taskManager, warningManager, t
        });
        expect(taskManager.cancelActiveTask).not.toHaveBeenCalled();
        expect(warningManager.cancelActiveWarning).not.toHaveBeenCalled();
        expect(res).toMatchObject({ success: false, code: 'WARNING_CHANGED' });
    });

    it('CANCEL_TOO_LATE başarı olarak raporlanmaz (banner gizlenmemeli)', async () => {
        const { warningManager, taskManager } = makeManagers({
            cancelResult: { ok: true, code: 'CANCEL_TOO_LATE' }
        });
        const res = await cancelWarningAction({
            pin: '1234', requireCancelPin: pinGate(null), taskManager, warningManager, t
        });
        expect(res).toMatchObject({ success: false, code: 'CANCEL_TOO_LATE' });
    });
});

describe('C-02 warning-snooze: PIN kapısı await edilir', () => {
    it('main.js handler async ve ortak eylemi await ediyor', () => {
        const body = handlerBody('warning-snooze');
        expect(body).toMatch(/async/);
        expect(body).toMatch(/await\s+snoozeWarningAction\(/);
    });

    it('doğru PIN ile snoozeTask tam bir kez çağrılır', async () => {
        const { warningManager, taskManager } = makeManagers();
        const res = await snoozeWarningAction({
            payload: { minutes: 15, pin: '1234' }, requireCancelPin: pinGate(null), taskManager, warningManager, t
        });
        expect(taskManager.snoozeTask).toHaveBeenCalledTimes(1);
        expect(taskManager.snoozeTask).toHaveBeenCalledWith('task_1', 15);
        expect(res).toMatchObject({ success: true, code: 'SNOOZED_ACTIVE', minutes: 15 });
    });

    it('PIN yoksa/yanlışsa görev ertelenmez', async () => {
        const { warningManager, taskManager } = makeManagers();
        const challenge = { success: false, code: 'PIN_WRONG', attemptsLeft: 2 };
        const res = await snoozeWarningAction({
            payload: { minutes: 10, pin: '0000' }, requireCancelPin: pinGate(challenge), taskManager, warningManager, t
        });
        expect(taskManager.snoozeTask).not.toHaveBeenCalled();
        expect(warningManager.snoozeActiveWarning).not.toHaveBeenCalled();
        expect(res).toEqual(challenge);
    });

    it('PIN beklerken uyarı kapandıysa erteleme uygulanmaz', async () => {
        const { warningManager, taskManager } = makeManagers();
        const requireCancelPin = vi.fn(async () => {
            warningManager.state = null;
            return null;
        });
        const res = await snoozeWarningAction({
            payload: 10, requireCancelPin, taskManager, warningManager, t
        });
        expect(taskManager.snoozeTask).not.toHaveBeenCalled();
        expect(warningManager.snoozeActiveWarning).not.toHaveBeenCalled();
        expect(res).toMatchObject({ success: false, code: 'WARNING_CHANGED' });
    });
});

describe('K-02 warning-confirm: taskId ile TOCTOU koruması', () => {
    it('main.js handler ortak onay eylemini kullanıyor', () => {
        const body = handlerBody('warning-confirm');
        expect(body).toMatch(/confirmWarningAction\(/);
        expect(body).toMatch(/args && args\.taskId/);
    });

    it('görülen uyarı ile aktif uyarı aynıysa onaylanır', () => {
        const { warningManager } = makeManagers();
        const res = confirmWarningAction({ taskId: 'task_1', warningManager, t });
        expect(res).toEqual({ success: true });
        expect(warningManager.finishWarning).toHaveBeenCalledWith(true, false, 'task_1');
    });

    it('PIN beklerken uyarı değiştiyse eski tıklama yeni görevi onaylamaz', () => {
        const { warningManager } = makeManagers({ activeTaskId: 'task_2' });
        const res = confirmWarningAction({ taskId: 'task_1', warningManager, t });
        expect(res).toMatchObject({ success: false, code: 'WARNING_CHANGED' });
        expect(warningManager.finishWarning).not.toHaveBeenCalled();
    });

    it('aktif uyarı yoksa NO_ACTIVE_WARNING; taskId yoksa aktif görev kullanılır', () => {
        const empty = makeManagers({ activeTaskId: null });
        expect(confirmWarningAction({ taskId: 'task_1', warningManager: empty.warningManager, t }))
            .toEqual({ success: false, code: 'NO_ACTIVE_WARNING' });

        const { warningManager } = makeManagers();
        expect(confirmWarningAction({ warningManager, t })).toEqual({ success: true });
        expect(warningManager.finishWarning).toHaveBeenCalledWith(true, false, 'task_1');
    });
});
