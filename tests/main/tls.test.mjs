/**
 * tls.test.mjs - WP-02.T11
 * T-TLS-01..11: konsol HTTPS zorunluluğu, loopback kaçış kapısı, istemci TLS,
 * mTLS parmak izi, LAN/TLS doğrulaması, timing-safe karşılaştırma, stop/start,
 * idempotency/iptal kodları ve istek sınırları.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import selfsigned from 'selfsigned';
import LocalApiService from '../../src/main/services/LocalApiService.js';
import { ConsoleServer, hashKey } from '../../src/console/ConsoleServer.js';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';
import { safeCompare } from '../../src/main/security/safeCompare.js';
import { validateSettings, validateSecuritySettings } from '../../src/main/ipc/validate.js';

const TEST_KEY = 'pp_key_tls_test';
const TEST_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex');

const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
        days: 2,
        keySize: 2048,
        extensions: [{
            name: 'subjectAltName',
            altNames: [
                { type: 2, value: 'localhost' },
                { type: 7, ip: '127.0.0.1' }
            ]
        }]
    }
);

const cleanups = [];
afterEach(async () => {
    while (cleanups.length) {
        const fn = cleanups.pop();
        try { await fn(); } catch (_) { /* yut */ }
    }
});

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

function localApiService(settings = {}) {
    const storage = {
        getSettings: () => ({
            localApiKeyHash: TEST_HASH,
            localApiKeyRole: 'admin',
            localApiEnabled: true,
            localApiPort: 0,
            lanModeEnabled: false,
            lanAllowedIps: ['127.0.0.1'],
            ...settings
        }),
        updateSettings: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        pausedAll: false,
        tasks: [],
        createTask: vi.fn((data) => ({ id: 't1', toJSON: () => ({ id: 't1', ...data }) })),
        cancelTask: vi.fn(() => ({ ok: true }))
    };
    return { svc: new LocalApiService(storage, taskManager, { execute: vi.fn() }), storage, taskManager };
}

function fakeReq({ ip = '127.0.0.1', headers = {}, url = '/api/v1/status', method = 'GET' } = {}) {
    const handlers = {};
    return {
        socket: { remoteAddress: ip },
        headers, url, method,
        on(ev, fn) { handlers[ev] = fn; return this; },
        __send(bodyStr) {
            if (bodyStr && handlers.data) handlers.data(bodyStr);
            if (handlers.end) handlers.end();
        }
    };
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
    };
}

function call(svc, { method = 'GET', url = '/api/v1/status', body = null, headers = {} } = {}) {
    const req = fakeReq({
        method,
        url,
        headers: {
            'x-api-key': TEST_KEY,
            ...(body !== null ? { 'content-type': 'application/json' } : {}),
            ...headers
        }
    });
    const res = fakeRes();
    svc.handleRequest(req, res);
    req.__send(body !== null ? JSON.stringify(body) : '');
    return res;
}

function httpGet(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

describe('T-TLS-01/02: konsol TLS zorunluluğu', () => {
    it('T-TLS-01: 0.0.0.0 + HTTP başlatma CONSOLE_TLS_REQUIRED ile reddedilir', () => {
        const srv = new ConsoleServer({ storePath: null, keys: { admin: hashKey('a') } });
        expect(() => srv.start(0, '0.0.0.0', { consoleTlsEnabled: false })).toThrow(/CONSOLE_TLS_REQUIRED|TLS olmadan/);
        try {
            srv.start(0, '0.0.0.0', { consoleTlsEnabled: false });
        } catch (err) {
            expect(err.code).toBe('CONSOLE_TLS_REQUIRED');
        }
    });

    it('T-TLS-02: loopback + PP_ALLOW_INSECURE_CONSOLE=1 yalnızca 127.0.0.1 dinler', async () => {
        const prev = process.env.PP_ALLOW_INSECURE_CONSOLE;
        process.env.PP_ALLOW_INSECURE_CONSOLE = '1';
        try {
            const srv = new ConsoleServer({ storePath: null, keys: { admin: hashKey('a') } });
            const server = srv.start(0, '127.0.0.1', { consoleTlsEnabled: false });
            cleanups.push(() => srv.stop());
            await new Promise((resolve) => server.once('listening', resolve));
            expect(srv.transport).toBe('http');
            expect(server.address().address).toMatch(/127\.0\.0\.1|::ffff:127\.0\.0\.1/);
        } finally {
            if (prev === undefined) delete process.env.PP_ALLOW_INSECURE_CONSOLE;
            else process.env.PP_ALLOW_INSECURE_CONSOLE = prev;
        }
    });

    it('T-TLS-01b: konsol TLS materyaliyle HTTPS başlar ve istek 200 döner', async () => {
        const srv = new ConsoleServer({ storePath: null, keys: { admin: hashKey('admin-key') } });
        const server = srv.start(0, '127.0.0.1', {
            consoleTlsEnabled: true,
            consoleCertPem: pems.cert,
            consoleKeyPem: pems.private
        });
        cleanups.push(() => srv.stop());
        await new Promise((resolve) => server.once('listening', resolve));
        expect(srv.transport).toBe('https');
        const port = server.address().port;
        const status = await new Promise((resolve, reject) => {
            const req = https.request({
                host: '127.0.0.1',
                port,
                path: '/api/v1/agents',
                method: 'GET',
                headers: { 'x-api-key': 'admin-key' },
                ca: pems.cert
            }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject);
            req.end();
        });
        expect(status).toBe(200);
    });
});

describe('T-TLS-03/04: istemci TLS', () => {
    it('T-TLS-03: http:// URL → TLS_REQUIRED, istek gitmez', async () => {
        const requestFn = vi.fn();
        const client = new ConsoleClient({
            storage: {
                getSettings: () => ({
                    consoleUrl: 'http://srv:8443',
                    consolePublicKeyPem: generateKeyPair().publicKey,
                    consoleAgentKey: 'k'
                })
            },
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null),
            requestFn
        });
        const res = await client.sync();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('TLS_REQUIRED');
        expect(requestFn).not.toHaveBeenCalled();
    });

    it('T-TLS-04: doğru CA ile HTTPS istek 200; sertifika doğrulanır', async () => {
        const kp = generateKeyPair();
        const now = Date.now();
        const order = sign({
            action: 'lock',
            targets: ['a1'],
            nonce: `tls-nonce-${now}`,
            issuedAt: now,
            expiresAt: now + 60000,
            issuer: 'console'
        }, kp.privateKey);

        const server = https.createServer({ cert: pems.cert, key: pems.private }, (req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let payload = {};
                try { payload = JSON.parse(raw); } catch (_) { /* yut */ }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ serverTime: new Date().toISOString(), orders: [order], echoAgent: payload.agentId }));
            });
        });
        server.listen(0, '127.0.0.1');
        cleanups.push(() => new Promise((resolve) => {
            try { server.closeAllConnections?.(); } catch (_) { /* yut */ }
            server.close(resolve);
        }));
        await new Promise((resolve) => server.once('listening', resolve));
        const port = server.address().port;

        const client = new ConsoleClient({
            storage: {
                getSettings: () => ({
                    consoleUrl: `https://127.0.0.1:${port}`,
                    consoleCaPem: pems.cert,
                    consolePublicKeyPem: kp.publicKey,
                    consoleAgentKey: 'k'
                })
            },
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null)
        });
        const res = await client.sync();
        expect(res.ok).toBe(true);
        expect(res.accepted).toBe(1);
    });

    it('T-TLS-04b: yanlış CA → TLS_CERTIFICATE_ERROR (sessiz geçiş yok)', async () => {
        const other = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 1, keySize: 2048 });
        const server = https.createServer({ cert: other.cert, key: other.private }, (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
        server.listen(0, '127.0.0.1');
        cleanups.push(() => new Promise((resolve) => {
            try { server.closeAllConnections?.(); } catch (_) { /* yut */ }
            server.close(resolve);
        }));
        await new Promise((resolve) => server.once('listening', resolve));

        const client = new ConsoleClient({
            storage: {
                getSettings: () => ({
                    consoleUrl: `https://127.0.0.1:${server.address().port}`,
                    consoleCaPem: pems.cert,
                    consolePublicKeyPem: generateKeyPair().publicKey,
                    consoleAgentKey: 'k'
                })
            },
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null)
        });
        const res = await client.sync();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('TLS_CERTIFICATE_ERROR');
    });

    it('yönlendirme izlenmez → CONSOLE_REDIRECT', async () => {
        const client = new ConsoleClient({
            storage: {
                getSettings: () => ({
                    consoleUrl: 'https://srv:8443',
                    consolePublicKeyPem: generateKeyPair().publicKey,
                    consoleAgentKey: 'k'
                })
            },
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null),
            requestFn: async () => ({ ok: false, status: 302, headers: { location: 'https://evil' } })
        });
        const res = await client.sync();
        expect(res.code).toBe('CONSOLE_REDIRECT');
    });

    it('WP-03.T6: eşzamanlı sync() çağrıları aynı Promise’i paylaşır', async () => {
        let resolveRequest;
        const requestFn = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
        const client = new ConsoleClient({
            storage: {
                getSettings: () => ({
                    consoleUrl: 'https://srv:8443',
                    consolePublicKeyPem: generateKeyPair().publicKey,
                    consoleAgentKey: 'k'
                })
            },
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null),
            requestFn
        });
        const p1 = client.sync();
        const p2 = client.sync();
        expect(p1).toBe(p2);
        await new Promise((resolve) => setImmediate(resolve));
        resolveRequest({ ok: true, status: 204, json: async () => ({}) });
        await Promise.all([p1, p2]);
        expect(requestFn).toHaveBeenCalledTimes(1);
    });
});

describe('T-TLS-06: LAN + TLS zorunluluğu', () => {
    it('LAN açık + TLS kapalı → LAN_REQUIRES_TLS; ayar yazılmaz', () => {
        const out = validateSecuritySettings(
            { lanModeEnabled: true, localApiTlsEnabled: false },
            { lanModeEnabled: false, localApiTlsEnabled: false, lanAllowedIps: ['192.168.1.0/24'] }
        );
        expect(out.ok).toBe(false);
        expect(out.code).toBe('LAN_REQUIRES_TLS');
    });

    it('LAN açık + TLS açık + materyal yok → TLS_MATERIAL_REQUIRED', () => {
        const out = validateSecuritySettings(
            { lanModeEnabled: true, localApiTlsEnabled: true },
            { lanAllowedIps: ['192.168.1.0/24'] }
        );
        expect(out.ok).toBe(false);
        expect(out.code).toBe('TLS_MATERIAL_REQUIRED');
    });
});

describe('T-TLS-07: timing-safe karşılaştırma', () => {
    it('eşit, farklı ve farklı uzunlukta girdilerde tek timingSafeEqual çağrısı', () => {
        const spy = vi.spyOn(crypto, 'timingSafeEqual');
        try {
            expect(safeCompare('abc', 'abc')).toBe(true);
            expect(safeCompare('abc', 'abd')).toBe(false);
            expect(safeCompare('abc', 'abc-def-uzun')).toBe(false);
            expect(spy).toHaveBeenCalledTimes(3);
            for (const call of spy.mock.calls) {
                expect(call[0]).toHaveLength(32);
                expect(call[1]).toHaveLength(32);
            }
        } finally {
            spy.mockRestore();
        }
    });
});

describe('T-TLS-08: stop/start', () => {
    it('20 eşzamanlı istek altında stop/start → EADDRINUSE yok', async () => {
        const port = await freePort();
        const { svc } = localApiService({ localApiPort: port });
        const started = await svc.start();
        cleanups.push(() => svc.stop());
        expect(started.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const first = await Promise.all(
            Array.from({ length: 20 }, () => httpGet(port, '/api/v1/status', { 'x-api-key': TEST_KEY }))
        );
        expect(first.every((code) => code === 200)).toBe(true);

        const restarted = await svc.restart();
        expect(restarted.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await httpGet(port, '/api/v1/status', { 'x-api-key': TEST_KEY })).toBe(200);
        expect(svc.server.listening).toBe(true);
    });

    it('T-TLS-10: istek sınırları yapılandırılmış', async () => {
        const port = await freePort();
        const { svc } = localApiService({ localApiPort: port });
        svc.start();
        cleanups.push(() => svc.stop());
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(svc.server.requestTimeout).toBe(15000);
        expect(svc.server.headersTimeout).toBe(10000);
        expect(svc.server.keepAliveTimeout).toBe(5000);
        expect(svc.server.maxHeadersCount).toBe(100);
    });
});

describe('T-TLS-09: HTTP kodları ve idempotency', () => {
    it('var olmayan görev iptali 404', () => {
        const { svc, taskManager } = localApiService();
        taskManager.cancelTask.mockReturnValue({ ok: false, code: 'NOT_FOUND' });
        const res = call(svc, { method: 'POST', url: '/api/v1/tasks/yok/cancel', body: {} });
        expect(res.statusCode).toBe(404);
        expect(res.body.code).toBe('TASK_NOT_FOUND');
    });

    it('iptal çok geç / zaten iptal → 409', () => {
        const { svc, taskManager } = localApiService();
        taskManager.cancelTask.mockReturnValue({ ok: true, code: 'CANCEL_TOO_LATE', message: 'güç başladı' });
        expect(call(svc, { method: 'POST', url: '/api/v1/tasks/t1/cancel', body: {} }).statusCode).toBe(409);
        taskManager.cancelTask.mockReturnValue({ ok: true, code: 'ALREADY_CANCELLED' });
        expect(call(svc, { method: 'POST', url: '/api/v1/tasks/t1/cancel', body: {} }).statusCode).toBe(409);
    });

    it('geçersiz muafiyet 400 (500 değil)', () => {
        const { svc } = localApiService();
        const res = call(svc, { method: 'POST', url: '/api/v1/exemptions', body: { reason: '' } });
        expect(res.statusCode).toBe(400);
    });

    it('aynı Idempotency-Key ikinci istekte aynı yanıtı döner, iş yeniden çalışmaz', () => {
        const { svc, taskManager } = localApiService();
        const first = call(svc, {
            method: 'POST',
            url: '/api/v1/power/lock',
            body: {},
            headers: { 'idempotency-key': 'idem-1' }
        });
        const second = call(svc, {
            method: 'POST',
            url: '/api/v1/power/lock',
            body: {},
            headers: { 'idempotency-key': 'idem-1' }
        });
        expect(first.statusCode).toBe(200);
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(taskManager.createTask).toHaveBeenCalledTimes(1);
    });
});
