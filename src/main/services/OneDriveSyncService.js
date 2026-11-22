/**
 * OneDriveSyncService.js - Sunucusuz, sifir maliyetli yerel Microsoft OneDrive
 * bulut yedekleme, atomik yazma, 15 gunluk surum gecmisi ve format sonrasi kurtarma.
 *
 * - OAuth / bulut sunucu maliyeti yoktur; yerel OneDrive istemci klasorunu kullanir.
 * - Sirlar (DPAPI/SecretStore, PIN ozetleri, TLS ozel anahtarlari, webhook sirlari)
 *   bulut JSON dosyasina ASLA yazilmaz.
 * - Dogrudan dosya uzerine yazmaz: .tmp-<pid> -> rename, Windows kilidinde (EBUSY/EPERM)
 *   copyFile + gecici dosya temizligi yedegine duser.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateSettings, SECURITY_SETTING_KEYS } = require('../ipc/validate');

const SYNC_FILE = 'powerpilot-onedrive-sync.json';
const PREVIOUS_FILE = 'powerpilot-onedrive-previous.json';
const DAILY_PREFIX = 'powerpilot-backup-';
const DAILY_RE = /^powerpilot-backup-(\d{4}-\d{2}-\d{2})\.json$/;
const MAX_DAILY_BACKUPS = 15;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_DEBOUNCE_MS = 300;
const SUBFOLDER_NAME = 'PowerPilot';
const FALLBACK_DIR_NAME = 'onedrive-backup';

// Bulut yedegine asla cikmamasi gereken sirlar ve cihaza ozgu meta alanlar.
const EXCLUDED_EXPORT_SETTINGS = new Set([
    'cancelPinHash',
    'cancelPinSalt',
    'localApiKeyHash',
    'localApiKeyMasked',
    'localApiKeyCreatedAt',
    'localApiKeyPem',
    'localApiPfxPassphrase',
    'localApiCertPem',
    'localApiCaPem',
    'localApiCertFile',
    'localApiKeyFile',
    'localApiCaFile',
    'localApiPfxFile',
    'consoleAgentKey',
    'consolePublicKeyPem',
    'consoleClientCertPem',
    'consoleClientCertFile',
    'consoleClientKeyPem',
    'consoleClientKeyFile',
    'consoleClientPfxFile',
    'consoleClientPfxPassphrase',
    'consoleClientCaFile',
    'consoleClientCaPem',
    'oneDriveConnected',
    'oneDriveAutoSync',
    'oneDriveCustomDir',
    'oneDriveLastSyncAt',
    'oneDriveRecoveryDismissed',
    'lanModeWarning',
    'maintenanceWindowWarning',
    'aiSilencedUntil'
]);

// Bos / varsayilan kurulum tespitinde kullanici ozellestirmesi sayilan ayarlar.
// language (ilk acilista sistem/kurulum dili olarak atanabilir) ve oneDrive*
// meta anahtarlari bilerek haric tutulur ki temiz kurulumda kurtarma kacirilmasin.
const MEANINGFUL_USER_SETTINGS = [
    'theme',
    'themeId',
    'customThemeColor',
    'appIcon',
    'customIconColor',
    'syncIconWithTheme',
    'uiZoom',
    'fontScale',
    'highContrast',
    'enhancedFocus',
    'readableSpacing',
    'reduceMotion',
    'onboardingCompleted',
    'autostart',
    'startMinimized',
    'closeToTray',
    'autoMiniWidget',
    'defaultAction',
    'defaultMinutes',
    'clockFormat',
    'soundMode',
    'uiDensity',
    'toastPosition',
    'notifications',
    'desktopNotifyStart',
    'desktopNotifyWarn',
    'desktopNotifySkip',
    'prewarnSeconds',
    'quietHoursEnabled',
    'quietStart',
    'quietEnd',
    'fallbackAction',
    'graceSeconds',
    'protectFullscreen',
    'protectActiveIo',
    'forceCloseApps',
    'remoteApprovalRequired',
    'protectedApps',
    'pinLengthMode',
    'autoBackupEnabled',
    'wakeMode',
    'wakeToleranceMinutes',
    'deviceWattage',
    'electricityCostPerKwh',
    'currency',
    'statsEnabled',
    'assumedOffHours',
    'bootGuardSeconds',
    'shortcuts',
    'globalShortcutsEnabled',
    'globalShortcutToggleWindow',
    'globalShortcutQuickStart',
    'globalShortcutCancel',
    'globalShortcutVoiceHud',
    'aiTier',
    'voiceHudEnabled',
    'voiceReplyTtsEnabled',
    'autoCheckUpdates',
    'sidebarCollapsed',
    'templateOverrides',
    'hiddenBuiltInTemplates',
    'upsEnabled',
    'upsAutoActionEnabled'
];

function safeClone(val) {
    try {
        if (typeof structuredClone === 'function') return structuredClone(val);
    } catch (_) { /* dus */ }
    try {
        return JSON.parse(JSON.stringify(val));
    } catch (_) {
        return val;
    }
}

function stableEquals(a, b) {
    if (a === b) return true;
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (_) {
        return false;
    }
}

function formatLocalDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Klasor yolunu guvenlik acisindan dogrular (path traversal, null byte, goreli yol yok).
 */
function validateDirectoryPath(dirPath) {
    if (typeof dirPath !== 'string') return { ok: false, code: 'INVALID_PATH' };
    const trimmed = dirPath.trim();
    if (!trimmed || trimmed.length > 512) return { ok: false, code: 'INVALID_PATH' };
    if (trimmed.includes('\0')) return { ok: false, code: 'INVALID_PATH' };
    const segments = trimmed.split(/[\\/]+/);
    if (segments.includes('..')) return { ok: false, code: 'PATH_TRAVERSAL' };
    if (!path.isAbsolute(trimmed)) return { ok: false, code: 'NOT_ABSOLUTE' };
    return { ok: true, path: path.resolve(trimmed) };
}

/**
 * Windows ortam degiskenlerinden yerel Microsoft OneDrive kok klasorunu algilar:
 * 1. OneDriveConsumer
 * 2. OneDrive
 * 3. OneDriveCommercial
 * 4. ~/OneDrive
 */
function detectOneDriveRoot(env = process.env, homedir = os.homedir(), fsImpl = fs) {
    const candidates = [
        { source: 'OneDriveConsumer', value: env && env.OneDriveConsumer },
        { source: 'OneDrive', value: env && env.OneDrive },
        { source: 'OneDriveCommercial', value: env && env.OneDriveCommercial },
        { source: 'homedir', value: homedir ? path.join(homedir, 'OneDrive') : null }
    ];

    for (const item of candidates) {
        if (typeof item.value !== 'string' || !item.value.trim()) continue;
        const check = validateDirectoryPath(item.value);
        if (!check.ok) continue;
        try {
            if (fsImpl.existsSync(check.path) && fsImpl.statSync(check.path).isDirectory()) {
                return { found: true, rootDir: check.path, source: item.source };
            }
        } catch (_) { /* erisilemeyen aday atlanir */ }
    }
    return { found: false, rootDir: null, source: 'local-fallback' };
}

function isExistingDir(candidate, fsImpl) {
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    const check = validateDirectoryPath(candidate);
    if (!check.ok) return null;
    try {
        if (fsImpl.existsSync(check.path) && fsImpl.statSync(check.path).isDirectory()) {
            return check.path;
        }
    } catch (_) { /* erisilemeyen aday atlanir */ }
    return null;
}

function detectDropboxRoot(env = process.env, homedir = os.homedir(), fsImpl = fs) {
    const infoFiles = [
        env && env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Dropbox', 'info.json') : null,
        env && env.APPDATA ? path.join(env.APPDATA, 'Dropbox', 'info.json') : null
    ].filter(Boolean);
    for (const infoFile of infoFiles) {
        try {
            if (fsImpl.existsSync(infoFile)) {
                const parsed = JSON.parse(fsImpl.readFileSync(infoFile, 'utf8'));
                const p = (parsed && parsed.personal && parsed.personal.path)
                    || (parsed && parsed.business && parsed.business.path);
                const valid = isExistingDir(p, fsImpl);
                if (valid) return valid;
            }
        } catch (_) { /* yut */ }
    }
    if (homedir) {
        const direct = isExistingDir(path.join(homedir, 'Dropbox'), fsImpl);
        if (direct) return direct;
    }
    return null;
}

function detectGoogleDriveRoot(env = process.env, homedir = os.homedir(), fsImpl = fs) {
    const candidates = [
        env && env.GOOGLE_DRIVE_DIR,
        homedir ? path.join(homedir, 'Google Drive', 'My Drive') : null,
        homedir ? path.join(homedir, 'Google Drive') : null,
        homedir ? path.join(homedir, 'My Drive') : null,
        'G:\\My Drive',
        "G:\\Drive'ım",
        "G:\\Drive'im"
    ];
    for (const c of candidates) {
        const valid = isExistingDir(c, fsImpl);
        if (valid) return valid;
    }
    return null;
}

function detectICloudDriveRoot(env = process.env, homedir = os.homedir(), fsImpl = fs) {
    const candidates = [
        env && env.ICLOUD_DRIVE_DIR,
        homedir ? path.join(homedir, 'iCloudDrive') : null,
        homedir ? path.join(homedir, 'iCloud Drive') : null
    ];
    for (const c of candidates) {
        const valid = isExistingDir(c, fsImpl);
        if (valid) return valid;
    }
    return null;
}

/**
 * Bilgisayarda kurulu tum yerel bulut senkron klasorlerini (OneDrive, Google Drive,
 * Dropbox, iCloud Drive) OAuth/API olmadan otomatik algilar.
 */
function detectCloudProviders(env = process.env, homedir = os.homedir(), fsImpl = fs) {
    const providers = [];
    const od = detectOneDriveRoot(env, homedir, fsImpl);
    if (od.found) {
        providers.push({
            id: 'onedrive',
            label: 'OneDrive',
            rootDir: od.rootDir,
            syncDir: path.join(od.rootDir, SUBFOLDER_NAME)
        });
    }
    const gd = detectGoogleDriveRoot(env, homedir, fsImpl);
    if (gd) {
        providers.push({
            id: 'gdrive',
            label: 'Google Drive',
            rootDir: gd,
            syncDir: path.join(gd, SUBFOLDER_NAME)
        });
    }
    const dbx = detectDropboxRoot(env, homedir, fsImpl);
    if (dbx) {
        providers.push({
            id: 'dropbox',
            label: 'Dropbox',
            rootDir: dbx,
            syncDir: path.join(dbx, SUBFOLDER_NAME)
        });
    }
    const ic = detectICloudDriveRoot(env, homedir, fsImpl);
    if (ic) {
        providers.push({
            id: 'icloud',
            label: 'iCloud Drive',
            rootDir: ic,
            syncDir: path.join(ic, SUBFOLDER_NAME)
        });
    }
    return providers;
}

/**
 * Atomik dosya yazimi:
 * 1. <target>.tmp-<pid> gecici dosyasina yaz
 * 2. renameSync ile degistir
 * 3. Windows OneDrive kilidi (EBUSY/EPERM/EACCES) durumunda copyFileSync + tmp temizligi
 */
function atomicWriteFile(targetPath, content, fsImpl = fs, pid = process.pid) {
    const dir = path.dirname(targetPath);
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmpPath = `${targetPath}.tmp-${pid}`;
    let renamed = false;
    try {
        fsImpl.writeFileSync(tmpPath, content, 'utf8');
        try {
            fsImpl.renameSync(tmpPath, targetPath);
            renamed = true;
            return { method: 'rename' };
        } catch (err) {
            const code = err && err.code;
            if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
                fsImpl.copyFileSync(tmpPath, targetPath);
                return { method: 'copy-fallback', lockCode: code };
            }
            throw err;
        }
    } finally {
        if (!renamed) {
            try {
                if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath);
            } catch (_) { /* en iyi caba temizlik */ }
        }
    }
}

function isValidSnapshot(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    if (typeof parsed.exportedAt !== 'string' || !parsed.exportedAt) return false;
    if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) return false;
    if (!parsed.data.settings || typeof parsed.data.settings !== 'object' || Array.isArray(parsed.data.settings)) {
        return false;
    }
    const arrayKeys = ['tasks', 'templates', 'deviceProfiles', 'webhooks', 'exemptions', 'maintenanceWindows', 'history'];
    for (const k of arrayKeys) {
        if (parsed.data[k] !== undefined && !Array.isArray(parsed.data[k])) return false;
    }
    return true;
}

class OneDriveSyncService {
    constructor(options = {}) {
        this.storageService = options.storageService;
        this.userDataDir = options.userDataDir || (this.storageService && this.storageService.userDataPath) || os.tmpdir();
        this.appVersion = options.appVersion || '1.0.0';
        this.env = options.env || process.env;
        this.homedir = typeof options.homedir === 'string' ? options.homedir : os.homedir();
        this.fs = options.fs || fs;
        this.pid = options.pid || process.pid;
        this.debounceMs = Number.isFinite(options.debounceMs) ? Math.max(0, options.debounceMs) : DEFAULT_DEBOUNCE_MS;
        this.nowFn = typeof options.nowFn === 'function' ? options.nowFn : () => new Date();
        this.logger = options.logger || null;
        this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null;

        this._debounceTimer = null;
        this._pendingSync = false;
        this._suppressAutoSync = false;
        this._lastErrorCode = null;
    }

    _logWarn(msg, err) {
        if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn(msg, err && err.message ? err.message : (err || ''));
        }
    }

    _logInfo(msg) {
        if (this.logger && typeof this.logger.info === 'function') {
            this.logger.info(msg);
        }
    }

    _getSettings() {
        return (this.storageService && typeof this.storageService.getSettings === 'function')
            ? this.storageService.getSettings()
            : {};
    }

    _getDefaultSettings() {
        return (this.storageService && typeof this.storageService.getDefaultData === 'function')
            ? this.storageService.getDefaultData().settings
            : {};
    }

    _updateMetaSettings(patch) {
        if (!this.storageService || typeof this.storageService.updateSettings !== 'function') return false;
        const prevSuppress = this._suppressAutoSync;
        this._suppressAutoSync = true;
        try {
            return this.storageService.updateSettings(patch, { silent: true });
        } finally {
            this._suppressAutoSync = prevSuppress;
        }
    }

    /**
     * Etkin yedek/esitleme klasorunu cozer:
     * - Kullanicinin sectigi ozel klasor varsa onu kullanir
     * - Yoksa algilanan <OneDrive>/PowerPilot klasorunu kullanir
     * - OneDrive yoksa userData/onedrive-backup guvenli yedegine duser
     */
    resolveDirectory() {
        const settings = this._getSettings();
        const detected = detectOneDriveRoot(this.env, this.homedir, this.fs);
        const defaultDir = detected.found
            ? path.join(detected.rootDir, SUBFOLDER_NAME)
            : path.join(this.userDataDir, FALLBACK_DIR_NAME);

        const customRaw = settings.oneDriveCustomDir;
        if (typeof customRaw === 'string' && customRaw.trim()) {
            const check = validateDirectoryPath(customRaw);
            if (check.ok) {
                return {
                    syncDir: check.path,
                    defaultDir,
                    isCustomDir: true,
                    isOneDriveDetected: detected.found,
                    isFallback: false,
                    detectedSource: detected.source,
                    detectedRoot: detected.rootDir
                };
            }
        }

        return {
            syncDir: defaultDir,
            defaultDir,
            isCustomDir: false,
            isOneDriveDetected: detected.found,
            isFallback: !detected.found,
            detectedSource: detected.source,
            detectedRoot: detected.rootDir
        };
    }

    /**
     * Yerel uygulama durumunun temiz kurulum / varsayilan bos durumda olup olmadigini belirler.
     */
    isLocalStateEmptyOrDefault() {
        if (!this.storageService) return true;
        if ((this.storageService.getTasks() || []).length > 0) return false;
        if ((this.storageService.getHistory() || []).length > 0) return false;
        if ((this.storageService.getTemplates() || []).length > 0) return false;
        if ((this.storageService.getDeviceProfiles() || []).length > 0) return false;
        if ((this.storageService.getWebhooks() || []).length > 0) return false;
        if ((this.storageService.getExemptions() || []).length > 0) return false;
        if ((this.storageService.getMaintenanceWindows() || []).length > 0) return false;

        const cur = this._getSettings();
        const defs = this._getDefaultSettings();
        for (const key of MEANINGFUL_USER_SETTINGS) {
            if (!stableEquals(cur[key], defs[key])) {
                return false;
            }
        }
        return true;
    }

    /**
     * Uzak yedegin gercek kullanici verisi veya ozellestirilmis ayar icerip icermedigini belirler.
     */
    isSnapshotNonEmpty(snapshot) {
        if (!isValidSnapshot(snapshot)) return false;
        const d = snapshot.data || {};
        if (Array.isArray(d.tasks) && d.tasks.length > 0) return true;
        if (Array.isArray(d.history) && d.history.length > 0) return true;
        if (Array.isArray(d.templates) && d.templates.length > 0) return true;
        if (Array.isArray(d.deviceProfiles) && d.deviceProfiles.length > 0) return true;
        if (Array.isArray(d.webhooks) && d.webhooks.length > 0) return true;
        if (Array.isArray(d.exemptions) && d.exemptions.length > 0) return true;
        if (Array.isArray(d.maintenanceWindows) && d.maintenanceWindows.length > 0) return true;

        const defs = this._getDefaultSettings();
        const s = d.settings || {};
        for (const key of MEANINGFUL_USER_SETTINGS) {
            if (Object.prototype.hasOwnProperty.call(s, key) && !stableEquals(s[key], defs[key])) {
                return true;
            }
        }
        return false;
    }

    /**
     * Guncel kullanici verilerinin sirlardan arindirilmis OneDrive anlik goruntusunu olusturur.
     */
    buildSnapshot() {
        const rawSettings = this._getSettings();
        const settings = {};
        for (const [k, v] of Object.entries(rawSettings)) {
            if (EXCLUDED_EXPORT_SETTINGS.has(k)) continue;
            if (SECURITY_SETTING_KEYS.includes(k)) continue;
            settings[k] = safeClone(v);
        }

        const rawWebhooks = this.storageService ? (this.storageService.getWebhooks() || []) : [];
        const webhooks = rawWebhooks.map((hook) => {
            if (!hook || typeof hook !== 'object') return hook;
            const clean = safeClone(hook);
            delete clean.secret;
            delete clean.password;
            delete clean.token;
            return clean;
        });

        return {
            app: 'Power Pilot',
            version: this.appVersion,
            schemaVersion: 1,
            provider: 'OneDrive',
            exportedAt: this.nowFn().toISOString(),
            data: {
                settings,
                tasks: safeClone(this.storageService ? this.storageService.getTasks() : []),
                templates: safeClone(this.storageService ? this.storageService.getTemplates() : []),
                deviceProfiles: safeClone(this.storageService ? this.storageService.getDeviceProfiles() : []),
                webhooks,
                exemptions: safeClone(this.storageService ? this.storageService.getExemptions() : []),
                maintenanceWindows: safeClone(this.storageService ? this.storageService.getMaintenanceWindows() : []),
                history: safeClone(this.storageService ? this.storageService.getHistory() : []).slice(0, 500)
            }
        };
    }

    listDailyBackups(syncDir) {
        try {
            if (!this.fs.existsSync(syncDir)) return [];
            return this.fs.readdirSync(syncDir)
                .filter((name) => DAILY_RE.test(name))
                .sort((a, b) => b.localeCompare(a)); // en yeni tarih basta
        } catch (_) {
            return [];
        }
    }

    pruneDailyBackups(syncDir, maxKeep = MAX_DAILY_BACKUPS) {
        const daily = this.listDailyBackups(syncDir);
        const removed = [];
        for (let i = maxKeep; i < daily.length; i++) {
            const full = path.join(syncDir, daily[i]);
            try {
                this.fs.unlinkSync(full);
                removed.push(daily[i]);
            } catch (err) {
                this._logWarn(`[OneDriveSync] Eski gunluk yedek silinemedi (${daily[i]}):`, err);
            }
        }
        return removed;
    }

    _readSnapshotFile(filePath) {
        try {
            if (!this.fs.existsSync(filePath)) return null;
            const st = this.fs.statSync(filePath);
            if (!st.isFile() || st.size <= 0 || st.size > MAX_SNAPSHOT_BYTES) return null;
            const raw = this.fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!isValidSnapshot(parsed)) return null;
            return { parsed, raw };
        } catch (_) {
            return null;
        }
    }

    /**
     * Bozuk dosya kurtarma zinciri:
     * sync.json -> previous.json -> en yeni tarihli backup-YYYY-MM-DD.json
     */
    readLatestValidBackup(syncDirOverride = null, prelistedDaily = null) {
        const syncDir = syncDirOverride || this.resolveDirectory().syncDir;
        const dailyList = Array.isArray(prelistedDaily) ? prelistedDaily : this.listDailyBackups(syncDir);
        const candidates = [
            SYNC_FILE,
            PREVIOUS_FILE,
            ...dailyList
        ];

        for (const name of candidates) {
            const full = path.join(syncDir, name);
            const loaded = this._readSnapshotFile(full);
            if (loaded) {
                return {
                    ok: true,
                    snapshot: loaded.parsed,
                    sourceFile: name,
                    filePath: full,
                    recoveredFromFallback: name !== SYNC_FILE
                };
            }
        }
        return { ok: false, code: 'NO_VALID_BACKUP' };
    }

    summarizeSnapshot(snapshot, syncDirOrDailyCount, extra = {}) {
        const d = (snapshot && snapshot.data) || {};
        const backupCount = typeof syncDirOrDailyCount === 'number'
            ? syncDirOrDailyCount
            : (Array.isArray(syncDirOrDailyCount)
                ? syncDirOrDailyCount.length
                : (syncDirOrDailyCount ? this.listDailyBackups(syncDirOrDailyCount).length : 0));
        return {
            exportedAt: (snapshot && snapshot.exportedAt) || null,
            version: (snapshot && snapshot.version) || null,
            tasks: Array.isArray(d.tasks) ? d.tasks.length : 0,
            templates: Array.isArray(d.templates) ? d.templates.length : 0,
            profiles: Array.isArray(d.deviceProfiles) ? d.deviceProfiles.length : 0,
            history: Array.isArray(d.history) ? d.history.length : 0,
            backupCount,
            sourceFile: extra.sourceFile || null,
            recoveredFromFallback: Boolean(extra.recoveredFromFallback)
        };
    }

    /**
     * Guncel durumu (UI karti ve acilis kurtarma denetimi icin) dondurur.
     */
    getStatus(opts = {}) {
        const settings = this._getSettings();
        const dirInfo = this.resolveDirectory();
        const daily = this.listDailyBackups(dirInfo.syncDir);
        const latest = (opts && opts.knownSnapshot)
            ? {
                ok: true,
                snapshot: opts.knownSnapshot,
                sourceFile: SYNC_FILE,
                filePath: path.join(dirInfo.syncDir, SYNC_FILE),
                recoveredFromFallback: false
            }
            : this.readLatestValidBackup(dirInfo.syncDir, daily);
        const hasRemoteBackup = latest.ok && this.isSnapshotNonEmpty(latest.snapshot);
        const isLocalEmpty = this.isLocalStateEmptyOrDefault();
        const shouldPromptRecovery = settings.oneDriveConnected !== true
            && settings.oneDriveRecoveryDismissed !== true
            && isLocalEmpty
            && hasRemoteBackup;

        const localSummary = {
            tasks: this.storageService ? (this.storageService.getTasks() || []).length : 0,
            templates: this.storageService ? (this.storageService.getTemplates() || []).length : 0,
            profiles: this.storageService ? (this.storageService.getDeviceProfiles() || []).length : 0,
            history: this.storageService ? (this.storageService.getHistory() || []).length : 0
        };

        const detectedProviders = detectCloudProviders(this.env, this.homedir, this.fs);
        const normSync = dirInfo.syncDir ? dirInfo.syncDir.toLowerCase() : '';
        const activeProvider = detectedProviders.find((p) => p.syncDir.toLowerCase() === normSync) || null;

        return {
            connected: settings.oneDriveConnected === true,
            autoSync: settings.oneDriveAutoSync !== false,
            lastSyncAt: settings.oneDriveLastSyncAt || (latest.ok ? latest.snapshot.exportedAt : null),
            syncDir: dirInfo.syncDir,
            defaultDir: dirInfo.defaultDir,
            isCustomDir: dirInfo.isCustomDir,
            isOneDriveDetected: dirInfo.isOneDriveDetected,
            isFallback: dirInfo.isFallback,
            detectedSource: dirInfo.detectedSource,
            detectedProviders,
            activeProviderId: activeProvider ? activeProvider.id : (dirInfo.isCustomDir ? 'custom' : 'local'),
            dailyBackupCount: daily.length,
            maxDailyBackups: MAX_DAILY_BACKUPS,
            hasRemoteBackup,
            remoteSummary: latest.ok ? this.summarizeSnapshot(latest.snapshot, daily.length, latest) : null,
            localSummary,
            isLocalEmpty,
            shouldPromptRecovery,
            lastErrorCode: this._lastErrorCode
        };
    }

    /**
     * Algilanan bulut saglayicilarindan birine (onedrive, gdrive/googledrive, dropbox, icloud, default) guvenle gecer.
     */
    useDetectedProvider(providerId) {
        if (typeof providerId !== 'string' || !providerId.trim()) {
            return { ok: false, code: 'INVALID_REQUEST' };
        }
        const norm = providerId.trim().toLowerCase();
        if (norm === 'default') {
            return this.setCustomDirectory(null);
        }
        const canonical = norm === 'googledrive' ? 'gdrive' : norm;
        const providers = detectCloudProviders(this.env, this.homedir, this.fs);
        const target = providers.find((p) => p.id === canonical);
        if (!target) {
            return { ok: false, code: 'INVALID_PATH' };
        }
        if (target.id === 'onedrive') {
            return this.setCustomDirectory(null);
        }
        return this.setCustomDirectory(target.syncDir);
    }

    /**
     * Anlik goruntuyu OneDrive klasorune atomik olarak yazar.
     * force=false (otomatik esitleme): yerel durum bossa dolu uzak yedegin uzerine ASLA yazmaz.
     */
    syncNow({ force = false } = {}) {
        if (!this.storageService || this.storageService.maintenanceMode) {
            return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        }
        const dirInfo = this.resolveDirectory();
        const syncDir = dirInfo.syncDir;

        if (!force && this.isLocalStateEmptyOrDefault()) {
            const existing = this.readLatestValidBackup(syncDir);
            if (existing.ok && this.isSnapshotNonEmpty(existing.snapshot)) {
                this._logInfo('[OneDriveSync] Bos yerel durum tespit edildi; mevcut OneDrive yedegi korundu.');
                return { ok: false, skipped: true, code: 'EMPTY_LOCAL_PROTECTED', status: this.getStatus() };
            }
        }

        const snapshot = this.buildSnapshot();
        const serialized = JSON.stringify(snapshot, null, 2);
        const syncPath = path.join(syncDir, SYNC_FILE);
        const prevPath = path.join(syncDir, PREVIOUS_FILE);
        const dateKey = formatLocalDateKey(this.nowFn());
        const dailyPath = path.join(syncDir, `${DAILY_PREFIX}${dateKey}.json`);

        try {
            this.fs.mkdirSync(syncDir, { recursive: true });

            // Once mevcut gecerli ana dosyayi previous.json olarak guvenceye al.
            const currentValid = this._readSnapshotFile(syncPath);
            if (currentValid) {
                atomicWriteFile(prevPath, currentValid.raw, this.fs, this.pid);
            }

            // Ana sync.json ve gunluk tarihli yedek atomik yazilir.
            const writeRes = atomicWriteFile(syncPath, serialized, this.fs, this.pid);
            atomicWriteFile(dailyPath, serialized, this.fs, this.pid);

            // 15 gunluk surum gecmisi rotasyonu.
            const pruned = this.pruneDailyBackups(syncDir, MAX_DAILY_BACKUPS);

            this._lastErrorCode = null;
            this._pendingSync = false;
            this._updateMetaSettings({ oneDriveLastSyncAt: snapshot.exportedAt });

            const status = this.getStatus({ knownSnapshot: snapshot });
            if (this.onStatusChange) {
                try { this.onStatusChange(status); } catch (_) { /* yut */ }
            }
            return {
                ok: true,
                exportedAt: snapshot.exportedAt,
                syncPath,
                dailyPath,
                writeMethod: writeRes.method,
                prunedCount: pruned.length,
                status
            };
        } catch (err) {
            this._lastErrorCode = (err && err.code) || 'SYNC_WRITE_FAILED';
            this._logWarn('[OneDriveSync] Yazma basarisiz:', err);
            return { ok: false, code: this._lastErrorCode, status: this.getStatus() };
        }
    }

    /**
     * OneDrive yedegini kurtarma zinciriyle okuyup yerel depoya atomik olarak geri yukler.
     */
    restoreFromBackup({ connect = false } = {}) {
        if (!this.storageService || this.storageService.maintenanceMode) {
            return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        }
        const dirInfo = this.resolveDirectory();
        const loaded = this.readLatestValidBackup(dirInfo.syncDir);
        if (!loaded.ok) {
            return { ok: false, code: loaded.code || 'NO_VALID_BACKUP', status: this.getStatus() };
        }

        const snap = loaded.snapshot;
        const incoming = snap.data || {};
        const currentSettings = this._getSettings();
        const validatedSettings = {};
        let restoredSettingsCount = 0;

        for (const [k, v] of Object.entries(incoming.settings || {})) {
            if (EXCLUDED_EXPORT_SETTINGS.has(k)) continue;
            if (SECURITY_SETTING_KEYS.includes(k)) continue;
            if (k === 'templateOverrides' && v && typeof v === 'object' && !Array.isArray(v)) {
                validatedSettings[k] = safeClone(v);
                restoredSettingsCount += 1;
                continue;
            }
            if (k === 'hiddenBuiltInTemplates' && Array.isArray(v)) {
                validatedSettings[k] = v.filter((id) => typeof id === 'string').slice(0, 100);
                restoredSettingsCount += 1;
                continue;
            }
            const check = validateSettings({ [k]: v }, currentSettings);
            if (check.ok) {
                validatedSettings[k] = safeClone(v);
                restoredSettingsCount += 1;
            }
        }

        if (connect) {
            validatedSettings.oneDriveConnected = true;
            validatedSettings.oneDriveAutoSync = true;
            validatedSettings.oneDriveRecoveryDismissed = false;
            validatedSettings.oneDriveLastSyncAt = snap.exportedAt || this.nowFn().toISOString();
        } else {
            validatedSettings.oneDriveLastSyncAt = snap.exportedAt || this.nowFn().toISOString();
            validatedSettings.oneDriveRecoveryDismissed = false;
        }

        const prevSuppress = this._suppressAutoSync;
        this._suppressAutoSync = true;
        this.cancelPending();
        try {
            if (Object.keys(validatedSettings).length > 0) {
                this.storageService.updateSettings(validatedSettings, { silent: true });
            }
            if (Array.isArray(incoming.tasks)) {
                this.storageService.saveTasks(safeClone(incoming.tasks), { silent: true });
            }
            if (Array.isArray(incoming.templates)) {
                this.storageService.saveTemplates(safeClone(incoming.templates), { silent: true });
            }
            if (Array.isArray(incoming.deviceProfiles)) {
                this.storageService.saveDeviceProfiles(safeClone(incoming.deviceProfiles), { silent: true });
            }
            if (Array.isArray(incoming.exemptions)) {
                this.storageService.saveExemptions(safeClone(incoming.exemptions), { silent: true });
            }
            if (Array.isArray(incoming.maintenanceWindows)) {
                this.storageService.saveMaintenanceWindows(safeClone(incoming.maintenanceWindows), { silent: true });
            }
            if (Array.isArray(incoming.webhooks)) {
                const existingById = new Map((this.storageService.getWebhooks() || [])
                    .filter((w) => w && w.id)
                    .map((w) => [w.id, w]));
                const mergedWebhooks = safeClone(incoming.webhooks).map((hook) => {
                    if (hook && hook.id && existingById.has(hook.id)) {
                        const prevHook = existingById.get(hook.id);
                        if (prevHook.secret && !hook.secret) hook.secret = prevHook.secret;
                    }
                    return hook;
                });
                this.storageService.saveWebhooks(mergedWebhooks, { silent: true });
            }
            if (Array.isArray(incoming.history)) {
                this.storageService.replaceHistory(safeClone(incoming.history).slice(0, 500), { silent: true });
            }
        } catch (err) {
            this._lastErrorCode = (err && err.code) || 'RESTORE_FAILED';
            this._logWarn('[OneDriveSync] Geri yukleme basarisiz:', err);
            return { ok: false, code: this._lastErrorCode, status: this.getStatus() };
        } finally {
            this._suppressAutoSync = prevSuppress;
        }

        this._lastErrorCode = null;
        const status = this.getStatus();
        if (this.onStatusChange) {
            try { this.onStatusChange(status); } catch (_) { /* yut */ }
        }
        return {
            ok: true,
            sourceFile: loaded.sourceFile,
            recoveredFromFallback: loaded.recoveredFromFallback,
            restored: {
                settingsCount: restoredSettingsCount,
                tasks: Array.isArray(incoming.tasks) ? incoming.tasks.length : 0,
                templates: Array.isArray(incoming.templates) ? incoming.templates.length : 0,
                profiles: Array.isArray(incoming.deviceProfiles) ? incoming.deviceProfiles.length : 0,
                history: Array.isArray(incoming.history) ? incoming.history.length : 0
            },
            status
        };
    }

    /**
     * OneDrive baglantisi kurar:
     * Yerel veriler bos ama OneDrive'da gecerli dolu yedek varsa once geri yukler;
     * aksi halde mevcut yerel verileri aninda OneDrive'a yazar.
     */
    connect() {
        if (!this.storageService || this.storageService.maintenanceMode) {
            return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        }
        const dirInfo = this.resolveDirectory();
        const existing = this.readLatestValidBackup(dirInfo.syncDir);
        if (this.isLocalStateEmptyOrDefault() && existing.ok && this.isSnapshotNonEmpty(existing.snapshot)) {
            const restored = this.restoreFromBackup({ connect: true });
            if (!restored.ok) return restored;
            return { ...restored, action: 'restored' };
        }

        this._updateMetaSettings({
            oneDriveConnected: true,
            oneDriveAutoSync: true,
            oneDriveRecoveryDismissed: false
        });
        const synced = this.syncNow({ force: true });
        if (!synced.ok) {
            this._updateMetaSettings({ oneDriveConnected: false });
            return synced;
        }
        return { ...synced, action: 'synced' };
    }

    disconnect() {
        this.cancelPending();
        this._updateMetaSettings({ oneDriveConnected: false });
        const status = this.getStatus();
        if (this.onStatusChange) {
            try { this.onStatusChange(status); } catch (_) { /* yut */ }
        }
        return { ok: true, status };
    }

    setAutoSync(enabled) {
        if (typeof enabled !== 'boolean') {
            return { ok: false, code: 'INVALID_REQUEST' };
        }
        this._updateMetaSettings({ oneDriveAutoSync: enabled });
        if (!enabled) this.cancelPending();
        const status = this.getStatus();
        return { ok: true, status };
    }

    setCustomDirectory(dirPath) {
        if (dirPath === null || dirPath === '') {
            this._updateMetaSettings({ oneDriveCustomDir: null });
            return { ok: true, status: this.getStatus() };
        }
        const check = validateDirectoryPath(dirPath);
        if (!check.ok) {
            return { ok: false, code: check.code };
        }
        try {
            this.fs.mkdirSync(check.path, { recursive: true });
        } catch (err) {
            return { ok: false, code: (err && err.code) || 'DIR_UNWRITABLE' };
        }
        this._updateMetaSettings({ oneDriveCustomDir: check.path });
        const status = this.getStatus();
        return { ok: true, status };
    }

    dismissRecovery() {
        this._updateMetaSettings({ oneDriveRecoveryDismissed: true });
        return { ok: true, status: this.getStatus() };
    }

    /**
     * Veri degisikliginde 200-400ms (varsayilan 300ms) debounce ile arka planda esitler.
     * Hatalar asla kullanici islemini bloklamaz veya firlatilmaz.
     */
    scheduleAutoSync(_reason = 'change') {
        if (this._suppressAutoSync) return false;
        const settings = this._getSettings();
        if (settings.oneDriveConnected !== true || settings.oneDriveAutoSync === false) return false;

        this._pendingSync = true;
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            this._runBackgroundSync();
        }, this.debounceMs);
        if (this._debounceTimer && typeof this._debounceTimer.unref === 'function') {
            this._debounceTimer.unref();
        }
        return true;
    }

    _runBackgroundSync() {
        if (!this._pendingSync) return { ok: false, skipped: true };
        this._pendingSync = false;
        try {
            return this.syncNow({ force: false });
        } catch (err) {
            this._lastErrorCode = (err && err.code) || 'BACKGROUND_SYNC_FAILED';
            this._logWarn('[OneDriveSync] Arka plan esitleme hatasi (yutuldu):', err);
            return { ok: false, code: this._lastErrorCode };
        }
    }

    /**
     * Kapanis flush: bekleyen debounce zamanlayicisi varsa kapanmadan once son degisikligi yazar.
     */
    flush() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        if (!this._pendingSync) return { ok: true, flushed: false };
        const settings = this._getSettings();
        if (settings.oneDriveConnected !== true || settings.oneDriveAutoSync === false) {
            this._pendingSync = false;
            return { ok: true, flushed: false };
        }
        const res = this._runBackgroundSync();
        return { ...res, flushed: Boolean(res && res.ok) };
    }

    cancelPending() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = null;
        }
        this._pendingSync = false;
    }
}

module.exports = {
    OneDriveSyncService,
    detectOneDriveRoot,
    detectCloudProviders,
    validateDirectoryPath,
    atomicWriteFile,
    isValidSnapshot,
    SYNC_FILE,
    PREVIOUS_FILE,
    DAILY_PREFIX,
    DAILY_RE,
    MAX_DAILY_BACKUPS,
    DEFAULT_DEBOUNCE_MS,
    SUBFOLDER_NAME,
    FALLBACK_DIR_NAME
};
