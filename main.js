const { app, BrowserWindow, ipcMain, Tray, Menu, screen, shell, powerMonitor, dialog, session, nativeImage, Notification } = require('electron');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

// Import modular services
const { PowerService } = require('./src/main/services/PowerService');
const AppIconService = require('./src/main/services/AppIconService');
const { OneDriveSyncService } = require('./src/main/services/OneDriveSyncService');
const { DiagnosticsService } = require('./src/main/services/DiagnosticsService');
const { searchDocs } = require('./src/main/services/DocsKnowledgeBase');
const { summarize: summarizeHealth } = require('./src/main/services/HealthMetrics');
const miniPlacement = require('./src/main/services/MiniWindowPlacement');
const miniWidgetState = require('./src/main/services/MiniWidgetState');
const log = require('./src/main/logger');
const {
    validateScheduleAction, validateTaskId, validateTaskData,
    validateSnooze, validateWol, validateSettings, validateWebhooks,
    validateCancelPin, validateSecuritySettings, SECURITY_SETTING_KEYS
} = require('./src/main/ipc/validate');
const { PinGuard } = require('./src/main/ipc/pinGuard');
const { cancelWarningAction, snoozeWarningAction, confirmWarningAction } = require('./src/main/ipc/warningActions');
const { setCancelPinAction, clearCancelPinAction } = require('./src/main/ipc/cancelPinActions');
const Pin = require('./src/main/security/Pin');
const { SecretStore, SECRET_SETTING_FIELDS } = require('./src/main/security/SecretStore');
const { runBackup } = require('./src/main/storage/DbWorker');
const { translate, actionLabel, taskName, loadLocale, normalizeLanguage, normalizeCatalogLanguage, ALL_LANGUAGE_CODES } = require('./src/main/i18n');
const { registerAppScheme, installAppProtocol, isAllowedAppUrl } = require('./src/main/security/AppProtocol');
const Acl = require('./src/main/security/Acl');
const Permissions = require('./src/main/security/Permissions');
const { openExternalSafely } = require('./src/main/config/externalLinks');
const distribution = require('./src/main/config/distribution');

// WP-10.T2: meta etiketiyle aynı politika HTTP başlığı olarak da uygulanır.
const APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'none'";
const { guardIpcHandler } = require('./src/main/ipc/SenderGuard');
const { normalizeAiInput } = require('./src/main/ai/input');
const { TimerRegistry } = require('./src/main/util/TimerRegistry');
const { installCrashGuard } = require('./src/main/util/CrashGuard');
const Portable = require('./src/main/util/Portable');

// WP-2: Windows 11 görev çubuğu, kısayol ve bildirim kimliği tutarlılığı için
// AppUserModelId uygulama açılışında tekil olarak sabitlenir.
if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    try { app.setAppUserModelId(AppIconService.APP_USER_MODEL_ID); } catch (_) { /* yut */ }
}

let diagnosticsService = null;
let oneDriveSyncService = null;

// Yayın dayanıklılığı: ana süreçteki yakalanmamış hata artık sessizce
// uygulamayı kapatmaz; redakte edilmiş log satırı bırakır ve süreç ayakta kalır.
installCrashGuard({
    processRef: process,
    logger: log,
    onCrash: ({ kind, message }) => {
        try {
            if (diagnosticsService) {
                diagnosticsService.recordCrash({ kind, message, source: 'main' });
            }
        } catch (_) { /* yut */ }
    }
});

// WP-5: Chromium renderer/alt süreç çöküşlerini de tanılama günlüğüne düş.
app.on('render-process-gone', (_event, _wc, details) => {
    const reason = (details && details.reason) || 'unknown';
    log.error(`[CrashGuard] Renderer süreci sonlandı: ${reason}`);
    try {
        if (diagnosticsService) {
            diagnosticsService.recordCrash({
                kind: 'render-process-gone',
                message: `Renderer process exited: ${reason} (exitCode=${details && details.exitCode})`,
                source: 'renderer'
            });
        }
    } catch (_) { /* yut */ }
});
app.on('child-process-gone', (_event, details) => {
    const type = (details && details.type) || 'unknown';
    const reason = (details && details.reason) || 'unknown';
    if (reason === 'clean-exit') return;
    log.warn(`[CrashGuard] Alt süreç sonlandı (${type}): ${reason}`);
    try {
        if (diagnosticsService) {
            diagnosticsService.recordCrash({
                kind: 'child-process-gone',
                message: `Child process (${type}) exited: ${reason}`,
                source: 'child'
            });
        }
    } catch (_) { /* yut */ }
});

// WP-10.T1: renderer yalnızca app://powerpilot origin'inden yüklenir.
registerAppScheme();

const ipcHandle = (channel, handler) => ipcMain.handle(channel, guardIpcHandler(handler, {
    onDenied: (url) => log.warn(`[IPC] güvenilmeyen gönderici reddedildi: ${channel} (${url || 'origin-yok'})`)
}));
const ipcOn = (channel, handler) => ipcMain.on(channel, guardIpcHandler(handler, {
    onDenied: (url) => log.warn(`[IPC] güvenilmeyen gönderici reddedildi: ${channel} (${url || 'origin-yok'})`)
}));

// WP-13.T6: tüm uzun ömürlü timer'lar tek kayıt defterinden temizlenir.
const timers = new TimerRegistry();

// WP-04.T5: headless servis modu. `PowerPilot.exe --headless --user-data-dir=<dir>`
// ile UI açılmadan ajan yığını çalışır; SecretStore/DPAPI aynı süreçte kullanılır.
const HEADLESS_MODE = process.argv.includes('--headless') && distribution.isFeatureEnabled('headless');

function parseUserDataDir(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--user-data-dir') {
            const next = argv[i + 1];
            if (typeof next === 'string' && next.length > 0 && !next.startsWith('--')) return next;
            return null;
        }
        if (arg.startsWith('--user-data-dir=')) {
            const value = arg.slice('--user-data-dir='.length);
            return value.length > 0 ? value : null;
        }
    }
    return null;
}

const userDataDirOverride = parseUserDataDir(process.argv);
if (userDataDirOverride) {
    const resolvedUserData = path.resolve(userDataDirOverride);
    fs.mkdirSync(resolvedUserData, { recursive: true });
    // Chromium anahtarı tek başına app.getPath('userData')'yı değiştirmez;
    // açıkça ayarlanır ki depolama ve sır dosyası aynı dizinde olsun.
    app.setPath('userData', resolvedUserData);
} else {
    // Taşınabilir sürüm: veri SFX'in yanında durur, aksi hâlde USB'ye
    // kopyalanan uygulama ayarlarını %APPDATA%'da bırakır ("portable" yalanı).
    const portableDir = Portable.portableDataDir(process.env);
    if (portableDir) {
        try {
            fs.mkdirSync(portableDir, { recursive: true });
            app.setPath('userData', portableDir);
            log.info(`[Portable] veri klasörü: ${portableDir}`);
        } catch (err) {
            // Salt okunur medya / kilitli klasör: açılmamak yerine normal yola dön.
            log.warn(`[Portable] veri klasörü kullanılamadı (${err && err.code}); varsayılan kullanılacak.`);
        }
    }
}

function currentLanguage() {
    try {
        // null = "kullanıcı henüz seçmedi" → sistem diline bırak; renderer
        // ilk çalıştırmada algılayıp geri yazar.
        return (storageService && storageService.getSettings().language) || 'en';
    } catch (_) {
        return 'en';
    }
}

function t(key, vars) {
    return translate(currentLanguage(), key, vars);
}

// Açılış hatası kullanıcıya aktif dilde gösterilir; ham (Türkçe) mesaj log'a gider.
function startupErrorText(err) {
    const code = err && err.code;
    if (code === 'SECRET_BACKEND_UNAVAILABLE') return t('errorSecretBackendUnavailable');
    if (code === 'SETTINGS_PERSIST_FAILED') return t('errorSaveFailed');
    return t('unknownError');
}

// Servis sonuçlarındaki ham (Türkçe) mesajlar yerine aktif dilin metni gösterilir.
const AI_RESULT_KEYS = {
    AI_SILENCED: 'toastAiDisabled',
    BUSY: 'aiBusy',
    RATE_LIMITED: 'aiRateLimited',
    AI_ERROR: 'aiNoResponse',
    NO_PARSER: 'aiNoResponse'
};
const STT_RESULT_KEYS = {
    INVALID_AUDIO: 'errorAudioParse',
    TOO_SHORT: 'errorRecordingShort',
    SILENCE: 'errorNotUnderstood',
    NOT_HEARD: 'errorNotUnderstood',
    TRANSCRIBE_FAILED: 'errorAudioParse',
    MODEL_MISSING: 'errorSttMissing'
};

// Model indirme hataları servis içinde Türkçe üretilir; kullanıcıya kod →
// anahtar eşlemesiyle aktif dilde gösterilir (ayrıntı log'da kalır).
const MODEL_DOWNLOAD_KEYS = {
    DISK_FULL: 'errorDownloadDiskSpace',
    CONNECTION_FAILED: 'errorDownloadConnection',
    RANGE_REJECTED: 'errorDownloadRange',
    RANGE_MISMATCH: 'errorDownloadInterrupted',
    EMPTY_BODY: 'errorDownloadInterrupted',
    INTERRUPTED: 'errorDownloadInterrupted',
    HTTP_STATUS: 'errorDownloadServer',
    SIZE_MISMATCH: 'errorDownloadIntegrity',
    PART_MISSING: 'errorDownloadIntegrity',
    SIZE_VERIFY_FAILED: 'errorDownloadIntegrity',
    SHA_COMPUTE_FAILED: 'errorDownloadIntegrity',
    SHA_MISMATCH: 'errorDownloadIntegrity',
    MOVE_FAILED: 'errorDownloadIntegrity',
    MODEL_DIR_MISSING: 'errorAiDownloadFailed',
    ALREADY_DOWNLOADING: 'errorDownloadBusy'
};

function localizeDownloadFailure(failure) {
    if (!failure || typeof failure !== 'object') return failure;
    const key = MODEL_DOWNLOAD_KEYS[failure.code] || 'errorAiDownloadFailed';
    return { ...failure, error: t(key, failure.params || {}) };
}

function localizeResult(result, keys) {
    if (!result || typeof result !== 'object') return result;
    const key = keys[result.code];
    return key ? { ...result, message: t(key) } : result;
}

// WBS-11.2 / WP-04.T4: PIN deneme sayacı (işlem-içi; yeniden başlatmada sıfırlanır, hash diskte kalır).
const pinGuard = new PinGuard();
let secretStore = null;

async function requireCancelPin(providedPin) {
    const s = storageService.getSettings();
    let stored = null;
    if (s.cancelPinHash) {
        stored = Pin.isArgon2Hash(s.cancelPinHash)
            ? s.cancelPinHash
            : { hash: s.cancelPinHash, salt: s.cancelPinSalt };
    }
    const check = await pinGuard.check('cancel', providedPin, stored);
    if (check.ok) {
        // WP-04.T4: eski SHA-256 kaydı doğrulandıktan sonra Argon2id'e yükseltilir.
        if (check.upgrade) {
            try {
                storageService.updateSettings({ cancelPinHash: check.upgrade, cancelPinSalt: null });
            } catch (err) {
                log.warn('[PIN] Argon2id yükseltmesi kaydedilemedi:', err && err.message);
            }
        }
        return null;
    }
    const message = check.code === 'PIN_REQUIRED'
        ? t('pinPromptCancel')
        : (check.message || t('pinVerifyFailed'));
    return { success: false, code: check.code, message, retryAfterSec: check.retryAfterSec, attemptsLeft: check.attemptsLeft };
}

/** WP-10.T4: güvenlik ayarları ve API anahtarı üretimi aynı PIN kapısından geçer. */
async function requireSecurityPin(providedPin) {
    const s = storageService.getSettings();
    let stored = null;
    if (s.cancelPinHash) {
        stored = Pin.isArgon2Hash(s.cancelPinHash)
            ? s.cancelPinHash
            : { hash: s.cancelPinHash, salt: s.cancelPinSalt };
    }
    // Fail-closed: güvenlik ayarı/API anahtarı için PIN yapılandırılmış olmalı.
    if (!stored) {
        return { success: false, code: 'PIN_REQUIRED', message: t('pinPromptCancel') };
    }
    const check = await pinGuard.check('security', providedPin, stored);
    if (check.ok) {
        if (check.upgrade) {
            try {
                storageService.updateSettings({ cancelPinHash: check.upgrade, cancelPinSalt: null });
            } catch (err) {
                log.warn('[PIN] Argon2id yükseltmesi kaydedilemedi:', err && err.message);
            }
        }
        return null;
    }
    return {
        success: false,
        code: check.code,
        message: check.code === 'PIN_REQUIRED' ? t('pinPromptCancel') : (check.message || t('pinVerifyFailed')),
        retryAfterSec: check.retryAfterSec,
        attemptsLeft: check.attemptsLeft
    };
}
const StorageService = require('./src/main/services/StorageService');
const HistoryService = require('./src/main/services/HistoryService');
const WarningManager = require('./src/main/services/WarningManager');
const SafetyPolicyEngine = require('./src/main/services/SafetyPolicyEngine');
const MetricCollector = require('./src/main/services/monitors/MetricCollector');
const SmartFinishEngine = require('./src/main/services/SmartFinishEngine');
const TaskManager = require('./src/main/services/TaskManager');
const WebhookService = require('./src/main/services/WebhookService');
const LocalApiService = require('./src/main/services/LocalApiService');
const TemplateService = require('./src/main/services/TemplateService');
const TemplateTransfer = require('./src/main/services/TemplateTransfer');
const DataWipe = require('./src/main/services/DataWipe');

/**
 * "Tüm verileri sil" işaret dosyası - userData'nın DIŞINDA (geçici dizin).
 * Kilitli kalan girdiler bir sonraki açılışta, hiçbir veri gösterilmeden önce
 * silinir. Aynı makinede farklı profiller karışmasın diye userData yolu
 * işaretin içinde saklanır ve yalnızca eşleşirse uygulanır.
 */
function pendingWipeMarkerPath() {
    return path.join(app.getPath('temp'), DataWipe.PENDING_MARKER_NAME);
}

const EnergyEstimateService = require('./src/main/services/EnergyEstimateService');
const DeviceProfileService = require('./src/main/services/DeviceProfileService');
const TaskSchedulerBridge = require('./src/main/services/TaskSchedulerBridge');
const { AiBackend } = require('./src/main/services/AiBackend');
const { ModelManager, STT_MODEL_ID, STT_MODEL_FILE, STT_MODEL_URL } = require('./src/main/services/ModelManager');
const { AiService } = require('./src/main/services/AiService');
const { SttService } = require('./src/main/services/SttService');
const { DeviceProfiler } = require('./src/main/services/DeviceProfiler');
const { AgentOrchestrator } = require('./src/main/services/AgentOrchestrator');
// FAZ B: kurumsal pilot servisleri
const { InventoryService } = require('./src/main/services/InventoryService');
const { ExemptionService } = require('./src/main/services/ExemptionService');
const { OrderQueue } = require('./src/main/services/OrderQueue');
const { AuditLog } = require('./src/main/services/AuditLog');
const { ConsoleClient } = require('./src/main/services/ConsoleClient');
const { OrderExecutor } = require('./src/main/services/OrderExecutor');
const { SignedOrderService } = require('./src/main/services/SignedOrderService');
const { UpsMonitor } = require('./src/main/services/UpsMonitor');
const { UpsSupervisor } = require('./src/main/services/UpsSupervisor');

let mainWindow;
let miniWindow = null;
let tray = null;
// WP-13.T5: tray yalnızca 100 ms debounce + imza değişiminde yeniden kurulur.
let trayUpdateTimer = null;
let lastTraySignature = '';
let trayUpdater = null;

function scheduleTrayUpdate() {
    if (!trayUpdater) return;
    if (trayUpdateTimer) clearTimeout(trayUpdateTimer);
    trayUpdateTimer = timers.setTimeout(() => {
        trayUpdateTimer = null;
        try { trayUpdater(); } catch (err) { log.warn('[Tray] güncelleme hatası:', err && err.message); }
    }, 100);
    if (typeof trayUpdateTimer.unref === 'function') trayUpdateTimer.unref();
}
let isQuitting = false;
let shutdownStarted = false;
let isMiniWindowDismissed = false;

// Instantiate Services
let storageService, historyService, warningManager, safetyPolicyEngine, metricCollector, smartFinishEngine, taskManager, webhookService, localApiService, templateService, energyService, deviceService, aiBackend, modelManager, aiService, sttService, agentOrchestrator, deviceProfiler, sttModelManager;
// FAZ B: kurumsal servis örnekleri
let inventoryService, exemptionService, orderQueue, auditLog, consoleClient, orderExecutor, upsMonitor;
let upsSupervisor = null;
let upsSupervisorTimer = null;
let consoleSyncTimer = null;
let headlessHandle = null;

function getAppVersion() {
    try { return require('./package.json').version || '1.0.0'; } catch (_) { return '1.0.0'; }
}

/**
 * P0-4: Paketlenmiş uygulamada ASAR içindeki bir dosyayı dış `node` sürecine
 * veremeyiz. `asarUnpack` kapsamındaki dosyalar `app.asar.unpacked` altında
 * FİZİKSEL olarak durur. Bu yardımcı, çalıştırılabilir gerçek yolu döndürür.
 * Geliştirme modunda normal yolu döner.
 * @param {...string} segments src/mcp/server.js gibi parçalar
 * @returns {string}
 */
function resolveUnpackedEntry(...segments) {
    const packaged = path.join(__dirname, ...segments);
    if (!app.isPackaged) return packaged;
    const unpacked = packaged.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    try {
        if (fs.existsSync(unpacked)) return unpacked;
    } catch (_) { /* yut */ }
    return unpacked;
}

/**
 * P1-5: Gerçek OS açılış zamanını boot geçmişine yazar. Enerji tasarrufu
 * ölçümü kapanış→açılış eşleşmesiyle çalışır; bu kayıt normal kullanıcıda
 * hiç yazılmıyordu. `os.uptime()` envanter toplamadan bağımsız, ucuz ve
 * yönetici yetkisi gerektirmez. Hata açılışı ASLA bloklamaz.
 */
function registerOsBootTime() {
    try {
        if (!storageService || typeof storageService.appendBoot !== 'function') return;
        const up = os.uptime();
        if (!Number.isFinite(up) || up < 0) return;
        const bootAtIso = new Date(Date.now() - Math.floor(up) * 1000).toISOString();
        storageService.appendBoot(bootAtIso);
    } catch (err) {
        log.warn('[Init] açılış zamanı kaydedilemedi:', err && err.message);
    }
}

/**
 * P1-6: Sessiz saat (quiet hours) penceresi içinde miyiz? Gece yarısını
 * kesen aralıklar (22:00 → 08:00) doğru ele alınır.
 * @param {object} settings
 * @param {Date} [now]
 * @returns {boolean}
 */
function isQuietHoursNow(settings, now = new Date()) {
    try {
        if (!settings || settings.quietHoursEnabled !== true) return false;
        const parse = (s) => {
            const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || ''));
            return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
        };
        const start = parse(settings.quietStart);
        const end = parse(settings.quietEnd);
        if (start === null || end === null) return false;
        const cur = now.getHours() * 60 + now.getMinutes();
        // Aynı gün içi pencere (08:00→17:00) veya gece yarısını kesen (22:00→08:00).
        return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
    } catch (_) {
        return false;
    }
}

async function startHeadless() {
    const { bootAgent } = require('./src/agent/headless');
    const appVersion = getAppVersion();
    const syncMs = Number(process.env.PP_SYNC_MS) || 60000;
    headlessHandle = await bootAgent({
        userDataPath: app.getPath('userData'),
        appVersion,
        syncIntervalMs: syncMs
    });
    const shutdown = () => app.quit();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    log.info(`[Headless] ajan hazır (veri: ${headlessHandle.dir})`);
    return headlessHandle;
}

/**
 * WP-04: sır deposu başlatma + düz metin migrasyonu.
 * Backend yoksa ve korunacak sır varsa başlatma reddedilir (düz metin fallback yok).
 */
async function initSecrets() {
    const dir = app.getPath('userData');
    secretStore = new SecretStore({
        filePath: path.join(dir, 'secrets.v1.json'),
        applyAcl: true,
        logger: log
    });
    storageService.setSecretStore(secretStore);

    const available = await secretStore.isAsyncEncryptionAvailable();
    const plaintext = SecretStore.findPlaintextSecrets(storageService.data);
    if (!available) {
        if (plaintext.length > 0 || secretStore.listNames().length > 0) {
            throw Object.assign(
                new Error('safeStorage/DPAPI kullanılamıyor; sırlar korunamaz. Uygulama kullanıcı hesabıyla çalıştırılmalı.'),
                { code: 'SECRET_BACKEND_UNAVAILABLE', plaintext }
            );
        }
        log.warn('[Secrets] safeStorage kullanılamıyor; kayıtlı sır yok, devam ediliyor.');
        return;
    }

    const result = await secretStore.migrateFromData(storageService.data);
    await secretStore.hydrateData(storageService.data);
    // Audit anahtarı, migrasyon denetim kaydından ÖNCE hazır olmalı; aksi
    // halde legacy adaptörü mevcut HMAC zincirini ezebilir.
    await initAuditKey();

    if (result.migrated.length > 0 || plaintext.length > 0) {
        storageService.save();
        storageService.checkpoint();
        const removed = SecretStore.purgeSecretBackups(storageService.backupDir);
        try {
            const audit = new AuditLog(storageService);
            audit.append({
                actor: 'system',
                action: 'secrets_migrated',
                target: null,
                detail: `migrated=${result.migrated.length}; already=${result.alreadyEncrypted.length}; backups_removed=${removed.length}`
            });
        } catch (err) {
            log.warn('[Secrets] migrasyon denetim kaydı yazılamadı:', err && err.message);
        }
        if (removed.length > 0) {
            log.warn(`[Secrets] Düz metin sır içeren ${removed.length} eski yedek silindi.`);
        }
        log.info(`[Secrets] ${result.migrated.length} sır şifrelendi.`);
    }
}

/**
 * WP-11.T7: audit HMAC anahtarı SecretStore'da tutulur. Kayıt varken anahtar
 * yoksa yeni anahtar ÜRETİLMEZ (T-STO-12): bakım modu + auditTampered.
 */
async function initAuditKey() {
    const checkpointDir = path.join(app.getPath('userData'), 'audit-checkpoints');
    let key = null;
    try {
        key = await secretStore.getSecret('auditHmacKey');
    } catch (err) {
        storageService.enterMaintenance(`Audit anahtarı okunamadı: ${err.message}`);
        storageService.auditTampered = true;
        return;
    }
    const records = storageService.getAuditLog();
    const chain = storageService.getMeta('audit_chain');
    if (!key) {
        if (records.length > 0 && chain === 'hmac-v1') {
            storageService.enterMaintenance('Audit HMAC anahtarı kayıp; yeni anahtar üretilmedi.');
            storageService.auditTampered = true;
            return;
        }
        key = crypto.randomBytes(32).toString('hex');
        await secretStore.setSecret('auditHmacKey', key);
        log.info('[Audit] Yeni HMAC anahtarı provisioning edildi.');
    }
    try {
        storageService.setAuditKey(Buffer.from(key, 'hex'), { checkpointDir, eventLog: true });
        const verify = storageService.verifyAuditChain();
        if (!verify.ok) {
            storageService.auditTampered = true;
            log.error('[Audit] Zincir doğrulaması başarısız:', verify.code, verify.error);
        }
    } catch (err) {
        storageService.enterMaintenance(`Audit zinciri kurulamadı: ${err.message}`);
        storageService.auditTampered = true;
    }
}

/**
 * WP-11.T11: yedek anahtarı SecretStore'da; yoksa bir kez üretilir.
 * Anahtar DB/JSON içine asla yazılmaz.
 */
async function ensureBackupKey() {
    let key = null;
    try {
        key = await secretStore.getSecret('backupAesKey');
    } catch (err) {
        log.error('[Backup] Yedek anahtarı okunamadı:', err && err.message);
        return null;
    }
    if (!key) {
        key = crypto.randomBytes(32).toString('hex');
        await secretStore.setSecret('backupAesKey', key);
        log.info('[Backup] Yeni AES-256-GCM yedek anahtarı provisioning edildi.');
    }
    return key;
}

let backupTimer = null;
let initialBackupTimer = null;
let maintenanceTimer = null;

/** Günlük VACUUM INTO + AES-256-GCM yedek (utilityProcess/CLI). */
function startBackupSchedule() {
    const run = async () => {
        if (!storageService || storageService.maintenanceMode) return;
        try {
            if (storageService.getSettings().autoBackupEnabled === false) return;
            const key = await ensureBackupKey();
            if (!key) return;
            const result = await runBackup({
                dbPath: storageService.dbPath,
                backupDir: storageService.backupDir,
                key,
                prefix: 'powerpilot',
                keep: 7,
                keepDays: 7
            });
            log.info(`[Backup] Günlük yedek alındı: ${path.basename(result.path)} (${result.encBytes} bayt).`);
        } catch (err) {
            log.error('[Backup] Günlük yedek başarısız:', err && err.message);
        }
    };
    // Açılıştan 5 dk sonra ilk yedek; ardından 24 saatte bir.
    initialBackupTimer = timers.setTimeout(run, 5 * 60 * 1000);
    initialBackupTimer.unref?.();
    backupTimer = timers.setInterval(run, 24 * 60 * 60 * 1000);
    backupTimer.unref?.();
}

// K-01: renderer'a asla ham sır/PIN özeti gönderilmez. Yalnızca whitelist
// DTO + hangi sırların dolu olduğunu belirten boolean haritası döner.
const RENDERER_SECRET_FIELDS = new Set([
    'consoleAgentKey', 'localApiKeyPem', 'localApiPfxPassphrase',
    'consoleClientKeyPem', 'consoleClientPfxPassphrase',
    'cancelPinHash', 'cancelPinSalt'
]);

function toRendererSettings(settings) {
    const out = {};
    for (const [key, value] of Object.entries(settings || {})) {
        if (RENDERER_SECRET_FIELDS.has(key)) continue;
        out[key] = value;
    }
    out.secretPresence = {};
    for (const key of RENDERER_SECRET_FIELDS) {
        out.secretPresence[key] = typeof settings[key] === 'string' && settings[key].length > 0;
    }
    return out;
}

/**
 * WP-04: gelen ayar yamasından sır alanlarını ayırır. Kalan alanlar normal
 * ayar akışına gider; sırlar yalnızca SecretStore'a yazılır.
 */
function splitSecretPatch(patch) {
    const rest = { ...(patch || {}) };
    const secrets = {};
    if (!patch || typeof patch !== 'object') return { rest: patch, secrets };
    for (const field of SECRET_SETTING_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
            secrets[field] = patch[field];
            delete rest[field];
        }
    }
    return { rest, secrets };
}

async function initServices() {
    // P0 ONARIM KAPISI: v1.1.0 ve öncesi, Windows ACL sıkılaştırmasını
    // `/T` + `(OI)(CI)F` ile uyguluyordu. Bu kombinasyon dosyaların kendisine
    // hiç ACE yazmadığı için powerpilot.db / secrets.v1.json sahibi için bile
    // erişilemez hale geliyor, sonraki açılışta DB açılamıyor ve kullanıcının
    // tüm görev ve ayarları kayboluyordu. Depo açılmadan ÖNCE onarılır.
    try {
        const repair = Acl.repairInheritedAccess(app.getPath('userData'));
        if (repair.repaired) {
            log.warn(`[Init] Veri dizini ACL'i onarıldı (önceki sürüm hatası): ${(repair.items || []).join(', ')}`);
        } else if (repair.reason && !['HEALTHY', 'UNSUPPORTED_PLATFORM'].includes(repair.reason)) {
            log.warn(`[Init] ACL onarımı tamamlanamadı (${repair.reason}): ${(repair.items || []).join(', ')}`);
        }
    } catch (err) {
        log.warn('[Init] ACL onarım kapısı hata verdi:', err && err.message);
    }
    // "Tüm verileri sil" sırasında kilitli kalan girdiler (Chromium klasörleri)
    // burada, depo açılmadan ÖNCE silinir: kullanıcı hiçbir eski veri görmez.
    try {
        const marker = pendingWipeMarkerPath();
        if (fs.existsSync(marker)) {
            const st = DataWipe.applyPendingWipe(marker);
            log.info(`[Init] bekleyen veri silme tamamlandı: ${st.removed} girdi, ${st.remaining.length} kaldı`);
        }
    } catch (err) {
        log.warn('[Init] bekleyen veri silme uygulanamadı:', err && err.message);
    }
    storageService = new StorageService();
    // NSIS kurulumunda seçilen başlangıç dilini ilk açılışta otomatik uygula.
    try {
        if (!storageService.getSettings().language) {
            const langFile = path.join(app.getPath('userData'), 'installer-language.json');
            if (fs.existsSync(langFile)) {
                const parsed = JSON.parse(fs.readFileSync(langFile, 'utf8'));
                const rawLang = parsed && typeof parsed.language === 'string' ? parsed.language.trim() : '';
                if (rawLang) {
                    const resolved = normalizeCatalogLanguage(rawLang);
                    if (ALL_LANGUAGE_CODES.includes(resolved)) {
                        storageService.updateSettings({ language: resolved });
                        log.info(`[Init] Kurulum dili uygulandı: ${resolved}`);
                    }
                }
                try { fs.unlinkSync(langFile); } catch (_) { /* tek seferlik tüketim */ }
            }
        }
    } catch (err) {
        log.warn('[Init] Kurulum dili okunamadı:', err && err.message);
    }
    await initSecrets();
    // WP-11.T7: kurcalanmış audit / bakım modu → yıkıcı eylem yok.
    PowerService.setExecutionGuard(() => {
        if (storageService.maintenanceMode) {
            return { ok: false, code: 'STORAGE_MAINTENANCE', error: t('errorStorageMaintenance') };
        }
        if (storageService.auditTampered) {
            return { ok: false, code: 'AUDIT_TAMPERED', error: t('errorAuditTampered') };
        }
        return { ok: true };
    });
    historyService = new HistoryService(storageService);
    warningManager = new WarningManager(historyService);
    // WP-04/05: PowerShell/tasklist yok; Electron powerMonitor + ps-list.
    safetyPolicyEngine = new SafetyPolicyEngine(storageService, null, null, { powerMonitor });
    metricCollector = new MetricCollector({
        powerMonitor,
        // WP-16: process_running koşulu yokken fastlist/ps-list spawn edilmez.
        needsProcessList: () => !!(taskManager && typeof taskManager.hasProcessConditions === 'function' && taskManager.hasProcessConditions())
    });
    smartFinishEngine = new SmartFinishEngine(metricCollector);
    webhookService = new WebhookService(storageService);
    // WBS-0.1: Enjeksiyon sırası önemli - MetricCollector -> SmartFinishEngine -> TaskManager.
    // TaskManager condition dalı için ikisine de ihtiyaç duyar.
    taskManager = new TaskManager(storageService, warningManager, safetyPolicyEngine, historyService, webhookService, smartFinishEngine, metricCollector, null, timers);
    // WP-08.T3: renderer yalnızca gerçek terminal sonuçta başarı/hata toast'ı gösterir.
    taskManager.setResultListener((payload) => {
        // P1-6: `desktopNotifySkip` / `desktopNotifyStart` artık gerçekten uygulanır.
        const settings = safeGetSettings();
        const quiet = isQuietHoursNow(settings);
        const skipped = payload && (payload.code === 'blocked_by_policy' || payload.code === 'condition_invalid');
        if (!quiet && ((skipped && settings.desktopNotifySkip === true) || (!skipped && settings.desktopNotifyStart === true))) {
            const body = payload && payload.name
                ? `${payload.name}${payload.message ? ` - ${payload.message}` : ''}`
                : t('trayTooltip');
            notifyDesktop('Power Pilot', body);
        }
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(payload.success ? 'task-executed' : 'task-failed', payload);
    });
    taskManager.setChangeListener(scheduleTrayUpdate);
    // A6: kapatma/yeniden başlatma Windows tarafından veto edildiğinde
    // (açık uygulamalar onay bekliyor) kullanıcıya açık rapor gönderilir.
    taskManager.setVetoListener((payload) => {
        const res = {
            ...payload,
            message: t('shutdownVetoedDetail')
        };
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('shutdown-vetoed', res);
        }
        if (tray && !tray.isDestroyed() && typeof tray.displayBalloon === 'function') {
            try {
                tray.displayBalloon({
                    title: t('shutdownVetoedTitle'),
                    content: t('shutdownVetoedDetail'),
                    iconType: 'warning'
                });
            } catch (_) { /* balon desteklenmiyorsa sessiz geç */ }
        }
    });
    // WBS-2.2: Scheduler yedeği takılır (Store sandbox'unda isSupported()=false → atlanır).
    // Store kapsamı: schtasks yedeği hiç yapılandırılmaz (politika 10.2.4/10.2.8).
    taskManager.schedulerBridge = new TaskSchedulerBridge({
        // Taşınabilir sürümde `app.getPath('exe')` geçici çıkarma dizinini
        // gösterir; oraya kayıt yazmak, uygulama kapandıktan sonra silinmiş bir
        // yolu tetiklemek olur. Kayıt SFX'in kendisine yönlendirilir.
        exePath: Portable.portableExePath(process.env, fs.existsSync) || app.getPath('exe'),
        isStoreApp: !distribution.isFeatureEnabled('taskScheduler')
    });
    // Bozuk DB karantinaya alındıysa görev listesi boşalmıştır; Windows Görev
    // Zamanlayıcı'daki eski kayıtlar artık var olmayan görevleri tetikler ve
    // uygulamayı kendi kendine açardı. Temiz depo ile birlikte temizlenir.
    if (storageService && storageService.recoveredFrom) {
        Promise.resolve(taskManager.schedulerBridge.removeAllTasks())
            .then((r) => {
                if (r && (r.removed || r.failed)) {
                    log.info(`[SchedulerBridge] kurtarma sonrası temizlik: ${r.removed} silindi, ${r.failed} başarısız`);
                }
            })
            .catch((err) => log.warn('[SchedulerBridge] kurtarma temizliği atlandı:', err && err.message));
    }
    // FAZ B: kurumsal pilot - LocalApiService deps'i için ÖNCE kurulur.
    const appVersion = getAppVersion();
    // FAZ D: UPS izleyici (ayar kapalıysa sorgulanmaz).
    upsMonitor = null;
    try {
        const s0 = storageService.getSettings();
        upsMonitor = new UpsMonitor({ host: s0.upsHost || '127.0.0.1', ups: s0.upsName || 'ups' });
    } catch (_) { upsMonitor = null; }
    inventoryService = new InventoryService({ storageService, agentVersion: appVersion, upsMonitor });
    exemptionService = new ExemptionService(storageService);
    orderQueue = new OrderQueue(storageService);
    auditLog = new AuditLog(storageService);
    localApiService = new LocalApiService(storageService, taskManager, PowerService, {
        inventory: inventoryService,
        exemptions: exemptionService,
        queue: orderQueue,
        audit: auditLog,
        powerMonitor,
        // Store sürümünde LAN/ağ maruziyeti yok: yalnızca loopback.
        allowLan: distribution.isFeatureEnabled('lanApi')
    });
    templateService = new TemplateService(storageService);
    energyService = new EnergyEstimateService(storageService);
    deviceService = new DeviceProfileService(storageService);
    // WBS-7.1: AI arka ucu iskeleti - model yoksa AI_NOT_READY kipinde durur,
    // uygulama AI'sız tam işlevsel açılır (IPC + görünüm WBS-7.4'te).
    aiBackend = new AiBackend({ modelDir: path.join(app.getPath('userData'), 'models') });
    log.info(`[AiBackend] durum: ${JSON.stringify(aiBackend.getStatus())}`);
    // WBS-7.2: Model yöneticisi aynı dizini kullanır (indirme IPC'si WBS-7.4'te).
    modelManager = new ModelManager({ modelDir: path.join(app.getPath('userData'), 'models') });
    // Plan kapanışı: STT modelinin ayrı yöneticisi (ayrı manifest, aynı dizin).
    sttModelManager = new ModelManager({
        modelDir: path.join(app.getPath('userData'), 'models'),
        modelId: STT_MODEL_ID,
        file: STT_MODEL_FILE,
        url: STT_MODEL_URL
    });
    // WBS-7.4: AI servisi (ayrıştırıcı). Model yoksa AI_NOT_READY döner.
    aiService = new AiService({ backend: aiBackend, translate: (key, vars) => t(key, vars) });
    // WBS-8.1: Ses servisi aynı model dizinini kullanır (ggml-base.bin).
    sttService = new SttService({ modelDir: path.join(app.getPath('userData'), 'models') });
    // WBS-E3: Cihaz profilleyici (kasa + watt tahmini/ölçümü).
    deviceProfiler = new DeviceProfiler();
    // WBS-9.1 + WP-8: Ajan orkestratörü (deterministik yönlendirme + şablon/bağlantı/RAG).
    agentOrchestrator = new AgentOrchestrator({ aiService, aiBackend, storage: storageService, history: historyService });
    // WP-5: Yerel tanılama, hata/çökme raporlama ve ZIP destek paketi servisi.
    let downloadsDir = null;
    try { downloadsDir = app.getPath('downloads'); } catch (_) { downloadsDir = null; }
    diagnosticsService = new DiagnosticsService({
        userDataDir: app.getPath('userData'),
        logsDir: path.join(app.getPath('userData'), 'logs'),
        downloadsDir,
        appVersion: getAppVersion(),
        distributionChannel: distribution.IS_STORE ? 'store' : 'direct',
        isPortable: Portable.isPortable(process.env),
        storageService
    });
    diagnosticsService.recordSystemEvent({
        level: 'info',
        scope: 'startup',
        message: `Power Pilot v${getAppVersion()} initialized (portable=${Portable.isPortable(process.env)})`
    });

    // FAZ B: konsol istemcisi + emir icracısı (deviceService yukarıda kuruldu).
    // Store kapsamı: konsol ajanı/senkronu yok (politika 10.2.4).
    consoleClient = distribution.isFeatureEnabled('consoleAgent')
        ? new ConsoleClient({
            storage: storageService,
            inventoryService,
            orderQueue,
            audit: auditLog
        })
        : null;
    orderExecutor = new OrderExecutor({ taskManager, deviceService, audit: auditLog });
    if (consoleClient) startConsoleSync();
    // P1-9: UPS düşük-batarya gözetimi (varsayılan kapalı; ayar açıksa çalışır).
    try { startUpsSupervisor(storageService.getSettings()); } catch (err) {
        log.warn('[UPS] gözetim başlatılamadı:', err && err.message);
    }
    startBackupSchedule();
    // Sunucusuz yerel Microsoft OneDrive bulut yedekleme ve 300ms debounce esitleme servisi.
    oneDriveSyncService = new OneDriveSyncService({
        storageService,
        userDataDir: app.getPath('userData'),
        appVersion: getAppVersion(),
        logger: log,
        debounceMs: 300
    });
    storageService.setChangeListener((reason) => {
        try {
            if (oneDriveSyncService) oneDriveSyncService.scheduleAutoSync(reason);
        } catch (err) {
            log.warn('[OneDriveSync] Otomatik esitleme planlanamadi:', err && err.message);
        }
    });
    // WP-11.T10: süresi geçen nonce'lar periyodik temizlenir.
    maintenanceTimer = timers.setInterval(() => {
        try { storageService.purgeExpiredNonces(); } catch (_) { /* yut */ }
    }, 6 * 60 * 60 * 1000);
    maintenanceTimer.unref?.();

    const apiStarted = await localApiService.start();
    if (!apiStarted || apiStarted.ok === false) {
        log.error('[IPC] Local API başlatılamadı:', apiStarted && apiStarted.code);
    }

    // P0/BLOCKER-001: `powercfg /requests` yükseltilmiş yetki ister; paket
    // `asInvoker` çalışır. Yetenek yoksa kapı atlanır - bu GÖRÜNÜR olmalı:
    // açılışta tek denetim kaydı + get-security-status + Ayarlar uyarısı.
    // Pencere açılışını BLOKLAMAZ: sonda en fazla 3 sn sürebilir ve kapı
    // zaten ilk görevde lazily ölçer; bu yüzden sonraki tura bırakılır.
    const recordPowerRequestCapability = async () => {
        try {
            const cap = await safetyPolicyEngine.probePowerRequestCapability();
            if (cap && cap.available === false) {
                log.warn('[Safety] Aktif güç isteği ölçümü kullanılamıyor (yükseltme gerekli); checkSystemLoad kapısı atlanacak.');
                try {
                    auditLog.append({
                        actor: 'system',
                        action: 'power_request_check_unavailable',
                        target: 'safety-policy',
                        detail: 'powercfg /requests yükseltilmiş yetki gerektiriyor; checkSystemLoad kapısı atlanıyor, diğer kapılar etkin.'
                    });
                } catch (auditErr) {
                    log.warn('[Safety] Yetenek kaydı denetim günlüğüne yazılamadı:', auditErr && auditErr.message);
                }
            }
        } catch (probeErr) {
            log.warn('[Safety] Yetenek sondası başarısız:', probeErr && probeErr.message);
        }
    };
    setImmediate(() => { void recordPowerRequestCapability(); });

    // Wire up WarningManager events to UI
    const forwardWarning = (channel) => (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, data);
        }
    };
    // P1-6: plasebo ayarlarını gerçek davranışa bağlayan yardımcılar.
    const safeGetSettings = () => {
        try {
            return (storageService && typeof storageService.getSettings === 'function')
                ? (storageService.getSettings() || {})
                : {};
        } catch (_) {
            return {};
        }
    };
    const isDesktopNotifyAllowed = (settings) => {
        // P1-6 (beşinci tur): `notifications` ayarı depoda ve şemada vardı ama
        // HİÇBİR mantık okumuyordu; kullanıcı "Bildirimleri Göster"i kapatsa
        // bile masaüstü balonları gelmeye devam ediyordu. Artık ana anahtar.
        if (settings && settings.notifications === false) return false;
        if (settings && settings.quietHoursEnabled === true && isQuietHoursNow(settings)) return false;
        return true;
    };
    const notifyDesktop = (title, body) => {
        try {
            if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) return;
            const n = new Notification({ title, body, icon: getCurrentAppIconImage(64) });
            n.on('click', () => {
                try {
                    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
                } catch (_) { /* yut */ }
            });
            n.show();
        } catch (err) {
            log.warn('[Notify] masaüstü bildirimi gönderilemedi:', err && err.message);
        }
    };
    /**
     * Kapatma uyarısı kullanıcıya GÖRÜNMELİ.
     *
     * Ölçülen kusur: kullanıcı "1 saat sonra kapat" der ve pencereyi kapatır
     * (uygulama tepside çalışmaya devam eder). Süre dolunca uyarı yalnızca
     * gizli pencerenin DOM'una yazılıyordu; `full` modda süre dolunca
     * `proceed:true` olduğu için makine, kullanıcı hiçbir şey görmeden
     * kapanıyordu. Uyarı başlarken pencere öne getirilir.
     */
    warningManager.on('warning-started', (data) => {
        forwardWarning('warning-started')(data);
        const settings = safeGetSettings();
        try {
            // P1-6: `quietHoursEnabled` artık gerçekten uygulanır. Sessiz saat
            // penceresinde pencere zorla öne getirilmez ve balon gösterilmez;
            // uyarı yine çalışır (iptal hakkı korunur), yalnızca taciz etmez.
            const quiet = isQuietHoursNow(settings);
            if (!quiet && mainWindow && !mainWindow.isDestroyed() && !isQuitting) {
                if (!mainWindow.isVisible()) mainWindow.show();
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.setAlwaysOnTop(true);
                mainWindow.focus();
                // Uyarı bannerı kapatıldığında (veya süre dolduğunda) üstte
                // kalma bırakılır; kalıcı always-on-top kullanıcıyı hapsederdi.
                const release = () => {
                    warningManager.removeListener('warning-finished', release);
                    warningManager.removeListener('warning-cancelled', release);
                    warningManager.removeListener('warning-snoozed', release);
                    try {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.setAlwaysOnTop(false);
                        }
                    } catch (_) { /* pencere kapanmış */ }
                };
                warningManager.once('warning-finished', release);
                warningManager.once('warning-cancelled', release);
                warningManager.once('warning-snoozed', release);
            }
        } catch (err) {
            log.warn('[Warning] pencere öne getirilemedi:', err && err.message);
        }
        // P1-6: `desktopNotifyWarn` kapalıysa balon gönderilmez.
        if (settings.desktopNotifyWarn !== false && isDesktopNotifyAllowed(settings)) {
            if (tray) {
                try {
                    tray.displayBalloon({
                        title: 'Power Pilot',
                        content: t('trayWarningRunning')
                    });
                } catch (_) { /* balon desteklenmiyor */ }
            }
            notifyDesktop('Power Pilot', t('trayWarningRunning'));
        }
    });
    warningManager.on('warning-tick', forwardWarning('warning-tick'));
    // WBS-9.4: Banner'ın kapanması için terminal olayları da iletilir.
    warningManager.on('warning-cancelled', forwardWarning('warning-cancelled'));
    warningManager.on('warning-snoozed', forwardWarning('warning-snoozed'));
    warningManager.on('warning-finished', forwardWarning('warning-finished'));
}

// WBS-0.2: Tek doğruluk kaynağı TaskManager'dır. Legacy targetTime/checkInterval
// değişkenleri kaldırıldı; hızlı zamanlayıcının sahip olduğu görev ID'si tutulur.
let quickTimerTaskId = null;

// FAZ B: konsol senkronizasyon döngüsü (60sn). Konsol tanımsızsa sessiz durur;
// hata üretmez, yalnızca loglar. Emirler verify→kuyruk→icra hattından geçer.
function startConsoleSync() {
    if (consoleSyncTimer) clearInterval(consoleSyncTimer);
    const tick = async () => {
        try {
            if (!consoleClient || !consoleClient.isConfigured()) return;
            const res = await consoleClient.sync();
            if (res && res.disabled) return; // kill-switch: yalnızca heartbeat sürer
            // Y-03: duraklatma yalnızca icrayı engeller; heartbeat/sync sürer.
            if (res && res.ok && !(taskManager && taskManager.pausedAll) && orderQueue) {
                await orderExecutor.drain(orderQueue);
            } else if (res && !res.ok && res.code !== 'CONSOLE_UNREACHABLE') {
                log.warn(`[ConsoleSync] ${res.code}: ${res.error || ''}`);
            }
        } catch (err) {
            log.warn('[ConsoleSync] beklenmeyen hata:', err && err.message);
        }
    };
    consoleSyncTimer = timers.setInterval(tick, 60000);
    // Açılışta 20sn sonra ilk deneme (metrikler otursun).
    timers.setTimeout(tick, 20000);
}

function hardenWebContents(contents) {
    // WP-10.T2: dış gezinme ve yeni pencere yok; yalnızca https dış tarayıcıda açılır.
    contents.on('will-navigate', (event, url) => {
        if (!isAllowedAppUrl(url)) {
            event.preventDefault();
            log.warn(`[Security] Gezinme engellendi: ${url}`);
        }
    });
    contents.on('will-redirect', (event, url) => {
        if (!isAllowedAppUrl(url)) event.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
        openExternalSafely(shell, url, log);
        return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
}

function getShortcutDirs() {
    const desktopDirs = [];
    const startMenuDirs = [];
    const taskbarDirs = [];
    const pushUnique = (list, candidate) => {
        if (!candidate || typeof candidate !== 'string') return;
        const norm = path.resolve(candidate);
        if (!list.some((d) => d.toLowerCase() === norm.toLowerCase())) list.push(norm);
    };
    try { pushUnique(desktopDirs, app.getPath('desktop')); } catch (_) { /* yut */ }
    try { pushUnique(desktopDirs, path.join(os.homedir(), 'Desktop')); } catch (_) { /* yut */ }
    if (process.env.OneDrive) pushUnique(desktopDirs, path.join(process.env.OneDrive, 'Desktop'));
    if (process.env.OneDriveConsumer) pushUnique(desktopDirs, path.join(process.env.OneDriveConsumer, 'Desktop'));
    if (process.env.OneDriveCommercial) pushUnique(desktopDirs, path.join(process.env.OneDriveCommercial, 'Desktop'));
    if (process.env.PUBLIC) pushUnique(desktopDirs, path.join(process.env.PUBLIC, 'Desktop'));
    if (process.env.APPDATA) {
        const programs = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        pushUnique(startMenuDirs, programs);
        pushUnique(startMenuDirs, path.join(programs, 'Power Pilot'));
        pushUnique(startMenuDirs, path.join(programs, 'Startup'));
        const pinned = path.join(process.env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
        pushUnique(taskbarDirs, path.join(pinned, 'TaskBar'));
        pushUnique(taskbarDirs, path.join(pinned, 'ImplicitAppShortcuts'));
    }
    if (process.env.ProgramData) {
        const commonPrograms = path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
        pushUnique(startMenuDirs, commonPrograms);
        pushUnique(startMenuDirs, path.join(commonPrograms, 'Power Pilot'));
    }
    return { desktopDirs, startMenuDirs, taskbarDirs };
}

function getCurrentAppIconId() {
    const raw = storageService && typeof storageService.getSettings === 'function'
        ? storageService.getSettings().appIcon
        : null;
    return AppIconService.normalizeAppIcon(raw);
}

function getCurrentCustomIconColor() {
    const settings = storageService && typeof storageService.getSettings === 'function'
        ? storageService.getSettings()
        : null;
    return (settings && (settings.customIconColor || settings.customThemeColor)) || '#3b82f6';
}

function getCurrentUiZoom() {
    const raw = storageService && typeof storageService.getSettings === 'function'
        ? storageService.getSettings().uiZoom
        : 100;
    const num = Number(raw);
    if (!Number.isFinite(num)) return 100;
    return Math.min(150, Math.max(75, Math.round(num)));
}

function applyRuntimeUiZoom(zoomPercent) {
    const clamped = Math.min(150, Math.max(75, Math.round(Number(zoomPercent) || 100)));
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
        try {
            mainWindow.webContents.setZoomFactor(clamped / 100);
        } catch (err) {
            log.warn('[Zoom] yakınlaştırma uygulanamadı:', err && err.message);
        }
    }
    return clamped;
}

function getCurrentAppIconPath() {
    return AppIconService.resolveIconIcoPath(getCurrentAppIconId(), {
        rootDir: __dirname,
        resourcesPath: process.resourcesPath,
        userDataDir: app.getPath('userData'),
        customIconColor: getCurrentCustomIconColor(),
        isPackaged: app.isPackaged
    });
}

function getCurrentAppIconImage(targetSize = null) {
    const id = getCurrentAppIconId();
    const userDataDir = app.getPath('userData');
    const customIconColor = getCurrentCustomIconColor();
    const icoPath = AppIconService.resolveIconIcoPath(id, {
        rootDir: __dirname,
        resourcesPath: process.resourcesPath,
        userDataDir,
        customIconColor,
        isPackaged: app.isPackaged
    });
    const pngPath = AppIconService.resolveIconPngPath(id, {
        rootDir: __dirname,
        resourcesPath: process.resourcesPath,
        userDataDir,
        customIconColor,
        isPackaged: app.isPackaged
    });
    return AppIconService.buildRuntimeIconPayload(id, { icoPath, pngPath, nativeImage, targetSize });
}

function applyRuntimeAppIcon(iconId, { updateShortcuts = true, customIconColor = null } = {}) {
    const { desktopDirs, startMenuDirs, taskbarDirs } = getShortcutDirs();
    return AppIconService.applyAppIcon(iconId, {
        mainWindow,
        miniWindow,
        tray,
        shell,
        nativeImage,
        rootDir: __dirname,
        resourcesPath: process.resourcesPath,
        userDataDir: app.getPath('userData'),
        customIconColor: customIconColor || getCurrentCustomIconColor(),
        desktopDirs,
        startMenuDirs,
        taskbarDirs,
        isPortable: Portable.isPortable(process.env),
        isStoreBuild: distribution.IS_STORE === true,
        isPackaged: app.isPackaged,
        updateShortcuts,
        logger: log
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 840,
        // Responsive iskelet: 720x520'ye kadar daraltilabilir (drawer modu).
        // PPX-013: 640x480 desteklenmez; istenirse 720x520'ye kenetlenir.
        minWidth: 720,
        minHeight: 520,
        resizable: true,
        frame: false,
        titleBarStyle: 'hidden',
        // A2: Pencere hazır olmadan gösterilmez; aksi halde açılışta kısa bir
        // beyaz parlama görünür ("yarım açılmış" izlenimi). Arka plan rengi
        // koyu tema iskeletiyle eşleşir.
        show: false,
        backgroundColor: '#0b1120',
        icon: getCurrentAppIconImage(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    hardenWebContents(mainWindow.webContents);
    mainWindow.loadURL('app://powerpilot/index.html');

    // `show: false` ile açılan pencere, ilk kare hazır olunca gösterilir;
    // böylece beyaz parlama olmaz ve kullanıcı doğrudan arayüzü görür.
    // WP-2: Pencere HWND hazır olduğunda seçili ikon yeniden uygulanır (Windows
    // görev çubuğu tutarlılığı). WP-9: startMinimized etkinse tepside açılır.
    mainWindow.webContents.on('did-finish-load', () => {
        applyRuntimeUiZoom(getCurrentUiZoom());
    });

    mainWindow.once('ready-to-show', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            applyRuntimeAppIcon(getCurrentAppIconId(), { updateShortcuts: false });
            applyRuntimeUiZoom(getCurrentUiZoom());
            const startMin = storageService && typeof storageService.getSettings === 'function'
                && storageService.getSettings().startMinimized === true;
            if (!startMin) {
                mainWindow.show();
                mainWindow.focus();
            }
        }
    });

    mainWindow.on('close', (event) => {
        const hasActive = taskManager && taskManager.getActiveTasks().length > 0;
        if (!isQuitting && hasActive) {
            event.preventDefault();
            mainWindow.hide();
            if (tray) {
                tray.displayBalloon({
                    title: 'Power Pilot',
                    content: t('trayBackgroundRunning')
                });
            }
            return;
        }
        const closeToTray = storageService && typeof storageService.getSettings === 'function'
            ? storageService.getSettings().closeToTray === true
            : false;
        if (!isQuitting && closeToTray && tray) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    const sendState = (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-state-changed', state);
        }
    };

    mainWindow.on('show', () => { sendState('show'); isMiniWindowDismissed = false; updateMiniWindowVisibility(); });
    mainWindow.on('hide', () => { sendState('hide'); updateMiniWindowVisibility(); });
    mainWindow.on('minimize', () => { sendState('minimize'); updateMiniWindowVisibility(); });
    mainWindow.on('restore', () => { sendState('restore'); isMiniWindowDismissed = false; updateMiniWindowVisibility(); });
    mainWindow.on('focus', () => { isMiniWindowDismissed = false; updateMiniWindowVisibility(); });
    mainWindow.on('blur', () => {
        timers.setTimeout(() => {
            updateMiniWindowVisibility();
        }, 100);
    });
}

function updateMiniWindowVisibility() {
    // WBS-0.2: Görünürlük kararı TaskManager aktif görev sayısına bağlıdır.
    const autoMini = storageService && typeof storageService.getSettings === 'function'
        ? storageService.getSettings().autoMiniWidget !== false
        : true;
    const hasActive = taskManager && taskManager.getActiveTasks().length > 0;
    if (!hasActive || !autoMini || isMiniWindowDismissed) {
        if (miniWindow && !miniWindow.isDestroyed()) {
            miniWindow.close();
        }
        miniWindow = null;
        return;
    }

    const isMainVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const isMainMinimized = mainWindow && !mainWindow.isDestroyed() && mainWindow.isMinimized();
    const isMainFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

    const shouldShowMini = !isMainVisible || isMainMinimized || !isMainFocused;

    if (shouldShowMini) {
        if (!miniWindow || miniWindow.isDestroyed()) {
            createMiniWindow();
        } else {
            if (!miniWindow.isVisible()) {
                miniWindow.showInactive();
            }
        }
    } else {
        if (miniWindow && !miniWindow.isDestroyed()) {
            miniWindow.close();
            miniWindow = null;
        }
    }
}

function createMiniWindow() {
    if (miniWindow && !miniWindow.isDestroyed()) return;

    // B5: Mini widget, ana pencerenin bulunduğu ekrana (yoksa imlecin
    // bulunduğu ekrana, yoksa birincil ekrana) yerleşir; böylece çoklu
    // monitör/DPI kurulumlarında yanlış ekranda belirmez.
    const anchorBounds = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow.getBounds()
        : null;
    let cursorPoint = null;
    try {
        cursorPoint = screen.getCursorScreenPoint();
    } catch (_) {
        cursorPoint = null;
    }

    const placement = miniPlacement.computePlacement({
        displays: screen.getAllDisplays(),
        primaryDisplay: screen.getPrimaryDisplay(),
        anchorBounds,
        cursorPoint
    });

    miniWindow = new BrowserWindow({
        width: placement.width,
        height: placement.height,
        x: placement.x,
        y: placement.y,
        // PPX-014: pencere sabit boyutlu; yine de savunma amaçlı alt sınır.
        minWidth: 160,
        minHeight: 48,
        frame: false,
        transparent: true,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        icon: getCurrentAppIconImage(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false
        }
    });

    hardenWebContents(miniWindow.webContents);
    miniWindow.loadURL('app://powerpilot/mini.html');

    miniWindow.once('ready-to-show', () => {
        if (miniWindow && !miniWindow.isDestroyed()) {
            miniWindow.showInactive();
        }
    });

    miniWindow.on('closed', () => {
        miniWindow = null;
    });

    // B5: Ekran yapılandırması değişirse (monitör sökülür/eklenir, DPI veya
    // çözünürlük değişir) mini widget görünmez koordinatta kalmasın; yeni
    // yerleşime taşınır.
    const repositionMini = () => {
        if (!miniWindow || miniWindow.isDestroyed()) return;
        const anchor = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
        let cursor = null;
        try {
            cursor = screen.getCursorScreenPoint();
        } catch (_) {
            cursor = null;
        }
        const placement = miniPlacement.computePlacement({
            displays: screen.getAllDisplays(),
            primaryDisplay: screen.getPrimaryDisplay(),
            anchorBounds: anchor,
            cursorPoint: cursor
        });
        miniWindow.setBounds(placement);
    };
    screen.on('display-removed', repositionMini);
    screen.on('display-added', repositionMini);
    screen.on('display-metrics-changed', repositionMini);
    miniWindow.on('closed', () => {
        screen.removeListener('display-removed', repositionMini);
        screen.removeListener('display-added', repositionMini);
        screen.removeListener('display-metrics-changed', repositionMini);
        stopMiniSync();
    });

    // Sayaç beslemesi: mini pencere HER aktif görevde açılır, ama tick
    // verisini yalnızca hızlı zamanlayıcı renderer'ı gönderiyordu. Diğer
    // görevlerde widget "--" / "00:00" ile boş kalıyordu. Tek doğruluk
    // kaynağı TaskManager'dan beslenir.
    startMiniSync();
}

// Mini widget sayaç senkronizasyonu (1 sn). Tek doğruluk kaynağı TaskManager.
let miniSyncTimer = null;
let miniWidgetTaskId = null;

function pushMiniTimerState() {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    if (!taskManager) return;
    let state = null;
    try {
        state = miniWidgetState.computeState({
            tasks: taskManager.getActiveTasks().map((task) => (
                typeof task.toJSON === 'function' ? task.toJSON() : task
            )),
            now: Date.now(),
            t: (key) => t(key),
            actionLabel: (action) => actionLabel(currentLanguage(), action),
            taskDisplayName: (task) => taskName(currentLanguage(), task),
            daySuffix: translate(currentLanguage(), 'timeFormatDays')
        });
    } catch (err) {
        log.warn('[Mini] durum hesaplanamadı:', err && err.message);
        return;
    }
    if (!state) return;
    miniWidgetTaskId = state.taskId || null;
    try {
        miniWindow.webContents.send('timer-tick', state);
    } catch (_) { /* pencere kapanıyor olabilir */ }
}

function startMiniSync() {
    stopMiniSync();
    pushMiniTimerState();
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniSyncTimer = timers.setInterval(pushMiniTimerState, 1000);
    }
}

function stopMiniSync() {
    if (miniSyncTimer) {
        timers.clear(miniSyncTimer);
        miniSyncTimer = null;
    }
    miniWidgetTaskId = null;
}

function showMainWindowForPin(reason) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        mainWindow.webContents.send('request-tray-pin-action', reason);
    }
    if (tray) {
        tray.displayBalloon({ title: 'Power Pilot', content: t('trayPinProtected') });
    }
}

function createTray() {
    tray = new Tray(getCurrentAppIconImage(32));

    const updateTrayMenu = (force = false) => {
        const activeCount = taskManager ? taskManager.getActiveTasks().length : 0;
        const nextTask = taskManager ? taskManager.getNextTask() : null;
        const lang = currentLanguage();
        const settings = storageService ? storageService.getSettings() : {};
        const statusLabel = nextTask ? t('trayNext', { name: taskName(lang, nextTask) }) : t('trayActiveCount', { count: activeCount });
        // WBS-9.6: Mod göstergesi + hızlı geçiş (değişim sonraki görevden geçerli).
        const mode = settings.autonomyMode || 'classic';
        const modeLabel = mode === 'full' ? t('trayModeFull') : t('trayModeClassic');
        // WP-13.T5: imza değişmezse menü yeniden kurulmaz.
        const signature = JSON.stringify({
            statusLabel,
            modeLabel,
            paused: settings.automationPaused === true,
            pin: Boolean(settings.cancelPinHash),
            lang,
            nextId: nextTask ? nextTask.id : null,
            nextTime: nextTask && nextTask.trigger ? nextTask.trigger.targetTime || null : null
        });
        if (!force && signature === lastTraySignature) return;
        lastTraySignature = signature;

        const contextMenu = Menu.buildFromTemplate([
            { label: t('trayShow'), click: () => { if (mainWindow) mainWindow.show(); } },
            { label: statusLabel, enabled: false },
            { label: modeLabel, enabled: false },
            { type: 'separator' },
            {
                label: t('trayTogglePause'), click: () => {
                    // Y-02: PIN kuruluysa tray'den PIN'siz duraklatma yok.
                    if (settings.cancelPinHash) return showMainWindowForPin('pause');
                    try { if (taskManager) taskManager.togglePauseAll(); } catch (err) {
                        log.error('[Tray] duraklatma kalıcılaştırılamadı:', err && err.message);
                    }
                    scheduleTrayUpdate();
                }
            },
            {
                label: mode === 'full' ? t('traySwitchClassic') : t('traySwitchFull'),
                click: () => {
                    // Y-05: otonomi modu güvenlik ayarıdır; tray doğrudan yazmaz,
                    // PIN'li renderer akışını başlatır.
                    if (!mainWindow || mainWindow.isDestroyed()) return;
                    mainWindow.show();
                    if (mainWindow.isMinimized()) mainWindow.restore();
                    mainWindow.focus();
                    mainWindow.webContents.send('request-autonomy-change',
                        mode === 'full' ? 'classic' : 'full');
                }
            },
            {
                label: t('traySilenceAi'), click: () => {
                    // L-11: sessizleştirme doğrulanmış ayar yolundan geçer; şema dışı yazım yok.
                    const until = Date.now() + 86400000;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('request-ai-silence', until);
                    } else {
                        setAiSilencedUntil(until).then(scheduleTrayUpdate).catch(() => { });
                    }
                    scheduleTrayUpdate();
                }
            },
            {
                label: t('trayCancelNearest'), click: () => {
                    if (!nextTask) return;
                    // WBS-11.2: PIN kuruluysa tray'den sessiz iptal yok - pencere açılır.
                    if (settings.cancelPinHash) {
                        if (mainWindow) {
                            mainWindow.show();
                            if (mainWindow.isMinimized()) mainWindow.restore();
                            mainWindow.focus();
                        }
                        if (tray) {
                            tray.displayBalloon({
                                title: 'Power Pilot',
                                content: t('trayPinProtected')
                            });
                        }
                        return;
                    }
                    taskManager.cancelTask(nextTask.id);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('timer-cancelled-from-tray');
                    }
                    scheduleTrayUpdate();
                }
            },
            { type: 'separator' },
            {
                label: t('trayQuit'), click: () => {
                    // Y-02: PIN kuruluysa çıkış PIN'li renderer akışına yönlendirilir;
                    // tray, PIN korumalı iptalin arka kapısı olamaz.
                    if (settings.cancelPinHash) return showMainWindowForPin('quit');
                    isQuitting = true;
                    app.quit();
                }
            }
        ]);
        tray.setToolTip(t('trayTooltip'));
        tray.setContextMenu(contextMenu);
    };

    tray.setToolTip(t('trayTooltip'));
    trayUpdater = updateTrayMenu;
    updateTrayMenu(true);

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

// WP-12: SingletonLock dosyası elle SİLİNMEZ. Electron süreç sahipliğini
// kendisi doğrular; elle silme ikinci örneğin veriyi bozmasına yol açar.
// Headless servis, GUI örneğinden bağımsızdır (farklı user-data-dir).
const gotTheLock = HEADLESS_MODE ? true : app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    if (!HEADLESS_MODE) app.on('second-instance', (event, commandLine) => {
        // P0-2: Scheduler yedeği uygulama açıkken tetiklenirse argv buraya gelir;
        // kayıt tüketilip görev normal boru hattından çalıştırılır.
        TaskSchedulerBridge.forwardRunTask(commandLine, taskManager);
        if (mainWindow) {
            mainWindow.show();
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        // WP-10.T1: file:// yerine app:// - protokol handler'ı pencere açılmadan hazır.
        installAppProtocol(path.join(__dirname, 'src'));
        // WP-10.T2/T6: yalnızca bildirim ve (sesli komut için) mikrofon;
        // kamera/konum/genel medya reddedilir. Mikrofon `getUserMedia` ile
        // kullanılıyor ("sesli komut"); burada izin verilmezse düğme her
        // seferinde "mikrofon izni yok" hatası veriyordu.
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
            callback(Permissions.allowRequest(permission, details));
        });
        session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
            return Permissions.allowCheck(permission, details, requestingOrigin);
        });
        session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
            if (!String(details.url || '').startsWith('app://powerpilot/')) {
                callback({ responseHeaders: details.responseHeaders });
                return;
            }
            callback({
                responseHeaders: {
                    ...details.responseHeaders,
                    'Content-Security-Policy': [APP_CSP],
                    'X-Content-Type-Options': ['nosniff'],
                    'Referrer-Policy': ['no-referrer'],
                    'Cross-Origin-Opener-Policy': ['same-origin'],
                    'Cross-Origin-Resource-Policy': ['same-origin']
                }
            });
        });
        // WP-01.T2: imza kanonikleştiricisi hazır olmadan emir üretilmez/doğrulanmaz.
        await SignedOrderService.initCanonicalizer();
        if (HEADLESS_MODE) {
            try {
                await startHeadless();
            } catch (err) {
                log.error('[Init] headless ajan başlatılamadı:', err && err.message);
                app.exitCode = 1;
                app.quit();
            }
            return;
        }
        // WP-04: sır deposu/DPAPI hazır değilse uygulama açılmaz (fail-closed).
        try {
            await initServices();
        } catch (err) {
            log.error('[Init] servisler başlatılamadı:', err && err.message);
            dialog.showErrorBox(t('startupFailed'), startupErrorText(err));
            app.quit();
            return;
        }
        createWindow();
        createTray();
        // P1-5: Enerji ölçümü "kapanış → sonraki açılış" eşleşmesine dayanır.
        // Önceden `appendBoot` YALNIZCA kurumsal envanter toplamasından
        // çağrılıyordu; normal kullanıcıda bootHistory ömür boyu boş kalıp
        // ölçülen oturum sayısı hep 0 çıkıyordu. Artık her açılışta, envanter
        // beklemeden, gerçek OS boot zamanı kaydedilir (aynı dakika tekilleşir).
        registerOsBootTime();
        // WP-08.T2: uykudan dönüşte sayaç hedef zamandan yeniden senkronlanır.
        // Faz 2: kaçırılan görevler kullanıcı politikasına göre çalıştırılır ya
        // da gerekçesiyle atlanır (varsayılan: 10 dk tolerans içindeyse çalıştır).
        powerMonitor.on('resume', () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('system-resumed');
            if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('system-resumed');
            // Metrikler/saat otursun diye kısa gecikme; kullanıcı uyanır uyanmaz
            // görev ateşlenmez.
            timers.setTimeout(() => {
                if (!taskManager) return;
                const s = storageService ? storageService.getSettings() : {};
                const result = taskManager.resyncAfterResume({
                    mode: s.wakeMode === 'skip' ? 'skip' : 'run',
                    toleranceMinutes: Number.isInteger(s.wakeToleranceMinutes) ? s.wakeToleranceMinutes : 10
                });
                if (tray && (result.ran > 0 || result.skipped > 0)) {
                    tray.displayBalloon({
                        title: 'Power Pilot',
                        content: result.ran > 0
                            ? t('wakeRanBalloon', { count: result.ran })
                            : t('wakeSkippedBalloon', { count: result.skipped })
                    });
                }
            }, 5000);
        });

        // WBS-2.2: Scheduler yedeğiyle uyandırma (--run-task=<id>).
        // Pencere hazır olduktan sonra normal boru hattından çalıştırılır
        // (uyarı kartı kullanıcıya gösterilebilir), tek-seferlik kayıt tüketilir.
        const runTaskId = TaskSchedulerBridge.parseRunTaskArgv(process.argv);
        if (runTaskId && taskManager) {
            const started = taskManager.runTaskNow(runTaskId);
            log.info(`[SchedulerBridge] --run-task=${runTaskId} başlatıldı: ${started}`);
            if (taskManager.schedulerBridge) {
                taskManager.schedulerBridge.removeTask(runTaskId);
            }
        }

        app.on('activate', function () {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });

        // WBS-E3: Arka-plan kalibrasyonu - metrikler otursun diye 30sn gecikmeli,
        // tek seferlik; ilk başarıda balon bildirim (sonrakiler sessiz).
        timers.setTimeout(() => {
            try {
                const m = metricCollector ? metricCollector.getMetrics() : {};
                const wasMeasured = storageService.getSettings().wattSource === 'measured';
                deviceProfiler.calibrateIfNeeded(storageService, {
                    hasBattery: m.batterySupported === true,
                    isCharging: typeof m.isCharging === 'boolean' ? m.isCharging : null
                }).then((r) => {
                    if (r.measured && !wasMeasured && tray) {
                        tray.displayBalloon({
                            title: 'Power Pilot',
                            content: t('balloonMeasured', { watt: r.wattW })
                        });
                    }
                }).catch(() => { });
            } catch (_) { }
        }, 30000);
    });
}

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// WP-12: Temiz kapanış - interval/sunucu sızıntısı bırakma. Görev durumu
// değiştirilmez; yarıda kalan işler açılışta recoverTasksOnStartup ile işaretlenir.
app.on('before-quit', (event) => {
    // L-10: ilk kapanışta API/headless stop await edilir (timeout'lu).
    if (shutdownStarted) return;
    shutdownStarted = true;
    event.preventDefault();
    isQuitting = true;
    try { if (consoleSyncTimer) clearInterval(consoleSyncTimer); } catch (_) { }
    try { if (trayUpdateTimer) clearTimeout(trayUpdateTimer); } catch (_) { }
    trayUpdater = null;
    try { if (backupTimer) clearInterval(backupTimer); } catch (_) { }
    try { if (initialBackupTimer) clearTimeout(initialBackupTimer); } catch (_) { }
    try { if (maintenanceTimer) clearInterval(maintenanceTimer); } catch (_) { }
    try { if (taskManager && taskManager.loopInterval) clearInterval(taskManager.loopInterval); } catch (_) { }
    try { if (metricCollector && typeof metricCollector.stopSampling === 'function') metricCollector.stopSampling(); } catch (_) { }
    try { if (aiBackend && typeof aiBackend.close === 'function') aiBackend.close().catch(() => { }); } catch (_) { }

    const stops = [];
    try {
        if (headlessHandle && typeof headlessHandle.stop === 'function') {
            stops.push(Promise.resolve(headlessHandle.stop()).catch(() => { }));
        }
    } catch (_) { /* yut */ }
    try {
        if (localApiService && typeof localApiService.stop === 'function') {
            stops.push(Promise.resolve(localApiService.stop()).catch(() => { }));
        }
    } catch (_) { /* yut */ }

    const finish = () => {
        try {
            if (oneDriveSyncService && typeof oneDriveSyncService.flush === 'function') {
                oneDriveSyncService.flush();
            }
        } catch (_) { /* kapanis flush best-effort; quit'i engellemez */ }
        try {
            if (storageService && storageService.auditCheckpoint) {
                storageService.auditCheckpoint.write(storageService.getAuditLog(), { eventLog: false });
            }
        } catch (_) { /* checkpoint best-effort; quit'i engellemez */ }
        try { if (storageService && typeof storageService.close === 'function') storageService.close(); } catch (_) { }
        try { timers.clearAll(); } catch (_) { }
        app.quit();
    };
    const timeout = new Promise((resolve) => {
        const t = setTimeout(resolve, 5000);
        if (t && typeof t.unref === 'function') t.unref();
    });
    Promise.race([Promise.allSettled(stops), timeout]).then(finish, finish);
});

// IPC Handlers

ipcOn('window-maximize-toggle', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcOn('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcOn('window-close', () => {
    if (mainWindow) mainWindow.close();
});

// WBS-0.2: Hızlı zamanlayıcı TaskManager üzerinden yönetilir; ayrı saat yok.
// TaskManager 1sn döngüsü hedef zamana ulaşıldığında görevi çalıştırır.
function cancelQuickTimer() {
    isMiniWindowDismissed = false;
    if (quickTimerTaskId && taskManager) {
        try { taskManager.cancelTask(quickTimerTaskId); } catch (_) { /* zaten bitmiş olabilir */ }
    }
    quickTimerTaskId = null;
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.close();
    }
    miniWindow = null;
}

ipcHandle('schedule-action', async (event, args) => {
    // WBS-2.1: Şema doğrulaması - reddet + gerekçe, asla çökme yok.
    const check = validateScheduleAction(args);
    if (!check.ok) {
        log.warn(`[IPC] schedule-action reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    const { action, durationMs } = args;

    cancelQuickTimer();

    // Create tracked AutomationTask - tek doğruluk kaynağı budur.
    let task;
    try {
        task = taskManager.createTask({
            name: `Hızlı Zamanlayıcı (${action})`,
            action: action,
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: durationMs }
        });
    } catch (err) {
        // Teknik mesaj logda kalır; kullanıcıya çevrilmiş metin gider
        // (ham hata metni başka dilde arayüzde görünmesin).
        log.warn('[IPC] schedule-action görev oluşturamadı:', err && err.message);
        return { success: false, message: t('errorTaskCreationFailed') };
    }
    quickTimerTaskId = task.id;

    updateMiniWindowVisibility();
    return {
        success: true,
        message: t('toastActionScheduled', { action: actionLabel(currentLanguage(), action) }),
        taskId: task.id,
        targetTime: (task.trigger && task.trigger.targetTime) || (Date.now() + durationMs)
    };
});

ipcHandle('cancel-action', async (event, args) => {
    // WBS-11.2: PIN kuruluysa iptal PIN ister (geriye uyumlu: args opsiyonel).
    const pinCheck = await requireCancelPin(args && args.pin);
    if (pinCheck) return pinCheck;
    // WP-03: Hızlı zamanlayıcıya ek olarak açık uyarı/aktif görev de çözülür.
    // Aksi halde banner açık kalırken görev arka planda çalışmaya devam eder.
    let activeResult = { ok: false, code: 'NO_ACTIVE_WARNING' };
    if (taskManager && typeof taskManager.cancelActiveTask === 'function') {
        activeResult = taskManager.cancelActiveTask();
    }
    // Mini widget, hızlı zamanlayıcı dışındaki görevleri de gösteriyor; "X"
    // düğmesi o görevi iptal edebilmeli. Aksi halde widget'ta dolu sayaç
    // görünürken iptal hiçbir şey yapmazdı (yalnızca ana pencere açılırdı).
    if (!activeResult.ok && miniWidgetTaskId && taskManager) {
        const miniResult = taskManager.cancelTask(miniWidgetTaskId);
        if (miniResult && miniResult.ok) {
            activeResult = { ok: true, code: miniResult.code };
        } else if (miniResult && miniResult.code === 'CANCEL_TOO_LATE') {
            activeResult = miniResult;
        }
    }
    cancelQuickTimer();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
    if (activeResult.code === 'CANCEL_TOO_LATE') {
        return {
            success: false,
            code: 'CANCEL_TOO_LATE',
            message: t('errorCancelTooLate')
        };
    }
    return { success: true, code: activeResult.code || 'NO_ACTIVE_WARNING', message: t('toastActionCancelled') };
});

// NOT: mini widget sayaç beslemesi TEK kaynaktan gelir - `pushMiniTimerState`
// (TaskManager aktif görevleri, 1 sn). Önceden renderer'ın `updateMiniTimer`
// çağrısı burada mini pencereye köprüleniyordu; iki kaynak aynı kanala yazınca
// sayaç titriyor ve hızlı zamanlayıcı dışındaki görevlerde widget boş kalıyordu.
//
// P1-6 (altıncı tur): `update-mini-timer` kanalı ve preload yüzeyi KALDIRILDI.
// Tek doğruluk kaynağına geçildikten sonra bu kanalın işleyicisi boş bir
// no-op'tu ve hiçbir renderer kodu onu çağırmıyordu. Sessiz no-op yüzeyi,
// "placebo" kusurunun IPC biçimidir: yüzey var, davranış yok. Geriye uyum için
// tutmanın bir faydası yoktu çünkü çağıran hiç yoktu.

// D-03: mini pencere tooltip'leri renderer'a hardcoded gitmez.
ipcHandle('get-mini-labels', () => ({
    miniHide: t('miniHide'),
    miniRestore: t('miniRestore'),
    miniCancel: t('miniCancel')
}));

ipcOn('hide-mini-widget', () => {
    isMiniWindowDismissed = true;
    if (miniWindow && !miniWindow.isDestroyed()) {
        miniWindow.close();
    }
    miniWindow = null;
});

ipcOn('restore-main-window', () => {
    isMiniWindowDismissed = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Comprehensive Tasks & Features IPC Handlers
ipcHandle('get-app-version', () => app.getVersion());
// WP-13/WP-15: Pencere yeniden yüklendiğinde aktif uyarı ve zamanlayıcı
// kaybolmaz; renderer bu uçtan durumu geri yükler.
ipcHandle('get-active-state', () => ({
    activeWarning: warningManager && typeof warningManager.getActiveState === 'function'
        ? warningManager.getActiveState()
        : null,
    tasks: taskManager ? taskManager.getActiveTasks().map(t => t.toJSON()) : [],
    claims: taskManager && typeof taskManager.getClaimState === 'function'
        ? taskManager.getClaimState()
        : []
}));
ipcHandle('get-tasks', () => taskManager.tasks.map(t => t.toJSON()));
ipcHandle('create-task', (event, data) => {
    const check = validateTaskData(data);
    if (!check.ok) {
        log.warn(`[IPC] create-task reddedildi: ${check.error}`);
        return { success: false, code: check.code || 'VALIDATION_ERROR', message: t('errorInvalidRequest') };
    }
    try {
        return { success: true, task: taskManager.createTask(data).toJSON() };
    } catch (err) {
        // Aynı gerekçe: ham hata metni renderer'a sızmaz.
        log.warn('[IPC] create-task oluşturamadı:', err && err.message);
        return { success: false, code: err.code || 'TASK_CREATION_FAILED', message: t('errorTaskCreationFailed') };
    }
});
// P1-6 (üçüncü tur): Görev duraklat / sürdür.
// Motorda `task.enabled` beş yürütme yolunda gerçek bir kapıydı ve
// `statusDisabled` 17 dilde çevriliydi, ama hiçbir yol bu alanı yazmıyordu.
ipcHandle('pause-task', (event, taskId) => {
    const check = validateTaskId(taskId);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    const result = taskManager.pauseTask(taskId);
    if (!result.ok) {
        return { success: false, code: result.code || 'PAUSE_FAILED', message: result.message || t('taskPauseFailed') };
    }
    return { success: true, code: result.code };
});
ipcHandle('resume-task', (event, taskId) => {
    const check = validateTaskId(taskId);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    const result = taskManager.resumeTask(taskId);
    if (!result.ok) {
        return { success: false, code: result.code || 'RESUME_FAILED', message: result.message || t('taskResumeFailed') };
    }
    return { success: true, code: result.code, status: result.status };
});
ipcHandle('cancel-task', async (event, payload) => {
    // WBS-11.2: Geriye uyumlu - string id veya {taskId, pin}.
    const taskId = typeof payload === 'string' ? payload : payload && payload.taskId;
    const pin = payload && typeof payload === 'object' ? payload.pin : undefined;
    const check = validateTaskId(taskId);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    const pinCheck = await requireCancelPin(pin);
    if (pinCheck) return pinCheck;
    const result = taskManager.cancelTask(taskId);
    if (!result.ok) return { success: false, code: result.code || 'CANCEL_FAILED', message: t('taskCancelFailed') };
    return { success: true, code: result.code, message: result.message };
});
ipcHandle('snooze-task', async (event, payload) => {
    const check = validateSnooze(payload);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    const pinCheck = await requireCancelPin(payload && payload.pin);
    if (pinCheck) return pinCheck;
    const result = taskManager.snoozeTask(payload.taskId, check.minutes);
    if (!result.ok) return { success: false, code: result.code || 'SNOOZE_FAILED', message: t('taskSnoozeFailed') };
    return { success: true, code: result.code, minutes: result.minutes };
});
// Biten görevleri listeden kaldırma. Çalışan görev silinemez (önce iptal).
ipcHandle('remove-task', (event, taskId) => {
    const check = validateTaskId(taskId);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    const result = taskManager.removeTask(taskId);
    if (!result.ok) {
        const message = result.code === 'TASK_NOT_TERMINAL'
            ? t('taskRemoveNotFinished')
            : t('taskRemoveFailed');
        return { success: false, code: result.code || 'REMOVE_FAILED', message };
    }
    return { success: true, code: result.code };
});
// Terminal durumdaki tüm görevleri temizle.
ipcHandle('remove-terminal-tasks', () => {
    const result = taskManager.removeTerminalTasks();
    return { success: true, removed: result.removed };
});
// WBS-11.2: PIN yönetimi.
// K-01: PIN zaten kuruluysa değiştirme/silme mevcut PIN doğrulaması ister.
// Aksi halde yerel erişimi olan biri PIN'i sıfırlayıp korumalı işlemleri açabilir.
ipcHandle('set-cancel-pin', async (event, args) => {
    const pin = args && args.pin;
    const currentPin = args && args.currentPin;
    const check = validateCancelPin(pin);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    return await setCancelPinAction({
        pin,
        currentPin,
        requireCancelPin,
        storageService,
        auditLog,
        t,
        hashPin: Pin.hashPin
    });
});
ipcHandle('clear-cancel-pin', async (event, args) => {
    return await clearCancelPinAction({
        currentPin: args && args.pin,
        requireCancelPin,
        storageService,
        auditLog,
        t
    });
});
ipcHandle('get-cancel-pin-state', () => {
    return { set: !!storageService.getSettings().cancelPinHash };
});
// Y-02: tray duraklat/çıkış PIN'li renderer akışından gelir. PIN kuruluysa
// bu IPC'ler de doğrulama ister (renderer güven sınırı değildir).
ipcHandle('toggle-pause-all', async (event, args) => {
    if (storageService.getSettings().cancelPinHash) {
        const pinCheck = await requireCancelPin(args && args.pin);
        if (pinCheck) return pinCheck;
    }
    try {
        const paused = taskManager.togglePauseAll();
        scheduleTrayUpdate();
        return { success: true, paused };
    } catch (err) {
        log.error('[IPC] duraklatma kalıcılaştırılamadı:', err && err.message);
        return { success: false, code: (err && err.code) || 'PAUSE_PERSIST_FAILED', message: t('errorSaveFailed') };
    }
});
ipcHandle('quit-app', async (event, args) => {
    if (storageService.getSettings().cancelPinHash) {
        const pinCheck = await requireCancelPin(args && args.pin);
        if (pinCheck) return pinCheck;
    }
    isQuitting = true;
    setImmediate(() => app.quit());
    return { success: true };
});

ipcHandle('get-history', (event, filter) => historyService.getHistory(filter));
ipcHandle('clear-history', () => historyService.clear());
ipcHandle('get-statistics', (event, options) => energyService.getStatistics(options && typeof options === 'object' ? options : {}));
ipcHandle('export-statistics', async (event, args) => {
    const format = args && args.format === 'csv' ? 'csv' : 'json';
    const days = args && args.days ? Number(args.days) : null;
    const stats = energyService.getStatistics(days ? { days } : {});
    if (!stats || stats.enabled === false) {
        return { success: false, code: 'STATS_DISABLED', message: t('errorInvalidRequest') };
    }
    const target = await dialog.showSaveDialog(mainWindow || undefined, {
        title: t('statsExportTitle'),
        defaultPath: `powerpilot-stats.${format}`,
        filters: format === 'csv'
            ? [{ name: 'CSV', extensions: ['csv'] }]
            : [{ name: 'JSON', extensions: ['json'] }]
    });
    if (target.canceled || !target.filePath) return { success: false, code: 'CANCELLED' };
    try {
        let content;
        if (format === 'csv') {
            const rows = [
                'date,runs,hours,kwh',
                ...(stats.dailySeries || []).map((d) => `${d.date},${d.runs},${d.hours},${d.kwh}`)
            ];
            content = rows.join('\n');
        } else {
            content = JSON.stringify({ exportedAt: new Date().toISOString(), appVersion: getAppVersion(), ...stats }, null, 2);
        }
        await fs.promises.writeFile(target.filePath, content, 'utf8');
        return { success: true, filePath: target.filePath };
    } catch (err) {
        log.warn('[IPC] export-statistics yazılamadı:', err && err.message);
        return { success: false, code: 'IO_ERROR', message: t('errorSaveFailed') };
    }
});
// C5: yerel sağlık özeti - hiçbir veri dışarı çıkmaz, yalnızca cihazdaki
// kayıtlar özetlenir (ürünün "telemetri yok" vaadi korunur).
ipcHandle('get-health-summary', () => {
    let installedAtMs = null;
    try {
        const created = storageService.getMeta('created_at');
        const parsed = created ? Date.parse(created) : NaN;
        if (Number.isFinite(parsed)) installedAtMs = parsed;
    } catch (_) { /* meta okunamazsa kurulum yaşı gizlenir */ }
    let history = [];
    try {
        history = historyService.getHistory() || [];
    } catch (_) { history = []; }
    return summarizeHealth({ history, installedAtMs, nowMs: Date.now() });
});
ipcHandle('get-templates', (event, options) => templateService.getTemplates(options && typeof options === 'object' ? options : {}));
ipcHandle('get-hidden-templates', () => templateService.getHiddenBuiltIns());
ipcHandle('save-template', (event, tpl) => {
    // WBS-6.4 + WP-7: Kullanıcı şablonu ve yerleşik şablon düzenleme (override).
    if (!tpl || typeof tpl !== 'object') {
        return { success: false, code: 'INVALID_BODY', message: t('errorInvalidTemplateData') };
    }
    const allowedCategories = new Set(TemplateService.getCategories());
    const safeIcon = (typeof tpl.icon === 'string' && /^[a-z0-9_]{1,40}$/.test(tpl.icon.trim()))
        ? tpl.icon.trim()
        : 'bookmark';
    const safeCategory = (typeof tpl.category === 'string' && allowedCategories.has(tpl.category))
        ? tpl.category
        : 'custom';
    const probe = {
        action: tpl.action,
        ...(tpl.trigger ? { trigger: tpl.trigger } : {}),
        ...(tpl.defaultConditionGroup || tpl.defaultCondition
            ? { conditionGroup: tpl.defaultConditionGroup || { operator: 'AND', conditions: [tpl.defaultCondition] } }
            : {})
    };
    const check = validateTaskData(probe);
    if (!check.ok && !tpl.schedule) {
        log.warn(`[IPC] save-template reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    // NOT: id istemciden gelmez (renderer {name, action, ...} gönderir); sunucu
    // üretir. Bu yüzden doğrulama NORMALEŞTİRİLMİŞ kayıt üzerinde yapılmalı -
    // aksi halde isValidTemplate `typeof tpl.id !== 'string'` kontrolünde
    // takılır ve UI'daki "Şablonu Kaydet" her zaman INVALID_TEMPLATE dönerdi.
    const record = {
        id: typeof tpl.id === 'string' && tpl.id ? tpl.id : `user_tpl_${Date.now()}`,
        name: String(tpl.name || '').trim().slice(0, 80),
        description: String(tpl.description || '').trim().slice(0, 200),
        action: tpl.action,
        icon: safeIcon,
        category: safeCategory,
        ...(tpl.defaultCondition ? { defaultCondition: tpl.defaultCondition } : {}),
        ...(tpl.defaultConditionGroup ? { defaultConditionGroup: tpl.defaultConditionGroup } : {}),
        ...(tpl.schedule ? { schedule: tpl.schedule } : {}),
        ...(tpl.trigger ? { trigger: tpl.trigger } : {})
    };
    if (!TemplateService.isValidTemplate(record)) {
        return { success: false, code: 'INVALID_TEMPLATE', message: t('errorInvalidTemplate') };
    }
    // Yerleşik bir şablon düzenleniyorsa override haritasına kaydet (ve gizliyse görünür yap).
    if (templateService.isBuiltInId(record.id)) {
        const s = storageService.getSettings();
        const overrides = { ...(s.templateOverrides || {}), [record.id]: record };
        const hidden = (Array.isArray(s.hiddenBuiltInTemplates) ? s.hiddenBuiltInTemplates : []).filter((id) => id !== record.id);
        storageService.updateSettings({ templateOverrides: overrides, hiddenBuiltInTemplates: hidden });
        return { success: true, template: { ...record, builtIn: true, modified: true } };
    }
    const list = storageService.getTemplates().filter(t => t.id !== record.id);
    list.push(record);
    storageService.saveTemplates(list);
    return { success: true, template: { ...record, custom: true, builtIn: false } };
});
ipcHandle('delete-template', (event, templateId) => {
    const check = validateTaskId(templateId);
    if (!check.ok) return { success: false, code: check.code, message: t('errorInvalidRequest') };
    // WP-7: Yerleşik şablon silindiğinde gizlenenler listesine alınır (geri getirilebilir).
    if (templateService.isBuiltInId(templateId)) {
        const s = storageService.getSettings();
        const hidden = Array.isArray(s.hiddenBuiltInTemplates) ? [...s.hiddenBuiltInTemplates] : [];
        if (!hidden.includes(templateId)) hidden.push(templateId);
        storageService.updateSettings({ hiddenBuiltInTemplates: hidden });
        return { success: true, hidden: true };
    }
    if (!String(templateId).startsWith('user_tpl_')) {
        return { success: false, code: 'PROTECTED_TEMPLATE', message: t('errorProtectedTemplate') };
    }
    storageService.saveTemplates(storageService.getTemplates().filter(t => t.id !== templateId));
    return { success: true };
});
ipcHandle('reset-template', (event, templateId) => {
    const check = validateTaskId(templateId);
    if (!check.ok || !templateService.isBuiltInId(templateId)) {
        return { success: false, code: 'INVALID_TEMPLATE', message: t('errorInvalidRequest') };
    }
    const s = storageService.getSettings();
    const overrides = { ...(s.templateOverrides || {}) };
    delete overrides[templateId];
    const hidden = (Array.isArray(s.hiddenBuiltInTemplates) ? s.hiddenBuiltInTemplates : []).filter((id) => id !== templateId);
    storageService.updateSettings({ templateOverrides: overrides, hiddenBuiltInTemplates: hidden });
    return { success: true, template: templateService.getBuiltInById(templateId) };
});
ipcHandle('restore-default-templates', (event, options) => {
    const resetEdits = !!(options && options.resetEdits === true);
    const patch = { hiddenBuiltInTemplates: [] };
    if (resetEdits) patch.templateOverrides = {};
    storageService.updateSettings(patch);
    return { success: true, templates: templateService.getTemplates() };
});

// Faz 3: profil/şablon içe-dışa aktarma (sürümlü JSON).
// Kullanıcı şablonları taşınabilir; hazır şablonlar yalnızca dışa aktarımda
// referans olarak yazılır, içe aktarımda yeniden üretilmez (id çakışması yok).
// Kurallar TemplateTransfer'de saf fonksiyonlar hâlinde tutulur (test edilebilir).
ipcHandle('export-templates', async () => {
    const payload = TemplateTransfer.collectExportable(storageService.getTemplates());
    if (!payload) {
        return { success: false, code: 'NO_CUSTOM_TEMPLATES', message: t('errorNoCustomTemplates') };
    }
    const target = await dialog.showSaveDialog(mainWindow || undefined, {
        title: t('templatesExportDialog'),
        defaultPath: 'powerpilot-templates.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (target.canceled || !target.filePath) return { success: false, code: 'CANCELLED' };
    try {
        await fs.promises.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
        auditLog?.append?.({ actor: 'user', action: 'template_export', target: 'templates', detail: String(payload.templates.length) });
        return { success: true, count: payload.templates.length, filePath: target.filePath };
    } catch (err) {
        log.warn(`[IPC] export-templates yazılamadı: ${err.message}`);
        return { success: false, code: 'IO_ERROR', message: t('errorTemplateExport') };
    }
});
ipcHandle('import-templates', async () => {
    const selection = await dialog.showOpenDialog(mainWindow || undefined, {
        title: t('templatesImportDialog'),
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (selection.canceled || !selection.filePaths || selection.filePaths.length === 0) {
        return { success: false, code: 'CANCELLED' };
    }
    let raw;
    try {
        raw = await fs.promises.readFile(selection.filePaths[0], 'utf8');
    } catch (err) {
        log.warn(`[IPC] import-templates okunamadı: ${err.message}`);
        return { success: false, code: 'IO_READ_ERROR', message: t('errorTemplateImport') };
    }
    const parsed = TemplateTransfer.parseImportPayload(raw);
    if (!parsed.ok) {
        log.warn(`[IPC] import-templates geçersiz: ${parsed.code}`);
        const message = parsed.code === 'FILE_TOO_LARGE' ? t('errorTemplateTooLarge') : t('errorTemplateImport');
        return { success: false, code: parsed.code, message };
    }
    const merged = TemplateTransfer.mergeImportedTemplates(parsed.templates, storageService.getTemplates());
    if (merged.added.length === 0) {
        return {
            success: false,
            code: 'NO_VALID_TEMPLATES',
            rejected: merged.rejected,
            message: t('errorTemplateImport')
        };
    }
    storageService.saveTemplates(merged.templates);
    auditLog?.append?.({ actor: 'user', action: 'template_import', target: 'templates', detail: String(merged.added.length) });
    return { success: true, count: merged.added.length, rejected: merged.rejected };
});

// WBS-7.4: AI IPC - durum (RAM kapısı dahil) + komut ayrıştırma.
const AI_STATUS_KEYS = {
    MODEL_MISSING: 'aiModelNotDownloaded',
    NOT_CONFIGURED: 'aiModelNotDownloaded',
    ALREADY_LOADING: 'loading',
    WRONG_PROCESS: 'aiNotReady',
    LOAD_FAILED: 'aiNoResponse'
};

ipcHandle('ai-status', () => {
    const totalGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
    const status = aiBackend.getStatus();
    // Durum metni servis içinde Türkçe üretilir; arayüze aktif dilde gider.
    const key = AI_STATUS_KEYS[status.code];
    return {
        ...status,
        ...(key ? { message: t(key) } : {}),
        model: modelManager.status(),
        stt: sttModelManager.status(),
        download: { ...aiDownloadState },
        ramGb: totalGb,
        ramOk: os.totalmem() >= 4294967296
    };
});
ipcHandle('ai-parse', async (event, text) => {
    // WBS-9.1 + el-freni: orkestratör kuyruk/susturma/denetim uygular;
    // tümü duraklatılmışken AI komutu reddedilir.
    if (taskManager && taskManager.pausedAll) {
        return { ok: false, code: 'PAUSED', message: t('toastAllPaused') };
    }
    const input = normalizeAiInput(text, { allowEmpty: false });
    if (!input.ok) return { ok: false, code: input.code, message: t('errorInvalidRequest') };
    return localizeResult(await agentOrchestrator.runCommand(input.text), AI_RESULT_KEYS);
});
ipcHandle('ai-assist', async (event, payload) => {
    const text = typeof payload === 'string' ? payload : (payload && payload.text);
    const intentHint = payload && typeof payload === 'object' ? payload.intentHint : null;
    const input = normalizeAiInput(text, { allowEmpty: false });
    if (!input.ok) return { ok: false, code: input.code, message: t('errorInvalidRequest') };
    // Doküman sorusu ve teşhis/enerji otomasyon duraklatılmışken bile çalışabilir;
    // sadece görev planlama el-frenine tabidir.
    const routed = intentHint || agentOrchestrator.constructor.route(input.text).agentId;
    if (routed === 'command' && taskManager && taskManager.pausedAll) {
        return { ok: false, code: 'PAUSED', message: t('toastAllPaused') };
    }
    const hist = historyService.getHistory();
    const lastBlocked = hist.find((h) => h.resultCode === 'blocked_by_policy');
    const lastBlockedReason = lastBlocked ? `${lastBlocked.taskName}: ${lastBlocked.detail || ''}`.slice(0, 4000) : '';
    const res = await agentOrchestrator.runAssistant(input.text, {
        language: currentLanguage(),
        intentHint,
        energyStats: energyService.getStatistics(),
        historyList: hist,
        lastBlockedReason
    });
    return localizeResult(res, AI_RESULT_KEYS);
});
ipcHandle('search-docs', (event, query) => {
    const q = String(query || '').trim().slice(0, 300);
    if (!q) return [];
    return searchDocs(q, { lang: currentLanguage(), topK: 6, minScore: 0.35 });
});
ipcHandle('ai-diagnose', (event, reason) => {
    // WP-10.T9: sebep de aynı 4000 karakter sınırına tabidir.
    let detail = '';
    if (reason !== undefined && reason !== null) {
        const input = normalizeAiInput(reason);
        if (!input.ok) return { ok: false, code: input.code, message: t('errorInvalidRequest') };
        detail = input.text;
    }
    if (!detail) {
        const lastBlocked = historyService.getHistory().find(h => h.resultCode === 'blocked_by_policy');
        detail = lastBlocked ? `${lastBlocked.taskName}: ${lastBlocked.detail || ''}`.slice(0, 4000) : '';
    }
    return agentOrchestrator.runDiagnose(detail, { language: currentLanguage() });
});
ipcHandle('ai-energy', () => agentOrchestrator.runEnergy(energyService.getStatistics(), { language: currentLanguage() }));
ipcHandle('ai-suggest', () => agentOrchestrator.runSuggest(historyService.getHistory(), { language: currentLanguage() }));
ipcHandle('ai-dismiss-suggestion', (event, topic) => {
    if (typeof topic !== 'string' || !topic) return { success: false };
    return { success: agentOrchestrator.dismissTopic(topic) };
});
// WBS-E3/E4: Cihaz tahmini (sihirbaz + Ayarlar "Yeniden ölç" kullanır).
ipcHandle('device-estimate', async () => {
    try {
        const m = metricCollector ? metricCollector.getMetrics() : {};
        const battery = {
            hasBattery: m.batterySupported === true,
            isCharging: typeof m.isCharging === 'boolean' ? m.isCharging : null
        };
        return { ok: true, profile: await deviceProfiler.profile(battery) };
    } catch (err) {
        return { ok: false, code: 'ESTIMATE_FAILED', message: t('errorEstimateFailed') };
    }
});
// WBS-9.4: Uyarı bannerı düğmeleri (Durdur / Ertele / Şimdi Çalıştır).
// WBS-11.2: Durdur/Ertele PIN korumalıdır (geriye uyumlu payload).
// C-01/C-02: PIN kapısı async olduğu için eylemler await edilir; gövdeler
// test edilebilir ortak modülde (src/main/ipc/warningActions.js).
ipcHandle('warning-cancel', async (event, args) => {
    return await cancelWarningAction({
        pin: args && args.pin,
        requireCancelPin,
        taskManager,
        warningManager,
        t
    });
});
ipcHandle('warning-snooze', async (event, payload) => {
    return await snoozeWarningAction({
        payload,
        requireCancelPin,
        taskManager,
        warningManager,
        t
    });
});
ipcHandle('warning-confirm', (event, args) => {
    // K-02: renderer hangi uyarıyı gördüğünü bildirir; PIN beklerken uyarı
    // değiştiyse eski tıklama yeni görevi onaylamaz (TOCTOU).
    return confirmWarningAction({
        taskId: args && args.taskId,
        warningManager,
        t
    });
});
// WBS-8.3: STT IPC - örnekler 16kHz mono olmalı (istemci yeniden örnekler).
ipcHandle('stt-status', () => sttService.getStatus());
ipcHandle('stt-transcribe', async (event, payload) => {
    const { samples, sampleRate, uiLang } = payload || {};
    if (sampleRate !== 16000) {
        return { ok: false, code: 'INVALID_SAMPLE_RATE', message: t('errorAudioFormat') };
    }
    const len = samples && typeof samples.length === 'number' ? samples.length : 0;
    if (len === 0 || len > 500000) {
        return { ok: false, code: 'INVALID_AUDIO', message: t('errorAudioSize') };
    }
    return localizeResult(await sttService.transcribePcm(samples, uiLang), STT_RESULT_KEYS);
});
// WBS-7.5: Model indirme/yükleme IPC - indirme arka planda sürer, durum polling ile izlenir.
let aiDownloadState = { state: 'idle', file: null, received: 0, total: null, step: 0, steps: 2, error: null };
ipcHandle('ai-model-download', () => {
    // AI paketi = LLM + STT modeli (sıralı, arka planda; canlı ilerleme ai-status.download ile).
    if (aiDownloadState.state === 'running') {
        return { started: false, code: 'ALREADY_DOWNLOADING', message: t('errorDownloadBusy') };
    }
    aiDownloadState = { state: 'running', file: null, received: 0, total: null, step: 0, steps: 2, error: null };
    const run = async () => {
        try {
            const { ModelManager } = require('./src/main/services/ModelManager');
            const out = await ModelManager.downloadBundle(modelManager, sttModelManager, (ev) => {
                aiDownloadState = { state: 'running', file: ev.file, received: ev.received, total: ev.total, step: ev.step, steps: ev.steps, error: null };
            });
            log.info(`[ModelManager] LLM indirme: ${out.llm.success ? 'ok' : out.llm.error}`);
            if (out.llm.success && out.stt) {
                log.info(`[ModelManager] STT indirme: ${out.stt.success ? 'ok' : out.stt.error}`);
            }
            const failed = !out.llm.success ? localizeDownloadFailure(out.llm)
                : (out.stt && !out.stt.success ? localizeDownloadFailure(out.stt) : null);
            aiDownloadState = failed
                ? { state: 'failed', file: aiDownloadState.file, received: aiDownloadState.received, total: aiDownloadState.total, step: aiDownloadState.step, steps: 2, error: failed.error || t('errorAiDownloadFailed') }
                : { state: 'done', file: null, received: 0, total: null, step: 2, steps: 2, error: null };
        } catch (err) {
            log.error('[ModelManager] beklenmeyen hata:', err && err.message);
            aiDownloadState = { state: 'failed', file: null, received: 0, total: null, step: 0, steps: 2, error: t('unknownError') };
        }
    };
    run();
    return { started: true };
});
ipcHandle('ai-model-load', async () => {
    const res = await aiBackend.loadModel();
    if (res && res.loaded === false) {
        // Yükleme hatası kodu arayüzde ham kod olarak görünmesin.
        const key = AI_STATUS_KEYS[res.code];
        return key ? { ...res, message: t(key) } : res;
    }
    return res;
});
ipcHandle('ai-model-unload', async () => {
    await aiBackend.unload();
    return { success: true, ...aiBackend.getStatus() };
});

ipcHandle('get-settings', () => toRendererSettings(storageService.getSettings()));

// WP-14.T2: renderer yalnızca aktif dil sözlüğünü alır.
ipcHandle('get-locale', (_event, language) => {
    try {
        const lang = normalizeLanguage(typeof language === 'string' ? language.slice(0, 16) : '');
        return { ok: true, lang, rtl: lang === 'ar', dictionary: loadLocale(lang) };
    } catch (err) {
        log.warn('[IPC] locale yüklenemedi:', err && err.message);
        return { ok: false, code: 'LOCALE_LOAD_FAILED' };
    }
});

/** L-11: AI sessizleştirme aralığı doğrulanır ve denetimli ayar yolundan yazılır. */
async function setAiSilencedUntil(until) {
    const now = Date.now();
    const MAX_SILENCE_MS = 7 * 86400000;
    if (!Number.isFinite(until) || until < now || until > now + MAX_SILENCE_MS) {
        return { success: false, code: 'INVALID_SILENCE_WINDOW', message: t('errorInvalidRequest') };
    }
    const current = storageService.getSettings();
    const check = validateSettings({ aiSilencedUntil: until }, current);
    if (!check.ok) {
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    return applySettingsPatch({ aiSilencedUntil: until }, current, 'ai_silenced');
}

/**
 * P1-9: UPS düşük-batarya gözetimi (`upsmon` semantiği).
 *
 * Ölçülen kusur: UPS uyarısı yalnızca `log.warn` ile yazılıyordu; sunucu
 * profilinde elektrik kesintisinde makine pil bitene kadar çalışıyordu.
 * Bu döngü `upsEnabled` + `upsAutoActionEnabled` ise UPS'i yoklar ve `LB`
 * durumunda kısa geri sayım sonrası seçilen eylemi uygular. Varsayılan kapalı.
 */
function stopUpsSupervisor() {
    if (upsSupervisor) {
        try { upsSupervisor.disarm(); } catch (_) { /* yut */ }
    }
    if (upsSupervisorTimer) {
        try { timers.clear(upsSupervisorTimer); } catch (_) { /* yut */ }
        upsSupervisorTimer = null;
    }
}

function startUpsSupervisor(settings) {
    stopUpsSupervisor();
    const s = settings || {};
    upsSupervisor = null;
    if (s.upsEnabled !== true || s.upsAutoActionEnabled !== true) return;
    if (!upsMonitor) return;
    upsSupervisor = new UpsSupervisor({
        powerService: PowerService,
        action: ['hibernate', 'shutdown', 'sleep', 'lock', 'restart'].includes(s.upsAutoAction)
            ? s.upsAutoAction
            : 'hibernate',
        countdownMs: (Number.isInteger(s.upsCountdownSeconds) ? s.upsCountdownSeconds : 30) * 1000,
        onEvent: (type, payload) => {
            const body = (() => {
                if (type === 'critical') return t('upsAlertCritical');
                if (type === 'executing') return t('upsAlertExecuting');
                if (type === 'failed') return t('upsAlertFailed');
                if (type === 'recovered') return t('upsAlertRecovered');
                return null;
            })();
            log.warn(`[UPS] olay=${type}${body ? ` - ${body}` : ''}`);
            if (body) {
                const current = safeGetSettings();
                if (isDesktopNotifyAllowed(current)) notifyDesktop('UPS', body);
            }
            if (type === 'executed' || type === 'failed') {
                try {
                    if (auditLog) {
                        auditLog.append({
                            actor: 'system',
                            action: type === 'executed' ? 'ups_low_battery_action' : 'ups_low_battery_action_failed',
                            target: 'ups',
                            detail: `action=${payload && payload.action} charge=${payload && payload.ups && payload.ups.charge}`
                        });
                    }
                } catch (_) { /* denetim yazımı akışı bozmaz */ }
            }
        }
    });
    const tick = async () => {
        if (!upsSupervisor || !upsMonitor) return;
        let state = null;
        try {
            state = await upsMonitor.query({ cacheTtlMs: 0 });
        } catch (_) {
            state = { reachable: false };
        }
        if (!upsSupervisor) return;
        upsSupervisor.handleState(state);
    };
    upsSupervisorTimer = timers.setInterval(() => { tick().catch(() => {}); }, 60000);
    // Açılışta 15 sn sonra ilk ölçüm (açılış yükü otursun).
    timers.setTimeout(() => { tick().catch(() => {}); }, 15000);
}

/** O-16: UPS ayarları değişince izleyici yeniden oluşturulur. */
function recreateUpsMonitor(settings) {
    try {
        if (upsMonitor) {
            try { upsMonitor.close(); } catch (_) { /* yut */ }
        }
        upsMonitor = new UpsMonitor({
            host: (settings && settings.upsHost) || '127.0.0.1',
            ups: (settings && settings.upsName) || 'ups'
        });
    } catch (err) {
        upsMonitor = null;
        log.warn('[UPS] izleyici oluşturulamadı:', err && err.message);
    }
    if (inventoryService) {
        inventoryService.upsMonitor = upsMonitor;
        inventoryService._cache = null;
    }
    startUpsSupervisor(settings);
}

/** Ortak uygulama yolu: ayarları + sırları atomik-ish uygular, hatada geri alır. */
async function applySettingsPatch(newSettings, current, auditAction) {
    const { rest, secrets } = splitSecretPatch(newSettings);
    const secretFields = Object.keys(secrets);
    const needsRestart = rest.localApiEnabled !== undefined || rest.localApiPort !== undefined || rest.lanModeEnabled !== undefined
        || rest.localApiTlsEnabled !== undefined || rest.localApiRequireClientCert !== undefined
        || rest.localApiTlsStrict !== undefined
        || rest.consoleUrl !== undefined || rest.consoleClientCertFile !== undefined
        || rest.consoleClientKeyFile !== undefined || rest.consoleClientPfxFile !== undefined
        || rest.consoleClientCaFile !== undefined
        || secretFields.includes('localApiKeyPem') || secretFields.includes('localApiPfxPassphrase')
        || secretFields.includes('consoleClientCertPem') || secretFields.includes('consoleClientKeyPem')
        || secretFields.includes('consoleClientPfxPassphrase');
    const before = { ...current };
    const previousSecrets = {};
    for (const field of secretFields) previousSecrets[field] = current[field] || null;
    try {
        if (Object.keys(rest).length > 0) {
            const persisted = storageService.updateSettings(rest);
            if (persisted === false) {
                throw Object.assign(new Error('Ayarlar diske yazılamadı.'), { code: 'SETTINGS_PERSIST_FAILED' });
            }
        }
        if (secretFields.length > 0) {
            if (!secretStore) {
                throw Object.assign(new Error('Sır deposu kullanılamıyor.'), { code: 'SECRET_BACKEND_UNAVAILABLE' });
            }
            for (const field of secretFields) {
                const value = secrets[field];
                if (typeof value === 'string' && value.length > 0) {
                    await secretStore.setSecret(field, value);
                    storageService.data.settings[field] = value;
                } else {
                    // null = sırrı temizle (boş dize şemada reddedilir).
                    await secretStore.deleteSecret(field);
                    storageService.data.settings[field] = null;
                }
            }
            await secretStore.hydrateData(storageService.data);
            try {
                auditLog.append({
                    actor: 'user_interface',
                    action: 'settings_secret_updated',
                    target: secretFields.join(','),
                    detail: `fields=${secretFields.length}`
                });
            } catch (auditErr) {
                log.warn('[IPC] sır güncelleme denetim kaydı yazılamadı:', auditErr && auditErr.message);
            }
        }
        // WBS-5.1 + FAZ A: API/TLS'yi etkileyen her değişiklikte sunucu yeniden başlatılır.
        // WP-02.T6: stop() portun boşalmasını bekler; start() başarısızsa ayarlar geri alınır.
        if (needsRestart) {
            const started = await localApiService.restart();
            const effectiveSettings = storageService.getSettings();
            if (effectiveSettings.localApiEnabled && started && started.ok === false) {
                throw Object.assign(new Error(`API yeniden başlatılamadı: ${started.code}`), { code: started.code });
            }
        }
        if (rest.upsHost !== undefined || rest.upsName !== undefined || rest.upsEnabled !== undefined
            || rest.upsAutoActionEnabled !== undefined || rest.upsAutoAction !== undefined || rest.upsCountdownSeconds !== undefined) {
            recreateUpsMonitor(storageService.getSettings());
        }
        let iconSync = null;
        if (rest.appIcon !== undefined || rest.customIconColor !== undefined) {
            const eff = storageService.getSettings();
            iconSync = applyRuntimeAppIcon(eff.appIcon, {
                updateShortcuts: true,
                customIconColor: eff.customIconColor
            });
        }
        if (rest.uiZoom !== undefined) {
            applyRuntimeUiZoom(rest.uiZoom);
        }
        if (auditAction) {
            try {
                auditLog.append({
                    actor: 'user_interface',
                    action: auditAction,
                    target: Object.keys(rest).join(','),
                    detail: `fields=${Object.keys(rest).length}`
                });
            } catch (auditErr) {
                // O-13: güvenlik ayarı denetlenemeden yürürlüğe girmez.
                log.warn('[IPC] güvenlik ayarı denetim kaydı yazılamadı:', auditErr && auditErr.message);
                throw Object.assign(
                    new Error('Güvenlik ayarı denetim kaydı yazılamadı.'),
                    { code: 'AUDIT_WRITE_FAILED', cause: auditErr }
                );
            }
        }
        scheduleTrayUpdate();
        return {
            success: true,
            settings: toRendererSettings(storageService.getSettings()),
            ...(iconSync ? { iconSync } : {})
        };
    } catch (err) {
        // WP-10: yarım kalmış yapılandırma bırakma; önceki ayarlara dön.
        log.error('[IPC] save-settings uygulanamadı, geri alınıyor:', err && err.message);
        try {
            storageService.updateSettings(before);
            if (secretStore && secretFields.length > 0) {
                for (const field of secretFields) {
                    const prev = previousSecrets[field];
                    if (typeof prev === 'string' && prev.length > 0) await secretStore.setSecret(field, prev);
                    else await secretStore.deleteSecret(field);
                }
                await secretStore.hydrateData(storageService.data);
            }
            if (needsRestart) {
                await localApiService.restart();
            }
            if (rest.upsHost !== undefined || rest.upsName !== undefined || rest.upsEnabled !== undefined
                || rest.upsAutoActionEnabled !== undefined || rest.upsAutoAction !== undefined || rest.upsCountdownSeconds !== undefined) {
                recreateUpsMonitor(storageService.getSettings());
            }
            if (rest.appIcon !== undefined || rest.customIconColor !== undefined) {
                applyRuntimeAppIcon(before.appIcon, {
                    updateShortcuts: true,
                    customIconColor: before.customIconColor
                });
            }
            if (rest.uiZoom !== undefined) {
                applyRuntimeUiZoom(before.uiZoom);
            }
        } catch (_) { /* rollback best-effort */ }
        return { success: false, code: err && err.code ? err.code : 'SETTINGS_APPLY_FAILED', message: t('errorSettingsApplyReverted') };
    }
}

ipcHandle('save-settings', async (event, newSettings) => {
    const current = storageService.getSettings();
    // WP-10.T4: güvenlik bayrakları bu yoldan yazılamaz (UNKNOWN_SETTING).
    const check = validateSettings(newSettings, current);
    if (!check.ok) {
        log.warn(`[IPC] save-settings reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    return applySettingsPatch(newSettings, current, null);
});

// O-20: dil/enerji + otonomi tek atomik yazımda. PIN doğrulanmadan hiçbir
// sunucu ayarı değişmez; PIN iptalinde kısmi kayıt oluşmaz.
ipcHandle('save-settings-atomic', async (event, payload) => {
    const patch = payload && typeof payload === 'object' ? payload.settings : null;
    const pin = payload && typeof payload === 'object' ? payload.pin : null;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { success: false, code: 'INVALID_REQUEST', message: t('errorInvalidRequest') };
    }
    const current = storageService.getSettings();
    const securityPatch = {};
    const regularPatch = {};
    for (const key of Object.keys(patch)) {
        if (SECURITY_SETTING_KEYS.includes(key)) securityPatch[key] = patch[key];
        else regularPatch[key] = patch[key];
    }
    if (Object.keys(regularPatch).length > 0) {
        const check = validateSettings(regularPatch, current);
        if (!check.ok) {
            log.warn(`[IPC] save-settings-atomic reddedildi: ${check.error}`);
            return { success: false, code: check.code, message: t('errorInvalidRequest') };
        }
    }
    if (Object.keys(securityPatch).length > 0) {
        if (!distribution.isFeatureEnabled('lanApi') && securityPatch.lanModeEnabled === true) {
            return { success: false, code: 'STORE_LAN_UNAVAILABLE', message: t('storeLanUnavailable') };
        }
        const check = validateSecuritySettings(securityPatch, current);
        if (!check.ok) {
            log.warn(`[IPC] save-settings-atomic reddedildi: ${check.error}`);
            return { success: false, code: check.code, message: t('errorInvalidRequest') };
        }
        const pinError = await requireSecurityPin(pin);
        if (pinError) return pinError;
    }
    return applySettingsPatch(patch, current, Object.keys(securityPatch).length > 0 ? 'settings_security_updated' : null);
});

// WP-10.T4: güvenlik ayarları yalnızca PIN doğrulandıktan sonra yazılır.
ipcHandle('security-settings-update', async (event, payload) => {
    const patch = payload && typeof payload === 'object' ? payload.settings : null;
    const pin = payload && typeof payload === 'object' ? payload.pin : null;
    const current = storageService.getSettings();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { success: false, code: 'INVALID_REQUEST', message: t('errorInvalidRequest') };
    }
    const unknown = Object.keys(patch).filter((key) => !SECURITY_SETTING_KEYS.includes(key));
    if (unknown.length > 0) {
        log.warn(`[IPC] security-settings-update bilinmeyen alan: ${unknown.join(',')}`);
        return { success: false, code: 'UNKNOWN_SETTING', message: t('errorInvalidRequest') };
    }
    if (!distribution.isFeatureEnabled('lanApi') && patch.lanModeEnabled === true) {
        return { success: false, code: 'STORE_LAN_UNAVAILABLE', message: t('storeLanUnavailable') };
    }
    const check = validateSecuritySettings(patch, current);
    if (!check.ok) {
        log.warn(`[IPC] security-settings-update reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    const pinError = await requireSecurityPin(pin);
    if (pinError) return pinError;
    return applySettingsPatch(patch, current, 'settings_security_updated');
});

ipcHandle('generate-api-key', async (event, args) => {
    const pinError = await requireSecurityPin(args && args.pin);
    if (pinError) return pinError;
    const role = args && typeof args.role === 'string' ? args.role : 'viewer';
    const safeRole = ['viewer', 'operator', 'admin'].includes(role) ? role : 'viewer';
    const current = storageService.getSettings();
    const previousKey = {
        localApiKeyHash: current.localApiKeyHash,
        localApiKeyMasked: current.localApiKeyMasked,
        localApiKeyCreatedAt: current.localApiKeyCreatedAt,
        localApiKeyRole: current.localApiKeyRole
    };
    let rawKey;
    try {
        rawKey = localApiService.generateApiKey(safeRole);
    } catch (err) {
        log.error('[IPC] API anahtarı kalıcılaştırılamadı:', err && err.message);
        return { success: false, code: (err && err.code) || 'SETTINGS_PERSIST_FAILED', message: t('errorSaveFailed') };
    }
    try {
        // O-13: anahtar üretimi denetlenemeden geçerli olmaz; hata halinde
        // önceki anahtar alanları geri yüklenir.
        auditLog.append({ actor: 'local_user', action: 'api_key_generated', target: 'local-api', detail: safeRole });
    } catch (auditErr) {
        try { storageService.updateSettings(previousKey); } catch (_) { /* geri alma best-effort */ }
        log.warn('[IPC] API anahtarı denetim kaydı yazılamadı:', auditErr && auditErr.message);
        return { success: false, code: 'AUDIT_WRITE_FAILED', message: t('errorSettingsApplyReverted') };
    }
    return rawKey;
});
// FAZ B: kurumsal IPC - envanter, konsol senkronu, denetim (tümü salt-okunur + tetikleme;
// muafiyet YAZMA yalnızca LocalAPI admin anahtarıyla, IPC'den değil).
ipcHandle('get-inventory', async () => {
    try {
        // Kullanıcı tetiklemeli envanter yenileme cache'i atlar.
        return { ok: true, inventory: await inventoryService.collect({ force: true }) };
    } catch (err) {
        return { ok: false, code: 'INVENTORY_FAILED', message: (err && err.message) || t('errorInventoryFailed') };
    }
});
ipcHandle('get-exemptions', () => ({ exemptions: exemptionService.list(), windows: exemptionService.windows() }));
ipcHandle('get-security-status', () => {
    const status = localApiService.getSecurityStatus();
    // P0/BLOCKER-001: yetenek durumu UI'da görünür olmalı (kapı atlandıysa).
    const cap = safetyPolicyEngine && typeof safetyPolicyEngine.getPowerRequestCapability === 'function'
        ? safetyPolicyEngine.getPowerRequestCapability()
        : { available: null, checkedAt: null, code: null };
    return {
        ...status,
        powerRequestCheck: { available: cap.available, code: cap.code, checkedAt: cap.checkedAt }
    };
});
/**
 * Depo durumu - bakım modu görünür olmalı.
 * Aksi halde DB açılamadığında her kayıt sessizce reddedilirken arayüz
 * normal görünür ve kullanıcı görevlerinin kaydedildiğini sanır.
 */
ipcHandle('get-storage-status', () => ({
    maintenanceMode: storageService.isMaintenanceMode(),
    auditTampered: !!storageService.auditTampered,
    reason: storageService.getMaintenanceReason(),
    // Bozuk veri karantinaya alınıp temiz depoyla devam edildiyse dolu.
    // Sessiz sıfırlama kabul edilemez: kullanıcı ne olduğunu görmeli.
    recoveredFrom: storageService.recoveredFrom || null
}));
ipcHandle('get-audit', (event, args = {}) => {
    // O-06: UI yalnızca görünen sayfayı ister; doğrulama ayrı çağrıyla yapılır.
    const limit = Math.min(500, Math.max(1, Number(args && args.limit) || 100));
    const beforeSeq = Number(args && args.beforeSeq) || null;
    const out = { audit: auditLog.load({ limit, beforeSeq }), limit };
    if (args && args.verify === true) out.verify = auditLog.verify();
    return out;
});
ipcHandle('console-sync', async () => {
    if (!distribution.isFeatureEnabled('consoleAgent') || !consoleClient) {
        return { ok: false, code: 'STORE_FEATURE_UNAVAILABLE', message: t('storeEnterpriseOnly') };
    }
    if (!consoleClient.isConfigured()) {
        return { ok: false, code: 'NOT_CONFIGURED', message: t('errorConsoleNotConfigured') };
    }
    const res = await consoleClient.sync();
    // Y-04: kill-switch manuel yolda da geçerli; disabled yanıtında kuyruk boşaltılmaz.
    if (res && res.ok && !res.disabled) {
        const drained = await orderExecutor.drain(orderQueue);
        return { ...res, drained };
    }
    if (res && res.disabled) {
        try {
            auditLog.append({
                actor: 'user_interface',
                action: 'agent_disabled_sync_skipped',
                target: 'console',
                detail: 'Konsol ajanı devre dışı; manuel senkron icra etmedi.'
            });
        } catch (_) { /* denetim best-effort */ }
    }
    return res;
});
ipcHandle('get-webhooks', () => WebhookService.redactForUi(storageService.getWebhooks()));
ipcHandle('save-webhooks', async (event, webhooks) => {
    const check = validateWebhooks(webhooks);
    if (!check.ok) {
        log.warn(`[IPC] save-webhooks reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    // WBS-5.2: Boş secret = mevcut korunsun (redacted liste geri kaydedilirken sırlar silinmez).
    const merged = WebhookService.mergeSecrets(webhooks, storageService.getWebhooks());
    const hasSecret = merged.some((hook) => WebhookService.secretFields()
        .some((field) => typeof hook[field] === 'string' && hook[field].length > 0));
    try {
        if (hasSecret && !secretStore) {
            throw Object.assign(new Error('Sır deposu kullanılamıyor.'), { code: 'SECRET_BACKEND_UNAVAILABLE' });
        }
        // WP-04: sırlar ayrı şifreli dosyaya yazılır; diskteki veri dosyasında
        // yalnızca null/alan-yok kalır. Öksüz webhook sırları temizlenir.
        if (secretStore) await secretStore.syncWebhooks(merged);
        storageService.saveWebhooks(merged);
        if (secretStore) await secretStore.hydrateData(storageService.data);
        try {
            auditLog.append({
                actor: 'user_interface',
                action: 'webhooks_updated',
                target: null,
                detail: `count=${merged.length}; secrets=${hasSecret ? 'present' : 'none'}`
            });
        } catch (auditErr) {
            log.warn('[IPC] webhook denetim kaydı yazılamadı:', auditErr && auditErr.message);
        }
        return { success: true };
    } catch (err) {
        log.error('[IPC] save-webhooks uygulanamadı:', err && err.message);
        return {
            success: false,
            code: err && err.code ? err.code : 'WEBHOOKS_APPLY_FAILED',
            message: t('errorSettingsApplyReverted')
        };
    }
});
ipcHandle('test-webhook', async (event, hook) => {
    // WBS-5.2 + WP-3: Gerçek asenkron test gönderimi + kayıtlı sırları birleştirme.
    const check = validateWebhooks([hook]);
    if (!check.ok) {
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    const merged = WebhookService.mergeSecrets([hook], storageService.getWebhooks())[0] || hook;
    const sample = webhookService.buildPayload('task_created', {
        id: 'test', name: t('toastConsoleTestTitle'), source: 'user_interface', status: 'testing', action: 'lock'
    });
    const t0 = Date.now();
    const res = await webhookService.sendPayload(merged, sample);
    const elapsedMs = Date.now() - t0;
    if (res && res.ok) {
        return {
            success: true,
            status: res.status || 200,
            elapsedMs,
            message: `${t('toastConsoleTestSent')} (HTTP ${res.status || 200} · ${elapsedMs} ms)`
        };
    }
    return {
        success: false,
        status: res && res.status ? res.status : 0,
        code: (res && res.code) || 'WEBHOOK_FAILED',
        elapsedMs,
        message: (res && (res.reason || res.code))
            ? `${t('errorWebhookTestFailed')} (${res.reason || res.code})`
            : t('errorWebhookTestFailed')
    };
});
ipcHandle('send-wol', (event, { macAddress, broadcastIp, port }) => {
    const check = validateWol({ macAddress, broadcastIp, port });
    if (!check.ok) {
        log.warn(`[IPC] send-wol reddedildi: ${check.error}`);
        return { success: false, code: check.code, message: t('errorInvalidRequest') };
    }
    return deviceService.sendWakeOnLan(macAddress, broadcastIp, port);
});
ipcHandle('get-wol-devices', () => {
    return storageService.getDeviceProfiles().filter((p) => p && typeof p.macAddress === 'string');
});
ipcHandle('save-wol-devices', (event, devices) => {
    if (!Array.isArray(devices) || devices.length > 32) {
        return { success: false, code: 'INVALID_BODY', message: t('errorInvalidRequest') };
    }
    const cleaned = [];
    for (const dev of devices) {
        if (!dev || typeof dev !== 'object') return { success: false, code: 'INVALID_BODY', message: t('errorInvalidRequest') };
        const macAddress = String(dev.macAddress || '').trim().toUpperCase().replace(/-/g, ':');
        const broadcastIp = dev.broadcastIp ? String(dev.broadcastIp).trim() : undefined;
        const port = dev.port !== undefined && dev.port !== '' ? Number(dev.port) : 9;
        const check = validateWol({ macAddress, ...(broadcastIp ? { broadcastIp } : {}), port });
        if (!check.ok) return { success: false, code: check.code, message: check.error };
        cleaned.push({
            id: typeof dev.id === 'string' && dev.id ? dev.id.slice(0, 64) : `wol_${Date.now()}_${cleaned.length}`,
            name: String(dev.name || macAddress).trim().slice(0, 60),
            macAddress,
            broadcastIp: broadcastIp || '',
            port
        });
    }
    storageService.saveDeviceProfiles(cleaned);
    return { success: true, devices: cleaned };
});
ipcHandle('test-ups', async (event, args) => {
    const s = storageService.getSettings();
    const host = (args && typeof args.host === 'string' && args.host.trim()) ? args.host.trim() : (s.upsHost || '127.0.0.1');
    const ups = (args && typeof args.ups === 'string' && args.ups.trim()) ? args.ups.trim() : (s.upsName || 'ups');
    let monitor = null;
    try {
        monitor = new UpsMonitor({ host, ups, cacheTtlMs: 0 });
        const result = await monitor.query();
        return { ok: result && result.reachable === true, ...result, host, ups };
    } catch (err) {
        return { ok: false, reachable: false, code: (err && err.code) || 'UPS_ERROR', error: err && err.message };
    } finally {
        if (monitor) {
            try { monitor.close(); } catch (_) { /* yut */ }
        }
    }
});
ipcHandle('get-mcp-config', () => {
    const s = storageService.getSettings();
    // P0-4: paketlenmiş uygulamada `__dirname` app.asar içindedir ve düz
    // `node` .asar'dan dosya ÇALIŞTIRAMAZ. asarUnpack'a alınan yolu
    // (app.asar.unpacked) kullanmak zorunlu.
    const mcpEntry = resolveUnpackedEntry('src', 'mcp', 'server.js');
    return {
        apiEnabled: s.localApiEnabled === true,
        port: s.localApiPort || 18456,
        hasKey: Boolean(s.localApiKeyHash),
        keyMasked: s.localApiKeyMasked || null,
        serverPath: mcpEntry,
        configJson: JSON.stringify({
            mcpServers: {
                'power-pilot': {
                    command: 'node',
                    args: [mcpEntry],
                    env: {
                        // P0-4: kanonik adlar (alt çizgili eski ad fallback olarak
                        // okunur, bkz. src/shared/localApiConnection.js).
                        POWERPILOT_API_PORT: String(s.localApiPort || 18456),
                        POWERPILOT_API_KEY: '<API_KEY>',
                        ...(s.localApiTlsEnabled === true ? { POWERPILOT_API_TLS: '1' } : {}),
                        ...(s.localApiCaFile ? { POWERPILOT_API_CA: s.localApiCaFile } : {})
                    }
                }
            }
        }, null, 2)
    };
});
ipcHandle('get-app-icon-status', () => {
    const iconId = getCurrentAppIconId();
    const isPortable = Portable.isPortable(process.env);
    let desktopLnk = null;
    try {
        const desktop = app.getPath('desktop');
        const names = isPortable
            ? ['Power Pilot Portable.lnk', 'Power Pilot.lnk']
            : ['Power Pilot.lnk', 'Power Pilot Portable.lnk'];
        for (const n of names) {
            const candidate = path.join(desktop, n);
            if (fs.existsSync(candidate)) { desktopLnk = candidate; break; }
        }
    } catch (_) { /* yut */ }
    return {
        iconId,
        isPortable,
        isStoreBuild: distribution.IS_STORE === true,
        hasDesktopShortcut: Boolean(desktopLnk)
    };
});
ipcHandle('create-desktop-shortcut', () => {
    const iconId = getCurrentAppIconId();
    const customIconColor = getCurrentCustomIconColor();
    const isPortable = Portable.isPortable(process.env);
    const sourceIco = AppIconService.resolveIconIcoPath(iconId, {
        rootDir: __dirname,
        resourcesPath: process.resourcesPath,
        userDataDir: app.getPath('userData'),
        customIconColor,
        isPackaged: app.isPackaged
    });
    const stableIco = AppIconService.ensureStableShortcutIco(iconId, {
        sourceIcoPath: sourceIco,
        userDataDir: app.getPath('userData'),
        customIconColor,
        isPortable,
        isPackaged: app.isPackaged
    });
    const targetExePath = Portable.portableExePath(process.env, fs.existsSync) || app.getPath('exe');
    let desktopDir = null;
    try { desktopDir = app.getPath('desktop'); } catch (_) { desktopDir = null; }
    return AppIconService.createDesktopShortcut({
        desktopDir,
        targetExePath,
        icoPath: stableIco,
        shell,
        isPortable,
        logger: log
    });
});
ipcHandle('save-custom-app-icon', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, code: 'INVALID_BODY', message: t('errorInvalidRequest') };
    }
    const hex = typeof payload.hex === 'string' ? payload.hex.trim() : '';
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return { ok: false, code: 'INVALID_COLOR', message: t('errorInvalidRequest') };
    }
    const written = AppIconService.writeCustomIconFiles(hex, payload.frames, {
        userDataDir: app.getPath('userData')
    });
    if (!written.ok) {
        log.warn(`[AppIcon] özel ikon yazılamadı: ${written.code}`);
        return { ok: false, code: written.code, message: t('errorSaveFailed') };
    }
    if (payload.apply === true) {
        const current = storageService.getSettings();
        const res = await applySettingsPatch(
            { appIcon: 'custom', customIconColor: written.hex },
            current,
            null
        );
        return {
            ok: Boolean(res && res.success),
            hex: written.hex,
            icoPath: written.icoPath,
            pngPath: written.pngPath,
            iconSync: res && res.iconSync ? res.iconSync : null
        };
    }
    return written;
});
ipcHandle('set-ui-zoom', (_event, zoom) => {
    const num = Number(zoom);
    if (!Number.isFinite(num) || num < 75 || num > 150) {
        return { ok: false, code: 'INVALID_ZOOM' };
    }
    const applied = applyRuntimeUiZoom(num);
    return { ok: true, zoom: applied };
});

// WP-5: Tanılama, çökme raporları ve destek paketi (ZIP) IPC'leri
ipcHandle('get-diagnostics', () => {
    return diagnosticsService ? diagnosticsService.getDiagnosticsSnapshot() : null;
});
ipcHandle('clear-diagnostics', () => {
    if (!diagnosticsService) return { ok: false };
    diagnosticsService.clearLogs();
    return { ok: true, snapshot: diagnosticsService.getDiagnosticsSnapshot() };
});
ipcOn('report-renderer-error', (event, payload) => {
    if (!diagnosticsService || !payload || typeof payload !== 'object') return;
    diagnosticsService.recordRendererError({
        kind: payload.kind || 'renderer_error',
        message: payload.message || '',
        stack: payload.stack || '',
        context: payload.context || ''
    });
});
ipcHandle('create-support-bundle', () => {
    if (!diagnosticsService) return { ok: false, code: 'NOT_READY' };
    try {
        return diagnosticsService.createSupportBundle();
    } catch (err) {
        log.error('[Diagnostics] Destek paketi oluşturulamadı:', err && err.message);
        return { ok: false, code: 'BUNDLE_FAILED', message: t('errorSaveFailed') };
    }
});
ipcHandle('reveal-support-bundle', (event, filePath) => {
    if (!diagnosticsService || typeof filePath !== 'string' || !filePath) return { ok: false };
    const resolved = path.resolve(filePath);
    const allowedRoots = [diagnosticsService.downloadsDir, diagnosticsService.logsDir]
        .filter(Boolean)
        .map((d) => path.resolve(d).toLowerCase());
    const insideAllowed = allowedRoots.some((rootDir) => resolved.toLowerCase().startsWith(rootDir + path.sep));
    if (!insideAllowed || !fs.existsSync(resolved)) return { ok: false, code: 'INVALID_PATH' };
    shell.showItemInFolder(resolved);
    return { ok: true };
});
ipcHandle('open-logs-folder', async () => {
    if (!diagnosticsService) return { ok: false };
    try {
        fs.mkdirSync(diagnosticsService.logsDir, { recursive: true });
        const err = await shell.openPath(diagnosticsService.logsDir);
        return { ok: !err, path: diagnosticsService.logsDir };
    } catch (_) {
        return { ok: false };
    }
});
ipcHandle('compose-support-mail', async (event, args) => {
    if (!diagnosticsService) return { ok: false };
    const bundleFileName = args && typeof args.bundleFileName === 'string'
        ? path.basename(args.bundleFileName).slice(0, 120)
        : null;
    const mailtoUrl = diagnosticsService.buildSupportMailto({ bundleFileName });
    // Güvenlik: alıcı yalnızca sabit support@vellium.dev olabilir.
    if (!mailtoUrl.startsWith('mailto:support@vellium.dev?')) return { ok: false, code: 'BLOCKED' };
    try {
        await shell.openExternal(mailtoUrl);
        return { ok: true };
    } catch (err) {
        log.warn('[Diagnostics] mailto açılamadı:', err && err.message);
        return { ok: false, code: 'MAIL_OPEN_FAILED' };
    }
});
ipcHandle('open-github-issue', () => {
    if (!diagnosticsService) return { ok: false };
    const url = diagnosticsService.buildGithubIssueUrl();
    const opened = openExternalSafely(shell, url, log);
    return { ok: opened };
});

// WP-9: Gerçek Ayarlar JSON Dışa/İçe Aktarma & Masaüstü Bildirim Testi
ipcHandle('export-settings', async () => {
    const safeSettings = toRendererSettings(storageService.getSettings());
    delete safeSettings.secretPresence;
    delete safeSettings.localApiKeyHash;
    delete safeSettings.localApiKeyMasked;
    delete safeSettings.localApiKeyCreatedAt;
    const payload = {
        app: 'Power Pilot',
        schemaVersion: 1,
        appVersion: getAppVersion(),
        exportedAt: new Date().toISOString(),
        settings: safeSettings
    };
    const target = await dialog.showSaveDialog(mainWindow || undefined, {
        title: t('settingsExportDialog'),
        defaultPath: 'powerpilot-settings.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (target.canceled || !target.filePath) return { success: false, code: 'CANCELLED' };
    try {
        await fs.promises.writeFile(target.filePath, JSON.stringify(payload, null, 2), 'utf8');
        return { success: true, filePath: target.filePath };
    } catch (err) {
        log.warn('[IPC] export-settings yazılamadı:', err && err.message);
        return { success: false, code: 'IO_ERROR', message: t('errorSaveFailed') };
    }
});
ipcHandle('import-settings', async (event, args) => {
    const selection = await dialog.showOpenDialog(mainWindow || undefined, {
        title: t('settingsImportDialog'),
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (selection.canceled || !selection.filePaths || selection.filePaths.length === 0) {
        return { success: false, code: 'CANCELLED' };
    }
    let parsed;
    try {
        const raw = await fs.promises.readFile(selection.filePaths[0], 'utf8');
        if (raw.length > 256 * 1024) return { success: false, code: 'FILE_TOO_LARGE', message: t('errorInvalidRequest') };
        parsed = JSON.parse(raw);
    } catch (_) {
        return { success: false, code: 'INVALID_JSON', message: t('errorInvalidRequest') };
    }
    const incoming = (parsed && typeof parsed.settings === 'object' && parsed.settings)
        || (parsed && typeof parsed.preferences === 'object' && parsed.preferences);
    if (!incoming || Array.isArray(incoming)) {
        return { success: false, code: 'INVALID_BODY', message: t('errorInvalidRequest') };
    }
    const current = storageService.getSettings();
    const regularEntries = [];
    for (const [k, v] of Object.entries(incoming)) {
        if (SECURITY_SETTING_KEYS.includes(k)) continue; // Güvenlik bayrakları içe aktarmada sessizce açılmaz
        const oneCheck = validateSettings({ [k]: v }, current);
        if (oneCheck.ok) regularEntries.push([k, v]);
    }
    if (regularEntries.length === 0) {
        return { success: false, code: 'NO_VALID_SETTINGS', message: t('errorInvalidRequest') };
    }
    const patch = Object.fromEntries(regularEntries);
    const res = await applySettingsPatch(patch, current, 'settings_imported');
    return res && res.success
        ? { success: true, count: regularEntries.length, settings: res.settings }
        : res;
});
ipcHandle('test-desktop-notification', () => {
    try {
        if (Notification && typeof Notification.isSupported === 'function' && Notification.isSupported()) {
            const n = new Notification({
                title: 'Power Pilot',
                body: t('toastNotifyTestBody'),
                icon: getCurrentAppIconImage(64)
            });
            n.show();
            return { ok: true, nativeShown: true };
        }
    } catch (err) {
        log.warn('[Notify] test bildirimi gönderilemedi:', err && err.message);
    }
    return { ok: true, nativeShown: false };
});

// Sunucusuz yerel Microsoft OneDrive Bulut Yedekleme ve Esitleme IPC katmani
function localizeOneDriveError(code) {
    switch (code) {
        case 'NO_VALID_BACKUP': return t('oneDriveErrNoBackup');
        case 'EMPTY_LOCAL_PROTECTED': return t('oneDriveErrEmptyProtected');
        case 'INVALID_PATH':
        case 'PATH_TRAVERSAL':
        case 'NOT_ABSOLUTE':
        case 'DIR_UNWRITABLE': return t('oneDriveErrInvalidFolder');
        case 'OPEN_FAILED': return t('errorOpenFolder');
        case 'RESTORE_FAILED': return t('oneDriveErrRestoreFailed');
        case 'STORAGE_UNAVAILABLE': return t('errorStorageMaintenance');
        default: return t('oneDriveErrWriteFailed');
    }
}

function applyRestoredOneDriveRuntime() {
    try {
        if (taskManager && typeof taskManager.reloadFromStorage === 'function') {
            taskManager.reloadFromStorage();
        }
    } catch (err) {
        log.warn('[OneDriveSync] Gorev listesi yenilenemedi:', err && err.message);
    }
    try {
        const s = storageService ? storageService.getSettings() : null;
        if (s) {
            if (typeof applyRuntimeAppIcon === 'function') {
                applyRuntimeAppIcon(s.appIcon, {
                    updateShortcuts: true,
                    customIconColor: s.customIconColor
                });
            }
            if (typeof applyRuntimeUiZoom === 'function') {
                applyRuntimeUiZoom(s.uiZoom);
            }
        }
    } catch (err) {
        log.warn('[OneDriveSync] Geri yukleme sonrasi gorunum guncellenemedi:', err && err.message);
    }
    scheduleTrayUpdate();
}

ipcHandle('onedrive-status', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    try {
        return { ok: true, status: oneDriveSyncService.getStatus() };
    } catch (err) {
        log.warn('[OneDriveSync] Durum okunamadi:', err && err.message);
        return { ok: false, code: 'SYNC_WRITE_FAILED', message: localizeOneDriveError('SYNC_WRITE_FAILED') };
    }
});

ipcHandle('onedrive-connect', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const res = oneDriveSyncService.connect();
    if (!res.ok) {
        return { ok: false, code: res.code, message: localizeOneDriveError(res.code), status: res.status };
    }
    if (res.action === 'restored') {
        applyRestoredOneDriveRuntime();
        return {
            ok: true,
            action: 'restored',
            restored: res.restored,
            recoveredFromFallback: res.recoveredFromFallback,
            settings: toRendererSettings(storageService.getSettings()),
            status: res.status,
            message: t('oneDriveToastConnectedRestored')
        };
    }
    return {
        ok: true,
        action: 'synced',
        exportedAt: res.exportedAt,
        status: res.status,
        message: t('oneDriveToastConnectedSynced')
    };
});

ipcHandle('onedrive-disconnect', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const res = oneDriveSyncService.disconnect();
    return { ok: true, status: res.status, message: t('oneDriveToastDisconnected') };
});

ipcHandle('onedrive-sync-now', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const res = oneDriveSyncService.syncNow({ force: false });
    if (!res.ok) {
        return { ok: false, skipped: Boolean(res.skipped), code: res.code, message: localizeOneDriveError(res.code), status: res.status };
    }
    return { ok: true, exportedAt: res.exportedAt, status: res.status, message: t('oneDriveToastSynced') };
});

ipcHandle('onedrive-restore', (event, args) => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const connect = Boolean(args && args.connect === true);
    const res = oneDriveSyncService.restoreFromBackup({ connect });
    if (!res.ok) {
        return { ok: false, code: res.code, message: localizeOneDriveError(res.code), status: res.status };
    }
    applyRestoredOneDriveRuntime();
    const message = res.recoveredFromFallback
        ? t('oneDriveToastRestoredFallback')
        : t('oneDriveToastRestored', {
            tasks: res.restored.tasks,
            templates: res.restored.templates,
            settings: res.restored.settingsCount
        });
    return {
        ok: true,
        restored: res.restored,
        recoveredFromFallback: res.recoveredFromFallback,
        settings: toRendererSettings(storageService.getSettings()),
        status: res.status,
        message
    };
});

ipcHandle('onedrive-set-autosync', (event, args) => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const enabled = args && typeof args.enabled === 'boolean' ? args.enabled : null;
    if (enabled === null) return { ok: false, code: 'INVALID_REQUEST', message: t('errorInvalidRequest') };
    const res = oneDriveSyncService.setAutoSync(enabled);
    return {
        ok: res.ok,
        status: res.status,
        message: enabled ? t('oneDriveToastAutoSyncOn') : t('oneDriveToastAutoSyncOff')
    };
});

ipcHandle('onedrive-open-folder', async () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    try {
        // Guvenlik: yol asla istemciden alinmaz; yalnizca sunucunun dogruladigi klasor acilir.
        const dirInfo = oneDriveSyncService.resolveDirectory();
        fs.mkdirSync(dirInfo.syncDir, { recursive: true });
        const err = await shell.openPath(dirInfo.syncDir);
        if (err) {
            log.warn(`[OneDriveSync] Klasor acilamadi: ${err}`);
            return { ok: false, code: 'OPEN_FAILED', message: localizeOneDriveError('OPEN_FAILED') };
        }
        return { ok: true, path: dirInfo.syncDir };
    } catch (err) {
        log.warn('[OneDriveSync] Klasor acma hatasi:', err && err.message);
        return { ok: false, code: 'OPEN_FAILED', message: localizeOneDriveError('OPEN_FAILED') };
    }
});

ipcHandle('onedrive-select-folder', async () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const currentDir = oneDriveSyncService.resolveDirectory().syncDir;
    const picked = await dialog.showOpenDialog(mainWindow || undefined, {
        title: t('oneDriveSelectFolderDialog'),
        defaultPath: fs.existsSync(currentDir) ? currentDir : undefined,
        properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || !picked.filePaths || picked.filePaths.length === 0) {
        return { ok: false, code: 'CANCELLED' };
    }
    const res = oneDriveSyncService.setCustomDirectory(picked.filePaths[0]);
    if (!res.ok) {
        return { ok: false, code: res.code, message: localizeOneDriveError(res.code), status: res.status };
    }
    return { ok: true, status: res.status, message: t('oneDriveToastFolderUpdated') };
});

ipcHandle('onedrive-reset-folder', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const res = oneDriveSyncService.setCustomDirectory(null);
    return { ok: res.ok, status: res.status, message: t('oneDriveToastFolderReset') };
});

ipcHandle('onedrive-dismiss-recovery', () => {
    if (!oneDriveSyncService) return { ok: false, code: 'STORAGE_UNAVAILABLE', message: localizeOneDriveError('STORAGE_UNAVAILABLE') };
    const res = oneDriveSyncService.dismissRecovery();
    return { ok: res.ok, status: res.status };
});

ipcOn('setting-autostart', (event, enable) => {
    if (typeof enable !== 'boolean') {
        log.warn('[IPC] setting-autostart reddedildi: boolean bekleniyor.');
        return;
    }
    if (distribution.isFeatureEnabled('startupViaWindowsSettings')) {
        // MSIX: Run anahtarı yazılamaz; kullanıcı Windows Başlangıç ayarlarından yönetir.
        shell.openExternal('ms-settings:startupapps').catch(() => { });
        return;
    }
    const exePath = Portable.portableExePath(process.env, fs.existsSync) || app.getPath('exe');
    try {
        app.setLoginItemSettings({ openAtLogin: enable, path: exePath });
        // P1-6 (beşinci tur): `autostart` ayarı depoda ve şemada vardı ama
        // hiçbir mantık okumuyor/yazmıyordu - yalnızca localStorage'da bir
        // bayrak ve bir OS çağrısı vardı. Sonuç: uygulama ayarı bilmiyordu,
        // başlangıçta Windows'taki gerçek durumla uzlaştıramıyordu. Artık
        // gerçek OS durumu geri okunup ayara yazılır.
        const effective = app.getLoginItemSettings({ path: exePath }).openAtLogin;
        storageService.updateSettings({ autostart: effective });
    } catch (err) {
        log.warn('[IPC] setting-autostart uygulanamadı:', err && err.message);
    }
});

ipcHandle('open-startup-settings', () => {
    shell.openExternal('ms-settings:startupapps').catch(() => { });
    return { ok: true };
});

/**
 * PIN kurtarma: veri klasörünü aç.
 *
 * PIN unutulduğunda uygulama içi sıfırlama yolu YOKTUR (plan D15: arka kapı
 * yasak). Kurtarma = kullanıcı Power Pilot'u kapatıp profil klasörünü siler.
 * Yolu sabit metin olarak vermek MSIX'te yanıltıcı olur (paket verisi
 * sanallaştırılır), bu yüzden platforma doğru klasörü kendimiz açıyoruz.
 * Güvenlik: istemciden yol alınmaz; yalnızca app.getPath('userData') açılır.
 */
ipcHandle('open-data-folder', async () => {
    try {
        const dir = app.getPath('userData');
        const err = await shell.openPath(dir);
        if (err) {
            log.warn(`[DataFolder] açılamadı: ${err}`);
            return { success: false, code: 'OPEN_FAILED', message: t('errorInvalidRequest') };
        }
        return { success: true, path: dir };
    } catch (err) {
        log.warn('[DataFolder] beklenmeyen hata:', err && err.message);
        return { success: false, code: 'OPEN_FAILED', message: t('errorInvalidRequest') };
    }
});

/**
 * Store politikası 10.2.7 - "verilerimi sil".
 * Tüm yerel kullanıcı verisini (görevler, ayarlar, geçmiş, anahtarlar,
 * yedekler, modeller, loglar) kalıcı olarak siler ve uygulamayı kapatır.
 * Güvenlik: PIN varsa zorunlu; onay metni istemciden gelse de sunucu
 * `confirm: true` olmadan asla silmez.
 */
ipcHandle('delete-all-data', async (event, args) => {
    const payload = args && typeof args === 'object' ? args : {};
    if (payload.confirm !== true) {
        return { success: false, code: 'CONFIRM_REQUIRED', message: t('errorInvalidRequest') };
    }
    if (storageService.getSettings().cancelPinHash) {
        const pinCheck = await requireCancelPin(payload.pin);
        if (pinCheck) return pinCheck;
    }
    const withTimeout = (p, ms) => Promise.race([
        Promise.resolve(p).catch(() => { }),
        new Promise((resolve) => timers.setTimeout(resolve, ms))
    ]);
    try {
        isQuitting = true;
        // 1. Arka plan servislerini ve dosya tutamaklarını kilitlemeden kapat.
        try {
            if (oneDriveSyncService && typeof oneDriveSyncService.cancelPending === 'function') {
                oneDriveSyncService.cancelPending();
            }
            if (consoleSyncTimer) { clearInterval(consoleSyncTimer); consoleSyncTimer = null; }
            if (taskManager && taskManager.loopInterval) {
                clearInterval(taskManager.loopInterval);
                taskManager.loopInterval = null;
            }
            if (upsMonitor && typeof upsMonitor.close === 'function') {
                upsMonitor.close();
            }
            if (localApiService && typeof localApiService.stop === 'function') {
                await withTimeout(localApiService.stop(), 1000);
            }
        } catch (_) { /* servisler zaten kapalı */ }

        // 2. Chromium oturum verisini kısa zaman aşımıyla temizle (olay döngüsünü dondurma).
        try {
            if (session && session.defaultSession) {
                await withTimeout(session.defaultSession.clearStorageData(), 1500);
                await withTimeout(session.defaultSession.clearCache(), 1500);
            }
        } catch (err) {
            log.warn('[DataWipe] oturum verisi bırakılamadı:', err && err.message);
        }

        // 3. Windows Görev Zamanlayıcı kayıtlarını üst sınırlı bekleme ile temizle.
        if (taskManager && taskManager.schedulerBridge
            && typeof taskManager.schedulerBridge.removeAllTasks === 'function') {
            try {
                const cleaned = await withTimeout(taskManager.schedulerBridge.removeAllTasks(), 3000);
                if (cleaned && cleaned.failed > 0) {
                    log.warn(`[DataWipe] ${cleaned.failed} zamanlayıcı kaydı silinemedi.`);
                }
            } catch (err) {
                log.warn('[DataWipe] zamanlayıcı temizliği atlandı:', err && err.message);
            }
        }

        // 4. Tamamen asenkron veri silme: Win32 pencere döngüsü asla donmaz ("yanıt vermiyor" yok).
        const result = await DataWipe.performWipeAsync(app.getPath('userData'), {
            readdir: (dir) => fs.readdirSync(dir),
            onBefore: () => {
                try { storageService.close(); } catch (_) { /* db kapalı */ }
                try {
                    if (log && log.transports && log.transports.file) {
                        log.transports.file.level = false;
                    }
                } catch (_) { /* yut */ }
            }
        });
        if (!result.ok) {
            const marker = pendingWipeMarkerPath();
            const queued = DataWipe.writePendingWipe(marker, {
                root: result.root,
                paths: result.failed.map((f) => f.path)
            });
            if (!queued) {
                isQuitting = false;
                return { success: false, code: 'WIPE_PARTIAL', message: t('errorSaveFailed') };
            }
        }
        // Silme tamamlandı: before-quit DB checkpoint'i / yeniden dosya oluşturmayı tetiklemesin;
        // renderer başarı mesajını göstersin, ardından kesin ve temiz kapanış yapılsın.
        shutdownStarted = true;
        setTimeout(() => {
            try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch (_) { /* yut */ }
            try { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy(); } catch (_) { /* yut */ }
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); } catch (_) { /* yut */ }
            try { timers.clearAll(); } catch (_) { /* yut */ }
            try { app.quit(); } catch (_) { /* yut */ }
            setTimeout(() => {
                try { app.exit(0); } catch (_) { /* yut */ }
            }, 800);
        }, 350);
        return { success: true, removed: result.removed.length };
    } catch (err) {
        isQuitting = false;
        log.error('[DataWipe] başarısız:', err && err.message);
        return { success: false, code: (err && err.code) || 'WIPE_FAILED', message: t('errorSaveFailed') };
    }
});

ipcHandle('get-distribution', () => distribution.publicInfo());

ipcOn('open-external-link', (event, url) => {
    // WP-10.T6: yalnızca allowlist'teki https host'lar dış tarayıcıda açılır.
    if (!openExternalSafely(shell, url, log)) {
        log.warn(`[IPC] open-external-link reddedildi: ${String(url).slice(0, 80)}`);
    }
});

// WP-10.T8: renderer CSP ihlalleri ana süreç loguna düşer (hassas veri yok).
ipcOn('csp-violation', (event, data) => {
    const safe = data && typeof data === 'object' ? data : {};
    const clip = (value) => String(value == null ? '' : value).slice(0, 512);
    log.warn(`[CSP] ihlal: directive=${clip(safe.violatedDirective)} blocked=${clip(safe.blockedURI)} source=${clip(safe.sourceFile)}:${Number(safe.lineNumber) || 0}`);
});
