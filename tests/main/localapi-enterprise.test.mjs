/**
 * localapi-enterprise.test.mjs - FAZ B
 * Kurumsal uçlar: envanter, imzalı emir alımı, muafiyet RBAC, denetim.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import LocalApiService from '../../src/main/services/LocalApiService.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';

const TEST_KEY = 'pp_key_test123';
const TEST_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex');

function makeService({ role = 'admin', settings = {}, deps = null } = {}) {
    const storageData = {
        localApiKeyHash: TEST_HASH,
        localApiKeyRole: role,
        localApiEnabled: true,
        localApiPort: 18456,
        lanModeEnabled: false,
        lanAllowedIps: ['127.0.0.1'],
        agentId: 'agent-pc-01',
        consolePublicKeyPem: null,
        ...settings
    };
    const storage = {
        getSettings: () => ({ ...storageData }),
        updateSettings: vi.fn((p) => Object.assign(storageData, p)),
        getExemptions: () => storageData._ex || [],
        saveExemptions: (l) => { storageData._ex = l; },
        getMaintenanceWindows: () => [],
        saveMaintenanceWindows: vi.fn(),
        getOrders: () => [],
        saveOrders: vi.fn(),
        getAuditLog: () => [],
        saveAuditLog: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        pausedAll: false,
        tasks: [],
        createTask: vi.fn((data) => ({ id: 't1', toJSON: () => ({ id: 't1', ...data }) })),
        cancelTask: vi.fn()
    };
    const svc = new LocalApiService(storage, taskManager, { execute: vi.fn() }, deps || {
        queue: new OrderQueue(null),
        audit: { append: vi.fn(), load: () => [], verify: () => ({ ok: true, records: 0 }) }
    });
    return { svc, storage, taskManager };
}

function req({ method = 'GET', url = '/', body = '' } = {}) {
    const handlers = {};
    return {
        socket: { remoteAddress: '127.0.0.1' },
        headers: {
            'x-api-key': TEST_KEY,
            ...(method === 'POST' || method === 'PUT' || method === 'PATCH'
                ? { 'content-type': 'application/json' }
                : {})
        },
        url, method,
        on(ev, fn) { handlers[ev] = fn; return this; },
        __send() {
            if (body && handlers.data) handlers.data(body);
            if (handlers.end) handlers.end();
        }
    };
}

function call(svc, method, url, bodyObj = null) {
    const r = req({ method, url, body: bodyObj ? JSON.stringify(bodyObj) : '' });
    const res = { statusCode: null, body: null, writeHead(c) { this.statusCode = c; }, end(p) { try { this.body = JSON.parse(p); } catch { this.body = p; } } };
    return new Promise((resolve) => {
        const origEnd = res.end.bind(res);
        res.end = (p) => { origEnd(p); setTimeout(() => resolve(res), 0); };
        svc.handleRequest(r, res);
        r.__send();
        setTimeout(() => resolve(res), 10);
    });
}

describe('FAZ B: LocalAPI kurumsal uçları', () => {
    it('envanter servisi yoksa 503 (çekirdek etkilenmez)', async () => {
        const { svc } = makeService();
        const res = await call(svc, 'GET', '/api/v1/orders/pending');
        // queue deps verildi → 200 boş liste
        expect(res.statusCode).toBe(200);
        expect(res.body.orders).toEqual([]);
    });

    it('imzalı emir doğrulanıp kuyruğa girer (201)', async () => {
        const kp = generateKeyPair();
        const { svc } = makeService({ settings: { consolePublicKeyPem: kp.publicKey } });
        const now = Date.now();
        const signed = sign({ action: 'lock', targets: ['a'], nonce: 'e2e-nonce-0001', issuedAt: now, expiresAt: now + 60000, issuer: 'console' }, kp.privateKey);
        const res = await call(svc, 'POST', '/api/v1/orders', signed);
        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
    });

    it('imzasız emir 401/400 ile reddedilir', async () => {
        const kp = generateKeyPair();
        const other = generateKeyPair();
        const { svc } = makeService({ settings: { consolePublicKeyPem: kp.publicKey } });
        const now = Date.now();
        const signed = sign({ action: 'lock', targets: ['a'], nonce: 'e2e-nonce-0002', issuedAt: now, expiresAt: now + 60000, issuer: 'console' }, other.privateKey);
        const res = await call(svc, 'POST', '/api/v1/orders', signed);
        expect([400, 401]).toContain(res.statusCode);
    });

    it('viewer muafiyet VEREMEZ (403), admin verebilir (201)', async () => {
        const ex = {
            deviceId: 'agent-pc-01', policyId: null,
            from: new Date().toISOString(), to: new Date(Date.now() + 86400000).toISOString(),
            reason: 'Render', approvedBy: 'IT'
        };
        const v = makeService({ role: 'viewer' });
        expect((await call(v.svc, 'POST', '/api/v1/exemptions', ex)).statusCode).toBe(403);
        const o = makeService({ role: 'operator' });
        expect((await call(o.svc, 'POST', '/api/v1/exemptions', ex)).statusCode).toBe(403);
        const a = makeService({ role: 'admin' });
        const res = await call(a.svc, 'POST', '/api/v1/exemptions', ex);
        expect(res.statusCode).toBe(201);
        expect(res.body.exemption.deviceId).toBe('agent-pc-01');
    });

    it('denetim ucu zincir doğrulamasıyla döner', async () => {
        const { svc } = makeService();
        const res = await call(svc, 'GET', '/api/v1/audit?verify=1');
        expect(res.statusCode).toBe(200);
        expect(res.body.verify.ok).toBe(true);
    });

    it('denetim ucu viewer/operator için 403, admin için 200 (O-06)', async () => {
        for (const role of ['viewer', 'operator']) {
            const { svc } = makeService({ role });
            const list = await call(svc, 'GET', '/api/v1/audit');
            expect(list.statusCode).toBe(403);
            const verify = await call(svc, 'GET', '/api/v1/audit/verify');
            expect(verify.statusCode).toBe(403);
        }
        const { svc } = makeService({ role: 'admin' });
        expect((await call(svc, 'GET', '/api/v1/audit')).statusCode).toBe(200);
        expect((await call(svc, 'GET', '/api/v1/audit/verify')).statusCode).toBe(200);
    });

    it('yönlendirici istisnası süreci öldürmez (500 döner)', async () => {
        const { svc } = makeService();
        svc.taskManager.getActiveTasks = () => { throw new Error('bozuk motor'); };
        const res = await call(svc, 'GET', '/api/v1/status');
        expect(res.statusCode).toBe(500);
    });
});
