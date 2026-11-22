'use strict';

/**
 * src/cli/commands.js
 *
 * Full-parity CLI command catalog - PURE module (zero network, zero I/O).
 * Maps every Local REST API capability into clean, validated CLI commands.
 */

const {
    formatStatus,
    formatTasks,
    formatTemplates,
    formatHealth,
    formatCloudStatus,
    formatSecurityStatus,
    formatAiStatus
} = require('./formatters');

const POWER_ACTIONS = ['lock', 'signout', 'restart', 'sleep', 'hibernate', 'shutdown'];

function parseScalarValue(raw) {
    if (typeof raw !== 'string') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
        try { return JSON.parse(raw); } catch (_) { return raw; }
    }
    return raw;
}

function parseJsonBodyFlag(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
}

function parseTargetTimeMs(raw) {
    if (!raw) return null;
    if (/^\d{10,15}$/.test(raw)) return Number(raw);
    if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw)) {
        const [hh, mm] = raw.split(':').map(Number);
        const now = new Date();
        const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
        if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
        return target.getTime();
    }
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? Math.floor(ts) : null;
}

function buildTaskCreateBody(flags) {
    if (flags['json-body']) {
        return parseJsonBodyFlag(flags['json-body']) || {};
    }
    const payload = {
        action: flags.action || 'shutdown',
        ...(flags.name ? { name: flags.name } : {})
    };
    const conditions = [];
    const stableSec = flags['stable-sec'] !== undefined ? Number(flags['stable-sec']) : undefined;
    if (flags.process) conditions.push({ type: 'process_running', processName: flags.process, ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });
    if (flags['cpu-below'] !== undefined) conditions.push({ type: 'cpu_usage', thresholdPercent: Number(flags['cpu-below']), ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });
    if (flags['net-below'] !== undefined) conditions.push({ type: 'network_speed', thresholdKbps: Number(flags['net-below']), ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });
    if (flags['disk-below'] !== undefined) conditions.push({ type: 'disk_activity', thresholdKbps: Number(flags['disk-below']), ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });
    if (flags['idle-sec'] !== undefined) conditions.push({ type: 'user_idle', idleSeconds: Number(flags['idle-sec']) });
    if (flags['battery-below'] !== undefined) conditions.push({ type: 'battery_level', belowPercent: Number(flags['battery-below']) });
    if (flags['dir-idle']) conditions.push({ type: 'directory_idle', dirPath: flags['dir-idle'], ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });
    if (flags['file-stable']) conditions.push({ type: 'file_stable', filePath: flags['file-stable'], ...(stableSec !== undefined ? { stableSeconds: stableSec } : {}) });

    if (conditions.length > 0) {
        payload.trigger = { type: 'composite' };
        payload.conditionGroup = {
            operator: flags.operator === 'OR' ? 'OR' : 'AND',
            conditions,
            ...(stableSec !== undefined ? { stabilitySeconds: stableSec } : {})
        };
    } else if (flags.recurrence && flags.at) {
        payload.trigger = { type: 'scheduled_time' };
        payload.recurrence = {
            enabled: true,
            frequency: flags.recurrence,
            timeOfDay: flags.at,
            ...(flags.days ? { daysOfWeek: String(flags.days).split(',').map(Number) } : {})
        };
    } else if (flags.at) {
        const targetTime = parseTargetTimeMs(flags.at);
        payload.trigger = { type: 'scheduled_time', targetTime };
    } else {
        const durationMs = flags.durationMs !== undefined
            ? Number(flags.durationMs)
            : (flags.minutes !== undefined ? Number(flags.minutes) * 60000 : undefined);
        payload.trigger = { type: 'duration', ...(Number.isFinite(durationMs) ? { durationMs } : {}) };
    }

    if (flags['warn-sec'] !== undefined) {
        payload.warningConfig = { enabled: Number(flags['warn-sec']) > 0, durationSeconds: Number(flags['warn-sec']) };
    }
    return payload;
}

const COMMANDS = {
    // --- Core Status & Tasks ---
    status: {
        method: 'GET',
        path: () => '/status',
        body: () => null,
        format: (r) => formatStatus(r.body),
        usage: 'Durum ve surum bilgisi'
    },
    tasks: {
        method: 'GET',
        path: (i) => {
            const params = new URLSearchParams();
            if (i.flags.limit !== undefined) params.set('limit', String(i.flags.limit));
            if (i.flags.offset !== undefined) params.set('offset', String(i.flags.offset));
            if (i.flags.status !== undefined) params.set('status', String(i.flags.status));
            const qs = params.toString();
            return qs ? `/tasks?${qs}` : '/tasks';
        },
        body: () => null,
        format: (r) => formatTasks(r.body),
        usage: 'Gorevleri listeler (--limit, --offset, --status)'
    },
    timer: {
        method: 'POST',
        path: () => '/tasks/timer',
        body: (i) => {
            const raw = i.flags.durationMs !== undefined
                ? i.flags.durationMs
                : (i.flags.minutes !== undefined ? Number(i.flags.minutes) * 60000 : undefined);
            const durationMs = raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
            return {
                action: i.flags.action || 'shutdown',
                ...(Number.isFinite(durationMs) ? { durationMs } : {}),
                ...(i.flags.name ? { name: i.flags.name } : {})
            };
        },
        format: (r) => r.body,
        usage: 'Sureli gorev: --action <eylem> --durationMs <ms> | --minutes <dk> [--name <ad>]'
    },
    'task-create': {
        method: 'POST',
        path: () => '/tasks',
        body: (i) => buildTaskCreateBody(i.flags),
        format: (r) => r.body,
        usage: 'Tam otomasyon gorevi (--action, --minutes|--at, --recurrence, --process, --cpu-below, --net-below, --disk-below, --idle-sec, --battery-below, --dir-idle, --file-stable, --json-body)'
    },
    cancel: {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/cancel`,
        body: (i) => (i.flags.pin ? { pin: i.flags.pin } : null),
        format: (r) => r.body,
        usage: 'Gorevi iptal eder: --id <taskId> [--pin <pin>]'
    },
    pause: {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/pause`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Gorevi duraklatir: --id <taskId>'
    },
    resume: {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/resume`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Duraklatilmis gorevi surdurur: --id <taskId>'
    },
    snooze: {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/snooze`,
        body: (i) => ({ minutes: i.flags.minutes !== undefined ? Number(i.flags.minutes) : 10 }),
        format: (r) => r.body,
        usage: 'Gorevi erteler: --id <taskId> [--minutes 10]'
    },
    'run-now': {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/run-now`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Kayitli gorevi hemen guvenli hattan calistirir: --id <taskId>'
    },
    'delete-task': {
        method: 'DELETE',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Gorev kaydini siler: --id <taskId>'
    },
    'clear-finished': {
        method: 'POST',
        path: () => '/tasks/clear-finished',
        body: () => null,
        format: (r) => r.body,
        usage: 'Tamamlanmis/iptal edilmis gorevleri temizler'
    },
    'pause-all': {
        method: 'POST',
        path: () => '/tasks/pause-all',
        body: (i) => ({
            ...(i.flags.on ? { paused: true } : (i.flags.off ? { paused: false } : {})),
            ...(i.flags.pin ? { pin: i.flags.pin } : {})
        }),
        format: (r) => r.body,
        usage: 'Tum otomasyonu duraklat/surdur ([--on | --off] [--pin <pin>])'
    },

    // --- Active Warning Controls ---
    warning: {
        method: 'GET',
        path: () => '/warning',
        body: () => null,
        format: (r) => r.body,
        usage: 'Aktif geri sayim uyari durumunu gosterir'
    },
    'warning-confirm': {
        method: 'POST',
        path: () => '/warning/confirm',
        body: (i) => (i.flags.id ? { taskId: i.flags.id } : {}),
        format: (r) => r.body,
        usage: 'Aktif geri sayim uyarisini hemen onaylar ([--id <taskId>])'
    },
    'warning-snooze': {
        method: 'POST',
        path: () => '/warning/snooze',
        body: (i) => ({
            ...(i.flags.minutes !== undefined ? { minutes: Number(i.flags.minutes) } : { minutes: 10 }),
            ...(i.flags.pin ? { pin: i.flags.pin } : {})
        }),
        format: (r) => r.body,
        usage: 'Aktif uyariyi erteler ([--minutes 10] [--pin <pin>])'
    },
    'warning-cancel': {
        method: 'POST',
        path: () => '/warning/cancel',
        body: (i) => (i.flags.pin ? { pin: i.flags.pin } : {}),
        format: (r) => r.body,
        usage: 'Aktif uyariyi ve gorevi iptal eder ([--pin <pin>])'
    },

    // --- Templates ---
    templates: {
        method: 'GET',
        path: (i) => (i.flags['include-hidden'] ? '/templates?includeHidden=1' : '/templates'),
        body: () => null,
        format: (r) => formatTemplates(r.body),
        usage: 'Otomasyon sablonlarini listeler ([--include-hidden])'
    },
    'template-save': {
        method: 'POST',
        path: () => '/templates',
        body: (i) => {
            if (i.flags['json-body']) return parseJsonBodyFlag(i.flags['json-body']) || {};
            const durationMs = i.flags.minutes !== undefined ? Number(i.flags.minutes) * 60000 : 1800000;
            return {
                ...(i.flags.id ? { id: i.flags.id } : {}),
                name: i.flags.name || '',
                action: i.flags.action || 'shutdown',
                ...(i.flags.description ? { description: i.flags.description } : {}),
                trigger: { type: 'duration', durationMs }
            };
        },
        format: (r) => r.body,
        usage: 'Sablon olusturur/gunceller (--name, --action, --minutes | --json-body)'
    },
    'template-run': {
        method: 'POST',
        path: (i) => `/templates/${encodeURIComponent(i.flags.id || '')}/run`,
        body: (i) => (i.flags.name ? { name: i.flags.name } : {}),
        format: (r) => r.body,
        usage: 'Sablondan canli gorev baslatir: --id <tplId> [--name <ad>]'
    },
    'template-delete': {
        method: 'DELETE',
        path: (i) => `/templates/${encodeURIComponent(i.flags.id || '')}`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Kullanici sablonunu siler veya hazir sablonu gizler: --id <tplId>'
    },
    'template-reset': {
        method: 'POST',
        path: (i) => `/templates/${encodeURIComponent(i.flags.id || '')}/reset`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Hazir sablonu varsayilana dondurur: --id <tplId>'
    },
    'templates-restore': {
        method: 'POST',
        path: () => '/templates/restore-defaults',
        body: (i) => ({ resetEdits: Boolean(i.flags['reset-edits']) }),
        format: (r) => r.body,
        usage: 'Gizlenen hazir sablonlari geri yukler ([--reset-edits])'
    },

    // --- Settings & Security ---
    settings: {
        method: 'GET',
        path: () => '/settings',
        body: () => null,
        format: (r) => r.body,
        usage: 'Tum uygulamanin maskelenmis ayarlarini okur'
    },
    'settings-set': {
        method: 'PATCH',
        path: () => '/settings',
        body: (i) => (i.flags['json-body']
            ? (parseJsonBodyFlag(i.flags['json-body']) || {})
            : { [i.flags.key]: parseScalarValue(i.flags.value) }),
        format: (r) => r.body,
        usage: 'Ayar gunceller (admin): --key <ad> --value <deger> | --json-body <json>'
    },
    'security-status': {
        method: 'GET',
        path: () => '/security/status',
        body: () => null,
        format: (r) => formatSecurityStatus(r.body),
        usage: 'TLS/mTLS, PIN, otonomi ve denetim guvenlik ozeti'
    },
    'security-set': {
        method: 'PATCH',
        path: () => '/settings/security',
        body: (i) => (i.flags['json-body']
            ? (parseJsonBodyFlag(i.flags['json-body']) || {})
            : { [i.flags.key]: parseScalarValue(i.flags.value) }),
        format: (r) => r.body,
        usage: 'Guvenlik bayragi gunceller (admin): --key <ad> --value <deger> | --json-body <json>'
    },
    'cancel-pin-status': {
        method: 'GET',
        path: () => '/security/cancel-pin',
        body: () => null,
        format: (r) => r.body,
        usage: 'Iptal PIN kilidinin kurulu olup olmadigini gosterir'
    },
    'cancel-pin-set': {
        method: 'PUT',
        path: () => '/security/cancel-pin',
        body: (i) => ({
            pin: i.flags.pin,
            ...(i.flags['current-pin'] ? { currentPin: i.flags['current-pin'] } : {})
        }),
        format: (r) => r.body,
        usage: 'Argon2id Iptal PIN kurar/degistirir (admin): --pin <4|6|8 hane> [--current-pin <eskiPin>]'
    },
    'cancel-pin-clear': {
        method: 'DELETE',
        path: () => '/security/cancel-pin',
        body: (i) => ({
            ...(i.flags['current-pin'] ? { currentPin: i.flags['current-pin'] } : (i.flags.pin ? { currentPin: i.flags.pin } : {}))
        }),
        format: (r) => r.body,
        usage: 'Iptal PIN kilidini kaldirir (admin): [--current-pin <pin>]'
    },
    'rotate-key': {
        method: 'POST',
        path: () => '/security/rotate-key',
        body: (i) => ({
            ...(i.flags.role ? { role: i.flags.role } : {}),
            ...(i.flags['no-save-profile'] ? { saveProfile: false } : {})
        }),
        format: (r) => r.body,
        usage: 'Local API anahtarini yeniler ve cli-connection.json dosyasini gunceller (admin)'
    },
    'export-settings': {
        method: 'GET',
        path: () => '/export/settings',
        body: () => null,
        format: (r) => r.body,
        usage: 'Sirlari haric tutarak ayarlari JSON olarak disa aktarir (admin)'
    },
    'import-settings': {
        method: 'POST',
        path: () => '/import/settings',
        body: (i) => parseJsonBodyFlag(i.flags['json-body']) || {},
        format: (r) => r.body,
        usage: 'JSON ayar yedegini ice aktarir (admin): --json-body <json>'
    },
    'export-templates': {
        method: 'GET',
        path: () => '/export/templates',
        body: () => null,
        format: (r) => r.body,
        usage: 'Kullanici sablonlarini JSON olarak disa aktarir'
    },
    'import-templates': {
        method: 'POST',
        path: () => '/import/templates',
        body: (i) => parseJsonBodyFlag(i.flags['json-body']) || {},
        format: (r) => r.body,
        usage: 'JSON sablon yedegini ice aktarir: --json-body <json>'
    },

    // --- History, Statistics, Health, Hardware, Console ---
    history: {
        method: 'GET',
        path: (i) => {
            const p = new URLSearchParams();
            if (i.flags.limit !== undefined) p.set('limit', String(i.flags.limit));
            if (i.flags.action) p.set('action', String(i.flags.action));
            return p.toString() ? `/history?${p}` : '/history';
        },
        body: () => null,
        format: (r) => r.body,
        usage: 'Gorev yurutme gecmisi (--limit, --action)'
    },
    'history-clear': {
        method: 'DELETE',
        path: () => '/history',
        body: () => null,
        format: (r) => r.body,
        usage: 'Gorev gecmisini temizler (admin)'
    },
    stats: {
        method: 'GET',
        path: (i) => (i.flags.days ? `/statistics?days=${encodeURIComponent(i.flags.days)}` : '/statistics'),
        body: () => null,
        format: (r) => r.body,
        usage: 'Enerji tasarrufu ve kWh/maliyet/CO2 istatistikleri ([--days N])'
    },
    health: {
        method: 'GET',
        path: () => '/health',
        body: () => null,
        format: (r) => formatHealth(r.body),
        usage: 'Yerel guvenilirlik ve basari orani ozeti'
    },
    'device-estimate': {
        method: 'POST',
        path: () => '/device/estimate',
        body: (i) => ({ apply: Boolean(i.flags.apply) }),
        format: (r) => r.body,
        usage: 'Donanim watt profilini hesaplar ([--apply])'
    },
    'console-sync': {
        method: 'POST',
        path: () => '/console/sync',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Kurumsal konsol ile manuel esitleme ve emir bosaltma baslatir (admin)'
    },

    // --- WoL, Webhooks, UPS ---
    'wol-devices': {
        method: 'GET',
        path: () => '/wol/devices',
        body: () => null,
        format: (r) => r.body,
        usage: 'Kayitli Wake-on-LAN cihazlarini listeler'
    },
    'wol-devices-save': {
        method: 'PUT',
        path: () => '/wol/devices',
        body: (i) => {
            if (i.flags['json-body']) return parseJsonBodyFlag(i.flags['json-body']) || {};
            return {
                devices: [{
                    name: i.flags.name || 'Device',
                    macAddress: i.flags.mac,
                    broadcastIp: i.flags.broadcast || '255.255.255.255',
                    port: i.flags.port ? Number(i.flags.port) : 9
                }]
            };
        },
        format: (r) => r.body,
        usage: 'Wake-on-LAN cihaz profillerini kaydeder (--json-body <json> | --mac <MAC> [--name <ad>])'
    },
    'wol-send': {
        method: 'POST',
        path: () => '/wol/send',
        body: (i) => ({
            ...(i.flags.mac ? { macAddress: i.flags.mac } : {}),
            ...(i.flags.id ? { deviceId: i.flags.id } : {}),
            ...(i.flags.name ? { name: i.flags.name } : {}),
            ...(i.flags.broadcast ? { broadcastIp: i.flags.broadcast } : {}),
            ...(i.flags.port ? { port: Number(i.flags.port) } : {})
        }),
        format: (r) => r.body,
        usage: 'Wake-on-LAN sihirli paketi gonderir (--mac <MAC> | --id <devId> [--broadcast <ip>] [--port 9])'
    },
    webhooks: {
        method: 'GET',
        path: () => '/webhooks',
        body: () => null,
        format: (r) => r.body,
        usage: 'Kayitli HTTPS webhook listesini okur (admin)'
    },
    'webhooks-save': {
        method: 'PUT',
        path: () => '/webhooks',
        body: (i) => {
            if (i.flags['json-body']) return parseJsonBodyFlag(i.flags['json-body']) || {};
            return {
                webhooks: [{
                    url: i.flags.url,
                    ...(i.flags.secret ? { hmacSecret: i.flags.secret } : {}),
                    enabled: true
                }]
            };
        },
        format: (r) => r.body,
        usage: 'HTTPS webhook listesini DPAPI sifreli kaydeder (admin): --json-body <json> | --url <https://...> [--secret <hmac>]'
    },
    'webhook-test': {
        method: 'POST',
        path: () => '/webhooks/test',
        body: (i) => ({
            url: i.flags.url,
            ...(i.flags.secret ? { hmacSecret: i.flags.secret } : {}),
            enabled: true
        }),
        format: (r) => r.body,
        usage: 'HTTPS webhook ucuna canli test gonderir (admin): --url <https://...> [--secret <hmac>]'
    },
    'ups-test': {
        method: 'POST',
        path: () => '/ups/test',
        body: (i) => ({
            ...(i.flags.host ? { host: i.flags.host } : {}),
            ...(i.flags.ups ? { ups: i.flags.ups } : {})
        }),
        format: (r) => r.body,
        usage: 'NUT UPS sunucusunu test eder ([--host 127.0.0.1] [--ups ups])'
    },

    // --- Cloud Sync ---
    'cloud-status': {
        method: 'GET',
        path: () => '/cloud/status',
        body: () => null,
        format: (r) => formatCloudStatus(r.body),
        usage: 'OneDrive / coklu bulut yedekleme durumunu gosterir'
    },
    'cloud-connect': {
        method: 'POST',
        path: () => '/cloud/connect',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Bulut esitlemeyi baglar (admin)'
    },
    'cloud-disconnect': {
        method: 'POST',
        path: () => '/cloud/disconnect',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Bulut esitleme baglantisini keser (admin)'
    },
    'cloud-sync': {
        method: 'POST',
        path: () => '/cloud/sync',
        body: (i) => ({ force: Boolean(i.flags.force) }),
        format: (r) => r.body,
        usage: 'Simdi bulut yedegi esitler ([--force])'
    },
    'cloud-restore': {
        method: 'POST',
        path: () => '/cloud/restore',
        body: (i) => ({ connect: Boolean(i.flags.connect) }),
        format: (r) => r.body,
        usage: 'En son gecerli bulut yedeginden geri yukler (admin, [--connect])'
    },
    'cloud-provider': {
        method: 'POST',
        path: () => '/cloud/provider',
        body: (i) => ({ providerId: i.flags.provider }),
        format: (r) => r.body,
        usage: 'Bulut saglayicisini degistirir (admin): --provider <onedrive|googledrive|dropbox|icloud|default>'
    },
    'cloud-autosync': {
        method: 'PATCH',
        path: () => '/cloud/autosync',
        body: (i) => ({ enabled: Boolean(i.flags.on) }),
        format: (r) => r.body,
        usage: 'Otomatik bulut esitlemeyi acar/kapatir (admin): --on | --off'
    },
    'cloud-folder': {
        method: 'PUT',
        path: () => '/cloud/folder',
        body: (i) => ({ dirPath: i.flags.dir }),
        format: (r) => r.body,
        usage: 'Ozel bulut yedekleme klasoru secer (admin): --dir <tamYol>'
    },
    'cloud-folder-reset': {
        method: 'POST',
        path: () => '/cloud/folder/reset',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Bulut klasorunu varsayilana dondurur (admin)'
    },
    'cloud-dismiss-recovery': {
        method: 'POST',
        path: () => '/cloud/dismiss-recovery',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Temiz kurulum bulut kurtarma uyarisini kapatir (admin)'
    },

    // --- Offline AI, Models, Insights, Docs RAG, Diagnostics, Updates ---
    'ai-status': {
        method: 'GET',
        path: () => '/ai/status',
        body: () => null,
        format: (r) => formatAiStatus(r.body),
        usage: 'Yerel AI LLM/STT model, RAM ve indirme durumunu gosterir'
    },
    'ai-model-download': {
        method: 'POST',
        path: () => '/ai/model/download',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'SHA-256 dogrulamali yerel GGUF/Whisper model indirmesini baslatir (admin)'
    },
    'ai-model-load': {
        method: 'POST',
        path: () => '/ai/model/load',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Yerel GGUF AI modelini bellege yukler (admin)'
    },
    'ai-model-unload': {
        method: 'POST',
        path: () => '/ai/model/unload',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Yerel GGUF AI modelini bellekten bosaltir (admin)'
    },
    'ai-parse': {
        method: 'POST',
        path: () => '/ai/parse',
        body: (i) => ({ text: i.flags.text, execute: Boolean(i.flags.execute) }),
        format: (r) => r.body,
        usage: 'Dogal dil komutunu cevirir: --text "<komut>" [--execute]'
    },
    'ai-assist': {
        method: 'POST',
        path: () => '/ai/assist',
        body: (i) => ({ text: i.flags.text, ...(i.flags.lang ? { lang: i.flags.lang } : {}) }),
        format: (r) => r.body,
        usage: 'Yerel coklu-ajan asistana sorar: --text "<soru/komut>" [--lang tr]'
    },
    'ai-diagnose': {
        method: 'POST',
        path: () => '/ai/diagnose',
        body: (i) => ({ ...(i.flags.reason ? { reason: i.flags.reason } : {}), ...(i.flags.lang ? { lang: i.flags.lang } : {}) }),
        format: (r) => r.body,
        usage: '"Neden kapanmadi?" teshisi calistirir ([--reason "..."] [--lang tr])'
    },
    'ai-energy': {
        method: 'GET',
        path: (i) => (i.flags.lang ? `/ai/energy?lang=${encodeURIComponent(i.flags.lang)}` : '/ai/energy'),
        body: () => null,
        format: (r) => r.body,
        usage: 'Yerel AI enerji tasarrufu danismani icgorusu ([--lang tr])'
    },
    'ai-suggest': {
        method: 'GET',
        path: (i) => (i.flags.lang ? `/ai/suggest?lang=${encodeURIComponent(i.flags.lang)}` : '/ai/suggest'),
        body: () => null,
        format: (r) => r.body,
        usage: 'Gecmise dayali yerel AI otomasyon onerisi ([--lang tr])'
    },
    'ai-dismiss': {
        method: 'POST',
        path: () => '/ai/dismiss-suggestion',
        body: (i) => ({ topic: i.flags.topic }),
        format: (r) => r.body,
        usage: 'AI oneri konusunu kapatir: --topic <konu>'
    },
    'docs-search': {
        method: 'GET',
        path: (i) => {
            const p = new URLSearchParams({ q: String(i.flags.query || '') });
            if (i.flags.lang) p.set('lang', String(i.flags.lang));
            return `/docs/search?${p}`;
        },
        body: () => null,
        format: (r) => r.body,
        usage: 'Cevrimdisi dokuman RAG aramasi: --query "<arama>" [--lang tr]'
    },
    diagnostics: {
        method: 'GET',
        path: () => '/diagnostics',
        body: () => null,
        format: (r) => r.body,
        usage: 'Maskelenmis tanilama ozetini ve loglari okur (admin)'
    },
    'diagnostics-clear': {
        method: 'DELETE',
        path: () => '/diagnostics',
        body: () => null,
        format: (r) => r.body,
        usage: 'Tanilama kayitlarini temizler (admin)'
    },
    'support-bundle': {
        method: 'POST',
        path: () => '/diagnostics/bundle',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Maskelenmis ZIP destek paketi olusturur (admin)'
    },
    updates: {
        method: 'GET',
        path: () => '/updates/status',
        body: () => null,
        format: (r) => r.body,
        usage: 'Guncelleme durumunu gosterir'
    },
    'updates-check': {
        method: 'POST',
        path: () => '/updates/check',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Yeni surum denetler (admin)'
    },
    'updates-download': {
        method: 'POST',
        path: () => '/updates/download',
        body: () => ({}),
        format: (r) => r.body,
        usage: 'Yeni surumu arka planda indirir (admin, Direct NSIS)'
    },
    'updates-install-on-quit': {
        method: 'PATCH',
        path: () => '/updates/install-on-quit',
        body: (i) => ({ enabled: Boolean(i.flags.on) }),
        format: (r) => r.body,
        usage: 'Cikista otomatik guncelleme bayragini ayarlar (admin): --on | --off'
    },
    'updates-install': {
        method: 'POST',
        path: () => '/updates/install',
        body: (i) => (i.flags.pin ? { pin: i.flags.pin } : {}),
        format: (r) => r.body,
        usage: 'Indirilmis guncellemeyi simdi kurar (admin, [--pin <pin>])'
    },

    // --- Enterprise (Existing + Full CRUD) ---
    inventory: {
        method: 'GET',
        path: () => '/inventory',
        body: () => null,
        format: (r) => r.body,
        usage: 'Cihaz donanim ve guc envanteri'
    },
    exemptions: {
        method: 'GET',
        path: () => '/exemptions',
        body: () => null,
        format: (r) => r.body,
        usage: 'Guvenlik muafiyetlerini listeler'
    },
    'exemption-add': {
        method: 'POST',
        path: () => '/exemptions',
        body: (i) => {
            if (i.flags['json-body']) return parseJsonBodyFlag(i.flags['json-body']) || {};
            const hours = Number(i.flags.hours) || 24;
            return {
                deviceId: i.flags.device || 'local',
                policyId: null,
                from: new Date().toISOString(),
                to: new Date(Date.now() + hours * 3600000).toISOString(),
                reason: i.flags.reason || 'CLI exemption',
                approvedBy: i.flags['approved-by'] || 'cli-admin'
            };
        },
        format: (r) => r.body,
        usage: 'Muafiyet ekler (admin): --device <id> --reason <sebep> --approved-by <onay> [--hours 24]'
    },
    'exemption-delete': {
        method: 'DELETE',
        path: (i) => `/exemptions/${encodeURIComponent(i.flags.id || '')}`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Muafiyeti kaldirir (admin): --id <exemptionId>'
    },
    'maintenance-windows': {
        method: 'GET',
        path: () => '/maintenance-windows',
        body: () => null,
        format: (r) => r.body,
        usage: 'Bakim pencerelerini listeler'
    },
    'window-add': {
        method: 'POST',
        path: () => '/maintenance-windows',
        body: (i) => (i.flags['json-body']
            ? (parseJsonBodyFlag(i.flags['json-body']) || {})
            : {
                name: i.flags.name || 'Maintenance',
                days: i.flags.days ? String(i.flags.days).split(',').map(Number) : [0, 6],
                start: i.flags.start || '02:00',
                end: i.flags.end || '04:00'
            }),
        format: (r) => r.body,
        usage: 'Bakim penceresi ekler (admin): --name <ad> --days <0,6> --start <HH:MM> --end <HH:MM>'
    },
    'window-delete': {
        method: 'DELETE',
        path: (i) => `/maintenance-windows/${encodeURIComponent(i.flags.id || '')}`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Bakim penceresini siler (admin): --id <windowId>'
    },
    audit: {
        method: 'GET',
        path: (i) => {
            const params = new URLSearchParams();
            if (i.flags.limit !== undefined) params.set('limit', String(i.flags.limit));
            if (i.flags.beforeSeq !== undefined) params.set('beforeSeq', String(i.flags.beforeSeq));
            if (i.flags.verify) params.set('verify', '1');
            const qs = params.toString();
            return qs ? `/audit?${qs}` : '/audit';
        },
        body: () => null,
        format: (r) => r.body,
        usage: 'Denetim gunlugu (--limit, --beforeSeq, --verify)'
    },
    'audit-verify': {
        method: 'GET',
        path: () => '/audit/verify',
        body: () => null,
        format: (r) => r.body,
        usage: 'Denetim zinciri butunlugunu dogrular'
    },
    orders: {
        method: 'GET',
        path: () => '/orders/pending',
        body: () => null,
        format: (r) => r.body,
        usage: 'Bekleyen konsol emirlerini listeler'
    },
    'order-submit': {
        method: 'POST',
        path: () => '/orders',
        body: (i) => parseJsonBodyFlag(i.flags['json-body']) || {},
        format: (r) => r.body,
        usage: 'Imzali kurumsal konsol emri gonderir: --json-body <json>'
    }
};

const FLAG_WITH_VALUE = new Set([
    'limit', 'offset', 'beforeSeq', 'action', 'durationMs', 'minutes', 'name', 'id', 'status',
    'at', 'recurrence', 'days', 'process', 'cpu-below', 'net-below', 'disk-below', 'idle-sec',
    'battery-below', 'dir-idle', 'file-stable', 'stable-sec', 'operator', 'warn-sec', 'json-body',
    'description', 'key', 'value', 'mac', 'broadcast', 'port', 'url', 'secret', 'host', 'ups',
    'provider', 'text', 'reason', 'lang', 'query', 'device', 'approved-by', 'hours', 'start', 'end',
    'pin', 'current-pin', 'topic', 'dir', 'role'
]);
const BOOLEAN_FLAGS = new Set([
    'verify', 'help', 'json', 'on', 'off', 'include-hidden', 'reset-edits', 'force', 'connect',
    'execute', 'apply', 'no-save-profile'
]);

const ID_REQUIRED_COMMANDS = new Set([
    'cancel', 'pause', 'resume', 'snooze', 'run-now', 'delete-task',
    'template-run', 'template-delete', 'template-reset',
    'exemption-delete', 'window-delete'
]);

function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const flags = {};
    const errors = [];
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (typeof token !== 'string' || token.length === 0) continue;
        if (token === '--help' || token === '-h') { flags.help = true; continue; }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
            if (FLAG_WITH_VALUE.has(name)) {
                let value;
                if (eq !== -1) {
                    value = token.slice(eq + 1);
                } else {
                    const next = args[i + 1];
                    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
                        errors.push(`--${name} için değer gerekli`);
                        continue;
                    }
                    value = next;
                    i += 1;
                }
                if (value === '') { errors.push(`--${name} boş olamaz`); continue; }
                flags[name] = value;
            } else if (BOOLEAN_FLAGS.has(name)) {
                flags[name] = eq === -1 ? true : token.slice(eq + 1) !== 'false';
            } else {
                errors.push(`bilinmeyen bayrak: --${name}`);
            }
            continue;
        }
        positional.push(token);
    }

    const command = positional[0] || 'status';
    if (positional.length > 1) errors.push(`fazla argüman: ${positional.slice(1).join(' ')}`);
    return { command, flags, errors };
}

function buildRequest(parsed) {
    const { command, flags } = parsed || {};
    if (POWER_ACTIONS.includes(command)) {
        return { method: 'POST', path: `/power/${command}`, body: null, format: (r) => r.body };
    }
    const def = COMMANDS[command];
    if (!def) return null;
    const input = { command, flags: flags || {} };
    return {
        method: def.method,
        path: def.path(input),
        body: def.body(input),
        format: def.format
    };
}

function validate(parsed) {
    if (!parsed) return { ok: false, error: 'Komut tanımsız.' };
    const { command, flags } = parsed;
    if (!POWER_ACTIONS.includes(command) && !COMMANDS[command]) {
        return { ok: false, error: `Bilinmeyen komut: ${command}` };
    }
    if (flags['json-body'] && parseJsonBodyFlag(flags['json-body']) === null) {
        return { ok: false, error: '--json-body geçerli JSON olmalı' };
    }
    if (command === 'timer') {
        if (!POWER_ACTIONS.includes(flags.action || 'shutdown')) {
            return { ok: false, error: `Geçersiz --action: ${flags.action}` };
        }
        const ms = flags.durationMs !== undefined
            ? Number(flags.durationMs)
            : (flags.minutes !== undefined ? Number(flags.minutes) * 60000 : NaN);
        if (!Number.isInteger(ms) || ms <= 0) {
            return { ok: false, error: '--durationMs veya --minutes pozitif tam sayı olmalı (ms / dk)' };
        }
    }
    if (command === 'task-create' && !flags['json-body']) {
        if (!POWER_ACTIONS.includes(flags.action || 'shutdown')) {
            return { ok: false, error: `Geçersiz --action: ${flags.action}` };
        }
        const body = buildTaskCreateBody(flags);
        const hasCond = body.conditionGroup && body.conditionGroup.conditions.length > 0;
        const hasRec = body.recurrence && body.recurrence.enabled;
        const hasTime = body.trigger && (Number.isInteger(body.trigger.durationMs) || Number.isInteger(body.trigger.targetTime));
        if (!hasCond && !hasRec && !hasTime) {
            return { ok: false, error: '--minutes, --durationMs, --at veya en az bir kosul bayragi gerekli' };
        }
    }
    if (ID_REQUIRED_COMMANDS.has(command) && !flags.id) {
        return { ok: false, error: '--id gerekli' };
    }
    if ((command === 'settings-set' || command === 'security-set') && !flags['json-body']) {
        if (!flags.key || flags.value === undefined) {
            return { ok: false, error: '--key ve --value (veya --json-body) gerekli' };
        }
    }
    if (command === 'template-save' && !flags['json-body'] && !flags.name) {
        return { ok: false, error: '--name (veya --json-body) gerekli' };
    }
    if (command === 'wol-send' && !flags.mac && !flags.id && !flags.name) {
        return { ok: false, error: '--mac, --id veya --name gerekli' };
    }
    if (command === 'webhook-test' && !flags.url) {
        return { ok: false, error: '--url gerekli' };
    }
    if (command === 'cloud-provider' && !flags.provider) {
        return { ok: false, error: '--provider gerekli' };
    }
    if (command === 'cloud-autosync' && !flags.on && !flags.off) {
        return { ok: false, error: '--on veya --off gerekli' };
    }
    if ((command === 'ai-parse' || command === 'ai-assist') && !flags.text) {
        return { ok: false, error: '--text gerekli' };
    }
    if (command === 'docs-search' && !flags.query) {
        return { ok: false, error: '--query gerekli' };
    }
    if (command === 'ai-dismiss' && !flags.topic) {
        return { ok: false, error: '--topic gerekli' };
    }
    if (command === 'updates-install-on-quit' && !flags.on && !flags.off) {
        return { ok: false, error: '--on veya --off gerekli' };
    }
    if (command === 'cloud-folder' && !flags.dir) {
        return { ok: false, error: '--dir gerekli' };
    }
    if (command === 'cancel-pin-set' && !flags.pin) {
        return { ok: false, error: '--pin gerekli' };
    }
    if (command === 'wol-devices-save' && !flags['json-body'] && !flags.mac) {
        return { ok: false, error: '--json-body veya --mac gerekli' };
    }
    if (command === 'webhooks-save' && !flags['json-body'] && !flags.url) {
        return { ok: false, error: '--json-body veya --url gerekli' };
    }
    if ((command === 'import-settings' || command === 'import-templates' || command === 'order-submit') && !flags['json-body']) {
        return { ok: false, error: '--json-body gerekli' };
    }
    return { ok: true };
}

function usageText() {
    const lines = [
        'Kullanim: powerpilot <komut> [bayraklar]',
        '',
        'Yerel / Arayuzsuz (Zero-GUI) Komutlar:',
        '  init                 Local API + API anahtari + cli-connection.json olusturur (GUI gerekmez)',
        '  daemon [start|stop|status] Arka plan headless servisini baslatir/durdurur/denetler',
        '  mcp                  Yerlesik MCP JSON-RPC 2.0 stdio sunucusunu baslatir',
        '',
        'Aninda Guc Eylemleri:'
    ];
    for (const action of POWER_ACTIONS) {
        lines.push(`  ${action.padEnd(22)} Aninda guc eylemi (guvenli gorev hattindan gecer)`);
    }
    lines.push('', 'Tam Kontrol Komutlari:');
    for (const [name, def] of Object.entries(COMMANDS)) {
        lines.push(`  ${name.padEnd(22)} ${def.usage}`);
    }
    lines.push('', 'Genel bayraklar: --json (ham JSON), --help');
    return lines.join('\n');
}

function renderResponse(req, res, flags = {}) {
    if (flags.json) return JSON.stringify(res.body, null, 2);
    if (res.body && typeof res.body === 'object' && typeof res.body.error === 'string') {
        return `Hata (${res.status}): ${res.body.error}${res.body.code ? ` [${res.body.code}]` : ''}`;
    }
    if (req && typeof req.format === 'function') {
        const out = req.format(res);
        return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    }
    return JSON.stringify(res.body, null, 2);
}

module.exports = {
    POWER_ACTIONS,
    COMMANDS,
    parseArgs,
    buildRequest,
    validate,
    usageText,
    renderResponse
};
