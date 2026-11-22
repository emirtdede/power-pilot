/**
 * localapi-http.test.mjs - LocalApiService HTTP katmanı (FAZ A/B)
 *
 * Gerçek soket yalnızca `start/stop/restart` testlerinde ve 127.0.0.1 üzerinde
 * kullanılır. İstek/yönlendirme testleri `handleRequest`'e sahte req/res ile
 * verilir: ağ yok, dış servis yok, gerçek görev yürütülmez (TaskManager sahte).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

import LocalApiService from '../../src/main/services/LocalApiService.js';

const RAW_KEY = 'pp_key_test_123456';
const KEY_HASH = crypto.createHash('sha256').update(RAW_KEY).digest('hex');

function settings(over = {}) {
    return Object.assign({
        localApiEnabled: true,
        localApiPort: 18456,
        localApiKeyHash: KEY_HASH,
        localApiKeyRole: 'admin',
        localApiKeyCreatedAt: Date.now(),
        localApiKeyMasked: 'pp_key_tes...',
        lanModeEnabled: false,
        lanAllowedIps: [],
        localApiTlsEnabled: false,
        localApiTlsStrict: false,
        localApiRequireClientCert: false,
        blockRemoteShutdownWhenActive: false,
        agentDisabled: false,
        agentId: 'agent-1',
        deviceRole: 'workstation'
    }, over);
}

function makeRes() {
    return {
        statusCode: null,
        body: '',
        headers: {},
        headersSent: false,
        writableEnded: false,
        writeHead(code, headers) {
            this.statusCode = code;
            Object.assign(this.headers, headers || {});
            this.headersSent = true;
        },
        setHeader(k, v) { this.headers[k] = v; },
        end(chunk) {
            if (chunk !== undefined && chunk !== null) this.body += String(chunk);
            this.writableEnded = true;
        }
    };
}

/**
 * Sahte istek: handleRequest senkron dinleyici bağlar, gövde bir sonraki
 * turda 'data'+'end' olarak beslenir.
 */
function makeReq({ method = 'GET', url = '/api/v1/status', headers = {}, ip = '127.0.0.1', body = null, socketExtra = null } = {}) {
    const listeners = {};
    const req = {
        method,
        url,
        headers: Object.assign({}, headers),
        socket: Object.assign({ remoteAddress: ip, end: vi.fn() }, socketExtra || {}),
        destroyed: false,
        on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return req; },
        destroy() { req.destroyed = true; },
        _emit(ev, arg) { for (const fn of listeners[ev] || []) fn(arg); }
    };
    setImmediate(() => {
        if (body !== null && body !== undefined) {
            req._emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        req._emit('end');
    });
    return req;
}

const authHeaders = (extra = {}) => Object.assign({ 'x-api-key': RAW_KEY }, extra);

function makeService({ store = settings(), taskManager = null, deps = {} } = {}) {
    const storage = {
        settings: store,
        getSettings() { return this.settings; },
        updateSettings(patch) { this.settings = Object.assign({}, this.settings, patch); return true; }
    };
    const tm = taskManager || {
        pausedAll: false,
        tasks: [],
        getActiveTasks: () => [],
        createTask: vi.fn(() => ({ id: 'task_new', toJSON: () => ({ id: 'task_new' }) })),
        cancelTask: vi.fn(() => ({ ok: true, code: 'CANCELLED' }))
    };
    const svc = new LocalApiService(storage, tm, { execute: vi.fn() }, deps);
    return { svc, storage, tm };
}

async function call(svc, opts) {
    const req = makeReq(opts);
    const res = makeRes();
    svc.handleRequest(req, res);
    await new Promise((r) => setTimeout(r, 15));
    return { res, req, json: (() => { try { return JSON.parse(res.body); } catch (_) { return null; } })() };
}

describe('LocalApiService - static yardımcılar', () => {
    it('roleOf bilinmeyen/boş rolde null (fail-closed)', () => {
        expect(LocalApiService.roleOf({ localApiKeyRole: 'admin' })).toBe('admin');
        expect(LocalApiService.roleOf({ localApiKeyRole: 'root' })).toBeNull();
        expect(LocalApiService.roleOf({})).toBeNull();
        expect(LocalApiService.roleOf(null)).toBeNull();
    });

    it('requiredRole uç başına asgari rol', () => {
        expect(LocalApiService.requiredRole('GET', '/api/v1/status')).toBe('viewer');
        expect(LocalApiService.requiredRole('GET', '/api/v1/audit')).toBe('admin');
        expect(LocalApiService.requiredRole('GET', '/api/v1/audit/verify')).toBe('admin');
        expect(LocalApiService.requiredRole('POST', '/api/v1/exemptions')).toBe('admin');
        expect(LocalApiService.requiredRole('DELETE', '/api/v1/exemptions/ex_1')).toBe('admin');
        expect(LocalApiService.requiredRole('POST', '/api/v1/maintenance-windows')).toBe('admin');
        expect(LocalApiService.requiredRole('DELETE', '/api/v1/maintenance-windows/mw_1')).toBe('admin');
        expect(LocalApiService.requiredRole('POST', '/api/v1/power/shutdown')).toBe('admin');
        expect(LocalApiService.requiredRole('POST', '/api/v1/power/restart')).toBe('admin');
        expect(LocalApiService.requiredRole('POST', '/api/v1/tasks/t1/cancel')).toBe('operator');
        expect(LocalApiService.requiredRole('POST', '/api/v1/tasks/timer')).toBe('operator');
    });

    it('isApiKeyRotationDue 90 gün eşiği', () => {
        const now = Date.now();
        expect(LocalApiService.isApiKeyRotationDue({}, now)).toBe(false);
        expect(LocalApiService.isApiKeyRotationDue({ localApiKeyCreatedAt: now - 89 * 86400000 }, now)).toBe(false);
        expect(LocalApiService.isApiKeyRotationDue({ localApiKeyCreatedAt: now - 91 * 86400000 }, now)).toBe(true);
    });
});

describe('LocalApiService - yapılandırma / status', () => {
    it('TLS materyali yoksa resolveTlsMaterial null', () => {
        const { svc } = makeService();
        expect(svc.resolveTlsMaterial({})).toBeNull();
        expect(svc.getServerOptions({ localApiTlsEnabled: true })).toBeNull();
    });

    it('TLS materyali dosyadan okunur', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tls-'));
        try {
            const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
            const certFile = path.join(dir, 'c.pem');
            const keyFile = path.join(dir, 'k.pem');
            fs.writeFileSync(certFile, pems.cert);
            fs.writeFileSync(keyFile, pems.private);
            const { svc } = makeService();
            const mat = svc.resolveTlsMaterial({ localApiTlsEnabled: true, localApiCertFile: certFile, localApiKeyFile: keyFile });
            expect(mat).not.toBeNull();
            expect(mat.cert).toBeTruthy();
            expect(mat.key).toBeTruthy();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('getSecurityStatus sözleşmesi', () => {
        const { svc } = makeService({ store: settings({ localApiKeyCreatedAt: Date.now() - 91 * 86400000 }) });
        const st = svc.getSecurityStatus();
        expect(st).toMatchObject({ transport: 'disabled', tlsEnabled: false, apiKeySet: true, keyRole: 'admin', rotationDue: true, lanMode: false });
        expect(st.diagnostics.rateLimitKeys).toBe(0);
        expect(typeof st.diagnostics.aclAllowed).toBe('number');
    });

    it('getDiagnostics sayaçları döner', () => {
        const { svc } = makeService();
        svc.diagnostics.aclDenied = 3;
        expect(svc.getDiagnostics()).toEqual({ aclAllowed: 0, aclDenied: 3, rateLimited: 0, rateLimitKeys: 0 });
    });

    it('generateApiKey rol verir, kalıcılık başarısızsa hata fırlatır', () => {
        const { svc, storage } = makeService();
        const key = svc.generateApiKey('operator');
        expect(key.startsWith('pp_key_')).toBe(true);
        expect(storage.settings.localApiKeyRole).toBe('operator');
        expect(storage.settings.localApiKeyHash).toBe(crypto.createHash('sha256').update(key).digest('hex'));

        const bad = makeService();
        bad.storage.updateSettings = () => false;
        expect(() => bad.svc.generateApiKey('viewer')).toThrow(/kalıcılaştırılamadı/);
        // Geçersiz rol en yüksek yetkiye düşmez
        const third = makeService();
        third.svc.generateApiKey('root');
        expect(third.storage.settings.localApiKeyRole).toBe('viewer');
    });

    it('isRemoteShutdownBlocked: eylem kümesi + idle sağlayıcı', () => {
        const { svc } = makeService();
        const on = { blockRemoteShutdownWhenActive: true };
        expect(svc.isRemoteShutdownBlocked(on, 'lock')).toBe(true); // sağlayıcı yok → fail-closed
        expect(svc.isRemoteShutdownBlocked({}, 'shutdown')).toBe(false);
        expect(svc.isRemoteShutdownBlocked(on, 'shutdown')).toBe(true); // sağlayıcı yok → fail-closed

        const idle = makeService({ deps: { idleProvider: () => 5 } });
        expect(idle.svc.isRemoteShutdownBlocked(on, 'shutdown')).toBe(true);
        const idleOk = makeService({ deps: { idleProvider: () => 120 } });
        expect(idleOk.svc.isRemoteShutdownBlocked(on, 'sleep')).toBe(false);
        const pm = makeService({ deps: { powerMonitor: { getSystemIdleTime: () => 300 } } });
        expect(pm.svc.isRemoteShutdownBlocked(on, 'hibernate')).toBe(false);
        const pmActive = makeService({ deps: { powerMonitor: { getSystemIdleTime: () => 1 } } });
        expect(pmActive.svc.isRemoteShutdownBlocked(on, 'signout')).toBe(true);
        const broken = makeService({ deps: { idleProvider: () => { throw new Error('x'); } } });
        expect(broken.svc.isRemoteShutdownBlocked(on, 'restart')).toBe(true);
        const badValue = makeService({ deps: { idleProvider: () => 'abc' } });
        expect(badValue.svc.isRemoteShutdownBlocked(on, 'restart')).toBe(true);
    });
});

describe('LocalApiService - kimlik doğrulama ve ACL', () => {
    it('loopback dışı + boş allowlist → 403 IP_NOT_ALLOWED', async () => {
        const { svc } = makeService();
        const { res, json } = await call(svc, { headers: authHeaders(), ip: '10.1.2.3' });
        expect(res.statusCode).toBe(403);
        expect(json.code).toBe('IP_NOT_ALLOWED');
        expect(svc.diagnostics.aclDenied).toBe(1);
    });

    it('allowlist\'teki LAN IP kabul edilir', async () => {
        const { svc } = makeService({ store: settings({ lanAllowedIps: ['10.0.0.0/8'] }) });
        const { res, json } = await call(svc, { headers: authHeaders(), ip: '10.1.2.3' });
        expect(res.statusCode).toBe(200);
        expect(json.status).toBe('online');
    });

    it('mTLS zorunlu ama sertifika yok → 401 MTLS_REQUIRED ve soket kapatılır', async () => {
        const { svc } = makeService({ store: settings({ localApiRequireClientCert: true }) });
        const { res, json, req } = await call(svc, { headers: authHeaders() });
        expect(res.statusCode).toBe(401);
        expect(json.code).toBe('MTLS_REQUIRED');
        expect(res.headers.Connection).toBe('close');
        expect(req.socket.end).toHaveBeenCalled();
    });

    it('anahtar yok / yanlış anahtar → 401', async () => {
        const { svc } = makeService();
        const noKey = await call(svc, {});
        expect(noKey.res.statusCode).toBe(401);
        const badKey = await call(svc, { headers: { 'x-api-key': 'yanlış' } });
        expect(badKey.json.code).toBe('UNAUTHORIZED');
    });

    it('Bearer şeması büyük/küçük harf duyarsız', async () => {
        const { svc } = makeService();
        const { res } = await call(svc, { headers: { authorization: `bearer ${RAW_KEY}` } });
        expect(res.statusCode).toBe(200);
        expect(svc.extractBearerToken('Bearer abc')).toBe('abc');
        expect(svc.extractBearerToken('Basic abc')).toBeNull();
        expect(svc.extractBearerToken(null)).toBeNull();
    });

    it('başarısız auth 11. denemede 429 (AUTH_RATE_LIMITED)', async () => {
        const { svc } = makeService();
        for (let i = 0; i < 10; i += 1) {
            await call(svc, { headers: { 'x-api-key': 'yanlış' } });
        }
        const { res, json } = await call(svc, { headers: { 'x-api-key': 'yanlış' } });
        expect(res.statusCode).toBe(429);
        expect(json.code).toBe('AUTH_RATE_LIMITED');
        expect(res.headers['Retry-After']).toBe('60');
    });

    it('mTLS parmak izi allowlist\'i uygulanır', () => {
        const fp = 'AB'.repeat(32);
        const { svc } = makeService({ store: settings({ localApiRequireClientCert: true, localApiClientFingerprints: [fp] }) });
        const req = { socket: { authorized: true, authorizationError: null, getPeerCertificate: () => ({ fingerprint256: fp.split('').join(':').replace(/^:|:$/g, '') }) } };
        expect(svc.isClientCertOk(req, settings({ localApiRequireClientCert: true }))).toBe(true);
        const mismatch = { socket: { authorized: true, authorizationError: null, getPeerCertificate: () => ({ fingerprint256: 'CD'.repeat(32) }) } };
        expect(svc.isClientCertOk(mismatch, settings({ localApiRequireClientCert: true, localApiClientFingerprints: [fp] }))).toBe(false);
        expect(svc.isClientCertOk({ socket: { authorized: false } }, settings({ localApiRequireClientCert: true }))).toBe(false);
        expect(svc.isClientCertOk({ socket: {} }, settings({ localApiRequireClientCert: true }))).toBe(false);
        expect(svc.isClientCertOk({ socket: { authorized: true, getPeerCertificate: () => ({}) } }, settings({ localApiRequireClientCert: true }))).toBe(false);
        expect(svc.isClientCertOk({ socket: {} }, settings())).toBe(true);
    });
});

describe('LocalApiService - istek gövdesi ve idempotency', () => {
    it('POST JSON olmayan içerik tipi → 415', async () => {
        const { svc } = makeService();
        const { res, json } = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: authHeaders({ 'content-type': 'text/plain' }), body: {} });
        expect(res.statusCode).toBe(415);
        expect(json.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('geçersiz JSON → 400', async () => {
        const { svc } = makeService();
        const { res, json } = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: authHeaders({ 'content-type': 'application/json' }), body: '{bozuk' });
        expect(res.statusCode).toBe(400);
        expect(json.error).toMatch(/Invalid JSON/);
    });

    it('100 KB üstü gövde → 413 ve bağlantı kapatılır', async () => {
        const { svc } = makeService();
        const big = JSON.stringify({ name: 'a'.repeat(120 * 1024) });
        const { res, json, req } = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: authHeaders({ 'content-type': 'application/json' }), body: big });
        expect(res.statusCode).toBe(413);
        expect(json.code).toBe('PAYLOAD_TOO_LARGE');
        expect(req.destroyed).toBe(true);
    });

    it('geçersiz URL → 400 BAD_URL', async () => {
        const { svc } = makeService();
        const { res } = await call(svc, { url: 'http://[geçersiz', headers: authHeaders() });
        expect(res.statusCode).toBe(400);
    });

    it('Idempotency-Key aynı yanıtı döndürür (metot+yol+gövde+anahtar kapsamı)', async () => {
        const { svc, tm } = makeService();
        const opts = {
            method: 'POST',
            url: '/api/v1/tasks/timer',
            headers: authHeaders({ 'content-type': 'application/json', 'idempotency-key': 'k-1' }),
            body: { action: 'shutdown', durationMs: 60000 }
        };
        const first = await call(svc, opts);
        const second = await call(svc, opts);
        expect(first.res.statusCode).toBe(201);
        expect(second.res.statusCode).toBe(201);
        expect(second.res.body).toBe(first.res.body);
        expect(tm.createTask).toHaveBeenCalledTimes(1);
    });

    it('idempotency 5xx yanıtı saklanmaz', async () => {
        const { svc } = makeService({ deps: { inventory: { collect: async () => { throw new Error('x'); } } } });
        const opts = { method: 'GET', url: '/api/v1/inventory', headers: authHeaders({ 'idempotency-key': 'k-2' }) };
        await call(svc, opts);
        expect(svc.idempotencyCache.size).toBe(0);
    });

    it('pruneIdempotency süresi geçenleri siler', () => {
        const { svc } = makeService();
        svc.idempotencyCache.set('a', { status: 200, body: {}, expiresAt: Date.now() - 1 });
        svc.idempotencyCache.set('b', { status: 200, body: {}, expiresAt: Date.now() + 100000 });
        svc.idempotencyCache.set('c', { status: 200, body: {} });
        svc.pruneIdempotency();
        expect([...svc.idempotencyCache.keys()]).toEqual(['b']);
    });

    it('rate limit: 60 istek/dk sonra 429; budama anahtar sayısını sınırlar', () => {
        const { svc } = makeService();
        for (let i = 0; i < 60; i += 1) expect(svc.isRateLimited('127.0.0.1:h')).toBe(false);
        expect(svc.isRateLimited('127.0.0.1:h')).toBe(true);
        for (let i = 0; i < 1100; i += 1) svc.requestCounts.set(`k${i}`, [Date.now()]);
        svc.pruneRateLimit();
        expect(svc.requestCounts.size).toBeLessThanOrEqual(1000);
    });
});

describe('LocalApiService - rol kapısı ve çekirdek uçlar', () => {
    const asRole = (role) => makeService({ store: settings({ localApiKeyRole: role }) });

    it('viewer GET /status izinli, audit 403, POST 403', async () => {
        const { svc } = asRole('viewer');
        const status = await call(svc, { headers: authHeaders() });
        expect(status.res.statusCode).toBe(200);
        expect(status.json.keyRole).toBe('viewer');

        const audit = await call(svc, { url: '/api/v1/audit', headers: authHeaders() });
        expect(audit.res.statusCode).toBe(403);
        expect(audit.json.code).toBe('FORBIDDEN');

        const post = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: authHeaders({ 'content-type': 'application/json' }), body: { action: 'lock', durationMs: 1000 } });
        expect(post.res.statusCode).toBe(403);
    });

    it('operator POST /tasks/timer izinli; power/shutdown admin ister', async () => {
        const { svc, tm } = asRole('operator');
        const timer = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: authHeaders({ 'content-type': 'application/json' }), body: { action: 'lock', durationMs: 1000 } });
        expect(timer.res.statusCode).toBe(201);
        expect(tm.createTask).toHaveBeenCalled();

        const shutdown = await call(svc, { method: 'POST', url: '/api/v1/power/shutdown', headers: authHeaders({ 'content-type': 'application/json' }), body: {} });
        expect(shutdown.res.statusCode).toBe(403);
    });

    it('rol tanımsızsa hiçbir uç yetkili değil (403)', async () => {
        const { svc } = asRole('root');
        const { res } = await call(svc, { headers: authHeaders() });
        expect(res.statusCode).toBe(403);
    });

    it('GET /tasks sayfalanır (limit/offset/hasMore)', async () => {
        const tasks = Array.from({ length: 5 }, (_, i) => ({ toJSON: () => ({ id: `t${i}` }) }));
        const { svc } = makeService({ taskManager: { pausedAll: false, tasks, getActiveTasks: () => [], createTask: vi.fn(), cancelTask: vi.fn() } });
        const page = await call(svc, { url: '/api/v1/tasks?limit=2&offset=2', headers: authHeaders() });
        expect(page.json.total).toBe(5);
        expect(page.json.tasks.map((t) => t.id)).toEqual(['t2', 't3']);
        expect(page.json.hasMore).toBe(true);
        const clamp = await call(svc, { url: '/api/v1/tasks?limit=99999&offset=-5', headers: authHeaders() });
        expect(clamp.json.limit).toBe(500);
        expect(clamp.json.offset).toBe(0);
    });

    it('POST /tasks/timer doğrulamaları', async () => {
        const { svc } = makeService();
        const h = authHeaders({ 'content-type': 'application/json' });
        const missing = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: {} });
        expect(missing.res.statusCode).toBe(400);
        const badAction = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: { action: 'format', durationMs: 1000 } });
        expect(badAction.res.statusCode).toBe(400);
        const badDuration = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: { action: 'lock', durationMs: 1.5 } });
        expect(badDuration.res.statusCode).toBe(400);
        const tooLong = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: { action: 'lock', durationMs: 2500000001 } });
        expect(tooLong.res.statusCode).toBe(400);
        const badName = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: { action: 'lock', durationMs: 1000, name: 5 } });
        expect(badName.res.statusCode).toBe(400);
        const xssName = await call(svc, { method: 'POST', url: '/api/v1/tasks/timer', headers: h, body: { action: 'lock', durationMs: 1000, name: '<b>' } });
        expect(xssName.res.statusCode).toBe(400);
    });

    it('POST /tasks/:id/cancel sonuç eşlemesi', async () => {
        const h = authHeaders({ 'content-type': 'application/json' });
        const notFound = makeService({ taskManager: { pausedAll: false, tasks: [], getActiveTasks: () => [], createTask: vi.fn(), cancelTask: () => ({ ok: false, code: 'NOT_FOUND' }) } });
        const r1 = await call(notFound.svc, { method: 'POST', url: '/api/v1/tasks/t9/cancel', headers: h, body: {} });
        expect(r1.res.statusCode).toBe(404);
        expect(r1.json.code).toBe('TASK_NOT_FOUND');

        const late = makeService({ taskManager: { pausedAll: false, tasks: [], getActiveTasks: () => [], createTask: vi.fn(), cancelTask: () => ({ ok: true, code: 'CANCEL_TOO_LATE', message: 'çok geç' }) } });
        const r2 = await call(late.svc, { method: 'POST', url: '/api/v1/tasks/t9/cancel', headers: h, body: {} });
        expect(r2.res.statusCode).toBe(409);
        expect(r2.json.code).toBe('CANCEL_TOO_LATE');

        const already = makeService({ taskManager: { pausedAll: false, tasks: [], getActiveTasks: () => [], createTask: vi.fn(), cancelTask: () => ({ ok: true, code: 'ALREADY_CANCELLED' }) } });
        const r3 = await call(already.svc, { method: 'POST', url: '/api/v1/tasks/t9/cancel', headers: h, body: {} });
        expect(r3.res.statusCode).toBe(409);

        const failed = makeService({ taskManager: { pausedAll: false, tasks: [], getActiveTasks: () => [], createTask: vi.fn(), cancelTask: () => ({ ok: false, code: 'CANCEL_FAILED' }) } });
        const r4 = await call(failed.svc, { method: 'POST', url: '/api/v1/tasks/t9/cancel', headers: h, body: {} });
        expect(r4.res.statusCode).toBe(400);

        const ok = makeService();
        const r5 = await call(ok.svc, { method: 'POST', url: '/api/v1/tasks/t9/cancel', headers: h, body: {} });
        expect(r5.res.statusCode).toBe(200);
        expect(r5.json.success).toBe(true);
    });

    it('power rotaları görev hattına girer; aktif kullanıcıda 403', async () => {
        const h = authHeaders({ 'content-type': 'application/json' });
        const { svc, tm } = makeService({ store: settings({ blockRemoteShutdownWhenActive: true }), deps: { idleProvider: () => 0 } });
        const blocked = await call(svc, { method: 'POST', url: '/api/v1/power/lock', headers: h, body: {} });
        expect(blocked.res.statusCode).toBe(403);
        expect(blocked.json.code).toBe('REMOTE_SHUTDOWN_BLOCKED');

        const open = makeService({ deps: { idleProvider: () => 600 } });
        for (const [route, action] of [['/lock', 'lock'], ['/signout', 'signout'], ['/restart', 'restart'], ['/sleep', 'sleep'], ['/hibernate', 'hibernate']]) {
            const r = await call(open.svc, { method: 'POST', url: `/api/v1/power${route}`, headers: h, body: {} });
            expect(r.res.statusCode).toBe(200);
            expect(open.tm.createTask.mock.calls.some((c) => c[0].action === action)).toBe(true);
        }
        const shutdown = await call(open.svc, { method: 'POST', url: '/api/v1/power/shutdown', headers: h, body: {} });
        expect(shutdown.res.statusCode).toBe(200);
        expect(shutdown.json.taskId).toBe('task_new');
        expect(tm).toBeTruthy();
    });

    it('bilinmeyen uç 404', async () => {
        const { svc } = makeService();
        const { res, json } = await call(svc, { url: '/api/v1/nope', headers: authHeaders() });
        expect(res.statusCode).toBe(404);
        expect(json.error).toMatch(/not found/i);
    });
});

describe('LocalApiService - kurumsal uçlar', () => {
    const h = () => authHeaders({ 'content-type': 'application/json' });

    it('GET /inventory: servis yoksa 503, varsa 200, hata 500', async () => {
        const none = makeService();
        expect((await call(none.svc, { url: '/api/v1/inventory', headers: h() })).res.statusCode).toBe(503);

        const ok = makeService({ deps: { inventory: { collect: async () => ({ hostname: 'pc' }) } } });
        const r = await call(ok.svc, { url: '/api/v1/inventory', headers: h() });
        expect(r.res.statusCode).toBe(200);
        expect(r.json.inventory.hostname).toBe('pc');

        const bad = makeService({ deps: { inventory: { collect: async () => { throw new Error('x'); } } } });
        const e = await call(bad.svc, { url: '/api/v1/inventory', headers: h() });
        expect(e.res.statusCode).toBe(500);
    });

    it('POST /orders: kuyruk yok 503, imza hatası 401/400, kuyruk dolu 429, başarı 201', async () => {
        const none = makeService();
        expect((await call(none.svc, { method: 'POST', url: '/api/v1/orders', headers: h(), body: {} })).res.statusCode).toBe(503);

        const queue = { enqueue: vi.fn(() => ({ record: { key: 'k1' }, duplicate: false })), pending: () => [{ key: 'k1' }] };
        const { svc } = makeService({ deps: { queue, audit: { append: vi.fn() } } });
        const unsigned = await call(svc, { method: 'POST', url: '/api/v1/orders', headers: h(), body: { action: 'lock' } });
        expect([400, 401]).toContain(unsigned.res.statusCode);

        const full = makeService({ deps: { queue: { enqueue: () => { const e = new Error('dolu'); e.code = 'QUEUE_FULL'; throw e; }, pending: () => [] } } });
        // Geçerli imza gerektiği için önce imza doğrulamasını geçemeyeceğiz;
        // kuyruk dolu dalı ancak doğrulanmış emirde çalışır.
        const res = makeRes();
        const out = full.svc.route('POST', '/api/v1/orders', { action: 'lock' }, res, { role: 'admin' });
        expect([400, 401]).toContain(res.statusCode);
        expect(out).toBeUndefined();
    });

    it('POST /orders: geçerli imzalı emir kuyruğa girer (201) ve dolu kuyruk 429 döner', async () => {
        const orderMod = require('../../src/main/services/SignedOrderService.js');
        const { publicKey, privateKey } = orderMod.generateKeyPair();
        const signed = orderMod.sign({ action: 'lock', targets: ['agent-1'] }, privateKey);

        const audit = { append: vi.fn() };
        const queue = { enqueue: vi.fn(() => ({ record: { key: 'order-1' }, duplicate: false })), pending: () => [] };
        const { svc } = makeService({ store: settings({ consolePublicKeyPem: publicKey }), deps: { queue, audit } });
        const ok = await call(svc, { method: 'POST', url: '/api/v1/orders', headers: h(), body: signed });
        expect(ok.res.statusCode).toBe(201);
        expect(ok.json).toMatchObject({ success: true, key: 'order-1', duplicate: false });
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_queued' }));

        const fullQueue = { enqueue: () => { const e = new Error('Kuyruk dolu'); e.code = 'QUEUE_FULL'; throw e; }, pending: () => [] };
        const full = makeService({ store: settings({ consolePublicKeyPem: publicKey }), deps: { queue: fullQueue } });
        const fullRes = await call(full.svc, { method: 'POST', url: '/api/v1/orders', headers: h(), body: signed });
        expect(fullRes.res.statusCode).toBe(429);
        expect(fullRes.json.code).toBe('QUEUE_FULL');
    });

    it('GET /orders/pending', async () => {
        const none = makeService();
        expect((await call(none.svc, { url: '/api/v1/orders/pending', headers: h() })).res.statusCode).toBe(503);
        const { svc } = makeService({ deps: { queue: { pending: () => [{ key: 'a' }] } } });
        const r = await call(svc, { url: '/api/v1/orders/pending', headers: h() });
        expect(r.json.orders).toEqual([{ key: 'a' }]);
    });

    it('muafiyetler: listeleme, id yasak, doğrulama, ekleme, silme + audit', async () => {
        const audit = { append: vi.fn() };
        const exemptions = {
            list: () => [{ id: 'ex_1' }],
            windows: () => [{ id: 'mw_1' }],
            add: (x) => x,
            remove: vi.fn(),
            addWindow: (x) => x,
            removeWindow: vi.fn()
        };
        const { svc } = makeService({ deps: { exemptions, audit } });
        expect((await call(svc, { url: '/api/v1/exemptions', headers: h() })).json.exemptions).toEqual([{ id: 'ex_1' }]);

        const withId = await call(svc, { method: 'POST', url: '/api/v1/exemptions', headers: h(), body: { id: 'ex_x', reason: 'x' } });
        expect(withId.res.statusCode).toBe(400);
        expect(withId.json.code).toBe('CLIENT_ID_FORBIDDEN');

        const invalid = await call(svc, { method: 'POST', url: '/api/v1/exemptions', headers: h(), body: {} });
        expect(invalid.res.statusCode).toBe(400);

        const del = await call(svc, { method: 'DELETE', url: '/api/v1/exemptions/ex%201', headers: h() });
        expect(del.res.statusCode).toBe(200);
        expect(exemptions.remove).toHaveBeenCalledWith('ex 1');
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'exemption_revoked' }));
    });

    it('bakım pencereleri: listeleme, id yasak, ekleme, silme', async () => {
        const exemptions = {
            list: () => [], windows: () => [{ id: 'mw_1' }],
            add: (x) => x, remove: vi.fn(), addWindow: (x) => x, removeWindow: vi.fn()
        };
        const { svc } = makeService({ deps: { exemptions } });
        expect((await call(svc, { url: '/api/v1/maintenance-windows', headers: h() })).json.windows).toEqual([{ id: 'mw_1' }]);
        const withId = await call(svc, { method: 'POST', url: '/api/v1/maintenance-windows', headers: h(), body: { id: 'x' } });
        expect(withId.json.code).toBe('CLIENT_ID_FORBIDDEN');
        const invalid = await call(svc, { method: 'POST', url: '/api/v1/maintenance-windows', headers: h(), body: {} });
        expect(invalid.res.statusCode).toBe(400);
        const del = await call(svc, { method: 'DELETE', url: '/api/v1/maintenance-windows/mw_1', headers: h() });
        expect(del.res.statusCode).toBe(200);
        expect(exemptions.removeWindow).toHaveBeenCalledWith('mw_1');
    });

    it('audit: sayfalama + verify', async () => {
        const audit = { load: vi.fn(() => [{ seq: 1 }]), verify: vi.fn(() => ({ ok: true })) };
        const { svc } = makeService({ deps: { audit } });
        const page = await call(svc, { url: '/api/v1/audit?limit=1&beforeSeq=5', headers: h() });
        expect(page.json.audit).toEqual([{ seq: 1 }]);
        expect(page.json.verify).toBeUndefined();
        expect(audit.load).toHaveBeenCalledWith({ limit: 1, beforeSeq: 5 });

        const verify = await call(svc, { url: '/api/v1/audit?verify=1', headers: h() });
        expect(verify.json.verify).toEqual({ ok: true });

        const verifyOnly = await call(svc, { url: '/api/v1/audit/verify', headers: h() });
        expect(verifyOnly.json.verify).toEqual({ ok: true });
    });
});

describe('LocalApiService - sunucu yaşam döngüsü (127.0.0.1)', () => {
    const started = [];
    afterEach(async () => {
        for (const svc of started.splice(0)) {
            try { await svc.stop(); } catch (_) { /* yut */ }
        }
    });

    async function freePort() {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.unref();
            srv.on('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const { port } = srv.address();
                srv.close(() => resolve(port));
            });
        });
    }

    it('API kapalıysa API_DISABLED', async () => {
        const { svc } = makeService({ store: settings({ localApiEnabled: false }) });
        await expect(svc.start()).resolves.toMatchObject({ ok: false, code: 'API_DISABLED' });
    });

    it('TLS açık ama materyal yok → TLS_MATERIAL_MISSING', async () => {
        const { svc } = makeService({ store: settings({ localApiTlsEnabled: true }) });
        await expect(svc.start()).resolves.toMatchObject({ ok: false, code: 'TLS_MATERIAL_MISSING' });
    });

    it('LAN modu TLS olmadan → LAN_REQUIRES_TLS', async () => {
        const { svc } = makeService({ store: settings({ lanModeEnabled: true, lanAllowedIps: ['10.0.0.0/8'] }) });
        await expect(svc.start()).resolves.toMatchObject({ ok: false, code: 'LAN_REQUIRES_TLS' });
    });

    it('LAN modu allowlist boşsa yalnız loopback dinlenir (uyarı)', async () => {
        const port = await freePort();
        const { svc } = makeService({ store: settings({ lanModeEnabled: true, lanAllowedIps: [], localApiPort: port }) });
        const r = await svc.start();
        started.push(svc);
        expect(r).toMatchObject({ ok: true, host: '127.0.0.1', transport: 'http' });
        await expect(svc.start()).resolves.toMatchObject({ ok: false, code: 'ALREADY_RUNNING' });
    });

    it('HTTP sunucu başlar, gerçek istek yanıtlanır ve durur', async () => {
        const port = await freePort();
        const { svc } = makeService({ store: settings({ localApiPort: port }) });
        const r = await svc.start();
        started.push(svc);
        expect(r.ok).toBe(true);
        expect(svc.getSecurityStatus().transport).toBe('http');

        const status = await new Promise((resolve, reject) => {
            const req = require('node:http').request({ host: '127.0.0.1', port, path: '/api/v1/status', headers: { 'x-api-key': RAW_KEY } }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(body) }));
            });
            req.on('error', reject);
            req.end();
        });
        expect(status.code).toBe(200);
        expect(status.body.app).toBe('Power Pilot');

        await svc.stop();
        expect(svc.getSecurityStatus().transport).toBe('disabled');
        await expect(svc.stop()).resolves.toEqual({ ok: true });
    });

    it('HTTPS sunucu self-signed sertifikayla başlar', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tls2-'));
        const port = await freePort();
        try {
            const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
            const certFile = path.join(dir, 'c.pem');
            const keyFile = path.join(dir, 'k.pem');
            fs.writeFileSync(certFile, pems.cert);
            fs.writeFileSync(keyFile, pems.private);
            const { svc } = makeService({ store: settings({ localApiPort: port, localApiTlsEnabled: true, localApiCertFile: certFile, localApiKeyFile: keyFile }) });
            const r = await svc.start();
            started.push(svc);
            expect(r).toMatchObject({ ok: true, transport: 'https' });
            expect(svc.getSecurityStatus().httpsActive).toBe(true);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('port kullanımda ise bind hatası koda döner (çökme yok)', async () => {
        const port = await freePort();
        const blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
        try {
            const { svc } = makeService({ store: settings({ localApiPort: port }) });
            const r = await svc.start();
            expect(r.ok).toBe(false);
            expect(typeof r.code).toBe('string');
            expect(svc.getSecurityStatus().transport).toBe('disabled');
        } finally {
            await new Promise((resolve) => blocker.close(resolve));
        }
    });

    it('restart stop+start yapar', async () => {
        const port = await freePort();
        const { svc } = makeService({ store: settings({ localApiPort: port }) });
        await svc.start();
        started.push(svc);
        const r = await svc.restart();
        expect(r.ok).toBe(true);
        expect(svc.getSecurityStatus().transport).toBe('http');
    });
});
