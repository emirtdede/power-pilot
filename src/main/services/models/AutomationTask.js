/**
 * AutomationTask.js
 * Core Domain Model for Power Pilot Automation Tasks.
 */

const { POWER_ACTIONS } = require('../PowerService');
const crypto = require('crypto');

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * P1-6: görev düzeyi güvenlik politikası alanları ve güvenli varsayılanları.
 * `AutomationTask` her zaman TAM nesne üretir (toJSON sözleşmesi); hangi
 * alanların kullanıcı tarafından GERÇEKTEN seçildiği `safetyPolicyExplicit`
 * içinde ayrıca tutulur. Böylece kalıcı ayarlar (forceCloseApps,
 * remoteApprovalRequired) varsayılan değerler tarafından gölgelenmez.
 */
const SAFETY_POLICY_DEFAULTS = Object.freeze({
    checkUserActivity: true,
    checkProtectedApps: true,
    checkFullscreen: true,
    checkSystemLoad: true,
    forceCloseApps: false,
    remoteApprovalRequired: false
});
const SAFETY_POLICY_KEYS = Object.freeze(Object.keys(SAFETY_POLICY_DEFAULTS));

const TASK_STATUS = {
    DRAFT: 'draft',
    SCHEDULED: 'scheduled',
    MONITORING: 'monitoring',
    WAITING: 'waiting',
    WARNING: 'warning',
    SNOOZED: 'snoozed',
    EXECUTING: 'executing',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    BLOCKED: 'blocked',
    FAILED: 'failed',
    DISABLED: 'disabled',
    EXPIRED: 'expired'
};

const TASK_SOURCE = {
    UI: 'user_interface',
    LOCAL_API: 'local_api',
    N8N: 'n8n',
    CLI: 'cli',
    TEMPLATE: 'imported_template',
    RECURRING: 'recurring_schedule',
    SYSTEM_RECOVERY: 'system_recovery',
    CONSOLE: 'console' // FAZ B: şirket konsolundan gelen politika emri
};

const TRIGGER_TYPE = {
    DURATION: 'duration',                 // After X duration
    SCHEDULED_TIME: 'scheduled_time',     // At specific date and time
    RECURRING: 'recurring',               // Cron / Recurrence rule
    PROCESS_CLOSE: 'process_close',       // Process terminated
    CPU_THRESHOLD: 'cpu_threshold',       // CPU usage below threshold
    NETWORK_THRESHOLD: 'network_threshold', // Net speed below threshold
    DISK_THRESHOLD: 'disk_threshold',     // Disk activity below threshold
    FILE_EVENT: 'file_event',             // File created/deleted/stabilized
    DIRECTORY_EVENT: 'directory_event',   // Directory changed/idle
    USER_IDLE: 'user_idle',               // User input idle
    BATTERY_EVENT: 'battery_event',       // Battery/power source status
    API_CALL: 'api_call',                 // Direct trigger via Local API / Webhook
    COMPOSITE: 'composite'                // Multi-condition AND/OR
};

// TaskManager'ın GERÇEKTEN zamanlayabildiği trigger türleri. Zamanlayıcı
// yalnızca bu iki türü targetTime'a çevirir (bkz. createTask + evaluateTasks).
//
// Denetim kusuru: enum 13 tür ilan ediyordu ve doğrulayıcı hepsini kabul
// ediyordu; ama `TaskManager` yalnızca duration/scheduled_time dağıtıyordu.
// Diğer 10 türle gelen görev `draft` durumunda kalıyor, hiçbir zaman
// tetiklenmiyor ve hiçbir hata da üretmiyordu - sessiz no-op.
const DISPATCHABLE_TRIGGER_TYPES = new Set([
    TRIGGER_TYPE.DURATION,
    TRIGGER_TYPE.SCHEDULED_TIME
]);

// Koşul-güdümlü trigger türleri: tek başına zamanlanamazlar, eşlik eden bir
// `conditionGroup` ile Smart Finish motoruna devredilirler. Koşul grubu yoksa
// görev ANLAMSIZDIR; sessizce draft'ta bırakmak yerine reddedilir.
const CONDITION_DRIVEN_TRIGGER_TYPES = new Set([
    TRIGGER_TYPE.PROCESS_CLOSE,
    TRIGGER_TYPE.CPU_THRESHOLD,
    TRIGGER_TYPE.NETWORK_THRESHOLD,
    TRIGGER_TYPE.DISK_THRESHOLD,
    TRIGGER_TYPE.FILE_EVENT,
    TRIGGER_TYPE.DIRECTORY_EVENT,
    TRIGGER_TYPE.USER_IDLE,
    TRIGGER_TYPE.BATTERY_EVENT,
    TRIGGER_TYPE.API_CALL,
    TRIGGER_TYPE.COMPOSITE
]);

// `recurring` bir trigger türü DEĞİLDİR: tekrarlama `task.recurrence` ile ve
// trigger.type='scheduled_time' olarak ifade edilir. Eski enum bu adı da
// taşıdığı için burada açıkça "desteklenmiyor" sayılır.

const CONDITION_TYPE = {
    PROCESS_RUNNING: 'process_running',
    CPU_USAGE: 'cpu_usage',
    NETWORK_SPEED: 'network_speed',
    DISK_ACTIVITY: 'disk_activity',
    FILE_STABLE: 'file_stable',
    DIRECTORY_IDLE: 'directory_idle',
    USER_IDLE: 'user_idle',
    BATTERY_LEVEL: 'battery_level'
    // P1-6 (üçüncü tur): `file_exists`, `file_size` ve `power_source` buradan
    // KALDIRILDI. Enum'da ilan ediliyorlardı ama SmartFinishEngine'de okuyucusu,
    // `SUPPORTED_CONDITION_TYPES`'ta kaydı, iki UI seçicisinde seçeneği ve
    // dokümanda tanımı yoktu. İlan edilen ama hiçbir yerde çalışmayan değer,
    // kullanıcıya "destekleniyor" izlenimi veren bir hayaletti; motor bunları
    // `UNSUPPORTED_CONDITION` ile açıkça reddediyor.
};

const LOGIC_OPERATOR = {
    AND: 'AND',
    OR: 'OR'
};

// SmartFinishEngine tarafından gerçekten karşılanan koşul tipleri.
// Desteklenmeyen tipler createTask'ta reddedilir (sessiz geçiş yok).
const SUPPORTED_CONDITION_TYPES = new Set([
    CONDITION_TYPE.PROCESS_RUNNING,
    CONDITION_TYPE.CPU_USAGE,
    CONDITION_TYPE.USER_IDLE,
    CONDITION_TYPE.FILE_STABLE,
    CONDITION_TYPE.DIRECTORY_IDLE,
    CONDITION_TYPE.NETWORK_SPEED,
    CONDITION_TYPE.DISK_ACTIVITY,
    CONDITION_TYPE.BATTERY_LEVEL
]);

const EXECUTION_RESULT_CODE = {
    SUCCESS: 'success',
    CANCELLED_BY_USER: 'cancelled_by_user',
    SNOOZED_BY_USER: 'snoozed_by_user',
    BLOCKED_BY_POLICY: 'blocked_by_policy',
    CONDITION_INVALID: 'condition_invalid',
    OS_EXECUTION_FAILED: 'os_execution_failed',
    AUTHORIZATION_ERROR: 'authorization_error',
    TIMEOUT: 'timeout',
    INTERRUPTED_BY_SHUTDOWN: 'interrupted_by_shutdown',
    // WP-02: OS komutu başladıktan sonra gelen iptal isteği.
    CANCEL_TOO_LATE: 'cancel_too_late',
    // Uyku/standby veya uygulama kapalıyken zamanı geçen görev. Kullanıcı
    // politikasına göre çalıştırılır ya da atlanır; asla sessizce yutulmaz.
    MISSED_WHILE_ASLEEP: 'missed_while_asleep'
};

class AutomationTask {
    /** ADR-08: kimlik sunucuda üretilir; istemci girdisi kullanılmaz. */
    static generateId(nowMs = Date.now()) {
        return `task_${nowMs.toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
    }

    static isValidId(id) {
        return typeof id === 'string' && TASK_ID_RE.test(id);
    }

    /**
     * P1-6: görev düzeyi politika alanı kullanıcı tarafından AÇIKÇA seçildi mi?
     *
     * `safetyPolicy` her zaman tam nesne olduğu için (varsayılanlar dahil)
     * yalnızca değer bakmak yanıltıcıydı: görev düzeyi `false`, kalıcı ayarı
     * gölgeliyordu. Karar `safetyPolicyExplicit` işaretinden verilir.
     * @param {object} task
     * @param {string} key
     * @returns {boolean}
     */
    static isExplicitPolicy(task, key) {
        if (!task || !task.safetyPolicy || task.safetyPolicy[key] === undefined) return false;
        const explicit = task.safetyPolicyExplicit;
        if (explicit && typeof explicit === 'object') return explicit[key] === true;
        // İşaret yok (eski kayıt/nesne): varsayılandan FARKLI değer gerçek tercihtir.
        return task.safetyPolicy[key] !== SAFETY_POLICY_DEFAULTS[key];
    }

    constructor(data = {}) {
        this.id = data.id || AutomationTask.generateId();
        this.name = data.name || 'Yeni Otomasyon';
        this.createdAt = data.createdAt || new Date().toISOString();
        this.updatedAt = data.updatedAt || new Date().toISOString();
        this.status = data.status || TASK_STATUS.DRAFT;
        this.action = data.action || POWER_ACTIONS.SHUTDOWN;
        this.enabled = typeof data.enabled === 'boolean' ? data.enabled : true;

        // Source tracking
        this.source = data.source || TASK_SOURCE.UI;

        // FAZ B: konsol politikası izlenebilirliği (yerel görevlerde null).
        this.policyId = typeof data.policyId === 'string' ? data.policyId.slice(0, 64) : null;
        this.consoleOrderId = typeof data.consoleOrderId === 'string' ? data.consoleOrderId.slice(0, 64) : null;
        // FAZ D: bakım-penceresi gerektiren görev bayrağı (konsol vurur, motor okur).
        this.requiresMaintenanceWindow = data.requiresMaintenanceWindow === true;

        // Autonomy mode stamp (P0-1: kuruluş anında vurulur, executeTask yalnızca okur).
        // 'classic' = onaylı akış, 'full' = tam yetki akışı.
        this.mode = data.mode === 'full' ? 'full' : 'classic';

        // Trigger Configuration
        this.trigger = data.trigger || {
            type: TRIGGER_TYPE.DURATION,
            durationMs: 3600000,
            targetTime: null
        };
        // ADR-09 / K-04: koşullu görevlerde erteleme targetTime'a DEĞİL notBefore'a
        // yazılır. targetTime yalnızca koşulsuz zamanlayıcı görevlerinde kullanılır.
        if (this.trigger && this.trigger.notBefore === undefined) this.trigger.notBefore = null;
        // L-01: koşul motorunun son ilerleme mesajı kalıcıdır (UI'da gösterilir).
        this.lastProgressMessage = typeof data.lastProgressMessage === 'string'
            ? data.lastProgressMessage.slice(0, 240)
            : null;

        // Condition Group (AND/OR)
        this.conditionGroup = data.conditionGroup || {
            operator: LOGIC_OPERATOR.AND,
            conditions: []
        };

        // Safety Policy settings
        //
        // P1-6 KÖK NEDEN: Eskiden burada yalnızca "safetyPolicy yoksa varsayılanı
        // yaz" vardı. Sonuç: HER görev tam bir politika nesnesi taşıyordu, yani
        // kalıcı ayarlarlar (`forceCloseApps`, `remoteApprovalRequired`) hiçbir
        // zaman uygulanamıyordu - görev düzeyi "false" onları eziyordu. Ayar
        // arayüzde vardı, davranışta yoktu (plasebo).
        //
        // Çözüm: `safetyPolicyExplicit` yalnızca çağıranın GERÇEKTEN seçtiği
        // alanları işaretler. `safetyPolicy` sözleşmesi (toJSON ve tüketiciler
        // tam nesne bekler) korunur; çözümleyiciler önce işarete bakar.
        //
        // "Seçti" kuralı:
        //  - Kısmi nesne (6 alanın hepsi yok) → verilen her alan bilinçli tercihtir.
        //    UI/CLI yalnızca dokunduğu alanları gönderir.
        //  - Tam nesne (6/6) → bu bir "maddeleştirilmiş varsayılan"dır (örn. konsol
        //    politikası); yalnızca varsayılandan FARKLI alanlar explicit sayılır.
        //  - Kalıcı kayıtta işaret varsa tek doğruluk kaynağı odur.
        const providedPolicy = (data.safetyPolicy && typeof data.safetyPolicy === 'object' && !Array.isArray(data.safetyPolicy))
            ? data.safetyPolicy
            : {};
        this.safetyPolicy = {
            ...SAFETY_POLICY_DEFAULTS,
            ...providedPolicy
        };
        const providedCount = SAFETY_POLICY_KEYS.filter((key) => providedPolicy[key] !== undefined).length;
        const looksMaterialized = providedCount === SAFETY_POLICY_KEYS.length;
        const storedExplicit = (data.safetyPolicyExplicit && typeof data.safetyPolicyExplicit === 'object' && !Array.isArray(data.safetyPolicyExplicit))
            ? data.safetyPolicyExplicit
            : null;
        this.safetyPolicyExplicit = {};
        for (const key of SAFETY_POLICY_KEYS) {
            if (storedExplicit) {
                // Kayıtlı görev: yalnızca açıkça işaretlenenler explicit.
                if (storedExplicit[key] === true) this.safetyPolicyExplicit[key] = true;
            } else if (providedPolicy[key] !== undefined) {
                // Kısmi nesnede her alan; tam nesnede yalnızca farklı olan alan.
                if (!looksMaterialized || providedPolicy[key] !== SAFETY_POLICY_DEFAULTS[key]) {
                    this.safetyPolicyExplicit[key] = true;
                }
            }
        }

        // Warning Modal Settings
        this.warningConfig = data.warningConfig || {
            enabled: true,
            durationSeconds: 30, // Default 30s warning
            silentMode: false
        };

        // Snooze Settings
        this.snoozeConfig = data.snoozeConfig || {
            allowed: true,
            maxCount: 3,
            currentCount: 0,
            durationMinutes: 10
        };

        // Recurrence Settings
        this.recurrence = data.recurrence || {
            enabled: false,
            frequency: 'none', // daily, weekly, weekdays, weekends, custom
            daysOfWeek: [], // [1,2,3,4,5]
            timeOfDay: '00:00'
        };

        // WBS-11.1: Zincir - bu görev bitince sırayla kurulacak halkalar.
        // [{action, delayMinutes}] en fazla 5 halka; kalıcıdır (toJSON).
        this.chain = Array.isArray(data.chain)
            ? data.chain.slice(0, 5).map(link => ({
                action: link.action,
                delayMinutes: link.delayMinutes
            }))
            : [];

        // Execution History & Results
        this.lastRunAt = data.lastRunAt || null;
        this.lastResult = data.lastResult || null; // { code, message, timestamp }
        this.errorInfo = data.errorInfo || null;
        // P1-6 (üçüncü tur): görev duraklatıldığında hangi durumdan geldiğini
        // hatırlar; `resumeTask` doğru duruma döner. Yalnızca duraklatılmış
        // görevlerde anlamlıdır, diğerlerinde null.
        this.pausedFromStatus = typeof data.pausedFromStatus === 'string'
            ? data.pausedFromStatus.slice(0, 32)
            : null;
    }

    /**
     * Converts a simple legacy duration timer into an AutomationTask
     */
    static fromLegacyTimer(action, durationMs) {
        return new AutomationTask({
            name: `Hızlı Zamanlayıcı (${action})`,
            action: action,
            status: TASK_STATUS.SCHEDULED,
            source: TASK_SOURCE.UI,
            trigger: {
                type: TRIGGER_TYPE.DURATION,
                durationMs: durationMs,
                targetTime: Date.now() + durationMs
            },
            warningConfig: {
                enabled: true,
                durationSeconds: 30,
                silentMode: false
            }
        });
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            status: this.status,
            action: this.action,
            enabled: this.enabled,
            source: this.source,
            mode: this.mode,
            policyId: this.policyId,
            consoleOrderId: this.consoleOrderId,
            requiresMaintenanceWindow: this.requiresMaintenanceWindow === true,
            trigger: this.trigger,
            conditionGroup: this.conditionGroup,
            lastProgressMessage: this.lastProgressMessage,
            safetyPolicy: this.safetyPolicy,
            // P1-6: yalnızca kullanıcı tarafından AÇIKÇA seçilen alanlar.
            safetyPolicyExplicit: this.safetyPolicyExplicit,
            warningConfig: this.warningConfig,
            snoozeConfig: this.snoozeConfig,
            recurrence: this.recurrence,
            chain: this.chain,
            lastRunAt: this.lastRunAt,
            lastResult: this.lastResult,
            errorInfo: this.errorInfo,
            pausedFromStatus: this.pausedFromStatus
        };
    }
}

module.exports = {
    AutomationTask,
    TASK_STATUS,
    TASK_SOURCE,
    TRIGGER_TYPE,
    CONDITION_TYPE,
    LOGIC_OPERATOR,
    EXECUTION_RESULT_CODE,
    SUPPORTED_CONDITION_TYPES,
    DISPATCHABLE_TRIGGER_TYPES,
    CONDITION_DRIVEN_TRIGGER_TYPES
};
