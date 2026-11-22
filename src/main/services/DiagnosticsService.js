/**
 * DiagnosticsService.js - WP-5 (Dev Cleaner Standardı)
 * Yerel-öncelikli hata/çökme günlüğü, sistem tanılama özeti ve harici bağımlılıksız
 * (saf Node `zlib`) destek paketi (ZIP) oluşturucu.
 *
 * Güvenlik sözleşmesi:
 * - Tüm metinler, yığın izleri, ayarlar ve dosya yolları Redact + kullanıcı yolu
 *   maskelemesinden geçer; PIN, API anahtarı, PEM, Bearer/HMAC sırrı asla pakete girmez.
 * - Sıfır telemetri: hiçbir veri otomatik olarak ağa gönderilmez; kullanıcı isterse
 *   ZIP paketini kendi paylaşır.
 * - E-posta taslağı yalnızca sabit `support@vellium.dev` adresine, GitHub bağlantısı
 *   yalnızca `https://github.com/emirtdede/Power-Pilot/issues/new` adresine yönlenir.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { redact, redactText } = require('../security/Redact');

const SUPPORT_EMAIL = 'support@vellium.dev';
const GITHUB_ISSUES_URL = 'https://github.com/emirtdede/Power-Pilot/issues/new';
const MAX_ERROR_ENTRIES = 200;
const MAX_SYSTEM_ENTRIES = 300;
const MAX_LOG_TAIL_LINES = 250;
const MAX_MESSAGE_LEN = 1200;
const MAX_STACK_LEN = 2500;

// CRC32 tablosu (saf Node ZIP oluşturucu için)
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = ((date.getHours() & 0x1f) << 11)
        | ((date.getMinutes() & 0x3f) << 5)
        | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9)
        | (((date.getMonth() + 1) & 0x0f) << 5)
        | (date.getDate() & 0x1f);
    return { dosTime, dosDate };
}

/**
 * Harici bağımlılıksız, RFC 1951 Deflate uyumlu saf Node.js ZIP arşivi üretir.
 * @param {Array<{name: string, content: string|Buffer}>} entries
 * @returns {Buffer}
 */
function createZipBuffer(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { dosTime, dosDate } = dosDateTime(new Date());

    for (const entry of entries) {
        const nameBuf = Buffer.from(String(entry.name || 'file.txt').replace(/\\/g, '/'), 'utf8');
        const rawBuf = Buffer.isBuffer(entry.content)
            ? entry.content
            : Buffer.from(String(entry.content ?? ''), 'utf8');
        const crc = crc32(rawBuf);
        const deflated = zlib.deflateRawSync(rawBuf, { level: 6 });
        const useDeflate = deflated.length < rawBuf.length;
        const dataBuf = useDeflate ? deflated : rawBuf;
        const method = useDeflate ? 8 : 0;

        // Local file header (30 bytes + name)
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(dosTime, 10);
        local.writeUInt16LE(dosDate, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dataBuf.length, 18);
        local.writeUInt32LE(rawBuf.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);

        localParts.push(local, nameBuf, dataBuf);

        // Central directory header (46 bytes + name)
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8); // UTF-8 flag
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(dosTime, 12);
        central.writeUInt16LE(dosDate, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dataBuf.length, 20);
        central.writeUInt32LE(rawBuf.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);

        centralParts.push(central, nameBuf);
        offset += local.length + nameBuf.length + dataBuf.length;
    }

    const centralDir = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDir, eocd]);
}

function sanitizePathsAndSecrets(input) {
    if (input == null) return '';
    let text = redactText(String(input));
    // Windows / POSIX kullanıcı adlarını yol içinden maskele
    text = text.replace(/([A-Za-z]:\\Users\\)([^\\\r\n\s"']+)/gi, '$1<USER>');
    text = text.replace(/(\/Users\/|\/home\/)([^/\r\n\s"']+)/gi, '$1<USER>');
    return text;
}

function formatTimestampCompact(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

class DiagnosticsService {
    constructor({
        userDataDir,
        logsDir = null,
        downloadsDir = null,
        appVersion = '1.0.0',
        distributionChannel = 'direct',
        isPortable = false,
        storageService = null,
        fsImpl = fs
    } = {}) {
        this.userDataDir = userDataDir || os.tmpdir();
        this.logsDir = logsDir || path.join(this.userDataDir, 'logs');
        this.downloadsDir = downloadsDir || path.join(os.homedir(), 'Downloads');
        this.appVersion = appVersion;
        this.distributionChannel = distributionChannel;
        this.isPortable = !!isPortable;
        this.storage = storageService;
        this.fs = fsImpl;

        this.errorFile = path.join(this.logsDir, 'diagnostics-errors.jsonl');
        this.errorEntries = [];
        this.systemEntries = [];
        this.lastBundlePath = null;
        this.lastBundleSize = 0;

        this._loadPersistedErrors();
    }

    _ensureLogsDir() {
        try {
            this.fs.mkdirSync(this.logsDir, { recursive: true });
        } catch (_) { /* yut */ }
    }

    _loadPersistedErrors() {
        try {
            if (!this.fs.existsSync(this.errorFile)) return;
            const raw = this.fs.readFileSync(this.errorFile, 'utf8');
            const lines = raw.split(/\r?\n/).filter(Boolean).slice(-MAX_ERROR_ENTRIES);
            const loaded = [];
            for (const line of lines) {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && typeof parsed === 'object') loaded.push(parsed);
                } catch (_) { /* bozuk satır atlanır */ }
            }
            this.errorEntries = loaded;
        } catch (_) {
            this.errorEntries = [];
        }
    }

    _persistErrorEntry(entry) {
        try {
            this._ensureLogsDir();
            this.fs.appendFileSync(this.errorFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
            // Dosya çok büyüdüyse kırp
            if (this.errorEntries.length >= MAX_ERROR_ENTRIES) {
                const trimmed = this.errorEntries.slice(-MAX_ERROR_ENTRIES)
                    .map((e) => JSON.stringify(e))
                    .join('\n') + '\n';
                this.fs.writeFileSync(this.errorFile, trimmed, { encoding: 'utf8', mode: 0o600 });
            }
        } catch (_) { /* diske yazılamazsa bellek halkası korunur */ }
    }

    recordCrash({ kind = 'crash', message = '', stack = '', source = 'main' } = {}) {
        return this._appendError({
            level: 'crash',
            source: String(source || 'main').slice(0, 40),
            kind: String(kind || 'crash').slice(0, 60),
            message,
            stack
        });
    }

    recordRendererError({ kind = 'error', message = '', stack = '', context = '' } = {}) {
        return this._appendError({
            level: kind === 'warning' ? 'warn' : 'error',
            source: 'renderer',
            kind: String(kind || 'error').slice(0, 60),
            message,
            stack,
            context
        });
    }

    _appendError({ level = 'error', source = 'main', kind = 'error', message = '', stack = '', context = '' }) {
        const entry = {
            id: `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            ts: new Date().toISOString(),
            level,
            source,
            kind,
            message: sanitizePathsAndSecrets(message).slice(0, MAX_MESSAGE_LEN),
            stack: sanitizePathsAndSecrets(stack).slice(0, MAX_STACK_LEN),
            ...(context ? { context: sanitizePathsAndSecrets(context).slice(0, 240) } : {})
        };
        this.errorEntries.push(entry);
        if (this.errorEntries.length > MAX_ERROR_ENTRIES) {
            this.errorEntries = this.errorEntries.slice(-MAX_ERROR_ENTRIES);
        }
        this._persistErrorEntry(entry);
        this.recordSystemEvent({
            level: level === 'crash' ? 'error' : level,
            scope: `${source}:${kind}`,
            message: entry.message
        });
        return entry;
    }

    recordSystemEvent({ level = 'info', scope = 'app', message = '' } = {}) {
        const entry = {
            ts: new Date().toISOString(),
            level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
            scope: String(scope || 'app').slice(0, 48),
            message: sanitizePathsAndSecrets(message).slice(0, 600)
        };
        this.systemEntries.push(entry);
        if (this.systemEntries.length > MAX_SYSTEM_ENTRIES) {
            this.systemEntries = this.systemEntries.slice(-MAX_SYSTEM_ENTRIES);
        }
        return entry;
    }

    readBackendLogTail(maxLines = MAX_LOG_TAIL_LINES) {
        const candidates = [
            path.join(this.logsDir, 'main.log'),
            path.join(this.userDataDir, 'logs', 'main.log')
        ];
        for (const file of candidates) {
            try {
                if (!this.fs.existsSync(file)) continue;
                const stat = this.fs.statSync(file);
                const maxRead = 128 * 1024;
                const raw = stat.size > maxRead
                    ? (() => {
                        const fd = this.fs.openSync(file, 'r');
                        try {
                            const buf = Buffer.alloc(maxRead);
                            this.fs.readSync(fd, buf, 0, maxRead, stat.size - maxRead);
                            return buf.toString('utf8');
                        } finally {
                            this.fs.closeSync(fd);
                        }
                    })()
                    : this.fs.readFileSync(file, 'utf8');
                return raw
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .slice(-maxLines)
                    .map((line) => sanitizePathsAndSecrets(line));
            } catch (_) { /* sonraki adaya düş */ }
        }
        return [];
    }

    getSystemInfo() {
        return {
            appName: 'Power Pilot',
            appVersion: this.appVersion,
            distribution: this.distributionChannel,
            portable: this.isPortable,
            platform: process.platform,
            release: os.release(),
            arch: process.arch,
            electronVersion: process.versions.electron || 'unknown',
            nodeVersion: process.versions.node || 'unknown',
            totalRamGb: Math.round((os.totalmem() / 1073741824) * 10) / 10,
            freeRamGb: Math.round((os.freemem() / 1073741824) * 10) / 10,
            uptimeMinutes: Math.round(os.uptime() / 60),
            locale: Intl.DateTimeFormat().resolvedOptions().locale || 'unknown',
            generatedAt: new Date().toISOString()
        };
    }

    getSanitizedSettingsSummary() {
        if (!this.storage || typeof this.storage.getSettings !== 'function') return {};
        try {
            const raw = this.storage.getSettings();
            const safe = redact(raw);
            // Ek güvence: bilinen sır/hash alanlarını tamamen kaldır
            const drop = [
                'cancelPinHash', 'cancelPinSalt', 'localApiKeyHash', 'localApiKeyPem',
                'localApiPfxPassphrase', 'consoleAgentKey', 'consoleClientKeyPem',
                'consoleClientPfxPassphrase', 'consolePublicKeyPem', 'localApiCertPem', 'localApiCaPem'
            ];
            for (const key of drop) delete safe[key];
            return safe;
        } catch (_) {
            return {};
        }
    }

    getAuditStatusSummary() {
        if (!this.storage) return { ok: true, count: 0, tampered: false, maintenanceMode: false };
        try {
            const verify = typeof this.storage.verifyAuditChain === 'function'
                ? this.storage.verifyAuditChain()
                : { ok: true };
            const logs = typeof this.storage.getAuditLog === 'function' ? this.storage.getAuditLog() : [];
            return {
                ok: verify.ok !== false,
                code: verify.code || null,
                count: Array.isArray(logs) ? logs.length : 0,
                tampered: this.storage.auditTampered === true,
                maintenanceMode: typeof this.storage.isMaintenanceMode === 'function'
                    ? this.storage.isMaintenanceMode()
                    : false
            };
        } catch (_) {
            return { ok: false, count: 0, tampered: false, maintenanceMode: false };
        }
    }

    getDiagnosticsSnapshot() {
        const backendLines = this.readBackendLogTail(150);
        const crashCount = this.errorEntries.filter((e) => e.level === 'crash').length;
        const errorCount = this.errorEntries.filter((e) => e.level === 'error').length;
        return {
            systemInfo: this.getSystemInfo(),
            auditStatus: this.getAuditStatusSummary(),
            counts: {
                crashes: crashCount,
                errors: errorCount,
                totalErrors: this.errorEntries.length,
                systemEvents: this.systemEntries.length,
                backendLogLines: backendLines.length
            },
            errors: [...this.errorEntries].reverse(),
            systemEvents: [...this.systemEntries].reverse(),
            backendLogLines: backendLines,
            logsDir: this.logsDir,
            lastBundlePath: this.lastBundlePath,
            lastBundleSize: this.lastBundleSize,
            supportEmail: SUPPORT_EMAIL,
            githubIssuesUrl: GITHUB_ISSUES_URL
        };
    }

    clearLogs() {
        this.errorEntries = [];
        this.systemEntries = [];
        try {
            if (this.fs.existsSync(this.errorFile)) {
                this.fs.writeFileSync(this.errorFile, '', { encoding: 'utf8', mode: 0o600 });
            }
        } catch (_) { /* yut */ }
        this.recordSystemEvent({ level: 'info', scope: 'diagnostics', message: 'Diagnostics logs cleared by user.' });
        return { ok: true };
    }

    formatTextReport() {
        const info = this.getSystemInfo();
        const audit = this.getAuditStatusSummary();
        const crashCount = this.errorEntries.filter((e) => e.level === 'crash').length;
        const errCount = this.errorEntries.length;
        return [
            'Power Pilot - Tanılama ve Çökme Raporu',
            '======================================',
            `Oluşturulma  : ${info.generatedAt}`,
            `Sürüm        : ${info.appVersion} (${info.distribution}${info.portable ? ' / portable' : ''})`,
            `İşletim Sist.: ${info.platform} ${info.release} (${info.arch})`,
            `Çalışma Zam. : Electron ${info.electronVersion} / Node ${info.nodeVersion}`,
            `Bellek       : ${info.freeRamGb} GB boş / ${info.totalRamGb} GB toplam`,
            `Açık Süre    : ${info.uptimeMinutes} dk`,
            `Denetim Zinc.: ${audit.ok ? 'DOĞRULANDI' : 'SORUNLU'} (kayıt=${audit.count}, bakım=${audit.maintenanceMode})`,
            `Hata / Çökme : ${errCount} kayıt (${crashCount} kritik çökme)`,
            '',
            'Gizlilik Notu: Tüm sırlar, PIN/API anahtarları ve kullanıcı dizin adları otomatik olarak maskelenmiştir.'
        ].join('\n');
    }

    createSupportBundle({ outputDir = null } = {}) {
        const dir = outputDir || this.downloadsDir || this.logsDir;
        try {
            this.fs.mkdirSync(dir, { recursive: true });
        } catch (_) { /* yut */ }

        const fileName = `powerpilot-support-${formatTimestampCompact(new Date())}.zip`;
        const filePath = path.join(dir, fileName);

        const crashesText = this.errorEntries
            .filter((e) => e.level === 'crash')
            .map((e) => `[${e.ts}] [${e.source}/${e.kind}] ${e.message}${e.stack ? `\n${e.stack}` : ''}`)
            .join('\n\n') || '(Çökme kaydı yok)';

        const errorsText = this.errorEntries
            .map((e) => `[${e.ts}] [${e.level.toUpperCase()}] [${e.source}/${e.kind}] ${e.message}${e.context ? ` | ${e.context}` : ''}${e.stack ? `\n${e.stack}` : ''}`)
            .join('\n\n') || '(Hata kaydı yok)';

        const systemLogText = this.systemEntries
            .map((e) => `[${e.ts}] [${e.level.toUpperCase()}] [${e.scope}] ${e.message}`)
            .join('\n') || '(Sistem olayı kaydı yok)';

        const backendText = this.readBackendLogTail(MAX_LOG_TAIL_LINES).join('\n') || '(Arka uç log dosyası boş)';
        const settingsJson = JSON.stringify(this.getSanitizedSettingsSummary(), null, 2);
        const sysInfoJson = JSON.stringify(this.getSystemInfo(), null, 2);
        const auditJson = JSON.stringify(this.getAuditStatusSummary(), null, 2);

        const zipBuffer = createZipBuffer([
            { name: 'report.txt', content: this.formatTextReport() },
            { name: 'system-info.json', content: sysInfoJson },
            { name: 'crash-log.txt', content: crashesText },
            { name: 'error-log.txt', content: errorsText },
            { name: 'system-log.txt', content: systemLogText },
            { name: 'backend-log.txt', content: backendText },
            { name: 'settings-summary.json', content: settingsJson },
            { name: 'audit-status.json', content: auditJson }
        ]);

        this.fs.writeFileSync(filePath, zipBuffer, { mode: 0o600 });
        this.lastBundlePath = filePath;
        this.lastBundleSize = zipBuffer.length;
        this.recordSystemEvent({
            level: 'info',
            scope: 'diagnostics',
            message: `Support bundle created (${fileName}, ${zipBuffer.length} bytes)`
        });

        return {
            ok: true,
            filePath,
            fileName,
            sizeBytes: zipBuffer.length,
            createdAt: new Date().toISOString()
        };
    }

    buildSupportMailto({ bundleFileName = null } = {}) {
        const info = this.getSystemInfo();
        const subject = `Power Pilot v${info.appVersion} - Destek ve Hata Raporu`;
        const recent = this.errorEntries.slice(-5)
            .map((e) => `- [${e.ts}] ${e.kind}: ${e.message.slice(0, 140)}`)
            .join('\n');
        const body = [
            'Merhaba Power Pilot Destek Ekibi,',
            '',
            'Karşılaştığım sorun:',
            '(Lütfen sorunu kısaca açıklayın)',
            '',
            '--- Sistem Özeti ---',
            `Sürüm: Power Pilot ${info.appVersion} (${info.distribution}${info.portable ? ' / portable' : ''})`,
            `OS: ${info.platform} ${info.release} (${info.arch})`,
            bundleFileName ? `Eklenen Destek Paketi: ${bundleFileName} (Lütfen bu ZIP dosyasını e-postaya ekleyin)` : '',
            recent ? `\nSon Hata Kayıtları:\n${recent}` : ''
        ].filter(Boolean).join('\n');

        return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }

    buildGithubIssueUrl() {
        const info = this.getSystemInfo();
        const recent = this.errorEntries.slice(-3)
            .map((e) => `- \`[${e.kind}]\` ${e.message.slice(0, 120)}`)
            .join('\n');
        const title = `[Bug] Power Pilot v${info.appVersion}: `;
        const body = [
            '### Sorun Açıklaması',
            '<!-- Lütfen karşılaştığınız sorunu açıklayın -->',
            '',
            '### Ortam Bilgisi',
            `- **Power Pilot:** v${info.appVersion} (${info.distribution}${info.portable ? ' / portable' : ''})`,
            `- **OS:** ${info.platform} ${info.release} (${info.arch})`,
            `- **Electron / Node:** ${info.electronVersion} / ${info.nodeVersion}`,
            recent ? `\n### Son Maskelenmiş Hata Özeti\n${recent}` : ''
        ].filter(Boolean).join('\n');
        return `${GITHUB_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    }
}

module.exports = {
    DiagnosticsService,
    createZipBuffer,
    sanitizePathsAndSecrets,
    SUPPORT_EMAIL,
    GITHUB_ISSUES_URL
};
