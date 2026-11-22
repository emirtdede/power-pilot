'use strict';

/**
 * warningActions.js - Uyarı bannerı eylemleri (Durdur / Ertele).
 *
 * Neden ayrı modül: `requireCancelPin` async'tir. main.js'teki IPC gövdeleri
 * async olmadığı için dönen Promise await edilmiyordu; Promise her zaman
 * truthy olduğundan PIN kontrolü koşulsuz erken dönüyor ve iptal/erteleme
 * hiç uygulanmıyordu (denetim C-01/C-02). Gövdeler buraya taşındı ki davranış
 * Electron'a ihtiyaç duymadan test edilebilsin (D17).
 *
 * TOCTOU (D16): PIN doğrulaması await edilirken uyarı sona erebilir veya yeni
 * bir görevin uyarısı açılabilir. Bu yüzden PIN'den ÖNCE aktif uyarının
 * taskId'si yakalanır, await'ten SONRA aynı taskId doğrulanır; kullanıcının
 * gördüğü uyarıdan başka bir görev iptal/erteletilmez.
 */

/** @returns {string|null} aktif uyarının görev kimliği */
function activeTaskId(warningManager) {
    if (!warningManager || typeof warningManager.getActiveState !== 'function') return null;
    const active = warningManager.getActiveState();
    return active && active.taskId ? active.taskId : null;
}

/**
 * @param {object} deps
 * @param {string|undefined} deps.pin Kullanıcının girdiği PIN (yoksa undefined)
 * @param {(pin?: string) => Promise<object|null>} deps.requireCancelPin
 * @param {object} deps.taskManager
 * @param {object} deps.warningManager
 * @param {(key: string) => string} deps.t
 */
async function cancelWarningAction({ pin, requireCancelPin, taskManager, warningManager, t }) {
    const expectedTaskId = activeTaskId(warningManager);
    const pinCheck = await requireCancelPin(pin);
    if (pinCheck) return pinCheck;

    // D16: PIN beklerken uyarı değiştiyse eski uyarıya ait iptal uygulanmaz.
    if (activeTaskId(warningManager) !== expectedTaskId) {
        return { success: false, code: 'WARNING_CHANGED', message: t('errorCancelTooLate') };
    }

    // WP-03: uyarıyı çöz + görevi CANCELLED yap (tek doğruluk kaynağı).
    if (taskManager && typeof taskManager.cancelActiveTask === 'function') {
        const r = taskManager.cancelActiveTask();
        // cancelTask() CANCEL_TOO_LATE'i ok:true ile döndürür; kod önce kontrol edilir.
        if (r && r.code === 'CANCEL_TOO_LATE') {
            return { success: false, code: 'CANCEL_TOO_LATE', message: t('errorCancelTooLate') };
        }
        if (r && r.ok) return { success: true, code: r.code };
    }
    const closed = warningManager.cancelActiveWarning();
    return { success: closed === true, code: closed ? 'CANCELLED' : 'NO_ACTIVE_WARNING' };
}

/**
 * @param {object} deps
 * @param {number|{minutes?: number, pin?: string}} deps.payload
 * @param {(pin?: string) => Promise<object|null>} deps.requireCancelPin
 * @param {object} deps.taskManager
 * @param {object} deps.warningManager
 * @param {(key: string) => string} deps.t
 */
async function snoozeWarningAction({ payload, requireCancelPin, taskManager, warningManager, t }) {
    const minutes = payload && typeof payload === 'object' ? payload.minutes : payload;
    const pin = payload && typeof payload === 'object' ? payload.pin : undefined;
    const expectedTaskId = activeTaskId(warningManager);
    const pinCheck = await requireCancelPin(pin);
    if (pinCheck) return pinCheck;

    // D16: PIN beklerken uyarı kapandı/değiştiyse erteleme uygulanmaz.
    if (activeTaskId(warningManager) !== expectedTaskId) {
        return { success: false, code: 'WARNING_CHANGED', message: t('taskSnoozeFailed') };
    }

    const m = Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : 10;
    if (expectedTaskId && taskManager && typeof taskManager.snoozeTask === 'function') {
        const r = taskManager.snoozeTask(expectedTaskId, m);
        if (r && r.ok) return { success: true, code: r.code, minutes: m };
        if (r && (r.code === 'ALREADY_RUNNING' || r.code === 'CANCEL_TOO_LATE')) {
            return { success: false, code: r.code, message: t('taskSnoozeFailed') };
        }
    }
    const snoozed = warningManager.snoozeActiveWarning(m);
    return { success: snoozed === true, code: snoozed ? 'SNOOZED' : 'NO_ACTIVE_WARNING' };
}

/**
 * Uyarıyı onaylar (Şimdi Çalıştır). K-02: renderer hangi uyarıyı gördüğünü
 * gönderir; PIN/başka bir eylem beklerken uyarı değiştiyse eski tıklama yeni
 * görevi onaylamaz.
 *
 * @param {object} deps
 * @param {string|undefined} deps.taskId Renderer'ın gördüğü uyarının görev kimliği
 * @param {object} deps.warningManager
 * @param {(key: string) => string} deps.t
 */
function confirmWarningAction({ taskId, warningManager, t }) {
    const requestedTaskId = typeof taskId === 'string' ? taskId : null;
    const active = warningManager && typeof warningManager.getActiveState === 'function'
        ? warningManager.getActiveState()
        : null;
    if (!active) return { success: false, code: 'NO_ACTIVE_WARNING' };
    if (requestedTaskId && active.taskId !== requestedTaskId) {
        return { success: false, code: 'WARNING_CHANGED', message: t('errorCancelTooLate') };
    }
    const closed = warningManager.finishWarning(true, false, requestedTaskId || active.taskId);
    return closed ? { success: true } : { success: false, code: 'NO_ACTIVE_WARNING' };
}

module.exports = { cancelWarningAction, snoozeWarningAction, confirmWarningAction, activeTaskId };
