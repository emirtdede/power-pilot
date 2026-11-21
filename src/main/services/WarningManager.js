/**
 * WarningManager.js
 * Manages power action warning dialogs, countdowns, snoozing, and last-second cancellations.
 */

const { EventEmitter } = require('events');
const log = require('../logger');

class WarningManager extends EventEmitter {
    constructor(historyService) {
        super();
        this.history = historyService;
        this.activeWarning = null;
    }

    /**
     * Shows a warning for an upcoming task.
     *
     * Süre dolduğunda davranış (P0-2 düzeltmesi):
     * Uyarı bir "son şans iptal penceresi"dir; kullanıcı bilinçli olarak
     * iptal/ertele DEMEDİYSE sayaç bittiğinde eylem GERÇEKLEŞİR. Eski davranış
     * (`classic` modda sayaç bitince görevi iptal etmek) kullanıcının kendi
     * kurduğu "1 saat sonra kapat" zamanlayıcısını sabaha kadar açık bırakıyordu.
     *
     * Zorunlu onay isteyen kullanıcı `warningConfig.requireConfirmation: true`
     * ile bunu açıkça seçer (o durumda sayaç bitince iptal edilir).
     *
     * @param {AutomationTask} task
     * @returns {Promise<{proceed: boolean, snoozed?: boolean}>}
     */
    showWarning(task) {
        return new Promise((resolve) => {
            // Aynı anda tek aktif uyarı. Eski uyarı varsa güvenli biçimde kapatılır.
            if (this.activeWarning) this.finishWarning(false, false);
            const rawSeconds = task.warningConfig && task.warningConfig.durationSeconds;
            // O-02: 0 geçerli bir değerdir ("hemen icra"); `|| 30` onu yutuyordu.
            const warningSec = Number.isInteger(rawSeconds) ? Math.min(Math.max(rawSeconds, 0), 3600) : 30;
            const requireConfirmation = !!(task.warningConfig && task.warningConfig.requireConfirmation === true);
            const autoProceed = !requireConfirmation;
            log.info(`[WarningManager] Starting ${warningSec}s warning for task "${task.name}" (mode=${task.mode || 'classic'}, autoProceed=${autoProceed}, requireConfirmation=${requireConfirmation})`);

            let secondsLeft = warningSec;
            let timerInterval = null;

            this.activeWarning = {
                taskId: task.id,
                taskName: task.name,
                action: task.action,
                secondsLeft: secondsLeft,
                resolve: resolve,
                interval: null,
                silentMode: !!(task.warningConfig && task.warningConfig.silentMode)
            };

            // Notify UI via event
            this.emit('warning-started', {
                taskId: task.id,
                taskName: task.name,
                action: task.action,
                secondsLeft: secondsLeft,
                // D-05: sessiz mod sesi bastırır; banner görünür kalır.
                silentMode: !!(task.warningConfig && task.warningConfig.silentMode)
            });

            // O-02: 0 saniye = "hemen icra" (uyarısız geçiş); moddan bağımsız
            // olarak proceed:true döner. Zamanlayıcı bir sonraki tura bırakılır
            // ki `warning-started` dinleyicisi durumu görebilsin.
            if (warningSec === 0) {
                const immediate = setTimeout(() => {
                    if (this.activeWarning && this.activeWarning.taskId === task.id) {
                        this.finishWarning(true, false);
                    }
                }, 0);
                if (typeof immediate.unref === 'function') immediate.unref();
                if (this.activeWarning && this.activeWarning.taskId === task.id) {
                    this.activeWarning.interval = immediate;
                }
                return;
            }

            timerInterval = setInterval(() => {
                secondsLeft--;
                if (this.activeWarning) {
                    this.activeWarning.secondsLeft = secondsLeft;
                }

                this.emit('warning-tick', {
                    taskId: task.id,
                    secondsLeft: secondsLeft
                });

                if (secondsLeft <= 0) {
                    clearInterval(timerInterval);
                    this.finishWarning(autoProceed, false);
                }
            }, 1000);

            if (this.activeWarning) {
                this.activeWarning.interval = timerInterval;
            }
        });
    }

    getActiveState() {
        if (!this.activeWarning) return null;
        return {
            taskId: this.activeWarning.taskId,
            taskName: this.activeWarning.taskName,
            action: this.activeWarning.action,
            secondsLeft: this.activeWarning.secondsLeft,
            silentMode: !!this.activeWarning.silentMode
        };
    }

    /**
     * @param {string|null} taskId Yalnızca bu görevin uyarısını kapatır.
     * @returns {boolean} uyarı kapatıldıysa true
     */
    cancelActiveWarning(taskId = null) {
        if (!this.activeWarning) return false;
        if (taskId && this.activeWarning.taskId !== taskId) return false;
        if (this.activeWarning.interval) clearInterval(this.activeWarning.interval);

        const resolve = this.activeWarning.resolve;
        const closedTaskId = this.activeWarning.taskId;
        this.activeWarning = null;
        this.emit('warning-cancelled', { taskId: closedTaskId });
        resolve({ proceed: false, snoozed: false });
        return true;
    }

    snoozeActiveWarning(minutes = 10, taskId = null) {
        if (!this.activeWarning) return false;
        if (taskId && this.activeWarning.taskId !== taskId) return false;
        if (this.activeWarning.interval) clearInterval(this.activeWarning.interval);

        // H-10: kullanıcı seçtiği süre kaybolmaz; executeTask bu değeri kullanır.
        const safeMinutes = Number.isInteger(minutes) ? Math.min(Math.max(minutes, 1), 1440) : 10;
        const resolve = this.activeWarning.resolve;
        const closedTaskId = this.activeWarning.taskId;
        this.activeWarning = null;
        this.emit('warning-snoozed', { minutes: safeMinutes, taskId: closedTaskId });
        resolve({ proceed: false, snoozed: true, minutes: safeMinutes });
        return true;
    }

    finishWarning(proceed, snoozed, taskId = null) {
        if (!this.activeWarning) return false;
        if (taskId && this.activeWarning.taskId !== taskId) return false;
        if (this.activeWarning.interval) clearInterval(this.activeWarning.interval);

        const resolve = this.activeWarning.resolve;
        const closedTaskId = this.activeWarning.taskId;
        this.activeWarning = null;
        this.emit('warning-finished', { proceed, snoozed, taskId: closedTaskId });
        resolve({ proceed, snoozed });
        return true;
    }
}

module.exports = WarningManager;
