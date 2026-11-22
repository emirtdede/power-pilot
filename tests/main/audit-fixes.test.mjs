/**
 * audit-fixes.test.mjs - Denetim turu düzeltmeleri:
 * kill-switch (konsol→ajan→motor), makbuz döngüsü, GPO rozeti, TLS sıkı kip.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsoleServer, hashKey } from '../../src/console/ConsoleServer.js';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';
import SafetyPolicyEngine from '../../src/main/services/SafetyPolicyEngine.js';
import LocalApiService from '../../src/main/services/LocalApiService.js';

const ADMIN = 'audit-admin';
const AGENT = 'audit-agent';

function makeServer() {
    return new ConsoleServer({ keys: { admin: hashKey(ADMIN), agent: hashKey(AGENT) }, localSubnets: [] });
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(c) { this.statusCode = c; },
        end(p) { try { this.body = JSON.parse(p); } catch { this.body = p; } }
    };
}

async function call(srv, method, path, body, key) {
    const res = fakeRes();
    const { URL } = await import('node:url');
    const parsed = new URL(path, 'http://x');
    const role = key === ADMIN ? 'admin' : 'agent';
    // K-02: ajan anahtarı agentId'ye bağlıdır; testte gövdedeki agentId ile eşlenir.
    const identity = { role, agentId: role === 'agent' ? ((body && body.agentId) || null) : null };
    await srv.route(method, parsed.pathname, body || {}, res, role, parsed, identity);
    return res;
}

describe('kill-switch uçtan-uca', () => {
    it('disable → heartbeat disabled:true + emir teslim edilmez', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        expect((await call(srv, 'POST', '/api/v1/agents/a1/disable', {}, ADMIN)).statusCode).toBe(200);
        srv.queueOrder('a1', 'lock');
        const hb = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        expect(hb.body.disabled).toBe(true);
        expect(hb.body.orders).toEqual([]);
        // enable → bayrak düşer
        await call(srv, 'POST', '/api/v1/agents/a1/enable', {}, ADMIN);
        const hb2 = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        expect(hb2.body.disabled).toBe(false);
    });

    it('operator disable edemez (403)', async () => {
        const srv = new ConsoleServer({ keys: { admin: hashKey(ADMIN), operator: hashKey('op'), agent: hashKey(AGENT) } });
        const res = fakeRes();
        await srv.route('POST', '/api/v1/agents/a1/disable', {}, res, 'operator');
        expect(res.statusCode).toBe(403);
    });

    it('ajan bayrağı kalıcılaştırır ve icrayı durdurur', async () => {
        const kp = generateKeyPair();
        const data = {};
        const storage = {
            getSettings: () => ({ consoleUrl: 'https://srv', consolePublicKeyPem: kp.publicKey, agentId: 'a1', consoleAgentKey: 'k-test', ...data }),
            updateSettings: vi.fn((p) => Object.assign(data, p))
        };
        const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ orders: [], disabled: true }) }));
        const appended = [];
        const client = new ConsoleClient({
            storage,
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null),
            auditLog: { append: (e) => appended.push(e) },
            fetchFn
        });
        const res = await client.sync();
        expect(res.disabled).toBe(true);
        expect(storage.updateSettings).toHaveBeenCalledWith({ agentDisabled: true });
        expect(appended.some((e) => e.action === 'agent_disabled')).toBe(true);
    });

    it('motor kill-switch’te tüm kaynakları engeller', async () => {
        const storage = { getSettings: () => ({ agentDisabled: true }) };
        const eng = new SafetyPolicyEngine(storage, () => { throw new Error('exec yok'); }, () => 9999);
        for (const source of ['console', 'user_interface', 'local_api']) {
            const r = await eng.evaluate({ action: 'lock', source, safetyPolicy: {} });
            expect(r.allowed).toBe(false);
            expect(r.reason).toContain('kill-switch');
        }
    });
});

describe('makbuz döngüsü', () => {
    it('acked makbuzlar bir kez gönderilir', () => {
        const q = new OrderQueue(null);
        const { record } = q.enqueue({ order: { action: 'lock', nonce: 'm1' }, signature: 'x' });
        expect(q.takeUnsentReceipts()).toEqual([]);
        q.ack(record.key, { code: 'success', message: 'ok' });
        const r1 = q.takeUnsentReceipts();
        expect(r1).toHaveLength(1);
        expect(r1[0].nonce).toBe('m1');
        expect(q.takeUnsentReceipts()).toEqual([]); // tekrar yok
    });

    it('istemci makbuzu heartbeat gövdesine koyar', async () => {
        const kp = generateKeyPair();
        const storage = { getSettings: () => ({ consoleUrl: 'https://srv', consolePublicKeyPem: kp.publicKey, consoleAgentKey: 'k-test' }) };
        const queue = new OrderQueue(null);
        const { record } = queue.enqueue({ order: { action: 'lock', nonce: 'm9' }, signature: 'x' });
        queue.ack(record.key, { code: 'success' });
        let sentBody = null;
        const fetchFn = vi.fn(async (_url, opts) => {
            sentBody = JSON.parse(opts.body);
            return { ok: true, json: async () => ({ orders: [] }) };
        });
        const client = new ConsoleClient({
            storage,
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: queue,
            auditLog: null,
            fetchFn
        });
        await client.sync();
        expect(sentBody.receipts).toHaveLength(1);
        expect(sentBody.receipts[0].nonce).toBe('m9');
    });
});

describe('GPO çatışma rozeti', () => {
    it('GPO süresi politikadan kısaysa listelenir', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/heartbeat', {
            agentId: 'g1',
            inventory: { lockPolicy: { timeoutSec: 300, enforcedByGpo: true } }
        }, AGENT);
        await call(srv, 'POST', '/api/v1/heartbeat', {
            agentId: 'g2',
            inventory: { lockPolicy: { timeoutSec: 900, enforcedByGpo: false } }
        }, AGENT);
        const res = await call(srv, 'GET', '/api/v1/agents/gpo-conflicts?idleMinutes=10', {}, ADMIN);
        expect(res.statusCode).toBe(200);
        expect(res.body.conflicts.map((c) => c.agentId)).toEqual(['g1']);
        expect(res.body.conflicts[0].gpoTimeoutMin).toBe(5);
    });
});

describe('TLS sıkı kip', () => {
    it('bayrak açıkken rejectUnauthorized:true', () => {
        const svc = new LocalApiService({ getSettings: () => ({}) }, {}, {});
        const opts = svc.getServerOptions({
            localApiTlsEnabled: true,
            localApiTlsStrict: true,
            localApiCertPem: 'CERT',
            localApiKeyPem: 'KEY'
        });
        expect(opts.rejectUnauthorized).toBe(true);
        expect(svc.getServerOptions({ localApiTlsEnabled: true, localApiCertPem: 'CERT', localApiKeyPem: 'KEY' }).rejectUnauthorized).toBe(false);
    });

    it('güvenlik özeti sıkı kipi raporlar', () => {
        const svc = new LocalApiService({ getSettings: () => ({ localApiTlsStrict: true }) }, {}, {});
        expect(svc.getSecurityStatus().tlsStrict).toBe(true);
    });
});
