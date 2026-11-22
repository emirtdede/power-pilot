/**
 * headless.js - FAZ A "Windows servisi" iskeleti (denetim turunda tamamlandı).
 * Electron'sız ajan çalıştırıcı: aynı servis yığını (depolama, görev motoru,
 * güvenlik, envanter, emir kuyruğu, konsol senkronu) NSSM/Task Scheduler ile
 * Windows Servisi olarak koşar. UI yok, AI yok (ajan için gereksiz).
 *
 * Servis kurulumu: scripts/install-service.ps1
 * Doğrudan çalıştırma (Electron): PowerPilot.exe --headless --user-data-dir=<dir>
 * Node ile yalnızca sırsız kurulumda çalışır (safeStorage/DPAPI yoktur).
 */
const path = require('path');
const fs = require('fs');
const { SecretStore } = require('../main/security/SecretStore');

const StorageService = require('../main/services/StorageService');
const HistoryService = require('../main/services/HistoryService');
const WarningManager = require('../main/services/WarningManager');
const SafetyPolicyEngine = require('../main/services/SafetyPolicyEngine');
const MetricCollector = require('../main/services/monitors/MetricCollector');
const SmartFinishEngine = require('../main/services/SmartFinishEngine');
const TaskManager = require('../main/services/TaskManager');
const WebhookService = require('../main/services/WebhookService');
const LocalApiService = require('../main/services/LocalApiService');
const { PowerService } = require('../main/services/PowerService');
const DeviceProfileService = require('../main/services/DeviceProfileService');
const EnergyEstimateService = require('../main/services/EnergyEstimateService');
const TemplateService = require('../main/services/TemplateService');
const { OneDriveSyncService } = require('../main/services/OneDriveSyncService');
const { DiagnosticsService } = require('../main/services/DiagnosticsService');
const { AiBackend } = require('../main/services/AiBackend');
const { AiService } = require('../main/services/AiService');
const { ModelManager, STT_MODEL_ID, STT_MODEL_FILE, STT_MODEL_URL } = require('../main/services/ModelManager');
const { DeviceProfiler } = require('../main/services/DeviceProfiler');
const { AgentOrchestrator } = require('../main/services/AgentOrchestrator');
const { UpdateService } = require('../main/services/UpdateService');
const TaskSchedulerBridge = require('../main/services/TaskSchedulerBridge');
const { InventoryService } = require('../main/services/InventoryService');
const { ExemptionService } = require('../main/services/ExemptionService');
const { OrderQueue } = require('../main/services/OrderQueue');
const { AuditLog } = require('../main/services/AuditLog');
const { ConsoleClient } = require('../main/services/ConsoleClient');
const { OrderExecutor } = require('../main/services/OrderExecutor');
const { UpsMonitor } = require('../main/services/UpsMonitor');
const { TimerRegistry } = require('../main/util/TimerRegistry');
const { initHeadlessConfig } = require('./bootstrap');
const log = require('../main/logger');

function defaultUserDataDir() {
    const base = process.env.ProgramData || process.env.ALLUSERSPROFILE || '.';
    return path.join(base, 'PowerPilot', 'Agent');
}

async function bootAgent({
    userDataPath = null,
    appVersion = '1.0.0',
    syncIntervalMs = 60000,
    secretStore = null,
    timerRegistry = null,
    autoEnableApi = false,
    apiPort = null,
    exePath = null
} = {}) {
    const dir = userDataPath || defaultUserDataDir();
    // WP-13.T6: servis kapanışında hiçbir timer açık kalmaz.
    const timers = timerRegistry || new TimerRegistry();
    fs.mkdirSync(dir, { recursive: true });

    // Zero-GUI convenience: when explicitly requested (`--enable-api`), bootstrap Local API + key before boot
    if (autoEnableApi === true) {
        initHeadlessConfig({
            userDataPath: dir,
            port: apiPort || undefined,
            enableApi: true,
            rotateKey: false,
            saveProfile: true
        });
    }

    const storage = new StorageService(dir);
    // WP-04.T5: headless da aynı sır deposunu kullanır. Backend yoksa ve
    // korunacak sır varsa açılış reddedilir (düz metin fallback yok).
    const secrets = secretStore || new SecretStore({
        filePath: path.join(dir, 'secrets.v1.json'),
        applyAcl: true,
        logger: log
    });
    storage.setSecretStore(secrets);
    const available = await secrets.isAsyncEncryptionAvailable();
    const plaintext = SecretStore.findPlaintextSecrets(storage.data);
    if (!available) {
        if (plaintext.length > 0 || secrets.listNames().length > 0) {
            storage.close();
            throw Object.assign(
                new Error('safeStorage/DPAPI kullanılamıyor; headless ajan sırları koruyamaz.'),
                { code: 'SECRET_BACKEND_UNAVAILABLE', plaintext }
            );
        }
        log.warn('[Headless] safeStorage kullanılamıyor; kayıtlı sır yok, devam ediliyor.');
        // WP-11.T7/T-STO-12: audit kaydı varsa anahtarsız devam edilmez.
        if (storage.getAuditLog().length > 0) {
            storage.enterMaintenance('Audit HMAC anahtarı yok (safeStorage kullanılamıyor).');
            storage.auditTampered = true;
        }
    } else {
        const migrated = await secrets.migrateFromData(storage.data);
        await secrets.hydrateData(storage.data);
        let auditKey = null;
        try {
            auditKey = await secrets.getSecret('auditHmacKey');
        } catch (_) {
            auditKey = null;
        }
        if (!auditKey) {
            if (storage.getAuditLog().length > 0 && storage.getMeta('audit_chain') === 'hmac-v1') {
                storage.enterMaintenance('Audit HMAC anahtarı kayıp; yeni anahtar üretilmedi.');
                storage.auditTampered = true;
            } else {
                auditKey = require('crypto').randomBytes(32).toString('hex');
                await secrets.setSecret('auditHmacKey', auditKey);
            }
        }
        if (auditKey) {
            try {
                storage.setAuditKey(Buffer.from(auditKey, 'hex'), {
                    checkpointDir: path.join(dir, 'audit-checkpoints'),
                    eventLog: true
                });
                const verify = storage.verifyAuditChain();
                if (!verify.ok) {
                    storage.auditTampered = true;
                    log.error('[Headless][Audit] Zincir doğrulaması başarısız:', verify.code, verify.error);
                }
            } catch (err) {
                storage.enterMaintenance(`Audit zinciri kurulamadı: ${err.message}`);
                storage.auditTampered = true;
            }
        }
        if (migrated.migrated.length > 0 || plaintext.length > 0) {
            storage.save();
            // Eski düz metin WAL çerçeveleri diskte kalmasın.
            storage.checkpoint();
            const removed = SecretStore.purgeSecretBackups(storage.backupDir);
            log.info(`[Headless] ${migrated.migrated.length} sır şifrelendi; ${removed.length} eski yedek silindi.`);
        }
    }

    PowerService.setExecutionGuard(() => {
        if (storage.maintenanceMode) {
            return { ok: false, code: 'STORAGE_MAINTENANCE', error: storage.maintenanceReason || 'Depo bakım modunda.' };
        }
        if (storage.auditTampered) {
            return { ok: false, code: 'AUDIT_TAMPERED', error: 'Denetim zinciri kurcalanmış; yıkıcı eylemler bloke.' };
        }
        return { ok: true };
    });

    const history = new HistoryService(storage);
    const warnings = new WarningManager(history);
    const safety = new SafetyPolicyEngine(storage);
    const metrics = new MetricCollector();
    const smart = new SmartFinishEngine(metrics);
    const webhooks = new WebhookService(storage);
    const tasks = new TaskManager(storage, warnings, safety, history, webhooks, smart, metrics, null, timers);
    if (exePath) {
        try {
            tasks.schedulerBridge = new TaskSchedulerBridge({ exePath, isStoreApp: false });
        } catch (err) {
            log.warn('[Headless] TaskSchedulerBridge baslatilamadi:', err && err.message);
        }
    }

    let upsMonitor = null;
    try {
        const s0 = storage.getSettings();
        upsMonitor = new UpsMonitor({ host: s0.upsHost || '127.0.0.1', ups: s0.upsName || 'ups' });
    } catch (_) {
        upsMonitor = null;
    }
    const inventory = new InventoryService({ storageService: storage, agentVersion: appVersion, upsMonitor });
    const exemptions = new ExemptionService(storage);
    const queue = new OrderQueue(storage);
    const audit = new AuditLog(storage);
    const devices = new DeviceProfileService(storage);
    const energy = new EnergyEstimateService(storage);
    const templates = new TemplateService(storage);
    const cloudSync = new OneDriveSyncService({
        storageService: storage,
        userDataDir: dir,
        appVersion,
        logger: log,
        debounceMs: 300
    });
    storage.setChangeListener((reason) => {
        try { cloudSync.scheduleAutoSync(reason); } catch (_) { /* best-effort */ }
    });
    const diagnostics = new DiagnosticsService({
        userDataDir: dir,
        logsDir: path.join(dir, 'logs'),
        downloadsDir: path.join(dir, 'support-bundles'),
        appVersion,
        distributionChannel: 'headless',
        isPortable: false,
        storageService: storage
    });
    const aiBackend = new AiBackend({ modelDir: path.join(dir, 'models') });
    const modelManager = new ModelManager({ modelDir: path.join(dir, 'models') });
    const sttModelManager = new ModelManager({
        modelDir: path.join(dir, 'models'),
        modelId: STT_MODEL_ID,
        file: STT_MODEL_FILE,
        url: STT_MODEL_URL
    });
    const deviceProfiler = new DeviceProfiler();
    const aiService = new AiService({ backend: aiBackend });
    const orchestrator = new AgentOrchestrator({ aiService, aiBackend, storage, history });
    const updates = new UpdateService({
        currentVersion: appVersion,
        isStore: false,
        isPortable: true,
        isPackaged: false,
        logger: log
    });

    let electronPowerMonitor = null;
    try {
        const elec = require('electron');
        if (elec && elec.powerMonitor) electronPowerMonitor = elec.powerMonitor;
    } catch (_) { /* plain Node.js headless runtime */ }

    const consoleClient = new ConsoleClient({ storage, inventoryService: inventory, orderQueue: queue, auditLog: audit });
    const executor = new OrderExecutor({ taskManager: tasks, deviceService: devices, audit });

    const api = new LocalApiService(storage, tasks, PowerService, {
        headless: true,
        userDataDir: dir,
        secretStore: secrets,
        powerMonitor: electronPowerMonitor,
        warningManager: warnings,
        metricCollector: metrics,
        inventory,
        exemptions,
        queue,
        audit,
        history,
        templates,
        energy,
        devices,
        deviceProfiler,
        webhooks,
        cloudSync,
        diagnostics,
        aiBackend,
        modelManager,
        sttModelManager,
        orchestrator,
        updates,
        upsMonitor,
        consoleClient,
        executor
    });

    // O-01/O-21: bind hatası sessizce yutulmaz; başlatma sonucu beklenir.
    const started = await api.start();
    if (!started || started.ok === false) {
        log.error('[Headless] Local API başlatılamadı:', started && started.code);
    }

    let stopped = false;
    const tick = async () => {
        if (stopped) return;
        try {
            if (!consoleClient.isConfigured()) return;
            // Y-03: duraklatma yalnızca drain/icrayı engeller; heartbeat sürer.
            const res = await consoleClient.sync();
            if (res && res.disabled) return;
            if (res && res.ok && !tasks.pausedAll) await executor.drain(queue);
        } catch (err) {
            try { log.warn('[Headless] sync hatası:', err && err.message); } catch (_) {}
        }
    };
    const rawSync = Number(syncIntervalMs);
    const effectiveSyncMs = Number.isFinite(rawSync)
        ? Math.min(3_600_000, Math.max(5_000, rawSync))
        : 60_000;
    timers.setInterval(tick, effectiveSyncMs);
    timers.setTimeout(tick, 5000);

    try { log.info(`[Headless] ajan başladı (veri: ${dir})`); } catch (_) {}

    return {
        dir, storage, history, tasks, api, inventory, exemptions, queue, audit,
        consoleClient, executor, devices, energy, templates, webhooks, cloudSync,
        diagnostics, orchestrator, updates, secretStore: secrets,
        async stop() {
            stopped = true;
            try { timers.clearAll(); } catch (_) {}
            try { metrics.stopSampling(); } catch (_) {}
            try { cloudSync.flush(); } catch (_) {}
            try { if (upsMonitor) upsMonitor.close(); } catch (_) {}
            try { await api.stop(); } catch (_) {}
            try { if (storage.auditCheckpoint) storage.auditCheckpoint.write(storage.getAuditLog(), { eventLog: false }); } catch (_) {}
            try { storage.close(); } catch (_) {}
        }
    };
}

if (require.main === module) {
    // PP_SYNC_MS: konsol senkron aralığı (servis ayarı; varsayılan 60000).
    const rawSyncMs = Number(process.env.PP_SYNC_MS);
    const syncMs = Number.isFinite(rawSyncMs)
        ? Math.min(3_600_000, Math.max(5_000, rawSyncMs))
        : 60_000;
    (async () => {
        try {
            const handle = await bootAgent({ userDataPath: process.argv[2] || null, syncIntervalMs: syncMs });
            const shutdown = async () => {
                try { await handle.stop(); } catch (_) {}
                process.exit(0);
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
        } catch (err) {
            log.error('[Headless] başlatılamadı:', err && err.message);
            process.exitCode = 1;
        }
    })();
}

module.exports = { bootAgent, defaultUserDataDir };
