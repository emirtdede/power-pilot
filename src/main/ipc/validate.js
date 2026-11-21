/**
 * validate.js — WBS-2.1 IPC doğrulama katmanı.
 * Saf fonksiyonlar (electron bağımlılığı yok) → vitest ile doğrudan test edilir.
 * İlke: reddet + gerekçe döndür; ASLA sessiz geçme, ASLA throw fırlatma (IPC çökmesin).
 */

const { POWER_ACTIONS } = require('../services/PowerService');
const ipaddr = require('ipaddr.js');
const { validateUrl } = require('../security/SsrfGuard');

const MAX_DURATION_MS = 2500000000;
// K-03: istemci yalnızca görev tanımı alanlarını gönderebilir. Kaynak, mod,
// durum ve politika kimlikleri sunucu tarafından atanır.
const CLIENT_FORBIDDEN_TASK_FIELDS = [
    'source', 'mode', 'status', 'enabled', 'policyId', 'consoleOrderId',
    'requiresMaintenanceWindow', 'createdAt', 'updatedAt', 'lastRunAt',
    'lastResult', 'errorInfo'
];
const TRIGGER_TYPE_VALUES = new Set([
    'duration', 'scheduled_time', 'recurring', 'process_close', 'cpu_threshold',
    'network_threshold', 'disk_threshold', 'file_event', 'directory_event',
    'user_idle', 'battery_event', 'api_call', 'composite'
]);
// P1-6 (üçüncü tur): TaskManager yalnızca bu iki türü zamanlayabilir.
// Diğerleri gelecekte modelde ilan edilmiş ama HİÇ dağıtılmayan türlerdi:
// görev `draft` kalıyor, tetiklenmiyor, hata da üretmiyordu (sessiz no-op).
const DISPATCHABLE_TRIGGER_TYPES = new Set(['duration', 'scheduled_time']);
// Koşul güdümlü türler yalnızca bir conditionGroup ile anlamlıdır.
const CONDITION_DRIVEN_TRIGGER_TYPES = new Set([
    'process_close', 'cpu_threshold', 'network_threshold', 'disk_threshold',
    'file_event', 'directory_event', 'user_idle', 'battery_event', 'api_call',
    'composite'
]);
const RECURRENCE_FREQUENCIES = new Set(['none', 'daily', 'weekly', 'weekdays', 'weekends', 'custom']);
// WP-05.T1 / ADR-08: kimlik yalnızca sunucuda üretilir. İstemciden gelen değer
// bu desene uymuyorsa reddedilir; desene uysa bile createTask onu yok sayar.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WEBHOOKS = 20;
const WEBHOOK_EVENTS = new Set([
    'task_created', 'task_blocked', 'task_warning_started',
    'task_cancelled', 'task_snoozed', 'power_action_started'
]);
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$|^([0-9A-Fa-f]{12})$/;
// IPv4 + basit hostname (WOL broadcast adresi için).
const HOST_RE = /^(\d{1,3}\.){3}\d{1,3}$|^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,61}[a-zA-Z0-9])?$/;
const PROCESS_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,119}$/;

// WP-01: LAN allowlist yalnızca IP/CIDR kabul eder (hostname yok).
function isValidIpOrCidr(value) {
    return normalizeIpOrCidr(value) !== null;
}

/**
 * IP/CIDR'yi kanonik biçime çevirir. IPv4-mapped IPv6 IPv4'e indirgenir;
 * böylece `::ffff:10.0.0.1` ile `10.0.0.1` yinelenen kayıt sayılır.
 * Geçersiz girdide null döner (sessiz kabul yok).
 */
function normalizeIpOrCidr(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
    // Zone ID'yi prefix'i kaybetmeden at: fe80::1%eth0/64 → fe80::1/64.
    const s = value.trim().replace(/%[^/]*/, '');
    if (!s) return null;
    try {
        if (s.includes('/')) {
            const [rawAddr, prefix] = ipaddr.parseCIDR(s);
            let addr = rawAddr;
            let effectivePrefix = prefix;
            if (rawAddr.kind() === 'ipv6' && rawAddr.isIPv4MappedAddress()) {
                // /96'dan geniş blok IPv4 dışı adresleri de kapsar; IPv4'e
                // indirgemek fail-open olur. Bu yüzden reddedilir.
                if (prefix < 96) return null;
                addr = rawAddr.toIPv4Address();
                effectivePrefix = prefix - 96;
            }
            const max = addr.kind() === 'ipv4' ? 32 : 128;
            if (!Number.isInteger(effectivePrefix) || effectivePrefix < 0 || effectivePrefix > max) return null;
            return `${addr.toString()}/${effectivePrefix}`;
        }
        const raw = ipaddr.parse(s);
        const addr = (raw.kind() === 'ipv6' && raw.isIPv4MappedAddress())
            ? raw.toIPv4Address()
            : raw;
        return addr.toString();
    } catch (_) {
        return null;
    }
}

function canonicalProcessName(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    if (!PROCESS_NAME_RE.test(s)) return null;
    if (s.includes('/') || s.includes('\\') || s.includes('*') || s.includes('?') || s.includes(':')) return null;
    return s;
}

function validateCondition(cond) {
    if (!cond || typeof cond !== 'object' || typeof cond.type !== 'string') {
        return fail('Geçersiz koşul.', 'INVALID_CONDITION');
    }
    const type = cond.type;
    if (type === 'process_running') {
        if (!canonicalProcessName(cond.processName)) {
            return fail('processName 1..120 karakter, geçerli bir süreç adı olmalı.', 'INVALID_PROCESS_NAME');
        }
    }
    if (type === 'file_stable') {
        if (typeof cond.filePath !== 'string' || cond.filePath.trim().length === 0 || cond.filePath.length > 1024) {
            return fail('filePath 1..1024 karakter olmalı.', 'INVALID_FILE_PATH');
        }
    }
    if (type === 'directory_idle') {
        const p = cond.dirPath || cond.filePath;
        if (typeof p !== 'string' || p.trim().length === 0 || p.length > 1024) {
            return fail('dirPath 1..1024 karakter olmalı.', 'INVALID_DIRECTORY_PATH');
        }
    }
    if (type === 'cpu_usage') {
        const p = cond.thresholdPercent;
        if (p !== undefined && (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100)) {
            return fail('thresholdPercent 0..100 olmalı.', 'INVALID_CONDITION');
        }
    }
    if (type === 'user_idle') {
        const s = cond.idleSeconds;
        if (s !== undefined && (!Number.isInteger(s) || s < 1 || s > 86400)) {
            return fail('idleSeconds 1..86400 olmalı.', 'INVALID_CONDITION');
        }
    }
    if (type === 'network_speed' || type === 'disk_activity') {
        const t = cond.thresholdKbps;
        if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1000000)) {
            return fail('thresholdKbps 0..1000000 olmalı.', 'INVALID_CONDITION');
        }
    }
    if (type === 'battery_level') {
        for (const key of ['belowPercent', 'abovePercent']) {
            if (cond[key] !== undefined && (typeof cond[key] !== 'number' || !Number.isFinite(cond[key]) || cond[key] < 0 || cond[key] > 100)) {
                return fail(`${key} 0..100 olmalı.`, 'INVALID_CONDITION');
            }
        }
        if (cond.belowPercent !== undefined && cond.abovePercent !== undefined) {
            return fail('belowPercent ve abovePercent birlikte kullanılamaz.', 'INVALID_CONDITION');
        }
    }
    if (cond.stabilitySeconds !== undefined) {
        if (!Number.isInteger(cond.stabilitySeconds) || cond.stabilitySeconds < 0 || cond.stabilitySeconds > 3600) {
            return fail('stabilitySeconds 0..3600 aralığında olmalı.', 'INVALID_CONDITION');
        }
    }
    return { ok: true };
}

function fail(message, code) {
    return { ok: false, error: message, code: code || 'VALIDATION_ERROR' };
}

function validateScheduleAction(args) {
    if (!args || typeof args !== 'object') return fail('Geçersiz istek gövdesi.', 'INVALID_BODY');
    const { action, durationMs } = args;
    if (!POWER_ACTIONS || !Object.values(POWER_ACTIONS).includes(action)) {
        return fail(`Geçersiz eylem: ${String(action)}.`, 'INVALID_ACTION');
    }
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || !Number.isInteger(durationMs)) {
        return fail('durationMs tam sayı olmalı.', 'INVALID_DURATION');
    }
    if (durationMs <= 0 || durationMs > MAX_DURATION_MS) {
        return fail(`durationMs 1..${MAX_DURATION_MS} aralığında olmalı.`, 'INVALID_DURATION');
    }
    return { ok: true };
}

function validateTaskId(taskId) {
    if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) {
        return fail('Geçersiz taskId.', 'INVALID_TASK_ID');
    }
    return { ok: true };
}

function validateTaskData(data) {
    if (!data || typeof data !== 'object') return fail('Geçersiz görev verisi.', 'INVALID_BODY');
    // WP-05.T1 / ADR-08: istemci kimlik üretemez; sunucu üretir.
    if (data.id !== undefined) {
        return fail('Görev kimliği istemci tarafından belirlenemez.', 'INVALID_TASK_ID');
    }
    // K-03: ayrıcalıklı alanlar istemciden kabul edilmez.
    for (const field of CLIENT_FORBIDDEN_TASK_FIELDS) {
        if (data[field] !== undefined) {
            return fail(`İstemci '${field}' alanını belirleyemez.`, 'INVALID_FIELD');
        }
    }
    // K-03: eylem zorunlu; eksik payload varsayılan shutdown üretemez.
    if (typeof data.action !== 'string' || !Object.values(POWER_ACTIONS).includes(data.action)) {
        return fail(`Geçersiz veya eksik eylem: ${String(data.action)}.`, 'INVALID_ACTION');
    }
    if (data.name !== undefined && (typeof data.name !== 'string' || data.name.length > 120)) {
        return fail('Görev adı en fazla 120 karakter olmalı.', 'INVALID_NAME');
    }
    // Boşluktan ibaret ad kabul edilmez: kullanıcı listede adsız bir görev
    // görürdü ("   " satırı). Yalnızca boşluk = ad verilmemiş sayılır.
    if (typeof data.name === 'string' && data.name.trim().length === 0) {
        return fail('Görev adı boşluktan oluşamaz.', 'INVALID_NAME');
    }
    // K2: Depolanmış XSS kapısı — ad innerHTML lavabolarına akıyor.
    if (typeof data.name === 'string' && /[<>]/.test(data.name)) {
        return fail('Görev adı < ve > içeremez.', 'INVALID_NAME');
    }
    const trig = data.trigger;
    if (trig !== undefined) {
        if (!trig || typeof trig !== 'object' || Array.isArray(trig)) return fail('Geçersiz trigger.', 'INVALID_TRIGGER');
        if (trig.type !== undefined && !TRIGGER_TYPE_VALUES.has(trig.type)) {
            return fail('Geçersiz trigger türü.', 'INVALID_TRIGGER');
        }
        if (trig.durationMs !== undefined) {
            if (!Number.isInteger(trig.durationMs) || trig.durationMs <= 0 || trig.durationMs > MAX_DURATION_MS) {
                return fail('durationMs aralık dışı.', 'INVALID_DURATION');
            }
        }
        if (trig.targetTime !== undefined && trig.targetTime !== null) {
            if (!Number.isInteger(trig.targetTime) || trig.targetTime <= 0) {
                return fail('targetTime geçersiz.', 'INVALID_TRIGGER');
            }
        }
        if (trig.notBefore !== undefined && trig.notBefore !== null) {
            if (!Number.isInteger(trig.notBefore) || trig.notBefore <= 0) {
                return fail('notBefore geçersiz.', 'INVALID_TRIGGER');
            }
        }
    }
    const cg = data.conditionGroup;
    if (cg !== undefined) {
        if (typeof cg !== 'object' || (cg.conditions !== undefined && !Array.isArray(cg.conditions))) {
            return fail('Geçersiz conditionGroup.', 'INVALID_CONDITION');
        }
        if (cg.operator !== undefined && cg.operator !== 'AND' && cg.operator !== 'OR') {
            return fail('operator AND veya OR olmalı.', 'INVALID_CONDITION');
        }
        if (Array.isArray(cg.conditions)) {
            if (cg.conditions.length > 10) return fail('En fazla 10 koşul.', 'INVALID_CONDITION');
            for (const c of cg.conditions) {
                if (!c || typeof c.type !== 'string' || c.type.length === 0 || c.type.length > 40) {
                    return fail('Geçersiz koşul tipi.', 'INVALID_CONDITION');
                }
                const condCheck = validateCondition(c);
                if (!condCheck.ok) return condCheck;
            }
        }
        if (cg.stabilitySeconds !== undefined) {
            if (!Number.isInteger(cg.stabilitySeconds) || cg.stabilitySeconds < 0 || cg.stabilitySeconds > 3600) {
                return fail('stabilitySeconds 0..3600 aralığında olmalı.', 'INVALID_CONDITION');
            }
        }
    }
    // ADR-09 invariant: koşullu görev targetTime taşımaz.
    if (cg && Array.isArray(cg.conditions) && cg.conditions.length > 0 && trig && trig.targetTime) {
        return fail('Koşullu görev targetTime taşıyamaz; notBefore kullanın.', 'INVALID_TRIGGER');
    }
    // P1-6 (üçüncü tur): "kabul edilir ama hiç çalışmaz" görevi reddet.
    if (trig && trig.type !== undefined) {
        const condCount = (cg && Array.isArray(cg.conditions)) ? cg.conditions.length : 0;
        const recurring = !!(data.recurrence && data.recurrence.enabled === true);
        if (DISPATCHABLE_TRIGGER_TYPES.has(trig.type)) {
            if (trig.type === 'duration' && trig.durationMs === undefined) {
                return fail('Süre tetikleyicisi durationMs gerektirir.', 'INVALID_DURATION');
            }
            if (trig.type === 'scheduled_time' && !recurring &&
                (trig.targetTime === undefined || trig.targetTime === null)) {
                return fail('Zamanlanmış tetikleyici targetTime gerektirir.', 'INVALID_TRIGGER');
            }
        } else if (CONDITION_DRIVEN_TRIGGER_TYPES.has(trig.type)) {
            if (condCount === 0) {
                return fail(`"${trig.type}" tetikleyicisi en az bir koşul gerektirir.`, 'UNSUPPORTED_TRIGGER');
            }
        } else if (trig.type === 'recurring') {
            return fail('"recurring" bir tetikleyici türü değildir; scheduled_time + recurrence kullanın.', 'UNSUPPORTED_TRIGGER');
        } else {
            return fail(`Desteklenmeyen tetikleyici türü: ${trig.type}`, 'UNSUPPORTED_TRIGGER');
        }
    }
    const wc = data.warningConfig;
    if (wc !== undefined) {
        if (!wc || typeof wc !== 'object' || Array.isArray(wc)) {
            return fail('Geçersiz warningConfig.', 'INVALID_WARNING');
        }
        if (wc.enabled !== undefined && typeof wc.enabled !== 'boolean') {
            return fail('warningConfig.enabled boolean olmalı.', 'INVALID_WARNING');
        }
        if (wc.silentMode !== undefined && typeof wc.silentMode !== 'boolean') {
            return fail('warningConfig.silentMode boolean olmalı.', 'INVALID_WARNING');
        }
        if (wc.durationSeconds !== undefined) {
            if (!Number.isInteger(wc.durationSeconds) || wc.durationSeconds < 0 || wc.durationSeconds > 3600) {
                return fail('warning durationSeconds 0..3600 aralığında olmalı.', 'INVALID_WARNING');
            }
        }
    }
    // K-03/Y-05: kısmi güvenlik politikası tüm kontrolleri atlayamaz;
    // bilinen alanlar boolean olmalı, eksikler motor tarafından merge edilir.
    const sp = data.safetyPolicy;
    if (sp !== undefined) {
        if (!sp || typeof sp !== 'object' || Array.isArray(sp)) {
            return fail('Geçersiz safetyPolicy.', 'INVALID_SAFETY_POLICY');
        }
        for (const key of ['checkUserActivity', 'checkProtectedApps', 'checkFullscreen', 'checkSystemLoad', 'forceCloseApps', 'remoteApprovalRequired']) {
            if (sp[key] !== undefined && typeof sp[key] !== 'boolean') {
                return fail(`safetyPolicy.${key} boolean olmalı.`, 'INVALID_SAFETY_POLICY');
            }
        }
    }
    const sc = data.snoozeConfig;
    if (sc !== undefined) {
        if (!sc || typeof sc !== 'object' || Array.isArray(sc)) {
            return fail('Geçersiz snoozeConfig.', 'INVALID_SNOOZE');
        }
        if (sc.allowed !== undefined && typeof sc.allowed !== 'boolean') {
            return fail('snoozeConfig.allowed boolean olmalı.', 'INVALID_SNOOZE');
        }
        if (sc.maxCount !== undefined && (!Number.isInteger(sc.maxCount) || sc.maxCount < 0 || sc.maxCount > 100)) {
            return fail('snoozeConfig.maxCount 0..100 olmalı.', 'INVALID_SNOOZE');
        }
        if (sc.durationMinutes !== undefined && (!Number.isInteger(sc.durationMinutes) || sc.durationMinutes < 1 || sc.durationMinutes > 1440)) {
            return fail('snoozeConfig.durationMinutes 1..1440 olmalı.', 'INVALID_SNOOZE');
        }
        if (sc.currentCount !== undefined && (!Number.isInteger(sc.currentCount) || sc.currentCount < 0 || sc.currentCount > 1000)) {
            return fail('snoozeConfig.currentCount geçersiz.', 'INVALID_SNOOZE');
        }
    }
    const rec = data.recurrence;
    if (rec !== undefined) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
            return fail('Geçersiz recurrence.', 'INVALID_RECURRENCE');
        }
        if (rec.enabled !== undefined && typeof rec.enabled !== 'boolean') {
            return fail('recurrence.enabled boolean olmalı.', 'INVALID_RECURRENCE');
        }
        if (rec.frequency !== undefined && !RECURRENCE_FREQUENCIES.has(rec.frequency)) {
            return fail('recurrence.frequency geçersiz.', 'INVALID_RECURRENCE');
        }
        if (rec.daysOfWeek !== undefined) {
            if (!Array.isArray(rec.daysOfWeek) || rec.daysOfWeek.length > 7
                || rec.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
                return fail('recurrence.daysOfWeek 0..6 tam sayıları olmalı.', 'INVALID_RECURRENCE');
            }
        }
        if (rec.timeOfDay !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(rec.timeOfDay))) {
            return fail('recurrence.timeOfDay HH:MM olmalı.', 'INVALID_RECURRENCE');
        }
    }
    // WBS-11.1: Zincir halkaları (en fazla 5, geçerli eylem + 1..43200 dk).
    if (data.chain !== undefined) {
        if (!Array.isArray(data.chain) || data.chain.length > 5) {
            return fail('chain en fazla 5 halka içerebilir.', 'INVALID_CHAIN');
        }
        for (const link of data.chain) {
            if (!link || !Object.values(POWER_ACTIONS).includes(link.action)) {
                return fail('Zincir eylemi geçersiz.', 'INVALID_CHAIN');
            }
            if (!Number.isInteger(link.delayMinutes) || link.delayMinutes < 1 || link.delayMinutes > 43200) {
                return fail('Zincir süresi 1..43200 dakika olmalı.', 'INVALID_CHAIN');
            }
        }
    }
    return { ok: true };
}

function validateSnooze(payload) {
    if (!payload || typeof payload !== 'object') return fail('Geçersiz istek.', 'INVALID_BODY');
    const idCheck = validateTaskId(payload.taskId);
    if (!idCheck.ok) return idCheck;
    const minutes = payload.minutes === undefined ? 10 : payload.minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        return fail('Erteleme 1..1440 dakika aralığında olmalı.', 'INVALID_SNOOZE');
    }
    return { ok: true, minutes };
}

function validateWol(payload) {
    if (!payload || typeof payload !== 'object') return fail('Geçersiz istek.', 'INVALID_BODY');
    const { macAddress, broadcastIp, port } = payload;
    if (typeof macAddress !== 'string' || !MAC_RE.test(macAddress.trim())) {
        return fail('Geçersiz MAC adresi (AA:BB:CC:DD:EE:FF biçimi).', 'INVALID_MAC');
    }
    if (broadcastIp !== undefined && (typeof broadcastIp !== 'string' || !HOST_RE.test(broadcastIp.trim()))) {
        return fail('Geçersiz broadcast adresi.', 'INVALID_HOST');
    }
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        return fail('Port 1..65535 aralığında olmalı.', 'INVALID_PORT');
    }
    return { ok: true };
}

const { ALL_LANGUAGE_CODES } = require('../i18n');
const { APP_ICON_IDS } = require('../services/AppIconService');
const SUPPORTED_LANGUAGES = ALL_LANGUAGE_CODES;
const THEME_IDS = [
    'obsidian', 'slate', 'navy', 'blue', 'cyan', 'indigo', 'purple',
    'pink', 'red', 'orange', 'yellow', 'emerald', 'grass', 'lime'
];

const SETTINGS_SCHEMA = {
    autostart: 'boolean',
    theme: ['light', 'dark'],
    themeId: THEME_IDS,
    appIcon: [...APP_ICON_IDS],
    sidebarCollapsed: 'boolean',
    notifications: 'boolean',
    // null = kullanıcı henüz dil seçmedi → ilk çalıştırmada sistem dili algılanır.
    language: { enum: SUPPORTED_LANGUAGES, nullable: true },
    localApiPort: { int: [1, 65535] },
    lanAllowedIps: { ipList: 16 },
    blockRemoteShutdownWhenActive: 'boolean',
    localApiCaFile: { str: [1, 512], nullable: true },
    localApiPfxFile: { str: [1, 512], nullable: true },
    // WP-02.T10/T11: mTLS istemci parmak izi allowlist'i (SHA-256, 64 hex).
    localApiClientFingerprints: { fingerprintList: 32 },
    agentId: { str: [1, 128], nullable: true }, // FAZ B: konsoldaki cihaz id'si
    // WP-04: sır alanları yalnızca SecretStore'da şifreli tutulur; burada
    // yalnızca biçim doğrulanır, diske asla düz metin yazılmaz.
    localApiKeyPem: { str: [1, 65536], nullable: true },
    localApiPfxPassphrase: { str: [1, 1024], nullable: true },
    consoleClientKeyPem: { str: [1, 65536], nullable: true },
    consoleClientPfxPassphrase: { str: [1, 1024], nullable: true },
    // P1-6: ajan→konsol mTLS materyali. `TlsConfig.buildClientOptions` bu
    // alanları okuyor; şemada yoklarsa yazma `UNKNOWN_SETTING` ile reddedilir
    // ve konsol istemci sertifikası hiçbir zaman yapılandırılamazdı.
    consoleClientCertPem: { str: [1, 65536], nullable: true },
    consoleClientCertFile: { str: [1, 512], nullable: true },
    consoleClientKeyFile: { str: [1, 512], nullable: true },
    consoleClientPfxFile: { str: [1, 512], nullable: true },
    consoleClientCaFile: { str: [1, 512], nullable: true },
    consoleClientCaPem: { str: [1, 65536], nullable: true },
    deviceRole: ['workstation', 'server'], // FAZ D: sunucu profilinde uyku/kapatma yasak
    upsEnabled: 'boolean', // FAZ D
    // O-16: NUT protokolüne satır enjeksiyonunu önleyen katı desenler.
    upsHost: { str: [1, 128], pattern: /^[A-Za-z0-9.:\[\]_-]+$/ },
    upsName: { str: [1, 64], pattern: /^[A-Za-z0-9._-]+$/ },
    // P1-9: UPS düşük-batarya otomatik eylemi (varsayılan kapalı).
    upsAutoActionEnabled: 'boolean',
    upsAutoAction: ['hibernate', 'shutdown', 'sleep', 'lock', 'restart'],
    upsCountdownSeconds: { int: [0, 600] },
    assumedOffHours: { num: [0.5, 24], nullable: true }, // FAZ D: beyanlı kapanış varsayımı
    statsEnabled: 'boolean',
    deviceWattage: { int: [5, 2000], nullable: true }, // WBS-E1: null = bilinmiyor
    wattSource: ['unset', 'measured', 'estimated', 'manual', 'legacy'],
    wattMeasuredAt: { int: [0, 9999999999999], nullable: true },
    electricityCostPerKwh: { num: [0, 1000], nullable: true }, // WBS-E1: null = TL'siz mod
    priceSource: ['unset', 'manual', 'legacy', 'default'],
    priceEffectiveFrom: { month: true, nullable: true },
    currency: ['TL', 'USD', 'EUR'],
    bootGuardSeconds: { int: [0, 1800] },
    // L-11: tepsi "AI'yi sustur" penceresi şema doğrulamasından geçer.
    aiSilencedUntil: { int: [0, 9999999999999], nullable: true },
    // Uyku/standby dönüşü politikası: kaçırılan görev çalıştırılsın mı, atlansın mı?
    wakeMode: ['run', 'skip'],
    wakeToleranceMinutes: { int: [0, 1440] },
    // WP-9: Gerçekten kablolanmış kullanıcı tercihleri ve güvenlik politikası ayarları
    closeToTray: 'boolean',
    startMinimized: 'boolean',
    autoMiniWidget: 'boolean',
    defaultAction: ['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout'],
    defaultMinutes: { int: [1, 1440] },
    clockFormat: ['24h', '12h'],
    soundMode: ['auto', 'always', 'never', 'on', 'off'],
    uiDensity: ['comfortable', 'compact'],
    toastPosition: ['bottom-right', 'top-right', 'bottom-left', 'top-left'],
    desktopNotifyStart: 'boolean',
    desktopNotifyWarn: 'boolean',
    desktopNotifySkip: 'boolean',
    prewarnSeconds: { int: [0, 300] },
    quietHoursEnabled: 'boolean',
    quietStart: { str: [5, 5], pattern: /^([01]\d|2[0-3]):([0-5]\d)$/ },
    quietEnd: { str: [5, 5], pattern: /^([01]\d|2[0-3]):([0-5]\d)$/ },
    fallbackAction: ['none', 'hibernate_to_sleep', 'sleep_to_lock', 'retry_once', 'sleep', 'hibernate', 'lock'],
    graceSeconds: { int: [0, 120] },
    protectFullscreen: 'boolean',
    protectActiveIo: 'boolean',
    // P1-6: gerçekten uygulanan güvenlik ayarları.
    forceCloseApps: 'boolean',
    remoteApprovalRequired: 'boolean',
    // P0-3: kullanıcı düzenleyebilir korunan uygulama listesi (.exe adları).
    protectedApps: { processList: 50, nullable: true },
    pinLengthMode: ['flex', '4', '6', '8'],
    autoBackupEnabled: 'boolean',
    shortcuts: { shortcutMap: true }
};

/**
 * WP-10.T4: güvenlik bayrakları normal ayar yolundan YAZILAMAZ; yalnızca
 * PIN'li `security-settings-update` IPC'si ile değişir. Okuma serbesttir.
 */
const SECURITY_SETTINGS_SCHEMA = {
    agentDisabled: 'boolean',
    autonomyMode: ['classic', 'full'],
    automationPaused: 'boolean',
    localApiEnabled: 'boolean',
    lanModeEnabled: 'boolean',
    localApiTlsEnabled: 'boolean',
    localApiTlsStrict: 'boolean',
    localApiRequireClientCert: 'boolean',
    localApiCertFile: { str: [1, 512], nullable: true },
    localApiKeyFile: { str: [1, 512], nullable: true },
    localApiKeyRole: ['viewer', 'operator', 'admin'],
    consoleAgentKey: { str: [8, 256], nullable: true },
    consoleUrl: { consoleUrl: true, nullable: true }
};
const SECURITY_SETTING_KEYS = Object.freeze(Object.keys(SECURITY_SETTINGS_SCHEMA));

function validateSettings(patch, currentSettings = {}, schema = SETTINGS_SCHEMA) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return fail('Geçersiz ayar verisi.', 'INVALID_BODY');
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) return fail('Boş ayar güncellemesi.', 'INVALID_BODY');
    if (keys.length > 20) return fail('Aşırı alan.', 'INVALID_BODY');
    for (const key of keys) {
        const rule = schema[key];
        if (!rule) return fail(`Bilinmeyen ayar: ${key}.`, 'UNKNOWN_SETTING');
        const val = patch[key];
        // WBS-E1: nullable kurallarda null = "bilinmiyor/boş", her zaman geçerli.
        if (val === null && rule && typeof rule === 'object' && rule.nullable) continue;
        if (rule === 'boolean' && typeof val !== 'boolean') return fail(`${key} boolean olmalı.`, 'INVALID_SETTING');
        if (Array.isArray(rule) && !rule.includes(val)) return fail(`${key} geçersiz değer.`, 'INVALID_SETTING');
        if (rule && Array.isArray(rule.enum) && !rule.enum.includes(val)) {
            return fail(`${key} geçersiz değer.`, 'INVALID_SETTING');
        }
        if (rule && rule.int && (!Number.isInteger(val) || val < rule.int[0] || val > rule.int[1])) {
            return fail(`${key} ${rule.int[0]}..${rule.int[1]} aralığında olmalı.`, 'INVALID_SETTING');
        }
        if (rule && rule.num && (typeof val !== 'number' || !Number.isFinite(val) || val < rule.num[0] || val > rule.num[1])) {
            return fail(`${key} aralık dışı.`, 'INVALID_SETTING');
        }
        // WP-01: izinli IP listesi — en fazla N kayıt, her biri IP/CIDR.
        if (rule && rule.ipList) {            if (!Array.isArray(val) || val.length > rule.ipList || val.some(h => !isValidIpOrCidr(h))) {
                return fail(`${key} en fazla ${rule.ipList} geçerli IP/CIDR içermeli.`, 'INVALID_SETTING');
            }
            const normalized = val.map(h => normalizeIpOrCidr(h));
            if (new Set(normalized).size !== normalized.length) {
                return fail(`${key} yinelenen kayıt içeremez.`, 'INVALID_SETTING');
            }
        }
        // P0-3: korunan uygulama listesi — her kayıt <ad>.exe biçiminde, yol yok.
        if (rule && rule.processList) {
            const list = Array.isArray(val) ? val : null;
            const valid = list && list.length <= rule.processList &&
                list.every((n) => typeof n === 'string' && /^[A-Za-z0-9._-]{1,64}\.exe$/i.test(n.trim()));
            if (!valid) {
                return fail(`${key} en fazla ${rule.processList} adet "<ad>.exe" içermeli.`, 'INVALID_SETTING');
            }
        }
        // WP-02.T11: mTLS istemci parmak izi allowlist'i — SHA-256 hex.
        if (rule && rule.fingerprintList) {
            const list = Array.isArray(val) ? val : null;
            const valid = list && list.length <= rule.fingerprintList &&
                list.every((f) => typeof f === 'string' && /^[A-Fa-f0-9]{64}$/.test(f.replace(/:/g, '')));
            if (!valid) {
                return fail(`${key} en fazla ${rule.fingerprintList} SHA-256 parmak izi içermeli.`, 'INVALID_SETTING');
            }
        }
        // WBS-E1: fiyat geçerlilik ayı `YYYY-MM` veya eski `unset` değeri.
        if (rule && rule.month) {
            const ok = typeof val === 'string' && (val === 'unset' || /^\d{4}-(0[1-9]|1[0-2])$/.test(val));
            if (!ok) return fail(`${key} YYYY-MM biçiminde olmalı.`, 'INVALID_SETTING');
        }
        // FAZ B: ajan id'si — kısa görünen ad.
        if (rule && rule.str && (typeof val !== 'string' || val.length < rule.str[0] || val.length > rule.str[1])) {
            return fail(`${key} ${rule.str[0]}..${rule.str[1]} karakter olmalı.`, 'INVALID_SETTING');
        }
        if (rule && rule.pattern && typeof val === 'string' && !rule.pattern.test(val)) {
            return fail(`${key} geçersiz karakter içeriyor.`, 'INVALID_SETTING');
        }
        // FAZ B: konsol URL'si — http(s) şeması zorunlu (ajan outbound bağlanır).
        if (rule && rule.consoleUrl) {
            if (typeof val !== 'string' || val.length > 512) return fail(`${key} en fazla 512 karakter.`, 'INVALID_SETTING');
            let parsed = null;
            try { parsed = new URL(val); } catch (_) { return fail(`${key} geçerli URL olmalı.`, 'INVALID_SETTING'); }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return fail(`${key} http(s) ile başlamalı.`, 'INVALID_SETTING');
            }
        }
        // WP-9: özel klavye kısayol haritası (5 sabit anahtar)
        if (rule && rule.shortcutMap) {
            if (!val || typeof val !== 'object' || Array.isArray(val)) {
                return fail(`${key} geçerli bir kısayol nesnesi olmalı.`, 'INVALID_SETTING');
            }
            const allowedShortcutKeys = new Set(['theme', 'quickstart', 'cancel', 'settings', 'docs']);
            const entries = Object.entries(val);
            if (entries.length === 0 || entries.length > 5) {
                return fail(`${key} 1..5 kısayol içermeli.`, 'INVALID_SETTING');
            }
            for (const [sk, sv] of entries) {
                if (!allowedShortcutKeys.has(sk)) return fail(`${key}.${sk} bilinmeyen kısayol.`, 'INVALID_SETTING');
                if (typeof sv !== 'string' || sv.length < 1 || sv.length > 32 || !/^[A-Za-z0-9+,\-. ]+$/.test(sv)) {
                    return fail(`${key}.${sk} geçersiz tuş kombinasyonu.`, 'INVALID_SETTING');
                }
            }
        }
    }

    const effective = Object.assign({}, currentSettings || {}, patch);
    if (effective.lanModeEnabled === true) {
        const list = Array.isArray(effective.lanAllowedIps) ? effective.lanAllowedIps : [];
        if (list.length === 0) {
            return fail('LAN modu için en az bir IP/CIDR allowlist kaydı gerekli.', 'LAN_ALLOWLIST_REQUIRED');
        }
        if (effective.localApiTlsEnabled !== true) {
            // WP-02.T5 / H-03: LAN'da düz HTTP imkânsız; ayar yazılmaz.
            return fail('LAN modu TLS olmadan etkinleştirilemez.', 'LAN_REQUIRES_TLS');
        }
        {
            const hasCert = !!(effective.localApiCertPem || effective.localApiCertFile || effective.localApiPfxFile);
            const hasKey = !!(effective.localApiKeyPem || effective.localApiKeyFile || effective.localApiPfxFile);
            if (!hasCert || !hasKey) {
                return fail('LAN + TLS için sertifika ve özel anahtar gerekli.', 'TLS_MATERIAL_REQUIRED');
            }
        }
    }
    // WP-10: mTLS ve sıkı TLS, TLS olmadan anlamsızdır; sessiz no-op kabul edilmez.
    if (effective.localApiTlsEnabled !== true) {
        if (effective.localApiRequireClientCert === true) {
            return fail('mTLS için önce TLS etkinleştirilmeli.', 'MTLS_REQUIRES_TLS');
        }
        if (effective.localApiTlsStrict === true) {
            return fail('Sıkı TLS doğrulaması için önce TLS etkinleştirilmeli.', 'TLS_STRICT_REQUIRES_TLS');
        }
    }
    return { ok: true };
}

/** WP-10.T4: yalnızca güvenlik bayrakları için, aynı çapraz-alan kurallarıyla. */
function validateSecuritySettings(patch, currentSettings = {}) {
    return validateSettings(patch, currentSettings, SECURITY_SETTINGS_SCHEMA);
}

function validateWebhooks(list) {
    if (!Array.isArray(list)) return fail('Webhook listesi dizi olmalı.', 'INVALID_BODY');
    if (list.length > MAX_WEBHOOKS) return fail(`En fazla ${MAX_WEBHOOKS} webhook.`, 'INVALID_WEBHOOK');
    for (const hook of list) {
        if (!hook || typeof hook !== 'object') return fail('Geçersiz webhook kaydı.', 'INVALID_WEBHOOK');
        if (typeof hook.url !== 'string' || hook.url.length > 2048) return fail('Geçersiz webhook URL.', 'INVALID_WEBHOOK');
        // WP-12.T1: yalnızca https + 443/8443 + userinfo yok + IDN normalize.
        const urlCheck = validateUrl(hook.url);
        if (!urlCheck.ok) {
            return fail(`Geçersiz webhook URL (${urlCheck.reason}).`, 'INVALID_WEBHOOK');
        }
        if (hook.events !== undefined) {
            if (!Array.isArray(hook.events)) return fail('events dizi olmalı.', 'INVALID_WEBHOOK');
            for (const ev of hook.events) {
                if (!WEBHOOK_EVENTS.has(ev)) return fail(`Bilinmeyen olay: ${ev}.`, 'INVALID_WEBHOOK');
            }
        }
        if (hook.enabled !== undefined && typeof hook.enabled !== 'boolean') {
            return fail('enabled boolean olmalı.', 'INVALID_WEBHOOK');
        }
        if (hook.secret !== undefined && (typeof hook.secret !== 'string' || hook.secret.length > 512)) {
            return fail('secret en fazla 512 karakter.', 'INVALID_WEBHOOK');
        }
    }
    return { ok: true };
}

// WBS-11.2: İptal PIN'i 4-8 hane.
function validateCancelPin(pin) {
    const { PinGuard } = require('./pinGuard');
    if (!PinGuard.validFormat(pin)) {
        return fail('PIN 4-8 haneli sayı olmalı.', 'INVALID_PIN');
    }
    return { ok: true };
}

module.exports = {
    validateScheduleAction,
    validateTaskId,
    validateTaskData,
    validateSnooze,
    validateWol,
    validateSettings,
    validateSecuritySettings,
    validateWebhooks,
    validateCancelPin,
    isValidIpOrCidr,
    normalizeIpOrCidr,
    canonicalProcessName,
    validateCondition,
    SECURITY_SETTING_KEYS,
    MAX_DURATION_MS
};
