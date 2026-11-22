/**
 * LocalApiService.js
 * Embedded REST API Server for local n8n, CLI, and custom scripts.
 * Listens on 127.0.0.1 by default with API key authentication, permission scopes,
 * rate limiting, and strict request validation.
 *
 * FAZ A (tek-şirket pilotu):
 * - TLS: localApiTlsEnabled + sertifika materyali varsa https; yoksa http fallback
 *   (mevcut tek-PC davranışı bozulmaz).
 * - mTLS: localApiRequireClientCert=true ise istemci sertifikası ister; uygulama
 *   katmanında 401 döner (FAZ B'de rejectUnauthorized:true'ya sıkılaştırılacak).
 * - Rol-bazlı anahtar: viewer (salt-okunur) | operator (yıkıcı olmayan güç) | admin (tümü).
 *   Kayıtlı rol yoksa geriye uyumlu olarak admin sayılır.
 * - Rotasyon: anahtar yaşı 90 günü geçerse getSecurityStatus().rotationDue=true.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { URL } = require('url');
const log = require('../logger');
const { POWER_ACTIONS } = require('./PowerService');
const POWER_ACTIONS_LIST = Object.values(POWER_ACTIONS);
const { SignedOrderService } = require('./SignedOrderService');
const { ExemptionService, validateExemption, validateWindow } = require('./ExemptionService');
const { AuditLog } = require('./AuditLog');
const ipAcl = require('./net/ipAcl');
const TlsConfig = require('../security/TlsConfig');
const { safeCompare } = require('../security/safeCompare');
const Pin = require('../security/Pin');
const { PinGuard } = require('../ipc/pinGuard');
const { routeCoreDomain } = require('./api/coreDomainRoutes');
const { routeIntegrationDomain } = require('./api/integrationDomainRoutes');
const { routeExtendedDomain } = require('./api/extendedDomainRoutes');
const { version: APP_VERSION } = require('../../../package.json');

const MAX_BODY_BYTES = 100 * 1024;
const REQUEST_TIMEOUT_MS = 15000;
const HEADERS_TIMEOUT_MS = 10000;
const KEEP_ALIVE_TIMEOUT_MS = 5000;
const MAX_HEADERS = 100;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX_ENTRIES = 500;

// FAZ A: rol hiyerarşisi + uç başına asgari rol.
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
// O-05: kullanıcı aktifken uzaktan engellenen tüm yıkıcı güç eylemleri.
const REMOTE_BLOCKED_ACTIONS = new Set(['shutdown', 'restart', 'sleep', 'hibernate', 'signout', 'lock']);
const API_KEY_ROTATION_DAYS = 90;
// WBS-0.4 / WP-01: rate-limit belleği sınırsız büyümez.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_MAX_KEYS = 1000;

class LocalApiService {
    constructor(storageService, taskManager, powerService, deps = {}) {
        this.storage = storageService;
        this.taskManager = taskManager;
        this.powerService = powerService;
        // FAZ B: kurumsal servisler (yoksa uçlar 503 döner, çekirdek etkilenmez).
        this.deps = deps || {};
        // Store dağıtımında LAN'a açılmayız; yalnızca loopback sunulur.
        this.allowLan = this.deps.allowLan !== false;

        this.server = null;
        this.transport = 'disabled'; // disabled|http|https (getSecurityStatus için)
        this.boundHost = null;
        this.requestCounts = new Map(); // Rate limiting: IP:keyHash -> timestamp list
        this.authFailures = new Map(); // O-02: IP -> başarısız auth zamanları
        this.idempotencyCache = new Map(); // Key -> response
        this.pinGuard = new PinGuard();
        this._aiDownloadState = null;
        this.diagnostics = {
            aclAllowed: 0,
            aclDenied: 0,
            rateLimited: 0
        };
    }

    // --- FAZ A: TLS / mTLS -------------------------------------------------

    /**
     * Ayarlardan TLS materyali çözer (PEM/PFX). Eksik materyalde null.
     */
    resolveTlsMaterial(settings) {
        const opts = TlsConfig.buildServerOptions(settings);
        if (!opts) return null;
        const mat = { ca: opts.ca || null };
        if (opts.pfx) {
            mat.pfx = opts.pfx;
            mat.passphrase = opts.passphrase || null;
        } else {
            mat.cert = opts.cert;
            mat.key = opts.key;
        }
        return mat;
    }

    getServerOptions(settings) {
        return TlsConfig.buildServerOptions(settings);
    }

    /**
     * WP-02.T4: mTLS istemci sertifikası.
     * - socket.authorized === true olmalı
     * - authorizationError boş olmalı
     * - parmak izi allowlist'i tanımlıysa fingerprint256 içinde olmalı
     * Zorunlu değilse true.
     */
    isClientCertOk(req, settings) {
        if (!settings.localApiRequireClientCert) return true;
        const sock = req.socket || {};
        if (sock.authorized !== true) return false;
        if (sock.authorizationError) return false;
        if (typeof sock.getPeerCertificate !== 'function') return false;
        let peer;
        try {
            peer = sock.getPeerCertificate(true);
        } catch (_) {
            return false;
        }
        if (!peer || Object.keys(peer).length === 0) return false;
        const allow = Array.isArray(settings.localApiClientFingerprints)
            ? settings.localApiClientFingerprints.map((f) => String(f).replace(/:/g, '').toLowerCase()).filter(Boolean)
            : [];
        if (allow.length > 0) {
            const fp = String(peer.fingerprint256 || '').replace(/:/g, '').toLowerCase();
            if (!fp || !allow.includes(fp)) return false;
        }
        return true;
    }

    // --- FAZ A: rol + rotasyon ----------------------------------------------

    static roleOf(settings) {
        const r = settings && settings.localApiKeyRole;
        // L-06/Y-06: bilinmeyen/boş rol varsayılana düşmez; fail-closed.
        return ROLE_RANK[r] ? r : null;
    }

    async verifyCancelPin(providedPin) {
        const s = this.storage.getSettings() || {};
        if (!s.cancelPinHash) return null;
        const stored = Pin.isArgon2Hash(s.cancelPinHash)
            ? s.cancelPinHash
            : { hash: s.cancelPinHash, salt: s.cancelPinSalt };
        const check = await this.pinGuard.check('api-cancel', providedPin, stored);
        if (check.ok) {
            if (check.upgrade) {
                try { this.storage.updateSettings({ cancelPinHash: check.upgrade, cancelPinSalt: null }); } catch (_) { /* best-effort */ }
            }
            return null;
        }
        return {
            success: false,
            code: check.code,
            error: check.code === 'PIN_REQUIRED' ? 'Cancel PIN is required.' : (check.message || 'Invalid Cancel PIN.'),
            retryAfterSec: check.retryAfterSec,
            attemptsLeft: check.attemptsLeft
        };
    }

    static requiredRole(method, path) {
        // O-06: denetim kaydi, webhooks, diagnostics, settings export hassas alanlar icerir; yalnizca admin okuyabilir.
        if (path === '/api/v1/audit' || path === '/api/v1/audit/verify') return 'admin';
        if (path === '/api/v1/webhooks' || path === '/api/v1/webhooks/test') return 'admin';
        if (path === '/api/v1/diagnostics' || path === '/api/v1/diagnostics/bundle') return 'admin';
        if (path === '/api/v1/export/settings') return 'admin';
        if (path === '/api/v1/ai/diagnose' && method === 'POST') return 'viewer';
        if (method === 'GET') return 'viewer';
        // Ayar, guvenlik bayragi, PIN, anahtar rotasyonu, gecmis silme, bulut/AI model/konsol/guncelleme yonetimi: admin.
        if (path === '/api/v1/settings' || path === '/api/v1/settings/security') return 'admin';
        if (path === '/api/v1/import/settings') return 'admin';
        if (path === '/api/v1/security/cancel-pin' || path === '/api/v1/security/rotate-key') return 'admin';
        if (path === '/api/v1/history' && method === 'DELETE') return 'admin';
        if (path === '/api/v1/console/sync') return 'admin';
        if (path === '/api/v1/updates/check' || path === '/api/v1/updates/download'
            || path === '/api/v1/updates/install-on-quit' || path === '/api/v1/updates/install') return 'admin';
        if (path === '/api/v1/ai/model/download' || path === '/api/v1/ai/model/cancel'
            || path === '/api/v1/ai/model/delete' || path === '/api/v1/ai/tier'
            || path === '/api/v1/ai/model/load' || path === '/api/v1/ai/model/unload') return 'admin';
        if (path === '/api/v1/cloud/connect' || path === '/api/v1/cloud/disconnect'
            || path === '/api/v1/cloud/restore' || path === '/api/v1/cloud/provider'
            || path === '/api/v1/cloud/autosync' || path === '/api/v1/cloud/folder'
            || path === '/api/v1/cloud/folder/reset' || path === '/api/v1/cloud/dismiss-recovery') return 'admin';
        // FAZ B: muafiyet/pencere yonetimi yalnizca admin (operator veremez/silemez).
        if (path === '/api/v1/exemptions' || path === '/api/v1/maintenance-windows') return 'admin';
        if (path.match(/^\/api\/v1\/(exemptions|maintenance-windows)\/[^\/]+$/)) return 'admin';
        // Yikici guc eylemleri yalnizca admin.
        if (path === '/api/v1/power/shutdown' || path === '/api/v1/power/restart') return 'admin';
        if (path.match(/^\/api\/v1\/tasks\/[^\/]+\/cancel$/)) return 'operator';
        return 'operator';
    }

    static isKnownRoute(path) {
        if (typeof path !== 'string') return false;
        const EXACT = new Set([
            '/api/v1/status',
            '/api/v1/tasks',
            '/api/v1/tasks/timer',
            '/api/v1/tasks/clear-finished',
            '/api/v1/tasks/pause-all',
            '/api/v1/warning',
            '/api/v1/warning/confirm',
            '/api/v1/warning/snooze',
            '/api/v1/warning/cancel',
            '/api/v1/templates',
            '/api/v1/templates/restore-defaults',
            '/api/v1/settings',
            '/api/v1/settings/security',
            '/api/v1/security/status',
            '/api/v1/security/cancel-pin',
            '/api/v1/security/rotate-key',
            '/api/v1/export/settings',
            '/api/v1/import/settings',
            '/api/v1/export/templates',
            '/api/v1/import/templates',
            '/api/v1/history',
            '/api/v1/statistics',
            '/api/v1/health',
            '/api/v1/device/estimate',
            '/api/v1/console/sync',
            '/api/v1/wol/devices',
            '/api/v1/wol/send',
            '/api/v1/webhooks',
            '/api/v1/webhooks/test',
            '/api/v1/ups/test',
            '/api/v1/cloud/status',
            '/api/v1/cloud/connect',
            '/api/v1/cloud/disconnect',
            '/api/v1/cloud/sync',
            '/api/v1/cloud/restore',
            '/api/v1/cloud/provider',
            '/api/v1/cloud/autosync',
            '/api/v1/cloud/folder',
            '/api/v1/cloud/folder/reset',
            '/api/v1/cloud/dismiss-recovery',
            '/api/v1/ai/status',
            '/api/v1/ai/tier',
            '/api/v1/ai/model/download',
            '/api/v1/ai/model/cancel',
            '/api/v1/ai/model/delete',
            '/api/v1/ai/model/load',
            '/api/v1/ai/model/unload',
            '/api/v1/ai/parse',
            '/api/v1/ai/assist',
            '/api/v1/ai/diagnose',
            '/api/v1/ai/energy',
            '/api/v1/ai/suggest',
            '/api/v1/ai/dismiss-suggestion',
            '/api/v1/docs/search',
            '/api/v1/diagnostics',
            '/api/v1/diagnostics/bundle',
            '/api/v1/updates/status',
            '/api/v1/updates/check',
            '/api/v1/updates/download',
            '/api/v1/updates/install-on-quit',
            '/api/v1/updates/install',
            '/api/v1/inventory',
            '/api/v1/orders',
            '/api/v1/orders/pending',
            '/api/v1/exemptions',
            '/api/v1/maintenance-windows',
            '/api/v1/audit',
            '/api/v1/audit/verify'
        ]);
        if (EXACT.has(path)) return true;
        if (path.startsWith('/api/v1/power/')) return true;
        if (/^\/api\/v1\/tasks\/[^\/]+(\/(cancel|pause|resume|snooze|run-now))?$/.test(path)) return true;
        if (/^\/api\/v1\/templates\/[^\/]+(\/(reset|run))?$/.test(path)) return true;
        if (/^\/api\/v1\/(exemptions|maintenance-windows)\/[^\/]+$/.test(path)) return true;
        return false;
    }

    static isApiKeyRotationDue(settings, now = Date.now()) {
        const created = settings && settings.localApiKeyCreatedAt;
        if (!created) return false;
        return (now - created) > API_KEY_ROTATION_DAYS * 86400000;
    }

    /**
     * Konsol/UI için güvenlik özeti (saf, test edilebilir - sunucuya dokunmaz).
     */
    /**
     * WP-08: Uzaktan kapatma, kullanıcı aktifken (idle < 60sn) engellenir.
     * Sağlayıcı yoksa 0 = aktif kabul edilir (fail-closed).
     */
    isRemoteShutdownBlocked(settings, action) {
        if (!settings || settings.blockRemoteShutdownWhenActive !== true) return false;
        if (!REMOTE_BLOCKED_ACTIONS.has(action)) return false;
        try {
            if (typeof this.deps.idleProvider === 'function') {
                const secs = Number(this.deps.idleProvider());
                return !(Number.isFinite(secs) && secs >= 60);
            }
            if (this.deps.powerMonitor && typeof this.deps.powerMonitor.getSystemIdleTime === 'function') {
                const secs = Number(this.deps.powerMonitor.getSystemIdleTime());
                return !(Number.isFinite(secs) && secs >= 60);
            }
        } catch (_) { /* fail-closed */ }
        return true;
    }

    getSecurityStatus() {
        const settings = this.storage.getSettings();
        const tlsEnabled = !!settings.localApiTlsEnabled;
        const hasCertMaterial = !!this.resolveTlsMaterial(settings);
        return {
            transport: this.transport,
            tlsEnabled,
            tlsStrict: settings.localApiTlsStrict === true,
            hasCertMaterial,
            httpsActive: this.transport === 'https',
            mtlsRequired: !!settings.localApiRequireClientCert,
            apiKeySet: !!settings.localApiKeyHash,
            keyRole: LocalApiService.roleOf(settings),
            rotationDue: LocalApiService.isApiKeyRotationDue(settings),
            lanMode: this.allowLan && !!settings.lanModeEnabled,
            boundHost: this.boundHost,
            diagnostics: this.getDiagnostics()
        };
    }

    getDiagnostics() {
        return {
            aclAllowed: this.diagnostics.aclAllowed,
            aclDenied: this.diagnostics.aclDenied,
            rateLimited: this.diagnostics.rateLimited,
            rateLimitKeys: this.requestCounts.size
        };
    }

    async start() {
        const settings = this.storage.getSettings();
        if (!settings.localApiEnabled) {
            log.info('[LocalApiService] API is disabled in settings.');
            return { ok: false, code: 'API_DISABLED' };
        }

        const port = settings.localApiPort || 18456;
        const allowlist = Array.isArray(settings.lanAllowedIps) ? settings.lanAllowedIps : [];
        const lanRequested = settings.lanModeEnabled === true && this.allowLan;
        const lanBound = lanRequested && allowlist.length > 0;
        const tlsOpts = this.getServerOptions(settings);

        // WP-02.T5: LAN modunda TLS zorunlu; bind öncesi son kontrol.
        if (lanBound && !tlsOpts) {
            log.error('[LocalApiService] LAN modu TLS olmadan başlatılamaz (LAN_REQUIRES_TLS).');
            return { ok: false, code: 'LAN_REQUIRES_TLS' };
        }
        // TLS açıkça istendiyse materyal yoksa sessiz HTTP fallback YOK.
        if (settings.localApiTlsEnabled === true && !tlsOpts) {
            log.error('[LocalApiService] TLS açık ama sertifika/anahtar yok (TLS_MATERIAL_MISSING).');
            return { ok: false, code: 'TLS_MATERIAL_MISSING' };
        }
        if (lanRequested && !lanBound) {
            log.warn('[LocalApiService] LAN modu açık ama allowlist boş - yalnızca loopback dinleniyor.');
        }
        const host = lanBound ? '::' : '127.0.0.1';

        // WP-02.T6: çalışan sunucu üzerine ikinci kez bind etme (EADDRINUSE yok).
        if (this.server) {
            log.warn('[LocalApiService] Sunucu zaten çalışıyor; yeniden başlatma için restart() kullanın.');
            return { ok: false, code: 'ALREADY_RUNNING' };
        }

        const handler = (req, res) => this.handleRequest(req, res);
        if (tlsOpts) {
            this.server = https.createServer(tlsOpts, handler);
            this.transport = 'https';
        } else {
            this.server = http.createServer(handler);
            this.transport = 'http';
        }
        // WP-02.T7: slowloris ve başlık taşması koruması.
        this.server.requestTimeout = REQUEST_TIMEOUT_MS;
        this.server.headersTimeout = HEADERS_TIMEOUT_MS;
        this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
        this.server.maxHeadersCount = MAX_HEADERS;

        const bind = (bindHost) => new Promise((resolve, reject) => {
            const onError = (err) => { cleanup(); reject(err); };
            const onListening = () => { cleanup(); resolve(); };
            const cleanup = () => {
                this.server.off('error', onError);
                this.server.off('listening', onListening);
            };
            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen({ port, host: bindHost, ipv6Only: false });
        });

        // O-01: bind sonucu beklenir; EADDRINUSE/EACCES çağırana hata olarak döner.
        try {
            try {
                await bind(host);
                this.boundHost = host;
            } catch (err) {
                const noIpv6 = err && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL');
                if (host === '::' && noIpv6) {
                    await bind('0.0.0.0');
                    this.boundHost = '0.0.0.0';
                } else {
                    throw err;
                }
            }
        } catch (err) {
            log.error('[LocalApiService] Bind hatası:', err && err.message);
            const failed = this.server;
            this.server = null;
            this.transport = 'disabled';
            this.boundHost = null;
            try { if (failed) failed.close(() => {}); } catch (_) { /* yut */ }
            return { ok: false, code: (err && err.code) || 'API_START_FAILED', message: err && err.message };
        }

        this.server.on('error', (err) => {
            log.error('[LocalApiService] Server error:', err && err.message);
        });
        log.info(`[LocalApiService] Running (${this.transport}) on ${this.boundHost}:${port}`);
        return { ok: true, transport: this.transport, host: this.boundHost };
    }

    /**
     * WP-02.T6: async durdurma - idle bağlantılar hemen, aktifler 5 sn sonra.
     */
    async stop() {
        const server = this.server;
        if (!server) {
            this.transport = 'disabled';
            this.boundHost = null;
            return { ok: true };
        }
        this.server = null;
        this.transport = 'disabled';
        this.boundHost = null;
        await new Promise((resolve) => {
            let settled = false;
            const done = () => { if (!settled) { settled = true; resolve(); } };
            try {
                if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
                server.close(done);
                setTimeout(() => {
                    try {
                        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    } catch (_) { /* yut */ }
                    done();
                }, 5000).unref?.();
            } catch (_) {
                done();
            }
        });
        log.info('[LocalApiService] Server stopped.');
        return { ok: true };
    }

    /**
     * WP-02.T6: ayar değişiminde güvenli yeniden başlatma. `stop()` portun
     * gerçekten boşalmasını bekler; ardışık çağrılar EADDRINUSE üretmez.
     */
    async restart() {
        await this.stop();
        return this.start();
    }

    generateApiKey(role = 'admin') {
        // Y-06: geçersiz rol en yüksek yetkiye düşmez.
        const safeRole = ROLE_RANK[role] ? role : 'viewer';
        const rawKey = `pp_key_${crypto.randomBytes(24).toString('hex')}`;
        const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const masked = `${rawKey.substr(0, 10)}...${rawKey.substr(-4)}`;

        const saved = this.storage.updateSettings({
            localApiKeyHash: hash,
            localApiKeyMasked: masked,
            localApiKeyCreatedAt: Date.now(), // Plan kapanışı: 90-gün rotasyon hatırlatması için
            localApiKeyRole: safeRole
        });
        if (saved === false) {
            throw Object.assign(new Error('API anahtarı kalıcılaştırılamadı.'), { code: 'SETTINGS_PERSIST_FAILED' });
        }

        return rawKey; // Return once to user for display
    }

    handleRequest(req, res) {
        const rawIp = req.socket.remoteAddress || '127.0.0.1';
        const remoteAddr = ipAcl.normalizeAddress(rawIp);
        const remoteIp = remoteAddr ? remoteAddr.toString() : '';
        const settings = this.storage.getSettings();

        // WP-01: ACL her zaman uygulanır (LAN kapalıyken yalnızca loopback).
        // Loopback daima açıktır; boş allowlist non-loopback'i reddeder.
        if (!ipAcl.isAllowed(rawIp, settings.lanAllowedIps)) {
            this.diagnostics.aclDenied += 1;
            return this.sendJson(res, 403, { error: 'IP address not allowed', code: 'IP_NOT_ALLOWED' });
        }
        this.diagnostics.aclAllowed += 1;

        // FAZ A: mTLS istemci sertifikası (gerekiyorsa API anahtarından ÖNCE bakılır).
        if (!this.isClientCertOk(req, settings)) {
            // WP-02.T11: iptal edilen istemcinin keep-alive bağlantısı da kapanır.
            try { if (res && typeof res.setHeader === 'function') res.setHeader('Connection', 'close'); } catch (_) { /* yut */ }
            const out = this.sendJson(res, 401, { error: 'Client certificate required', code: 'MTLS_REQUIRED' });
            try { if (req.socket && typeof req.socket.end === 'function') req.socket.end(); } catch (_) { /* yut */ }
            return out;
        }

        // Authentication Check
        const apiKeyHeader = req.headers['x-api-key'] || this.extractBearerToken(req.headers['authorization']);
        if (!apiKeyHeader) {
            return this.rejectAuth(res, remoteIp);
        }

        const providedHash = crypto.createHash('sha256').update(apiKeyHeader).digest('hex');
        // WP-01.T8 / M-01: sabit zamanlı karşılaştırma (uzunluk sızıntısı yok).
        if (!safeCompare(providedHash, settings.localApiKeyHash || '')) {
            return this.rejectAuth(res, remoteIp);
        }

        // O-02: başarılı auth sonrası anahtar+IP bazlı limit; meşru istemci
        // başka bir istemcinin brute-force denemelerinden etkilenmez.
        this.authFailures.delete(remoteIp);
        const rateKey = `${remoteIp}:${providedHash.slice(0, 16)}`;
        if (this.isRateLimited(rateKey)) {
            this.diagnostics.rateLimited += 1;
            return this.sendJson(res, 429, { error: 'Rate limit exceeded. Try again later.', code: 'RATE_LIMITED' });
        }

        const role = LocalApiService.roleOf(settings);

        // Parse URL & Body
        let parsedUrl;
        try {
            // O-05: Host başlığı URL tabanı olarak KULLANILMAZ; sabit loopback
            // tabanı path/query ayrıştırması için yeterlidir.
            parsedUrl = new URL(req.url, 'http://127.0.0.1');
        } catch (_) {
            return this.sendJson(res, 400, { error: 'Invalid URL', code: 'BAD_URL' });
        }
        const pathname = parsedUrl.pathname;
        const method = String(req.method || 'GET').toUpperCase();

        // WP-02.T7: gövde taşıyan metotlarda JSON içerik tipi zorunlu.
        const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (['POST', 'PUT', 'PATCH'].includes(method) && contentType !== 'application/json') {
            return this.sendJson(res, 415, { error: 'Content-Type must be application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });
        }

        // WP-02.T8 / L-03: Idempotency-Key aynı yanıtı döndürür. O-03: anahtar
        // metot + yol + gövde + API anahtarı parmak iziyle kapsamlanır.
        const idemKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null;

        let bodyRaw = '';
        let bodyBytes = 0;
        let tooLarge = false;
        req.on('data', chunk => {
            if (tooLarge) return;
            bodyBytes += chunk.length;
            if (bodyBytes > MAX_BODY_BYTES) {
                tooLarge = true;
                this.sendJson(res, 413, { error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', limit: MAX_BODY_BYTES });
                try { if (typeof req.destroy === 'function') req.destroy(); } catch (_) { /* yut */ }
                return;
            }
            bodyRaw += chunk;
        });

        req.on('end', () => {
            if (tooLarge) return;
            let body = {};
            if (bodyRaw) {
                try {
                    body = JSON.parse(bodyRaw);
                } catch (e) {
                    return this.sendJson(res, 400, { error: 'Invalid JSON payload' });
                }
            }

            if (idemKey) {
                const bodyHash = crypto.createHash('sha256').update(bodyRaw).digest('hex');
                const cacheKey = [
                    method,
                    pathname,
                    bodyHash,
                    providedHash.slice(0, 16),
                    idemKey
                ].join(':');
                this.pruneIdempotency();
                const cached = this.idempotencyCache.get(cacheKey);
                if (cached) return this.sendJson(res, cached.status, cached.body);
                if (this.idempotencyCache.size >= IDEMPOTENCY_MAX_ENTRIES) {
                    const oldest = this.idempotencyCache.keys().next().value;
                    if (oldest !== undefined) this.idempotencyCache.delete(oldest);
                }
                res.__ppIdempotencyKey = cacheKey;
            }

            // Denetim: yönlendirici istisnası süreci ÖLDÜRMEZ (500 + log).
            try {
                const out = this.route(method, pathname, body, res, { role, url: parsedUrl, headers: req.headers });
                if (out && typeof out.catch === 'function') {
                    out.catch((err) => {
                        log.error('[LocalApiService] asenkron uç hatası:', err && err.message);
                        try { this.sendJson(res, 500, { error: 'Endpoint failed' }); } catch (_) {}
                    });
                }
            } catch (err) {
                log.error('[LocalApiService] yönlendirici hatası:', err && err.message);
                try { this.sendJson(res, 500, { error: 'Internal error' }); } catch (_) {}
            }
        });
    }

    extractBearerToken(authHeader) {
        // L-06: şema büyük/küçük harf duyarsız; token trim edilir.
        if (typeof authHeader !== 'string') return null;
        const m = authHeader.match(/^Bearer\s+(.+)$/i);
        return m ? m[1].trim() : null;
    }

    pruneRateLimit(now = Date.now()) {
        for (const [ip, timestamps] of this.requestCounts.entries()) {
            const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
            if (valid.length === 0) this.requestCounts.delete(ip);
            else this.requestCounts.set(ip, valid);
        }
        // Map insertion order: en eski anahtarlar önce silinir.
        while (this.requestCounts.size > RATE_LIMIT_MAX_KEYS) {
            const oldest = this.requestCounts.keys().next().value;
            if (oldest === undefined) break;
            this.requestCounts.delete(oldest);
        }
    }

    isRateLimited(ip) {
        const now = Date.now();
        // Periyodik budama: yalnızca boyut sınırı aşıldığında değil, map
        // büyüdükçe eski anahtarlar temizlenir (bellek sınırı korunur).
        if (this.requestCounts.size > 100) this.pruneRateLimit(now);
        if (this.requestCounts.size > RATE_LIMIT_MAX_KEYS) this.pruneRateLimit(now);
        const timestamps = this.requestCounts.get(ip) || [];
        const validTimestamps = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

        if (validTimestamps.length >= RATE_LIMIT_MAX) {
            return true;
        }

        validTimestamps.push(now);
        this.requestCounts.set(ip, validTimestamps);
        return false;
    }

    /** O-02: başarısız auth denemeleri için ayrı, daha küçük sayaç (IP başına 10/dk). */
    rejectAuth(res, remoteIp) {
        const now = Date.now();
        const list = (this.authFailures.get(remoteIp) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
        list.push(now);
        this.authFailures.set(remoteIp, list);
        while (this.authFailures.size > RATE_LIMIT_MAX_KEYS) {
            const oldest = this.authFailures.keys().next().value;
            if (oldest === undefined) break;
            this.authFailures.delete(oldest);
        }
        if (list.length > 10) {
            try { res.setHeader('Retry-After', '60'); } catch (_) { /* yut */ }
            return this.sendJson(res, 429, { error: 'Too many authentication failures. Try again later.', code: 'AUTH_RATE_LIMITED' });
        }
        return this.sendJson(res, 401, { error: 'Invalid API key', code: 'UNAUTHORIZED' });
    }

    pruneIdempotency(now = Date.now()) {
        for (const [key, entry] of this.idempotencyCache.entries()) {
            if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
                this.idempotencyCache.delete(key);
            }
        }
    }

    route(method, path, body, res, ctx = {}) {
        // Y-06/L-06: rol yoksa veya bilinmiyorsa hiçbir uç yetkili değildir.
        const role = ROLE_RANK[ctx.role] ? ctx.role : null;
        // O-06: query parametreleri (limit/offset/beforeSeq/verify) için URL bağlamı.
        const parsedUrl = ctx.url instanceof URL ? ctx.url : new URL(String(path), 'http://127.0.0.1');
        const settings = this.storage.getSettings();

        // FAZ A: rol kapısı - bilinmeyen yola 404 (yetki sızıntısı yok).
        if (LocalApiService.isKnownRoute(path)) {
            const need = LocalApiService.requiredRole(method, path);
            if (!role || ROLE_RANK[role] < ROLE_RANK[need]) {
                return this.sendJson(res, 403, { error: `Role '${role || 'none'}' insufficient (requires '${need}')`, code: 'FORBIDDEN' });
            }
        }

        // System & Info
        if (method === 'GET' && path === '/api/v1/status') {
            return this.sendJson(res, 200, {
                status: 'online',
                app: 'Power Pilot',
                version: APP_VERSION,
                headless: Boolean(this.deps && this.deps.headless === true),
                activeTasksCount: this.taskManager.getActiveTasks().length,
                pausedAll: this.taskManager.pausedAll,
                transport: this.transport,
                boundHost: this.boundHost,
                port: (settings && settings.localApiPort) || 18456,
                keyRole: role,
                diagnostics: this.getDiagnostics()
            });
        }

        // Tasks API - O-06: varsayılan sayfalama; tüm geçmiş tek yanıtta dönmez.
        if (method === 'GET' && path === '/api/v1/tasks') {
            const limit = Math.min(500, Math.max(1, Number(parsedUrl.searchParams.get('limit')) || 100));
            const offset = Math.max(0, Number(parsedUrl.searchParams.get('offset')) || 0);
            const statusFilter = parsedUrl.searchParams.get('status');
            const source = statusFilter
                ? this.taskManager.tasks.filter((t) => t && t.status === statusFilter)
                : this.taskManager.tasks;
            const page = source.slice(offset, offset + limit);
            return this.sendJson(res, 200, {
                tasks: page.map(t => (t.toJSON ? t.toJSON() : t)),
                total: source.length,
                limit,
                offset,
                hasMore: offset + page.length < source.length
            });
        }

        if (method === 'POST' && path === '/api/v1/tasks/timer') {
            // Takip-1: fail-fast - geçersiz eylem/süre 400 döner, bozuk görev kurulmaz.
            if (!body.action || !body.durationMs) {
                return this.sendJson(res, 400, { error: 'Missing action or durationMs' });
            }
            if (!POWER_ACTIONS_LIST.includes(body.action)) {
                return this.sendJson(res, 400, { error: `Invalid action: ${body.action}` });
            }
            if (!Number.isInteger(body.durationMs) || body.durationMs <= 0 || body.durationMs > 2500000000) {
                return this.sendJson(res, 400, { error: 'durationMs must be an integer in 1..2500000000' });
            }
            // K2: ad doğrulaması (uzunluk + HTML karakterleri) - geçmiş tablosu lavabosu.
            if (body.name !== undefined) {
                if (typeof body.name !== 'string' || body.name.length > 120) {
                    return this.sendJson(res, 400, { error: 'name must be a string up to 120 chars' });
                }
                if (/[<>]/.test(body.name)) {
                    return this.sendJson(res, 400, { error: 'name must not contain < or >' });
                }
            }
            const task = this.taskManager.createTask({
                name: body.name || `API Timer (${body.action})`,
                action: body.action,
                source: 'local_api',
                trigger: {
                    type: 'duration',
                    durationMs: body.durationMs
                }
            });
            return this.sendJson(res, 201, { success: true, task: task.toJSON() });
        }

        if (method === 'POST' && path.match(/^\/api\/v1\/tasks\/[^\/]+\/cancel$/)) {
            const taskId = path.split('/')[4];
            const runCancel = () => {
                // WP-02.T8 / D-06: iptal sonucu yok sayılmaz; gerçek sonuç eşlenir.
                const result = this.taskManager.cancelTask(taskId);
                if (!result || result.ok === false) {
                    if (result && result.code === 'NOT_FOUND') {
                        return this.sendJson(res, 404, { success: false, code: 'TASK_NOT_FOUND', error: `Task ${taskId} not found` });
                    }
                    return this.sendJson(res, 400, {
                        success: false,
                        code: (result && result.code) || 'CANCEL_FAILED',
                        error: (result && result.message) || `Task ${taskId} could not be cancelled`
                    });
                }
                if (result.code === 'CANCEL_TOO_LATE') {
                    return this.sendJson(res, 409, { success: false, code: 'CANCEL_TOO_LATE', error: result.message || 'Cancel too late' });
                }
                if (result.code === 'ALREADY_CANCELLED') {
                    return this.sendJson(res, 409, { success: false, code: 'ALREADY_CANCELLED', error: `Task ${taskId} is already cancelled` });
                }
                return this.sendJson(res, 200, { success: true, message: `Task ${taskId} cancelled` });
            };
            if (settings && settings.cancelPinHash) {
                const providedPin = (body && body.pin) || (ctx.headers && ctx.headers['x-cancel-pin']) || undefined;
                this.verifyCancelPin(providedPin)
                    .then((pinErr) => (pinErr ? this.sendJson(res, 403, pinErr) : runCancel()))
                    .catch((err) => this.sendJson(res, 500, { success: false, error: err && err.message }));
                return true;
            }
            return runCancel();
        }

        // Power Actions API - K3: TÜM güç eylemleri görev hattından geçer
        // (güvenlik motoru + uyarı + geçmiş/denetim). shutdown deseni genelleştirildi:
        // 5sn gecikmeli görev + 15sn uyarı; anında `execute()` çağrısı YOKTUR.
        // Gerekçe: uzaktan-emir koruması (blockRemoteShutdownWhenActive), muafiyet,
        // sunucu profili ve kill-switch yalnızca boru hattında çalışır.
        const POWER_ROUTES = {
            '/api/v1/power/lock': 'lock',
            '/api/v1/power/signout': 'signout',
            '/api/v1/power/restart': 'restart',
            '/api/v1/power/sleep': 'sleep',
            '/api/v1/power/hibernate': 'hibernate'
        };
        if (method === 'POST' && POWER_ROUTES[path]) {
            const action = POWER_ROUTES[path];
            if (this.isRemoteShutdownBlocked(settings, action)) {
                return this.sendJson(res, 403, {
                    error: 'Kullanıcı aktifken uzaktan kapatma/yeniden başlatma engellendi.',
                    code: 'REMOTE_SHUTDOWN_BLOCKED'
                });
            }
            const task = this.taskManager.createTask({
                name: `API Immediate ${action}`,
                action,
                source: 'local_api',
                warningConfig: { enabled: true, durationSeconds: 15, silentMode: false },
                trigger: { type: 'duration', durationMs: 5000 }
            });
            return this.sendJson(res, 200, { success: true, message: `${action} scheduled via API`, taskId: task.id });
        }

        if (method === 'POST' && path === '/api/v1/power/shutdown') {
            if (this.isRemoteShutdownBlocked(settings, 'shutdown')) {
                return this.sendJson(res, 403, {
                    error: 'Kullanıcı aktifken uzaktan kapatma engellendi.',
                    code: 'REMOTE_SHUTDOWN_BLOCKED'
                });
            }
            const task = this.taskManager.createTask({
                name: 'API Immediate Shutdown',
                action: 'shutdown',
                source: 'local_api',
                trigger: { type: 'duration', durationMs: 5000 }
            });
            return this.sendJson(res, 200, { success: true, message: 'Shutdown scheduled via API', taskId: task.id });
        }

        // Full-headless domain endpoints (core + integrations + extended + enterprise)
        const routeCtx = { role, query: parsedUrl.searchParams, headers: ctx.headers || {} };
        try {
            const coreRes = routeCoreDomain(this, method, path, body, res, routeCtx);
            if (coreRes !== null) return coreRes;
            const intRes = routeIntegrationDomain(this, method, path, body, res, routeCtx);
            if (intRes !== null) return intRes;
            const extRes = routeExtendedDomain(this, method, path, body, res, routeCtx);
            if (extRes !== null) return extRes;
            const enterprise = this.routeEnterprise(method, path, body, res, parsedUrl);
            if (enterprise !== null) return enterprise;
        } catch (err) {
            log.warn('[LocalApiService] domain route hatası:', err && err.message);
            return this.sendJson(res, 500, { error: 'Endpoint failed', code: (err && err.code) || 'ENDPOINT_FAILED' });
        }

        return this.sendJson(res, 404, { error: 'Endpoint not found' });
    }

    unavailable(res, what) {
        return this.sendJson(res, 503, { error: `${what} kullanılamıyor`, code: 'UNAVAILABLE' });
    }

    routeEnterprise(method, path, body, res, parsedUrl = null) {
        const query = parsedUrl && parsedUrl.searchParams ? parsedUrl.searchParams : new URLSearchParams();
        // GET /api/v1/inventory - cihaz envanteri (viewer+).
        if (method === 'GET' && path === '/api/v1/inventory') {
            if (!this.deps.inventory || typeof this.deps.inventory.collect !== 'function') {
                return this.unavailable(res, 'Envanter servisi');
            }
            this.deps.inventory.collect()
                .then((inv) => this.sendJson(res, 200, { inventory: inv }))
                .catch((err) => this.sendJson(res, 500, { error: 'Envanter alınamadı', code: 'INVENTORY_FAILED' }));
            return true; // asenkron yanıt
        }

        // POST /api/v1/orders - imzalı konsol emri alımı (operator+).
        if (method === 'POST' && path === '/api/v1/orders') {
            if (!this.deps.queue || typeof this.deps.queue.enqueue !== 'function') {
                return this.unavailable(res, 'Emir kuyruğu');
            }
            const settings = this.storage.getSettings();
            const verifier = new SignedOrderService({ publicKeyPem: settings.consolePublicKeyPem || null, storage: this.storage });
            const v = verifier.verify(body);
            if (!v.ok) {
                const authLike = v.code === 'BAD_SIGNATURE' || v.code === 'NO_TRUST_ANCHOR';
                return this.sendJson(res, authLike ? 401 : 400, { error: v.error, code: v.code });
            }
            let record;
            let duplicate = false;
            try {
                const enq = this.deps.queue.enqueue(body, { idempotencyKey: body.idempotencyKey || null });
                record = enq.record;
                duplicate = enq.duplicate;
            } catch (err) {
                if (err && err.code === 'QUEUE_FULL') {
                    return this.sendJson(res, 429, { error: err.message, code: 'QUEUE_FULL' });
                }
                throw err;
            }
            if (this.deps.audit) {
                this.deps.audit.append({ actor: 'console', action: duplicate ? 'order_duplicate' : 'order_queued', target: v.order.action, detail: v.order.nonce });
            }
            return this.sendJson(res, 201, { success: true, key: record.key, duplicate });
        }

        // GET /api/v1/orders/pending - bekleyen emirler (viewer+).
        if (method === 'GET' && path === '/api/v1/orders/pending') {
            if (!this.deps.queue || typeof this.deps.queue.pending !== 'function') {
                return this.unavailable(res, 'Emir kuyruğu');
            }
            return this.sendJson(res, 200, { orders: this.deps.queue.pending() });
        }

        // Muafiyetler (okuma viewer+, yazma admin - rol kapısı yukarıda).
        if (method === 'GET' && path === '/api/v1/exemptions') {
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            return this.sendJson(res, 200, { exemptions: svc.list() });
        }
        if (method === 'POST' && path === '/api/v1/exemptions') {
            if (body && body.id !== undefined) {
                return this.sendJson(res, 400, { error: 'id sunucu tarafından üretilir.', code: 'CLIENT_ID_FORBIDDEN' });
            }
            const candidate = { ...body, id: `ex_${crypto.randomUUID()}` };
            const check = validateExemption(candidate);
            if (!check.ok) return this.sendJson(res, 400, { error: check.error, code: check.code });
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            const record = svc.add(candidate);
            if (this.deps.audit) {
                this.deps.audit.append({ actor: 'api', action: 'exemption_granted', target: record.id, detail: record.reason });
            }
            return this.sendJson(res, 201, { success: true, exemption: record });
        }
        const exDel = typeof path === 'string' && path.match(/^\/api\/v1\/exemptions\/([^\/]+)$/);
        if (method === 'DELETE' && exDel) {
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            svc.remove(decodeURIComponent(exDel[1]));
            if (this.deps.audit) {
                this.deps.audit.append({ actor: 'api', action: 'exemption_revoked', target: decodeURIComponent(exDel[1]), detail: '' });
            }
            return this.sendJson(res, 200, { success: true });
        }

        // Bakım pencereleri (okuma viewer+, yazma admin).
        if (method === 'GET' && path === '/api/v1/maintenance-windows') {
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            return this.sendJson(res, 200, { windows: svc.windows() });
        }
        if (method === 'POST' && path === '/api/v1/maintenance-windows') {
            if (body && body.id !== undefined) {
                return this.sendJson(res, 400, { error: 'id sunucu tarafından üretilir.', code: 'CLIENT_ID_FORBIDDEN' });
            }
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            const candidate = { ...body, id: `mw_${crypto.randomUUID()}` };
            const check = validateWindow(candidate);
            if (!check.ok) return this.sendJson(res, 400, { error: check.error, code: check.code });
            const record = svc.addWindow(candidate);
            return this.sendJson(res, 201, { success: true, window: record });
        }
        const mwDel = typeof path === 'string' && path.match(/^\/api\/v1\/maintenance-windows\/([^\/]+)$/);
        if (method === 'DELETE' && mwDel) {
            const svc = this.deps.exemptions || new ExemptionService(this.storage);
            svc.removeWindow(decodeURIComponent(mwDel[1]));
            return this.sendJson(res, 200, { success: true });
        }

        // GET /api/v1/audit - O-06: yalnızca admin; sayfalı denetim günlüğü.
        // Zincir doğrulaması ayrı ve pahalı olduğu için varsayılan yanıta dahil edilmez.
        if (method === 'GET' && path === '/api/v1/audit') {
            const audit = this.deps.audit || new AuditLog(this.storage);
            const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
            const beforeSeq = Number(query.get('beforeSeq')) || null;
            const out = { audit: audit.load({ limit, beforeSeq }), limit };
            if (query.get('verify') === '1') out.verify = audit.verify();
            return this.sendJson(res, 200, out);
        }
        if (method === 'GET' && path === '/api/v1/audit/verify') {
            const audit = this.deps.audit || new AuditLog(this.storage);
            return this.sendJson(res, 200, { verify: audit.verify() });
        }

        return null; // kurumsal uç değil
    }

    sendJson(res, statusCode, data) {
        // WP-02.T8 / L-03: Idempotency-Key yanıtı saklanır; aynı anahtar aynı
        // gövdeyi döner. 5xx saklanmaz (geçici hata kalıcılaşmasın).
        if (res && res.__ppIdempotencyKey && statusCode < 500) {
            this.idempotencyCache.set(res.__ppIdempotencyKey, {
                status: statusCode,
                body: data,
                expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
            });
        }
        if (!res || res.headersSent || res.writableEnded) return;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(data));
    }
}

module.exports = LocalApiService;
