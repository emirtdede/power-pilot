/**
 * localapi-auth.test.mjs - LocalApiService handleRequest: auth, rate-limit, LAN, JSON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import LocalApiService from '../../src/main/services/LocalApiService.js';

const TEST_KEY = 'pp_key_test123';
const TEST_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex');

function makeService(settingsOverrides = {}) {
    const storage = {
        getSettings: () => Object.assign(
            { localApiKeyHash: TEST_HASH, localApiKeyRole: 'admin', localApiEnabled: true, localApiPort: 18456, lanModeEnabled: false, lanAllowedIps: ['127.0.0.1'] },
            settingsOverrides
        ),
        updateSettings: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        pausedAll: false,
        tasks: [],
        createTask: vi.fn((data) => ({ id: 't1', toJSON: () => ({ id: 't1', ...data }) })),
        cancelTask: vi.fn()
    };
    const powerService = { execute: vi.fn(async () => ({ success: true })) };
    return { svc: new LocalApiService(storage, taskManager, powerService), storage, taskManager, powerService };
}

function fakeReq({ ip = '127.0.0.1', headers = {}, url = '/api/v1/status', method = 'GET' } = {}) {
    const handlers = {};
    return {
        socket: { remoteAddress: ip },
        headers, url, method,
        on(ev, fn) { handlers[ev] = fn; return this; },
        // handleRequest erken dönüşlerde (401/403/429) gövde dinleyicisi takmaz;
        // o durumda yanıt zaten senkron yazılmıştır, __send çağrılmaz.
        __send(bodyStr) {
            if (bodyStr && handlers.data) handlers.data(bodyStr);
            handlers.end();
        },
        __hasBodyListener() { return typeof handlers.end === 'function'; }
    };
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
    };
}

function authedGet(svc, path = '/api/v1/status', extra = {}) {
    const req = fakeReq({ url: path, method: 'GET', headers: { 'x-api-key': TEST_KEY }, ...extra });
    const res = fakeRes();
    svc.handleRequest(req, res);
    if (req.__hasBodyListener()) req.__send('');
    return res;
}

function sendWith(svc, req, bodyStr) {
    const res = fakeRes();
    svc.handleRequest(req, res);
    if (req.__hasBodyListener()) req.__send(bodyStr);
    return res;
}

describe('LocalApiService kimlik doğrulama', () => {
    let ctx;
    beforeEach(() => { ctx = makeService(); });

    it('anahtar yoksa 401', () => {
        const res = sendWith(ctx.svc, fakeReq(), '');
        expect(res.statusCode).toBe(401);
    });

    it('yanlış anahtar 401', () => {
        const res = sendWith(ctx.svc, fakeReq({ headers: { 'x-api-key': 'pp_key_yanlis' } }), '');
        expect(res.statusCode).toBe(401);
    });

    it('Bearer başlığı da kabul edilir', () => {
        const res = sendWith(ctx.svc, fakeReq({ headers: { authorization: `Bearer ${TEST_KEY}` } }), '');
        expect(res.statusCode).toBe(200);
    });

    it('geçerli anahtar + status 200', () => {
        const res = authedGet(ctx.svc);
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe('online');
    });

    it('bozuk JSON 400', () => {
        const res = sendWith(ctx.svc, fakeReq({ url: '/api/v1/tasks/timer', method: 'POST', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' } }), '{bozuk');
        expect(res.statusCode).toBe(400);
    });

    it('POST gövdesinde JSON content-type zorunlu (415)', () => {
        const res = sendWith(ctx.svc, fakeReq({ url: '/api/v1/tasks/timer', method: 'POST', headers: { 'x-api-key': TEST_KEY } }), '{}');
        expect(res.statusCode).toBe(415);
        expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('dakikada 61. istek 429 alır', () => {
        let last;
        for (let i = 0; i < 61; i++) last = authedGet(ctx.svc);
        expect(last.statusCode).toBe(429);
    });

    it('LAN modunda izinli olmayan IP 403 alır', () => {
        const lan = makeService({ lanModeEnabled: true, lanAllowedIps: ['192.168.1.10'] });
        const res = sendWith(lan.svc, fakeReq({ ip: '::ffff:192.168.1.99', headers: { 'x-api-key': TEST_KEY } }), '');
        expect(res.statusCode).toBe(403);
    });

    it('100KB üstü gövde 413 + bağlantı kesilir', () => {
        const req = fakeReq({ url: '/api/v1/tasks/timer', method: 'POST', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' } });
        let destroyed = false;
        req.destroy = () => { destroyed = true; };
        const res = fakeRes();
        ctx.svc.handleRequest(req, res);
        req.__send('x'.repeat(102401));
        expect(destroyed).toBe(true);
        expect(res.statusCode).toBe(413);
    });
});
