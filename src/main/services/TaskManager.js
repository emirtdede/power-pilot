/**
 * TaskManager.js
 * Central Engine managing multiple concurrent automation tasks, schedule evaluations,
 * conflict resolutions, and application restart recoveries.
 */

const { AutomationTask, TASK_STATUS, TASK_SOURCE, TRIGGER_TYPE, CONDITION_TYPE, EXECUTION_RESULT_CODE, SUPPORTED_CONDITION_TYPES, DISPATCHABLE_TRIGGER_TYPES, CONDITION_DRIVEN_TRIGGER_TYPES } = require('./models/AutomationTask');
const { PowerService } = require('./PowerService');
const { TerminalActionVerifier } = require('./TerminalActionVerifier');
const crypto = require('crypto');
const fs = require('fs');
const log = require('../logger');

class TaskManager {
    constructor(storageService, warningManager, safetyPolicyEngine, historyService, webhookService, smartFinishEngine = null, metricCollector = null, powerService = null, timerRegistry = null) {
        this.storage = storageService;
        this.warningManager = warningManager;
        this.safetyPolicyEngine = safetyPolicyEngine;
        this.history = historyService;
        this.webhook = webhookService;
        // WBS-0.1: Smart Finish motoru ve metrik toplayıcı enjekte edilir.
        // Eksik verilirse condition dalı güvenli şekilde atlanır (fail-safe, sessiz geçilmez).
        this.smartFinishEngine = smartFinishEngine;
        this.metricCollector = metricCollector;
        // WBS-4.2: OS çağrıları test edilebilirlik için enjekte edilir.
        // Üretimde varsayılan gerçek PowerService; testlerde sahte nesne verilir.
        // (Doğrudan modül mock'una güvenilmez — çift modül kaydı riski.)
        this.power = powerService || PowerService;

        this.tasks = [];
        // WBS-2.2: Duraklatma kalıcıdır (yeniden başlatmada scheduler yedeği
        // duraklatılmışken tetiklenemez). Depoda yoksa false.
        this.pausedAll = !!(this.storage && typeof this.storage.getSettings === 'function' && this.storage.getSettings().automationPaused);
        // WBS-2.2: Scheduler köprüsü main.js tarafından sonradan takılır
        // (taskManager.schedulerBridge = ...). Takılı değilse yedekleme atlanır.
        this.schedulerBridge = null;
        this.loopInterval = null;
        // WP-02: tek-icra kilidi. Anahtar taskId, değer claim kaydıdır.
        // Claim senkrondur; await içermez. Böylece scheduler + runTaskNow
        // aynı tick'te yarışsa bile yalnızca biri kazanır.
        this.claims = new Map();
        // WP-02: Plan v2.0 sözleşmesindeki ad. Aynı Map'e işaret eder; iki ad
        // arasında durum kopyası oluşmaz (tek doğruluk kaynağı).
        this.executionClaims = this.claims;
        // WP-08.T3: renderer başarı toast'ını yalnızca bu olayla gösterir.
        this.resultListener = null;
        // WP-13.T5: tray/menü değişim sinyali (100 ms debounce main.js'de).
        this.changeListener = null;
        this.timerRegistry = timerRegistry;
        this._evaluating = false;
        // A6: kapatma/yeniden başlatma komutu "başarılı" dönse de Windows
        // oturumu anında kapatmaz; kaydedilmemiş işi olan uygulamalar vetosu
        // yalnızca süreç hâlâ ayaktayken gözlemlenebilir. Doğrulayıcı enjekte
        // edilebilir (test), üretimde varsayılan gerçek zamanlayıcıdır.
        this.terminalVerifier = new TerminalActionVerifier();
        this.vetoListener = null;
        // WP-11.T5: yalnızca değişen satırlar; tam liste yazımı yok.
        this._savedTaskState = new Map();

        this.init();
    }

    init() {
        // Load tasks from storage
        const rawTasks = this.storage.getTasks();
        this.tasks = rawTasks.map(t => new AutomationTask(t));
        this._savedTaskState = this._taskSnapshot();

        // Evaluate & Recover tasks after application restart
        this.recoverTasksOnStartup();

        // Start 1-second task evaluation loop
        this.startLoop();
    }

    // --- WP-02: atomik claim / token -------------------------------------

    claimTask(taskId, source = 'scheduler') {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || task.enabled === false) return { ok: false, code: 'NOT_FOUND' };
        if (this.pausedAll) return { ok: false, code: 'PAUSED' };
        if (this.claims.size > 0) return { ok: false, code: 'ALREADY_RUNNING' };
        const runnable = [TASK_STATUS.SCHEDULED, TASK_STATUS.MONITORING, TASK_STATUS.EXPIRED];
        if (!runnable.includes(task.status)) return { ok: false, code: 'NOT_RUNNABLE' };
        const token = crypto.randomUUID();
        this.claims.set(taskId, {
            token,
            source,
            phase: 'claimed',
            powerStarted: false,
            cancelRequested: false,
            claimedAt: Date.now()
        });
        return { ok: true, token, task };
    }

    isClaimValid(taskId, token) {
        const claim = this.claims.get(taskId);
        return !!(claim && token && claim.token === token && !claim.cancelRequested);
    }

    releaseTask(taskId, token = null) {
        const claim = this.claims.get(taskId);
        if (!claim) return false;
        if (token && claim.token !== token) return false;
        this.claims.delete(taskId);
        return true;
    }

    /** WP-08.T3: main.js bir kez bağlar; olay yalnızca terminal sonuçta yayınlanır. */
    setResultListener(fn) {
        this.resultListener = typeof fn === 'function' ? fn : null;
    }

    setChangeListener(fn) {
        this.changeListener = typeof fn === 'function' ? fn : null;
    }

    /**
     * A6: kapatma/yeniden başlatma Windows tarafından veto edildiğinde
     * (açık uygulamalar onay bekliyor) çağrılır. Renderer'a kullanıcı diliyle
     * rapor verilir; bu bir başarısızlık değil, engellenme raporudur.
     */
    setVetoListener(fn) {
        this.vetoListener = typeof fn === 'function' ? fn : null;
    }

    setTimerRegistry(registry) {
        this.timerRegistry = registry || null;
    }

    notifyResult(task, success) {
        if (!this.resultListener || !task) return;
        try {
            this.resultListener({
                taskId: task.id,
                name: task.name,
                action: task.action,
                success: success === true,
                status: task.status,
                code: task.lastResult && task.lastResult.code,
                message: task.errorInfo || (task.lastResult && task.lastResult.message) || null
            });
        } catch (err) {
            log.warn('[TaskManager] Sonuç dinleyicisi hata verdi:', err && err.message);
        }
    }

    handleExecutionError(task, err) {
        log.error(`[TaskManager] Görev hatası (${task && task.name}):`, err && err.message);
        if (!task) return;
        task.status = TASK_STATUS.FAILED;
        task.errorInfo = (err && err.message) || 'Beklenmeyen yürütme hatası.';
        task.lastResult = { code: EXECUTION_RESULT_CODE.OS_EXECUTION_FAILED, message: task.errorInfo };
        if (this.history) {
            this.history.record(task, EXECUTION_RESULT_CODE.OS_EXECUTION_FAILED, task.errorInfo);
        }
        this.persistChanges();
        this.notifyResult(task, false);
    }

    recoverTasksOnStartup() {
        const now = Date.now();
        log.info(`[TaskManager] Recovering ${this.tasks.length} tasks on startup...`);

        this.tasks.forEach(task => {
            // Terminalizasyon, görev devre dışı bırakılmış olsa bile yapılır.
            // Aksi halde disabled + EXECUTING/WARNING kaydı açılışta asılı kalır.
            if (task.status === TASK_STATUS.EXECUTING || task.status === TASK_STATUS.WARNING) {
                task.status = TASK_STATUS.FAILED;
                task.errorInfo = 'Uygulama beklenmedik şekilde kapandığı için işlem yarıda kaldı.';
                if (this.history) {
                    this.history.record(task, EXECUTION_RESULT_CODE.INTERRUPTED_BY_SHUTDOWN, 'App shutdown/crash');
                }
                return;
            }

            if (!task.enabled) return;

            // Y-02: tekrarlayan görevlerde önce sonraki occurrence hesaplanır;
            // yalnızca tekrarlamayan zamanlı görevler süre dolumundan etkilenir.
            const targetTime = task.trigger && task.trigger.targetTime;
            const timed = task.trigger && (task.trigger.type === TRIGGER_TYPE.DURATION ||
                task.trigger.type === TRIGGER_TYPE.SCHEDULED_TIME);

            if (task.recurrence && task.recurrence.enabled) {
                this.calculateNextRecurrence(task);
                if (task.status === TASK_STATUS.EXPIRED) task.status = TASK_STATUS.SCHEDULED;
            } else if (timed && targetTime && targetTime < now) {
                // Time has already passed -> set Expired (Do NOT auto-execute!)
                task.status = TASK_STATUS.EXPIRED;
                task.errorInfo = 'Zamanlanan an uygulama kapalıyken geçti; güvenlik için çalıştırılmadı.';
                task.lastResult = { code: EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, message: task.errorInfo };
                if (this.history) {
                    this.history.record(task, EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, task.errorInfo);
                }
                log.info(`[TaskManager] Task "${task.name}" expired during offline time.`);
            }
        });

        this.persistChanges();
    }

    calculateNextRecurrence(task) {
        if (!task.recurrence || !task.recurrence.enabled) return;

        const now = new Date();
        const [targetHour, targetMin] = String(task.recurrence.timeOfDay || '00:00')
            .split(':')
            .map((n) => Number(n));
        if (!Number.isInteger(targetHour) || !Number.isInteger(targetMin) ||
            targetHour < 0 || targetHour > 23 || targetMin < 0 || targetMin > 59) {
            log.warn(`[TaskManager] Geçersiz recurrence.timeOfDay: ${task.recurrence.timeOfDay}`);
            return;
        }

        const nextRun = new Date(now);
        nextRun.setHours(targetHour, targetMin, 0, 0);
        if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);

        const days = Array.isArray(task.recurrence.daysOfWeek)
            ? task.recurrence.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
            : [];
        const frequency = task.recurrence.frequency;
        const dayAllowed = (day) => {
            if (frequency === 'weekdays') return day >= 1 && day <= 5;
            if (frequency === 'weekends') return day === 0 || day === 6;
            if (frequency === 'weekly' || frequency === 'custom') {
                return days.length === 0 || days.includes(day);
            }
            return true;
        };

        // En fazla bir yıl ileri tara; bozuk gün listesi sonsuz döngü yapamaz.
        let guard = 0;
        while (!dayAllowed(nextRun.getDay()) && guard < 370) {
            nextRun.setDate(nextRun.getDate() + 1);
            guard += 1;
        }

        task.trigger.targetTime = nextRun.getTime();
        task.status = TASK_STATUS.SCHEDULED;
        // Y-04: bayrak yalnızca tek icra içindir; tekrarlayan görevin sonraki
        // çalışması kullanıcı uyarısını atlamamalı.
        delete task._schedulerFired;
    }

    /**
     * Uykudan/standby'dan dönüşte zaman çizelgesini yeniden senkronlar.
     *
     * Kullanıcı politikası (ayarlar: wakeMode / wakeToleranceMinutes):
     *  - 'run': hedef zamanı tolerans penceresi içinde kaçırıldıysa görev şimdi
     *    çalıştırılır (varsayılan 10 dk). Daha eski kaçırmalar atlanır.
     *  - 'skip': hiçbir kaçırılan görev otomatik çalışmaz; hepsi atlanır.
     *
     * Atlanan her görev kullanıcı dilinde bir nedenle geçmişe yazılır; sessiz
     * yutma yoktur. Tekrarlayan görevler takvimden düşmez, sonraki vakte taşınır.
     *
     * @returns {{ran: number, skipped: number, maxOverdueMinutes: number}}
     */
    resyncAfterResume({ mode = 'run', toleranceMinutes = 10 } = {}) {
        const now = Date.now();
        const tolerance = Math.max(0, Math.min(1440, Number(toleranceMinutes) || 0));
        const toleranceMs = tolerance * 60000;
        const ready = [];
        let skipped = 0;
        let maxOverdueMinutes = 0;

        for (const task of this.tasks) {
            if (!task || task.enabled === false) continue;
            if (task.status !== TASK_STATUS.SCHEDULED) continue;
            const conds = (task.conditionGroup && task.conditionGroup.conditions) || [];
            if (conds.length > 0) continue; // koşullu görevler Smart Finish ile izlenir
            const target = Number(task.trigger && task.trigger.targetTime);
            if (!Number.isFinite(target) || target <= 0 || target > now) continue;

            const overdueMs = now - target;
            const overdueMinutes = Math.floor(overdueMs / 60000);
            maxOverdueMinutes = Math.max(maxOverdueMinutes, overdueMinutes);

            if (mode === 'run' && overdueMs <= toleranceMs) {
                task.lastProgressMessage = 'Uykudan dönüşte tolerans içinde çalıştırılıyor';
                ready.push(task);
                continue;
            }

            const recurring = !!(task.recurrence && task.recurrence.enabled);
            task.errorInfo = recurring
                ? `Uyku sırasında zamanı geçti (${overdueMinutes} dk); sonraki tekrara taşındı.`
                : `Uyku sırasında zamanı geçti (${overdueMinutes} dk); tolerans ${tolerance} dk olduğu için atlandı.`;
            task.lastResult = { code: EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, message: task.errorInfo };
            if (recurring) {
                this.calculateNextRecurrence(task);
            } else {
                task.status = TASK_STATUS.EXPIRED;
            }
            if (this.history) {
                this.history.record(task, EXECUTION_RESULT_CODE.MISSED_WHILE_ASLEEP, task.errorInfo);
            }
            skipped += 1;
        }

        if (skipped > 0) this.persistChanges();
        if (ready.length > 0) {
            this.handleTaskExecution(ready);
        }
        if (skipped > 0 || ready.length > 0) {
            log.info(`[TaskManager] Uykudan dönüş: ${ready.length} çalıştırıldı, ${skipped} atlandı (mod=${mode}, tolerans=${tolerance}dk).`);
        }
        return { ran: ready.length, skipped, maxOverdueMinutes };
    }

    startLoop() {
        if (this.loopInterval) clearInterval(this.loopInterval);

        const schedule = this.timerRegistry
            ? this.timerRegistry.setInterval.bind(this.timerRegistry)
            : setInterval;
        this.loopInterval = schedule(() => {
            // P1-8: klasör taraması asenkron önden yüklenir. Senkron tarama
            // 1 sn'lik döngünün içinde ana süreci kilitliyordu; artık önbellek
            // ısıtılır ve değerlendirme bir sonraki turda önbellekten okur.
            if (this.smartFinishEngine && typeof this.smartFinishEngine.prefetchDirectoryScans === 'function') {
                Promise.resolve(this.smartFinishEngine.prefetchDirectoryScans(this.tasks))
                    .catch(() => { /* önbellek ısıtma best-effort */ });
            }
            this.evaluateTasks();
        }, 1000);
    }

    evaluateTasks() {
        if (this.pausedAll) return;
        // Reentrancy guard: 1sn'lik tick üst üste binerse aynı görev iki kez
        // değerlendirilmez. Bu guard await içermez; scheduler senkron kalır.
        if (this._evaluating) return;
        this._evaluating = true;

        try {
            const now = Date.now();
            const readyToExecute = [];

            this.tasks.forEach(task => {
                if (!task.enabled || task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELLED || task.status === TASK_STATUS.BLOCKED || task.status === TASK_STATUS.EXPIRED || task.status === TASK_STATUS.FAILED) {
                    return;
                }

                // Time-based trigger check — YALNIZCA koşulsuz görevler.
                // ADR-09/K-04: koşullu görevde targetTime yoktur; erteleme notBefore'tadır.
                const hasConditions = !!(task.conditionGroup && Array.isArray(task.conditionGroup.conditions) && task.conditionGroup.conditions.length > 0);
                if (!hasConditions && task.trigger.targetTime && now >= task.trigger.targetTime && task.status === TASK_STATUS.SCHEDULED) {
                    readyToExecute.push(task);
                    return;
                }

                // WBS-0.1: Condition-based (Smart Finish) trigger check.
                // MONITORING veya koşullu SCHEDULED görevler her döngüde değerlendirilir.
                if (hasConditions && (task.status === TASK_STATUS.MONITORING || task.status === TASK_STATUS.SCHEDULED)) {
                    // WP-06.T5: notBefore geçilmeden koşul değerlendirilmez.
                    const notBefore = Number(task.trigger.notBefore);
                    if (Number.isFinite(notBefore) && notBefore > 0 && now < notBefore) {
                        task.lastProgressMessage = `Erteleme: ${Math.ceil((notBefore - now) / 1000)} sn kaldı`;
                        return;
                    }
                    if (!this.smartFinishEngine) return;
                    // WBS-11.5: Açılış koruması — sessizlik-tipi koşullarda ilk 120sn atlanır.
                    // Tracker'a dokunulmaz, history şişirilmez; yalnızca bu tur pas geçilir.
                    if (this.hasIdleLikeCondition(task) && this.safetyPolicyEngine &&
                        typeof this.safetyPolicyEngine.isBootGuardActive === 'function' &&
                        this.safetyPolicyEngine.isBootGuardActive()) {
                        task.lastProgressMessage = 'Açılış koruması devrede';
                        return;
                    }
                    try {
                        const verdict = this.smartFinishEngine.evaluateTask(task);
                        task.lastProgressMessage = verdict.progressMessage;
                        if (task.status !== TASK_STATUS.MONITORING) {
                            task.status = TASK_STATUS.MONITORING;
                            this.persistChanges();
                        }
                        if (verdict.satisfied) {
                            readyToExecute.push(task);
                        }
                    } catch (err) {
                        task.status = TASK_STATUS.FAILED;
                        task.errorInfo = `Smart Finish değerlendirme hatası: ${err.message}`;
                        if (this.history) {
                            this.history.record(task, EXECUTION_RESULT_CODE.CONDITION_INVALID, task.errorInfo);
                        }
                        this.persistChanges();
                    }
                }
            });

            // O-09: silinen görevlerin Smart Finish örnekleri bellekte birikmesin.
            if (this.smartFinishEngine && typeof this.smartFinishEngine.prune === 'function') {
                try { this.smartFinishEngine.prune(new Set(this.tasks.map((t) => t.id))); } catch (_) { /* yut */ }
            }

            if (readyToExecute.length > 0) {
                // ÖNEMLİ: await YOK. Bu çağrı senkron claim alır ve promise'i
                // ateşleyip bırakır; scheduler tick'i OS işlemini beklemez.
                this.handleTaskExecution(readyToExecute);
            }
        } finally {
            this._evaluating = false;
        }
    }

    blockTask(task, primaryTask, reason) {
        if (!task) return;
        task.status = TASK_STATUS.BLOCKED;
        task.errorInfo = reason || (primaryTask
            ? `Çakışan görev: "${primaryTask.name}" daha önce çalıştırıldı.`
            : 'Başka bir görev yürütülüyor.');
        if (this.history) {
            this.history.record(task, EXECUTION_RESULT_CODE.BLOCKED_BY_POLICY, task.errorInfo);
        }
        if (this.webhook) this.webhook.triggerEvent('task_blocked', task);
        this.removeScheduler(task.id);

        // Tekrarlayan görev bloklandığı için takvimden düşmez; sonraki
        // uygun vakti hesaplanır. Tek seferlik görev BLOCKED kalır.
        if (task.recurrence && task.recurrence.enabled) {
            this.calculateNextRecurrence(task);
            this.syncScheduler(task);
        }
    }

    handleTaskExecution(taskList) {
        if (!Array.isArray(taskList) || taskList.length === 0) return;

        const ordered = taskList.slice().sort((a, b) => {
            if (a.source === 'user_interface' && b.source !== 'user_interface') return -1;
            if (b.source === 'user_interface' && a.source !== 'user_interface') return 1;
            return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        });

        // Global tek-icra politikası: bir görev çalışıyorsa yeni görev başlatılmaz.
        if (this.claims.size > 0) {
            for (const task of ordered) this.blockTask(task, null, 'Başka bir görev yürütülüyor; bu görev bloklandı.');
            this.persistChanges();
            return;
        }

        let primaryTask = null;
        let claim = null;
        for (const candidate of ordered) {
            const result = this.claimTask(candidate.id, 'scheduler');
            if (result.ok) {
                primaryTask = candidate;
                claim = result;
                break;
            }
        }
        if (!primaryTask || !claim) return;

        // Uzaktan kaynaklı görevlerde uyarı süresi dolarsa devam edilir
        // (kullanıcı başında olmayabilir); klasik UI görevinde durur.
        if ([TASK_SOURCE.LOCAL_API, TASK_SOURCE.N8N, TASK_SOURCE.CONSOLE].includes(primaryTask.source)) {
            primaryTask._schedulerFired = true;
        }

        for (const task of ordered) {
            if (task.id === primaryTask.id) continue;
            this.blockTask(task, primaryTask);
        }
        this.persistChanges();

        //Fire-and-forget: await edilmez; hata executeTask içinde yakalanır.
        Promise.resolve(this.executeTask(primaryTask, claim.token)).catch((err) => {
            this.handleExecutionError(primaryTask, err);
        });
    }

    async executeTask(task, token = null) {
        if (!task) return;

        // Doğrudan çağrı (test/CLI) claim sahibi değilse kendi claim'ini alır.
        // Böylece iki eşzamanlı doğrudan çağrı da çift icra edemez.
        let directClaim = false;
        if (!token) {
            const acquired = this.claimTask(task.id, 'direct');
            if (!acquired.ok) {
                log.info(`[TaskManager] executeTask reddedildi (${acquired.code}): ${task.id}`);
                return;
            }
            token = acquired.token;
            directClaim = true;
        }
        void directClaim;

        const claim = this.claims.get(task.id);
        if (!claim || claim.token !== token) return;

        log.info(`[TaskManager] Initiating task execution: ${task.name} (${task.action})`);

        try {
            // Check Safety Policies
            claim.phase = 'safety';
            if (this.safetyPolicyEngine) {
                const safetyCheck = await this.safetyPolicyEngine.evaluate(task);
                if (!this.isClaimValid(task.id, token)) return;
                if (!safetyCheck.allowed) {
                    task.status = TASK_STATUS.BLOCKED;
                    task.errorInfo = safetyCheck.reason || 'Güvenlik politikası engelledi.';
                    task.lastResult = { code: EXECUTION_RESULT_CODE.BLOCKED_BY_POLICY, message: task.errorInfo };
                    if (this.history) {
                        this.history.record(task, EXECUTION_RESULT_CODE.BLOCKED_BY_POLICY, task.errorInfo);
                    }
                    if (this.webhook) this.webhook.triggerEvent('task_blocked', task);
                    this.removeScheduler(task.id);
                    this.persistChanges();
                    this.notifyResult(task, false);
                    return;
                }
            }

            // Warning Modal / Countdown check
            // P1-6: uzaktan gelen görev + `remoteApprovalRequired` → yerel insan
            // onayı ZORUNLUDUR. Uyarı ayarı kapalı olsa bile bir onay penceresi
            // açılır ve sayaç dolarsa eylem İPTAL edilir (fail-closed).
            const requireLocalApproval = this.resolveRemoteApproval(task);
            let warningTask = task;
            if (requireLocalApproval && !(task.warningConfig && task.warningConfig.requireConfirmation === true)) {
                const base = (task.warningConfig && typeof task.warningConfig === 'object') ? task.warningConfig : {};
                const rawSec = Number.isInteger(base.durationSeconds) ? base.durationSeconds : 60;
                warningTask = {
                    ...task,
                    warningConfig: {
                        ...base,
                        enabled: true,
                        requireConfirmation: true,
                        durationSeconds: Math.min(Math.max(rawSec, 30), 300)
                    }
                };
            }
            if (warningTask.warningConfig && warningTask.warningConfig.enabled && this.warningManager) {
                claim.phase = 'warning';
                task.status = TASK_STATUS.WARNING;
                this.persistChanges();

                if (this.webhook) this.webhook.triggerEvent('task_warning_started', task);

                const warningConfirmed = await this.warningManager.showWarning(warningTask);
                // İptal, warning await'i sırasında geldiyse token geçersizdir.
                if (!this.isClaimValid(task.id, token)) return;

                if (!warningConfirmed || !warningConfirmed.proceed) {
                    if (warningConfirmed && warningConfirmed.snoozed) {
                        const applied = this.applySnooze(task, warningConfirmed.minutes);
                        if (applied.ok && this.history) {
                            this.history.record(task, EXECUTION_RESULT_CODE.SNOOZED_BY_USER, `${applied.minutes} dk ertelendi`);
                        }
                        if (applied.ok && this.webhook) this.webhook.triggerEvent('task_snoozed', task);
                        if (!applied.ok) {
                            task.status = TASK_STATUS.CANCELLED;
                            task.errorInfo = applied.message || 'Erteleme reddedildi.';
                            if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.CANCELLED_BY_USER, task.errorInfo);
                        }
                        this.syncScheduler(task);
                    } else {
                        task.status = TASK_STATUS.CANCELLED;
                        if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.CANCELLED_BY_USER, 'Kullanıcı İptal Etti');
                        if (this.webhook) this.webhook.triggerEvent('task_cancelled', task);
                        this.removeScheduler(task.id);
                    }
                    this.persistChanges();
                    return;
                }
            }

            // Final OS Execution
            claim.phase = 'executing';
            task.status = TASK_STATUS.EXECUTING;
            task.lastRunAt = new Date().toISOString();
            this.persistChanges();

            if (this.webhook) this.webhook.triggerEvent('power_action_started', task);

            // L-13: iptal penceresi OS çağrısına kadar açık kalır. Bayrak
            // execute'tan hemen önce set edilir; bu arada gelen iptal kazanır.
            claim.powerStarted = true;
            if (claim.cancelRequested) {
                claim.powerStarted = false;
                this.persistChanges();
                return;
            }

            let result;
            try {
                // P1-6: `forceCloseApps` (Ayarlar) artık gerçekten uygulanır:
                // açık uygulamalar kapanmayı veto ediyorsa /f ile zorla kapatılır.
                // Görev düzeyinde `safetyPolicy.forceCloseApps` ayarı ezer.
                const forceClose = this.resolveForceClose(task);
                // P1-6: "Açık Uygulamalar İçin Bekleme Süresi" (graceSeconds)
                // artık gerçekten uygulanır: Windows'un yerel gecikmesi (`/t n`)
                // kullanılır; bu pencerede `shutdown /a` ile iptal edilebilir.
                const graceSeconds = this.resolveGraceSeconds(task);
                if (graceSeconds > 0) {
                    claim.graceUntil = Date.now() + graceSeconds * 1000;
                }
                result = await this.power.execute(task.action, { forceClose, graceSeconds });
            } catch (err) {
                result = { success: false, error: err && err.message ? err.message : 'Güç işlemi hatası.' };
            }

            // WP-9: Ana güç eylemi başarısızsa ve ayarlı yedek eylem (fallbackAction) uygunsa dene.
            let usedFallback = null;
            if ((!result || !result.success) && this.storage && typeof this.storage.getSettings === 'function') {
                try {
                    const fb = this.storage.getSettings().fallbackAction;
                    let targetFb = null;
                    const RETRY_ONCE_DELAY_MS = 30000;
                    if (fb === 'hibernate_to_sleep' && task.action === 'hibernate') targetFb = 'sleep';
                    else if (fb === 'sleep_to_lock' && task.action === 'sleep') targetFb = 'lock';
                    else if (fb === 'retry_once') targetFb = task.action;
                    else if (fb && fb !== 'none' && fb !== task.action && ['sleep', 'hibernate', 'lock'].includes(fb)) targetFb = fb;
                    if (targetFb) {
                        // P1-6: README "30 sn sonra yeniden dene" diyordu ama kod
                        // 0 ms'de anında tekrar deniyordu. Artık gerçekten beklenir;
                        // iptal bu pencerede de kazanır.
                        if (fb === 'retry_once') {
                            const canceledDuringRetry = await this.waitForRetryDelay(RETRY_ONCE_DELAY_MS);
                            if (canceledDuringRetry || !this.isClaimValid(task.id, token)) {
                                this.persistChanges();
                                return;
                            }
                        }
                        log.warn(`[TaskManager] Ana eylem (${task.action}) başarısız; yedek eylem deneniyor: ${targetFb}`);
                        const fbRes = await this.power.execute(targetFb);
                        if (fbRes && fbRes.success) {
                            result = fbRes;
                            usedFallback = fb === 'retry_once' ? 'retry_once' : targetFb;
                        }
                    }
                } catch (_) { /* ana hata korunur */ }
            }

            // OS çağrısı başladıktan sonra iptal "çok geç"tir; sonuç yine yazılır.
            const cancelTooLate = claim.cancelRequested === true;

            if (result && result.success) {
                task.status = TASK_STATUS.COMPLETED;
                task.errorInfo = null;
                task.lastResult = {
                    code: EXECUTION_RESULT_CODE.SUCCESS,
                    message: usedFallback ? `Yedek eylem (${usedFallback}) çalıştırıldı` : 'Başarıyla çalıştırıldı',
                    ...(usedFallback ? { fallbackAction: usedFallback } : {}),
                    ...(cancelTooLate ? { note: 'CANCEL_TOO_LATE' } : {})
                };
                if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.SUCCESS, usedFallback ? `Yedek eylem: ${usedFallback}` : 'Başarılı');
                this.notifyResult(task, true);

                // A6: kapatma komutu döndü ama oturum kapanmadıysa Windows
                // engellemiştir. Doğrulayıcı pencere dolarsa rapor verilir;
                // süreç gerçekten kapanırsa timer hiç çalışmaz.
                // P1-6: yerel gecikme (`/t n`) doğrulama penceresine eklenir;
                // meşru bekleme "engellendi" diye yanlış raporlanmaz.
                this.armTerminalVetoCheck(task, Number.isFinite(claim.graceUntil) && claim.graceUntil > Date.now()
                    ? claim.graceUntil - Date.now()
                    : 0);

                if (task.recurrence && task.recurrence.enabled) {
                    this.calculateNextRecurrence(task);
                    this.syncScheduler(task);
                } else {
                    this.removeScheduler(task.id);
                    this.spawnChainLink(task);
                }
            } else {
                task.status = TASK_STATUS.FAILED;
                task.errorInfo = (result && result.error) || 'Güç işlemi çalıştırılamadı.';
                // P1-6 (üçüncü tur): hata nedeni artık korunur. Eskiden her
                // başarısızlık `os_execution_failed` idi; `timeout` ve
                // `authorization_error` kodları hiç üretilmiyordu (etiketleri
                // ve sağlık sınıflandırması olmasına rağmen).
                const failureCode = this.mapPowerFailureCode(result && result.code);
                task.lastResult = {
                    code: failureCode,
                    message: task.errorInfo,
                    ...(cancelTooLate ? { note: 'CANCEL_TOO_LATE' } : {})
                };
                if (this.history) this.history.record(task, failureCode, task.errorInfo);
                this.notifyResult(task, false);
                this.removeScheduler(task.id);
            }
        } catch (err) {
            this.handleExecutionError(task, err);
        } finally {
            // L-10: tek release + tek save; dallanma yok.
            this.releaseTask(task.id, token);
            this.persistChanges();
        }
    }

    // A6: kapatma/yeniden başlatma vetosu. Komut başarı dönse de Windows
    // oturumu hemen kapatmazsa (açık uygulamalar onay bekliyorsa) kısa bir
    // pencere sonunda süreç hâlâ ayaktadır ve engellenme raporlanır.
    armTerminalVetoCheck(task, extraMs = 0) {
        if (!task || !this.terminalVerifier) return false;
        if (!TerminalActionVerifier.isTerminalAction(task.action)) return false;
        const expectedRun = task.lastRunAt;
        return this.terminalVerifier.arm(task.action, (action) => {
            // Timer çalıştığına göre süreç ayakta: oturum kapanmadı.
            // Aynı görev bu arada yeniden çalıştırıldıysa eski rapor geçersiz.
            if (task.lastRunAt !== expectedRun) return;
            log.warn(`[TaskManager] Kapatma engellendi (açık uygulamalar): ${task.name} (${action})`);
            if (this.vetoListener) {
                try {
                    this.vetoListener({
                        taskId: task.id,
                        name: task.name,
                        action,
                        code: 'SHUTDOWN_VETOED'
                    });
                } catch (err) {
                    log.warn('[TaskManager] Veto dinleyicisi hata verdi:', err && err.message);
                }
            }
        }, extraMs);
    }

    // WBS-11.5: Açılışta yanlış tetiklenebilen sessizlik-tipi koşullar.
    hasIdleLikeCondition(task) {
        const conds = (task.conditionGroup && task.conditionGroup.conditions) || [];
        return conds.some(c => c && (c.type === 'user_idle' || c.type === 'network_speed' ||
            c.type === 'disk_activity' || c.type === 'cpu_usage'));
    }

    // WBS-2.2: Scheduler yedeği best-effort'tur; köprü yoksa veya kayıt
    // reddedilirse sessizce atlanır (birincil döngü etkilenmez).
    syncScheduler(task) {
        if (this.schedulerBridge && typeof this.schedulerBridge.syncTask === 'function') {
            // O-13: fallback yazılamazsa sessizce kaybolmaz; loglanır.
            // Köprü senkron fırlatırsa da görev hattı durmaz (best-effort).
            try {
                Promise.resolve(this.schedulerBridge.syncTask(task))
                    .then((ok) => {
                        if (ok === false) log.warn(`[TaskManager] Scheduler fallback yazılamadı: ${task && task.id}`);
                    })
                    .catch((err) => log.warn(`[TaskManager] Scheduler hatası: ${err && err.message}`));
            } catch (err) {
                log.warn(`[TaskManager] Scheduler hatası: ${err && err.message}`);
            }
        }
    }

    removeScheduler(taskId) {
        if (this.schedulerBridge && typeof this.schedulerBridge.removeTask === 'function' && taskId) {
            try {
                Promise.resolve(this.schedulerBridge.removeTask(taskId)).catch(() => {});
            } catch (_) { /* best-effort */ }
        }
    }

    /**
     * P1-6: `remoteApprovalRequired` çözümü. Uzaktan gelen (REST API / n8n /
     * konsol) güç görevleri, ayar açıksa YEREL bir insan onayı olmadan
     * çalışmaz. Onay penceresi, `warningConfig.requireConfirmation` semantiğiyle
     * çalışır: sayaç dolarsa eylem İPTAL edilir (fail-closed).
     * @param {AutomationTask} task
     * @returns {boolean}
     */
    resolveRemoteApproval(task) {
        if (!task) return false;
        const remoteSources = [TASK_SOURCE.LOCAL_API, TASK_SOURCE.N8N, TASK_SOURCE.CONSOLE];
        if (!remoteSources.includes(task.source)) return false;
        // P1-6: yalnızca kullanıcının AÇIKÇA verdiği görev-düzeyi değer ezer.
        if (AutomationTask.isExplicitPolicy(task, 'remoteApprovalRequired')) {
            return task.safetyPolicy.remoteApprovalRequired === true;
        }
        try {
            const settings = this.storage && typeof this.storage.getSettings === 'function'
                ? this.storage.getSettings()
                : {};
            return settings && settings.remoteApprovalRequired === true;
        } catch (_) {
            return false;
        }
    }

    /**
     * K-04: otonomi modu tek kaynaktan (kalıcı ayarlar) okunur. İstemci
     * payload'ındaki `mode` yok sayılır; ayar okunamazsa güvenli varsayılan
     * `classic` kullanılır.
     */
    resolveAutonomyMode() {
        try {
            const settings = this.storage && typeof this.storage.getSettings === 'function'
                ? this.storage.getSettings()
                : {};
            return settings && settings.autonomyMode === 'full' ? 'full' : 'classic';
        } catch (_) {
            return 'classic';
        }
    }

    /**
     * P1-6: `forceCloseApps` çözümü. Görev düzeyi `safetyPolicy.forceCloseApps`
     * açıkça verilmişse o kazanır; yoksa kalıcı ayar okunur.
     * @param {AutomationTask} task
     * @returns {boolean}
     */
    resolveForceClose(task) {
        // P1-6: yalnızca AÇIKÇA verilmiş görev-düzeyi değer kalıcı ayarı ezer.
        if (AutomationTask.isExplicitPolicy(task, 'forceCloseApps')) {
            return task.safetyPolicy.forceCloseApps === true;
        }
        try {
            const settings = this.storage && typeof this.storage.getSettings === 'function'
                ? this.storage.getSettings()
                : {};
            return settings && settings.forceCloseApps === true;
        } catch (_) {
            return false;
        }
    }

    /**
     * P1-6: `graceSeconds` ("Açık Uygulamalar İçin Bekleme Süresi") çözümü.
     * Yalnızca oturum sonlandıran eylemlerde (shutdown/restart/signout) anlamlıdır;
     * Windows `shutdown /t n` bu pencereyi OS düzeyinde uygular.
     * Görev düzeyi `safetyPolicy.graceSeconds` ayarı varsa o kazanır.
     * @param {AutomationTask} task
     * @returns {number} saniye (0 = gecikme yok)
     */
    resolveGraceSeconds(task) {
        const terminal = task && ['shutdown', 'restart', 'signout'].includes(task.action);
        if (!terminal) return 0;
        const clamp = (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return 0;
            return Math.min(Math.round(n), 600);
        };
        // `graceSeconds` varsayılanlarda YOK; verilmişse zaten gerçek bir tercihtir.
        // Yine de işaret varsa ona uyulur (tutarlılık).
        const explicit = task.safetyPolicyExplicit;
        const hasTaskLevel = task && task.safetyPolicy && task.safetyPolicy.graceSeconds !== undefined
            && (!explicit || typeof explicit !== 'object' || explicit.graceSeconds !== false);
        if (hasTaskLevel) {
            return clamp(task.safetyPolicy.graceSeconds);
        }
        try {
            const settings = this.storage && typeof this.storage.getSettings === 'function'
                ? this.storage.getSettings()
                : {};
            return clamp(settings && settings.graceSeconds);
        } catch (_) {
            return 0;
        }
    }

    /**
     * P1-6 (üçüncü tur): PowerService hata sınıfını yürütme sonuç koduna çevirir.
     *
     * `EXECUTION_RESULT_CODE` içinde `timeout` ve `authorization_error` zaten
     * tanımlıydı, 17 dilde etiketleri vardı ve `HealthMetrics` bunları
     * başarısızlık olarak sayıyordu — ama hiçbir kod yolu bu değerleri
     * üretmiyordu; her şey `os_execution_failed` oluyordu. Kullanıcı zaman
     * aşımını yetki reddinden ayırt edemiyordu.
     *
     * @param {string|undefined} code PowerService.POWER_ERROR değeri
     * @returns {string} EXECUTION_RESULT_CODE değeri
     */
    mapPowerFailureCode(code) {
        switch (code) {
            case 'POWER_TIMEOUT':
                return EXECUTION_RESULT_CODE.TIMEOUT;
            case 'POWER_AUTHORIZATION':
                return EXECUTION_RESULT_CODE.AUTHORIZATION_ERROR;
            case 'POWER_BLOCKED':
                return EXECUTION_RESULT_CODE.BLOCKED_BY_POLICY;
            default:
                return EXECUTION_RESULT_CODE.OS_EXECUTION_FAILED;
        }
    }

    /**
     * P1-6: `retry_once` yedeği için gerçek bekleme penceresi.
     * Bekleme sırasında görev iptal edilirse `true` döner; çağıran tekrar
     * denemeden vazgeçer. Zamanlayıcı unref edilir (uygulama kapanışını tutmaz).
     * @param {number} ms
     * @returns {Promise<boolean>} iptal edildiyse true
     */
    waitForRetryDelay(ms) {
        const delay = Number.isInteger(ms) && ms > 0 ? ms : 30000;
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(false), delay);
            if (timer && typeof timer.unref === 'function') timer.unref();
        });
    }

    /**
     * P1-6 (üçüncü tur): "kabul edildi ama hiç çalışmaz" görev üretimini engeller.
     *
     * Denetim kanıtı: doğrulayıcı 13 trigger türünü kabul ediyordu ama
     * `evaluateTasks` yalnızca `duration` ve `scheduled_time` türlerini
     * `targetTime` üzerinden dağıtıyor. Diğer 10 türle oluşturulan görev
     * `draft` durumunda kalıyor, hiç tetiklenmiyor ve hata da üretmiyordu.
     *
     * Kurallar (hepsi fail-closed):
     *  - `duration`  → geçerli `durationMs` zorunlu.
     *  - `scheduled_time` → hedef zaman zorunlu (tekrarlayan görevde sunucu
     *    tarafından `calculateNextRecurrence` ile üretilir, o yüzden muaf).
     *  - koşul-güdümlü türler (`composite`, `cpu_threshold`, ...) → en az bir
     *    koşul zorunlu; koşul yoksa görev anlamsızdır.
     *  - `recurring` → trigger türü değildir; `scheduled_time` + `recurrence`
     *    kullanılmalıdır.
     *  - Bilinmeyen tür → reddedilir.
     *
     * @param {object} taskData
     * @param {Array} conditions
     */
    assertTriggerIsExecutable(taskData, conditions) {
        const trigger = taskData && taskData.trigger;
        // Trigger hiç verilmezse model varsayılanı (duration, 1 saat) uygulanır.
        if (!trigger || typeof trigger !== 'object') return;
        const type = trigger.type;
        if (type === undefined) return;

        const reject = (code, message) => {
            const err = new Error(message);
            err.code = code;
            throw err;
        };

        if (DISPATCHABLE_TRIGGER_TYPES.has(type)) {
            if (type === TRIGGER_TYPE.DURATION) {
                if (!Number.isInteger(trigger.durationMs) || trigger.durationMs <= 0) {
                    reject('INVALID_TRIGGER', 'Süre tetikleyicisi pozitif durationMs gerektirir.');
                }
                return;
            }
            // scheduled_time: tekrarlayan görevde hedef sunucuda hesaplanır.
            const recurring = !!(taskData.recurrence && taskData.recurrence.enabled);
            if (!Number.isInteger(trigger.targetTime) || trigger.targetTime <= 0) {
                if (!recurring) {
                    reject('INVALID_TRIGGER', 'Zamanlanmış tetikleyici geçerli targetTime gerektirir.');
                }
            }
            return;
        }

        if (CONDITION_DRIVEN_TRIGGER_TYPES.has(type)) {
            if (!Array.isArray(conditions) || conditions.length === 0) {
                reject('UNSUPPORTED_TRIGGER',
                    `"${type}" tetikleyicisi en az bir koşul gerektirir; koşulsuz görev hiçbir zaman çalışmaz.`);
            }
            return;
        }

        if (type === TRIGGER_TYPE.RECURRING) {
            reject('UNSUPPORTED_TRIGGER',
                '"recurring" bir tetikleyici türü değildir; trigger.type="scheduled_time" + recurrence kullanın.');
        }

        reject('UNSUPPORTED_TRIGGER', `Desteklenmeyen tetikleyici türü: ${type}`);
    }

    createTask(taskData) {
        // Y-10: aynı konsol siparişi (nonce) iki kez görev üretmez.
        if (taskData && typeof taskData.consoleOrderId === 'string' && taskData.consoleOrderId) {
            const existing = this.tasks.find((t) => t && t.consoleOrderId === taskData.consoleOrderId);
            if (existing) return existing;
        }
        // WBS-1.2: Desteksiz koşul tipi erken reddedilir. Sessiz "Bilinmeyen koşul" akışı yasaktır.
        const conditions = (taskData && taskData.conditionGroup && taskData.conditionGroup.conditions) || [];
        for (const cond of conditions) {
            if (!SUPPORTED_CONDITION_TYPES.has(cond.type)) {
                const err = new Error(`Desteklenmeyen koşul tipi: ${cond.type}`);
                err.code = 'UNSUPPORTED_CONDITION';
                throw err;
            }
        }
        // P1-6 (üçüncü tur): SESSİZ NO-OP KAPISI.
        //
        // Zamanlayıcı yalnızca iki türü targetTime'a çevirebiliyor. Eskiden
        // doğrulayıcı 13 türü kabul ediyordu; diğer 10 türle gelen görev
        // `draft` durumunda kalıp hiç tetiklenmiyor, hata da üretmiyordu.
        // Kullanıcı görevi oluşturuyor ("kaydedildi"), ömrü boyunca hiçbir şey
        // olmuyor. Artık bu durum sessizce kabul edilmez.
        this.assertTriggerIsExecutable(taskData, conditions);
        // WP-07.T3: eski `file_stable` klasör görevleri `directory_idle`'a çevrilir.
        // Klasör mtime'ı indirme sırasında sabit kalabildiği için erken kapanma olurdu.
        const normalizedData = taskData && taskData.conditionGroup
            ? {
                ...taskData,
                conditionGroup: {
                    ...taskData.conditionGroup,
                    conditions: conditions.map((cond) => {
                        if (!cond || cond.type !== CONDITION_TYPE.FILE_STABLE || typeof cond.filePath !== 'string') return cond;
                        try {
                            if (fs.statSync(cond.filePath).isDirectory()) {
                                const { filePath, ...rest } = cond;
                                return { ...rest, type: CONDITION_TYPE.DIRECTORY_IDLE, dirPath: filePath };
                            }
                        } catch (_) { /* yol yoksa fail-closed kalır */ }
                        return cond;
                    })
                }
            }
            : taskData;
        const defaultPrewarn = (() => {
            try {
                const s = this.storage && typeof this.storage.getSettings === 'function' ? this.storage.getSettings() : {};
                return Number.isInteger(s.prewarnSeconds) && s.prewarnSeconds >= 0 && s.prewarnSeconds <= 300 ? s.prewarnSeconds : null;
            } catch (_) {
                return null;
            }
        })();
        const taskInput = {
            ...normalizedData,
            // K-04: mod istemci payload'ından değil, kalıcı güvenlik ayarından gelir.
            mode: this.resolveAutonomyMode(),
            // ADR-08: gelen `id` ne olursa olsun sunucu yeni kimlik üretir.
            id: AutomationTask.generateId()
        };
        if (defaultPrewarn !== null && (!taskInput.warningConfig || taskInput.warningConfig.durationSeconds === undefined)) {
            taskInput.warningConfig = {
                enabled: defaultPrewarn > 0,
                durationSeconds: defaultPrewarn,
                ...(taskInput.warningConfig || {})
            };
        }
        const task = new AutomationTask(taskInput);
        const hasConditions = !!(task.conditionGroup && Array.isArray(task.conditionGroup.conditions) && task.conditionGroup.conditions.length > 0);
        if (hasConditions) {
            // ADR-09 invariant: koşullu görev Windows'a/timer'a çevrilmez.
            // targetTime yalnızca koşulsuz görevlerin alanıdır; yanlışlıkla
            // verilmişse temizlenir ve görev monitoring'de kalır.
            task.trigger.targetTime = null;
            if (task.status === TASK_STATUS.DRAFT || task.status === TASK_STATUS.SCHEDULED) {
                task.status = TASK_STATUS.MONITORING;
            }
        } else if (task.trigger.type === TRIGGER_TYPE.DURATION && task.trigger.durationMs) {
            task.trigger.targetTime = Date.now() + task.trigger.durationMs;
            task.status = TASK_STATUS.SCHEDULED;
        } else if (task.trigger.type === TRIGGER_TYPE.SCHEDULED_TIME && Number.isInteger(task.trigger.targetTime)) {
            // WBS-6.x: Belirli saat görevleri hedef zamanla SCHEDULED başlar.
            // Geçmiş zamanlıysa recovery döngüsü EXPIRED işaretler (otomatik çalışmaz).
            task.status = TASK_STATUS.SCHEDULED;
        }
        // Tekrarlayan görevde İLK occurrence da sunucuda hesaplanır. İstemcinin
        // gönderdiği hedef yalnızca saat bilgisi taşır; gün kısıtı (hafta sonu /
        // özel günler) yok sayılırsa görev yanlış günde tetiklenirdi.
        if (!hasConditions && task.recurrence && task.recurrence.enabled) {
            const before = task.trigger.targetTime;
            this.calculateNextRecurrence(task);
            if (!Number.isFinite(task.trigger.targetTime) && Number.isFinite(before)) {
                // Bozuk recurrence yapılandırması görevi kaybettirmez; verilen
                // hedef korunur (calculateNextRecurrence uyarı loglar).
                task.trigger.targetTime = before;
                task.status = TASK_STATUS.SCHEDULED;
            }
        }
        this.tasks.push(task);
        try {
            // Y-06: kalıcılaştırma başarısızsa görev bellekte bırakılmaz.
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            this.tasks.pop();
            throw Object.assign(new Error('Görev kalıcılaştırılamadı.'), { code: 'TASK_PERSIST_FAILED', cause: err });
        }
        if (this.webhook) this.webhook.triggerEvent('task_created', task);
        this.syncScheduler(task);
        return task;
    }

    /**
     * Kullanıcı iptali. Aktif uyarıyı da çözer; böylece modal açık kalıp
     * arka planda görev çalışmaya devam etmez.
     * @returns {{ok: boolean, code?: string, message?: string}}
     */
    cancelTask(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return { ok: false, code: 'NOT_FOUND' };
        if (task.status === TASK_STATUS.CANCELLED) return { ok: true, code: 'ALREADY_CANCELLED' };
        const snapshot = task.toJSON();

        const claim = this.claims.get(taskId);
        if (claim) {
            // P1-6: OS komutu yerel gecikme penceresinde bekliyorsa
            // (`shutdown /t n` + `graceSeconds`) iptal HÂLÂ mümkündür:
            // `shutdown /a` planlanmış kapatmayı gerçekten durdurur.
            const inGrace = claim.phase === 'executing' && claim.powerStarted
                && Number.isFinite(claim.graceUntil) && Date.now() < claim.graceUntil;
            if (inGrace) {
                claim.cancelRequested = true;
                const power = this.power;
                if (power && typeof power.abortScheduledShutdown === 'function') {
                    Promise.resolve(power.abortScheduledShutdown()).catch(() => { /* rapor ana akışı bozmaz */ });
                } else if (typeof PowerService.abortScheduledShutdown === 'function') {
                    Promise.resolve(PowerService.abortScheduledShutdown()).catch(() => { /* yut */ });
                }
                log.info(`[TaskManager] Kapatma bekleme penceresinde iptal edildi: ${task.name}`);
            } else if (claim.phase === 'executing' && claim.powerStarted) {
                // OS komutu başladıysa geri alınamaz; kullanıcıya açıkça söylenir.
                claim.cancelRequested = true;
                if (this.history) {
                    this.history.record(task, EXECUTION_RESULT_CODE.CANCEL_TOO_LATE, 'Güç işlemi başladıktan sonra iptal edilemez');
                }
                if (this.webhook) this.webhook.triggerEvent('task_cancel_too_late', task);
                return { ok: true, code: 'CANCEL_TOO_LATE', message: 'Güç işlemi başladı; iptal uygulanamaz.' };
            }

            claim.cancelRequested = true;
            if (this.warningManager && typeof this.warningManager.cancelActiveWarning === 'function') {
                const active = typeof this.warningManager.getActiveState === 'function'
                    ? this.warningManager.getActiveState()
                    : null;
                if (!active || active.taskId === taskId) {
                    this.warningManager.cancelActiveWarning(taskId);
                }
            }
            this.releaseTask(taskId, claim.token);
        }

        task.status = TASK_STATUS.CANCELLED;
        task.errorInfo = null;
        task.lastResult = { code: EXECUTION_RESULT_CODE.CANCELLED_BY_USER, message: 'Kullanıcı tarafından iptal edildi' };
        // A6: kullanıcı açıkça vazgeçtiyse bekleyen veto raporu düşer.
        if (this.terminalVerifier) this.terminalVerifier.disarm();
        // Y-06: disk yazımı başarısızsa bellek durumu geri alınır ve çağırana
        // açık hata döner; arayüz "iptal edildi" diyemez.
        try {
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            Object.assign(task, snapshot);
            return { ok: false, code: 'TASK_PERSIST_FAILED', message: 'Görev iptali kalıcılaştırılamadı.' };
        }
        if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.CANCELLED_BY_USER, 'Kullanıcı tarafından iptal edildi');
        if (this.webhook) this.webhook.triggerEvent('task_cancelled', task);
        this.removeScheduler(taskId);
        return { ok: true, code: 'CANCELLED' };
    }

    cancelActiveTask() {
        const active = this.warningManager && typeof this.warningManager.getActiveState === 'function'
            ? this.warningManager.getActiveState()
            : null;
        if (!active || !active.taskId) return { ok: false, code: 'NO_ACTIVE_WARNING' };
        return this.cancelTask(active.taskId);
    }

    /**
     * Biten (terminal durumdaki) görevi listeden kaldırır.
     *
     * Neden gerekli: iptal edilen/tamamlanan/süresi geçen görevler diskte
     * kalıcı olarak kalıyordu ve "Tüm" filtresinde eylem düğmesi OLMAYAN
     * satırlar olarak sonsuza kadar birikiyordu (ölçüm: 15 iptal → 15 satır,
     * her birinde 0 eylem). Kullanıcının bunları temizlemesinin hiçbir yolu
     * yoktu.
     *
     * Güvenlik: yalnızca terminal durumdaki görevler silinebilir; çalışan bir
     * görev (scheduled/monitoring/executing/...) silinemez — önce iptal
     * edilmelidir. Bu, "çalışan görevi kazara silme" riskini kapatır.
     */
    removeTask(taskId) {
        const index = this.tasks.findIndex((t) => t && t.id === taskId);
        if (index < 0) return { ok: false, code: 'NOT_FOUND' };
        const task = this.tasks[index];
        if (!TaskManager.isTerminalStatus(task.status)) {
            return { ok: false, code: 'TASK_NOT_TERMINAL' };
        }
        // Çalışan bir claim varsa silme reddedilir (yarış koruması).
        if (this.claims && this.claims.has(taskId)) {
            return { ok: false, code: 'TASK_RUNNING' };
        }
        this.tasks.splice(index, 1);
        try {
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            // Disk yazımı başarısızsa bellek durumu geri alınır.
            this.tasks.splice(index, 0, task);
            return { ok: false, code: 'TASK_PERSIST_FAILED' };
        }
        this.removeScheduler(taskId);
        return { ok: true, code: 'REMOVED' };
    }

    /** Terminal (artık çalışmayacak) durumlar. */
    static isTerminalStatus(status) {
        return status === TASK_STATUS.COMPLETED
            || status === TASK_STATUS.CANCELLED
            || status === TASK_STATUS.BLOCKED
            || status === TASK_STATUS.FAILED
            || status === TASK_STATUS.EXPIRED
            || status === TASK_STATUS.DISABLED;
    }

    /** Terminal durumdaki tüm görevleri kaldırır. */
    removeTerminalTasks() {
        const terminal = this.tasks.filter((t) => t && TaskManager.isTerminalStatus(t.status));
        let removed = 0;
        for (const task of terminal) {
            const result = this.removeTask(task.id);
            if (result.ok) removed += 1;
        }
        return { ok: true, removed };
    }

    /**
     * WP-06.T4 (K-04): erteleme tek yerden uygulanır.
     * - Koşullu görev: targetTime YAZILMAZ; notBefore yazılır, durum monitoring kalır.
     * - Koşulsuz görev: targetTime ileri alınır.
     * - allowed/maxCount sınırları burada uygulanır (H-10 tek kaynak).
     * @returns {{ok: boolean, code?: string, minutes?: number, message?: string}}
     */
    applySnooze(task, minutes = 10) {
        if (!task) return { ok: false, code: 'NOT_FOUND', message: 'Görev bulunamadı.' };
        const cfg = task.snoozeConfig || {};
        if (cfg.allowed === false) {
            return { ok: false, code: 'SNOOZE_NOT_ALLOWED', message: 'Bu görev için erteleme kapalı.' };
        }
        const maxCount = Number.isInteger(cfg.maxCount) ? cfg.maxCount : 3;
        const current = Number(cfg.currentCount) || 0;
        if (current >= maxCount) {
            return { ok: false, code: 'SNOOZE_LIMIT', message: 'Erteleme sınırı aşıldı.' };
        }
        const safeMinutes = Number.isInteger(minutes) ? Math.min(Math.max(minutes, 1), 1440) : 10;
        const conditions = task.conditionGroup && Array.isArray(task.conditionGroup.conditions)
            ? task.conditionGroup.conditions
            : [];
        task.snoozeConfig = { ...cfg, currentCount: current + 1 };
        if (conditions.length > 0) {
            task.trigger.notBefore = Date.now() + safeMinutes * 60000;
            task.trigger.targetTime = null;
            task.status = TASK_STATUS.MONITORING;
        } else {
            const base = Math.max(Number(task.trigger.targetTime) || 0, Date.now());
            task.trigger.targetTime = base + safeMinutes * 60000;
            task.trigger.notBefore = null;
            task.status = TASK_STATUS.SCHEDULED;
        }
        task.updatedAt = new Date().toISOString();
        return { ok: true, minutes: safeMinutes };
    }

    snoozeTask(taskId, minutes = 10) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return { ok: false, code: 'NOT_FOUND' };

        const safeMinutes = Number.isInteger(minutes) ? Math.min(Math.max(minutes, 1), 1440) : 10;
        const claim = this.claims.get(taskId);

        // Sınır kontrolü uyarıyı çözmeden ÖNCE yapılır (T-PAR-05).
        const cfg = task.snoozeConfig || {};
        const conditions = task.conditionGroup && Array.isArray(task.conditionGroup.conditions)
            ? task.conditionGroup.conditions
            : [];
        if (cfg.allowed === false) return { ok: false, code: 'SNOOZE_NOT_ALLOWED', message: 'Erteleme kapalı.' };
        const maxCount = Number.isInteger(cfg.maxCount) ? cfg.maxCount : 3;
        if ((Number(cfg.currentCount) || 0) >= maxCount) {
            return { ok: false, code: 'SNOOZE_LIMIT', message: 'Erteleme sınırı aşıldı.' };
        }

        // Aktif uyarı açıksa önce onu çöz; executeTask sayaç/takvimi işler.
        if (claim && claim.phase === 'warning' && this.warningManager &&
            typeof this.warningManager.snoozeActiveWarning === 'function') {
            this.warningManager.snoozeActiveWarning(safeMinutes, taskId);
            return { ok: true, code: 'SNOOZED_ACTIVE', minutes: safeMinutes };
        }
        if (claim) return { ok: false, code: 'ALREADY_RUNNING' };

        const applied = this.applySnooze(task, safeMinutes);
        if (!applied.ok) return applied;
        // Y-06: disk yazımı başarısızsa bellek durumu geri alınır; arayüz
        // "ertelendi" diyemez.
        const snapshot = task.toJSON();
        try {
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            Object.assign(task, snapshot);
            return { ok: false, code: 'TASK_PERSIST_FAILED', message: 'Erteleme kalıcılaştırılamadı.' };
        }
        if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.SNOOZED_BY_USER, `${applied.minutes} dk ertelendi`);
        if (this.webhook) this.webhook.triggerEvent('task_snoozed', task);
        this.syncScheduler(task);
        return { ok: true, code: 'SNOOZED', minutes: applied.minutes };
    }

    /**
     * P1-6 (üçüncü tur): GÖREV DÜZEYİNDE duraklatma.
     *
     * Denetim kusuru: `task.enabled` beş yürütme yolunda gerçek bir kapıydı
     * (`evaluateTasks`, `getActiveTasks`, `hasInFlight`, `runScheduledTask`,
     * `TaskSchedulerBridge`), `statusDisabled` 17 dilde çeviriye sahipti ve
     * renderer `task.enabled !== false` kontrolünü yapıyordu — ama hiçbir kod
     * yolu `enabled` alanını ASLA false yapmıyordu. Yani "görevi duraklat"
     * yeteneği motorda vardı, kullanıcıya ulaşmıyordu. Tıpkı `directory_idle`
     * gibi: altyapı tam, kapı yok.
     *
     * Duraklatma, iptalden farklıdır: görev silinmez, terminal olmaz ve
     * `resumeTask` ile kaldığı yerden devam eder. Tekrarlayan görev de
     * duraklatılabilir (sonraki occurrence hesaplanmaz).
     *
     * @param {string} taskId
     * @returns {{ok: boolean, code?: string, message?: string}}
     */
    pauseTask(taskId) {
        const task = this.tasks.find((t) => t && t.id === taskId);
        if (!task) return { ok: false, code: 'NOT_FOUND' };
        if (task.enabled === false && task.status === TASK_STATUS.DISABLED) {
            return { ok: true, code: 'ALREADY_PAUSED' };
        }
        // Yürütülmekte olan görev duraklatılamaz: OS komutu çoktan başlamış
        // olabilir. Kullanıcı önce iptal etmelidir (fail-closed).
        const claim = this.claims && this.claims.get(taskId);
        if (claim && claim.phase === 'executing' && claim.powerStarted) {
            return { ok: false, code: 'TASK_EXECUTING', message: 'Güç işlemi başladı; önce iptal edin.' };
        }
        if (TaskManager.isTerminalStatus(task.status)) {
            return { ok: false, code: 'TASK_NOT_PAUSABLE', message: 'Bitmiş görev duraklatılamaz.' };
        }
        const snapshot = task.toJSON();
        // Devam ederken doğru duruma dönmek için önceki durumu sakla.
        task.pausedFromStatus = task.status;
        task.enabled = false;
        task.status = TASK_STATUS.DISABLED;
        task.lastProgressMessage = null;
        task.updatedAt = new Date().toISOString();
        try {
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            Object.assign(task, snapshot);
            delete task.pausedFromStatus;
            return { ok: false, code: 'TASK_PERSIST_FAILED', message: 'Duraklatma kalıcılaştırılamadı.' };
        }
        // Windows Görev Zamanlayıcı yedeği de kaldırılır; aksi halde uygulama
        // kapalıyken duraklatılmış görev yine tetiklenirdi.
        this.removeScheduler(taskId);
        if (this.history) this.history.record(task, EXECUTION_RESULT_CODE.CANCELLED_BY_USER, 'Görev duraklatıldı');
        return { ok: true, code: 'PAUSED' };
    }

    /**
     * Duraklatılmış görevi kaldığı yerden sürdürür.
     *
     * - Koşullu görev → MONITORING (Smart Finish yeniden değerlendirir).
     * - Gelecekteki zamanlı görev → SCHEDULED, hedef korunur.
     * - Vadesi geçmiş zamanlı görev → EXPIRED (asla otomatik çalıştırılmaz;
     *   `recoverTasksOnStartup` ile aynı güvenlik kuralı).
     *
     * @param {string} taskId
     * @returns {{ok: boolean, code?: string, message?: string}}
     */
    resumeTask(taskId) {
        const task = this.tasks.find((t) => t && t.id === taskId);
        if (!task) return { ok: false, code: 'NOT_FOUND' };
        if (task.enabled !== false && task.status !== TASK_STATUS.DISABLED) {
            return { ok: false, code: 'TASK_NOT_PAUSED', message: 'Görev duraklatılmış değil.' };
        }
        const snapshot = task.toJSON();
        const previous = task.pausedFromStatus;
        const hasConditions = !!(task.conditionGroup && Array.isArray(task.conditionGroup.conditions)
            && task.conditionGroup.conditions.length > 0);
        task.enabled = true;
        if (hasConditions) {
            task.status = TASK_STATUS.MONITORING;
        } else if (task.recurrence && task.recurrence.enabled) {
            this.calculateNextRecurrence(task);
            task.status = TASK_STATUS.SCHEDULED;
        } else if (previous === TASK_STATUS.EXPIRED || previous === TASK_STATUS.FAILED
            || previous === TASK_STATUS.BLOCKED || previous === TASK_STATUS.COMPLETED) {
            // Geri dönülemez terminal durum: yeniden canlandırmak yerine
            // zamanı geçmişse EXPIRED, değilse SCHEDULED yap.
            task.status = (task.trigger.targetTime && task.trigger.targetTime < Date.now())
                ? TASK_STATUS.EXPIRED
                : TASK_STATUS.SCHEDULED;
        } else if (task.trigger.targetTime && task.trigger.targetTime < Date.now()) {
            task.status = TASK_STATUS.EXPIRED;
            task.errorInfo = 'Duraklatma sırasında zamanı geçti; güvenlik için çalıştırılmadı.';
        } else {
            task.status = TASK_STATUS.SCHEDULED;
        }
        // `delete` yerine açıkça null: model alanı her zaman tanımlı kalır ve
        // toJSON kalıcı kayıtta tutarlı bir şekil üretir.
        task.pausedFromStatus = null;
        task.errorInfo = task.status === TASK_STATUS.EXPIRED ? task.errorInfo : null;
        task.updatedAt = new Date().toISOString();
        try {
            this.persistChanges({ throwOnError: true });
        } catch (err) {
            Object.assign(task, snapshot);
            return { ok: false, code: 'TASK_PERSIST_FAILED', message: 'Sürdürme kalıcılaştırılamadı.' };
        }
        if (task.status === TASK_STATUS.SCHEDULED || task.status === TASK_STATUS.MONITORING) {
            this.syncScheduler(task);
        }
        return { ok: true, code: 'RESUMED', status: task.status };
    }

    togglePauseAll() {
        const next = !this.pausedAll;
        // Y-06: kalıcı duraklatma yazılamazsa bellek durumu değişmez.
        if (this.storage && typeof this.storage.updateSettings === 'function') {
            const persisted = this.storage.updateSettings({ automationPaused: next });
            if (persisted === false) {
                throw Object.assign(new Error('Duraklatma durumu kalıcılaştırılamadı.'), { code: 'PAUSE_PERSIST_FAILED' });
            }
        }
        this.pausedAll = next;
        return this.pausedAll;
    }

    /**
     * WBS-2.2: Scheduler yedeğiyle başlatılan tek-seferlik çalıştırma
     * (uygulama kapalıyken vadesi gelen görev). Normal boru hattından geçer:
     * güvenlik → uyarı → OS. Kalıcı duraklatma açıksa reddedilir.
     * @returns {boolean} çalıştırma başlatıldıysa true
     */
    runTaskNow(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task || task.enabled === false) return false;
        if (this.pausedAll) {
            log.info(`[TaskManager] runTaskNow reddedildi (duraklatılmış): ${taskId}`);
            return false;
        }
        if (task.status === TASK_STATUS.EXPIRED) {
            const snapshot = task.toJSON();
            task.status = TASK_STATUS.SCHEDULED;
            task.trigger.targetTime = Date.now();
            try {
                this.persistChanges({ throwOnError: true });
            } catch (err) {
                Object.assign(task, snapshot);
                log.error(`[TaskManager] runTaskNow kalıcılaştırılamadı: ${taskId}`);
                return false;
            }
        }
        // Atomik claim: scheduler aynı anda tetiklese bile yalnızca biri kazanır.
        const claim = this.claimTask(taskId, 'scheduler');
        if (!claim.ok) {
            log.info(`[TaskManager] runTaskNow reddedildi (${claim.code}): ${taskId}`);
            return false;
        }
        // WBS-9.4: Scheduler-ateşlemeli görevde uyarı zaman-aşımı devam eder
        // (kullanıcı başında olmayabilir). Geçici bayrak — persist edilmez.
        task._schedulerFired = true;
        Promise.resolve(this.executeTask(task, claim.token)).catch((err) => {
            this.handleExecutionError(task, err);
        });
        return true;
    }

    // WBS-11.1: Zincir — biten görevin sıradaki halkasını süreli görev olarak kurar.
    // Geçersiz halka atlanır (durmaz); kalan zincir yeni göreve taşınır.
    spawnChainLink(task) {
        const remaining = Array.isArray(task.chain) ? task.chain : [];
        if (remaining.length === 0) return null;
        const [next, ...rest] = remaining;
        if (!next || !this.power || typeof this.power.isValidAction !== 'function' || !this.power.isValidAction(next.action)) {
            log.warn(`[TaskManager] zincir halkası atlandı (geçersiz eylem): ${next && next.action}`);
            return null;
        }
        const delayMinutes = Number.isInteger(next.delayMinutes) ? Math.min(Math.max(next.delayMinutes, 1), 43200) : 1;
        try {
            return this.createTask({
                name: `Zincir: ${next.action} (${task.name})`,
                action: next.action,
                source: task.source,
                mode: task.mode,
                safetyPolicy: task.safetyPolicy ? { ...task.safetyPolicy } : undefined,
                warningConfig: task.warningConfig ? { ...task.warningConfig } : undefined,
                snoozeConfig: task.snoozeConfig ? { ...task.snoozeConfig, currentCount: 0 } : undefined,
                trigger: { type: 'duration', durationMs: delayMinutes * 60000 },
                chain: rest
            });
        } catch (err) {
            log.warn(`[TaskManager] zincir kurulamadı: ${err.message}`);
            return null;
        }
    }

    getActiveTasks() {
        // Y-03: EXECUTING de aktiftir; kapanış guard'ı ve mini pencere
        // güç işlemi sürerken pencereyi kapatmamalı.
        return this.tasks.filter(t => t.enabled && (
            t.status === TASK_STATUS.SCHEDULED ||
            t.status === TASK_STATUS.MONITORING ||
            t.status === TASK_STATUS.WAITING ||
            t.status === TASK_STATUS.WARNING ||
            t.status === TASK_STATUS.EXECUTING
        ));
    }

    /** Y-03: kapanış/çıkış öncesi yarıda iş var mı? */
    hasInFlight() {
        if (this.claims && this.claims.size > 0) return true;
        return this.tasks.some(t => t && t.enabled !== false && (
            t.status === TASK_STATUS.EXECUTING || t.status === TASK_STATUS.WARNING
        ));
    }

    /**
     * WP-04/WP-16: Süreç listesine gerçekten ihtiyaç var mı?
     * MetricCollector bu yüzden yalnızca process_running koşulu varken
     * fastlist/ps-list çağırır; boşta spawn maliyeti sıfırdır.
     */
    hasProcessConditions() {
        // O-07: terminal görevler süreç tüketicisi saymaz; aksi halde
        // tamamlanan görev sonsuza kadar ps-list/fastlist çalıştırır.
        const active = new Set([
            TASK_STATUS.SCHEDULED,
            TASK_STATUS.MONITORING,
            TASK_STATUS.WAITING,
            TASK_STATUS.WARNING,
            TASK_STATUS.EXECUTING
        ]);
        return this.tasks.some((task) => {
            if (!task || task.enabled === false) return false;
            if (!active.has(task.status)) return false;
            const conds = (task.conditionGroup && task.conditionGroup.conditions) || [];
            return conds.some((c) => c && c.type === CONDITION_TYPE.PROCESS_RUNNING);
        });
    }

    /** WP-02: Tanılama/UI için aktif claim özeti (kopya; mutasyon dışarıdan yapılamaz). */
    getClaimState(taskId = null) {
        if (taskId) {
            const c = this.claims.get(taskId);
            return c ? { taskId, ...c } : null;
        }
        return Array.from(this.claims.entries()).map(([id, c]) => ({ taskId: id, ...c }));
    }

    getNextTask() {
        const active = this.getActiveTasks().filter(t => t.trigger.targetTime);
        if (active.length === 0) return null;
        active.sort((a, b) => a.trigger.targetTime - b.trigger.targetTime);
        return active[0];
    }

    _taskSnapshot() {
        const snapshot = new Map();
        for (const task of this.tasks) {
            if (task && task.id) snapshot.set(task.id, JSON.stringify(task.toJSON()));
        }
        return snapshot;
    }

    /**
     * WP-11.T5/P-01: değişen görevleri `saveTask`, silinenleri `deleteTask` ile
     * yazar. Tam liste hiçbir zaman diske yazılmaz.
     */
    persistChanges({ throwOnError = false } = {}) {
        const next = this._taskSnapshot();
        const saved = new Map(this._savedTaskState);
        let changed = 0;
        let failed = false;
        for (const [id, json] of next.entries()) {
            if (saved.get(id) === json) continue;
            const result = this.storage.saveTask(JSON.parse(json));
            if (result !== false) {
                saved.set(id, json);
                changed += 1;
            } else {
                failed = true;
            }
        }
        for (const id of [...saved.keys()]) {
            if (next.has(id)) continue;
            const result = this.storage.deleteTask(id);
            if (result !== false) {
                saved.delete(id);
                changed += 1;
            } else {
                failed = true;
            }
        }
        this._savedTaskState = saved;
        if (changed > 0 && this.changeListener) {
            try { this.changeListener(); } catch (_) { /* dinleyici hatası yutulur */ }
        }
        if (failed && throwOnError) {
            throw Object.assign(new Error('Görev kalıcılaştırılamadı.'), { code: 'TASK_PERSIST_FAILED' });
        }
        return changed;
    }
}

module.exports = TaskManager;
