/**
 * console-server.test.mjs - FAZ B
 * Kayıt defteri, politika dağıtımı, WoL dalgası, RBAC, iptal, denetim.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsoleServer, hashKey } from '../../src/console/ConsoleServer.js';
import { SignedOrderService } from '../../src/main/services/SignedOrderService.js';

const ADMIN = 'console-admin-key';
const OPERATOR = 'console-operator-key';
const VIEWER = 'console-viewer-key';
const AGENT = 'console-agent-key';

function makeServer(opts = {}) {
    return new ConsoleServer({
        keys: {
            admin: hashKey(ADMIN),
            operator: hashKey(OPERATOR),
            viewer: hashKey(VIEWER),
            agent: hashKey(AGENT)
        },
        ...opts
    });
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
    };
}

async function call(srv, method, path, body, key) {
    const res = fakeRes();
    const role = key
        ? ({ [ADMIN]: 'admin', [OPERATOR]: 'operator', [VIEWER]: 'viewer', [AGENT]: 'agent' }[key] || null)
        : null;
    // K-02: ajan anahtarı agentId'ye bağlıdır; testte gövdedeki agentId ile eşlenir.
    const identity = role
        ? { role, agentId: role === 'agent' ? (body && body.agentId) || null : null }
        : null;
    await srv.route(method, path, body || {}, res, role, null, identity);
    return res;
}

describe('ConsoleServer heartbeat + envanter', () => {
    it('ajan kaydolur, bekleyen emri teslim alır', async () => {
        const srv = makeServer();
        const inv = { agentId: 'a1', hostname: 'PC-01', nics: [{ mac: 'AA:BB:CC:DD:EE:01' }] };
        let res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: inv }, AGENT);
        expect(res.statusCode).toBe(200);
        expect(res.body.orders).toEqual([]);
        srv.queueOrder('a1', 'lock');
        res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: inv }, AGENT);
        expect(res.body.orders).toHaveLength(1);
        expect(res.body.orders[0].order.action).toBe('lock');
        const nonce = res.body.orders[0].order.nonce;
        // WP-03.T7: makbuz gelmeden emir yeniden teslim edilir (kaybolmaz).
        res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: inv }, AGENT);
        expect(res.body.orders).toHaveLength(1);
        expect(res.body.orders[0].order.nonce).toBe(nonce);
        // Makbuz sonrası kuyruk boşalır; aynı makbuz idempotenttir.
        res = await call(srv, 'POST', '/api/v1/receipts', { agentId: 'a1', nonce, code: 'OK' }, AGENT);
        expect(res.statusCode).toBe(200);
        expect(res.body.accepted).toBe(1);
        res = await call(srv, 'POST', '/api/v1/receipts', { agentId: 'a1', nonce, code: 'OK' }, AGENT);
        expect(res.statusCode).toBe(200);
        expect(res.body.duplicates).toBe(1);
        res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: inv }, AGENT);
        expect(res.body.orders).toEqual([]);
    });

    it('bağlı olmayan ajan anahtarı heartbeat reddeder (K-02)', async () => {
        const srv = makeServer();
        const res = fakeRes();
        await srv.route('POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, res, 'agent', null, { role: 'agent', agentId: null });
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('AGENT_KEY_UNBOUND');
    });

    it('kuyruk sayaçları ve emir geçmişi görünür (WP-03.T5)', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        srv.queueOrder('a1', 'lock');
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        let res = await call(srv, 'GET', '/api/v1/queues', {}, VIEWER);
        expect(res.statusCode).toBe(200);
        expect(res.body.counts.inflight).toBe(1);
        expect(res.body.orders[0].state).toBe('inflight');
        expect(res.body.orders[0].action).toBe('lock');
        const nonce = res.body.orders[0].nonce;
        await call(srv, 'POST', '/api/v1/receipts', { agentId: 'a1', nonce, code: 'DENIED', message: 'yönetici yok' }, AGENT);
        res = await call(srv, 'GET', '/api/v1/queues?agentId=a1', {}, VIEWER);
        expect(res.body.counts.acked).toBe(1);
        expect(res.body.orders[0].code).toBe('DENIED');
        expect(res.body.orders[0].message).toBe('yönetici yok');
    });

    it('anahtarsız heartbeat 401', async () => {
        const srv = makeServer();
        const res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1' }, null);
        expect(res.statusCode).toBe(401);
    });

    it('ajan listesi çevrimiçi gösterir', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        const res = await call(srv, 'GET', '/api/v1/agents', {}, VIEWER);
        expect(res.statusCode).toBe(200);
        expect(res.body.agents[0].online).toBe(true);
    });
});

describe('ConsoleServer politika dağıtımı', () => {
    it('gece-kapat politikası hedef başına apply-policy kuyruklar', async () => {
        const srv = makeServer();
        const policy = { id: 'pol-gece', type: 'nightly-shutdown', targets: ['a1', 'a2'], params: { timeOfDay: '19:30', days: [1, 2, 3, 4, 5] } };
        const res = await call(srv, 'POST', '/api/v1/policies', policy, OPERATOR);
        expect(res.statusCode).toBe(201);
        expect(res.body.queued).toBe(2);
        // emirler imzalı mı? (ajan anahtarıyla doğrulanabilir olmalı)
        const v = new SignedOrderService({ publicKeyPem: srv.publicKey });
        const check = v.verify(srv.store.queues['a1'][0]);
        expect(check.ok).toBe(true);
        expect(check.order.action).toBe('apply-policy');
    });

    it('viewer politika dağıtamaz (403)', async () => {
        const srv = makeServer();
        const res = await call(srv, 'POST', '/api/v1/policies', { id: 'x', type: 'idle-lock', targets: ['a1'], params: { idleMinutes: 10 } }, VIEWER);
        expect(res.statusCode).toBe(403);
    });

    it('operator politika SİLEMEZ, admin siler (revoke emri kuyruklanır)', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/policies', { id: 'pol-gece', type: 'nightly-shutdown', targets: ['a1'], params: { timeOfDay: '19:30', days: [1] } }, OPERATOR);
        // dağıtım emirlerini temizle ki revoke emri isolated görülsün
        srv.store.queues['a1'] = [];
        expect((await call(srv, 'DELETE', '/api/v1/policies/pol-gece', {}, OPERATOR)).statusCode).toBe(403);
        expect((await call(srv, 'DELETE', '/api/v1/policies/pol-gece', {}, ADMIN)).statusCode).toBe(200);
        expect(srv.store.queues['a1'][0].order.action).toBe('revoke-policy');
    });

    it('wake: çevrimiçi röle varsa relay-wake emri röleye gider', async () => {
        const srv = makeServer({ localSubnets: ['10.99.0.0/24'] }); // konsolla aynı ağ yok
        const nic = (mac) => ({ mac, subnet: '192.168.10.0/24' });
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'relay1', inventory: { nics: [nic('AA:BB:CC:DD:EE:10')], wolReadiness: { level: 'ready' } } }, AGENT);
        // hedef kapalı (kayıtlı ama eski heartbeat)
        srv.store.agents['hedef1'] = {
            agentId: 'hedef1',
            inventory: { nics: [nic('AA:BB:CC:DD:EE:11')], wolReadiness: { level: 'ready' } },
            lastHeartbeatAt: new Date(Date.now() - 3600000).toISOString()
        };
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'pol-yama', type: 'pre-patch-wake', targets: ['hedef1'], params: { wakeTime: '03:00', waveSize: 20, waveGapSec: 5 } },
            OPERATOR);
        expect(res.statusCode).toBe(201);
        expect(res.body.queued).toBe(1);
        const relayOrders = srv.store.queues['relay1'] || [];
        expect(relayOrders).toHaveLength(1);
        expect(relayOrders[0].order.action).toBe('relay-wake');
        expect(relayOrders[0].order.params.finalTarget).toBe('hedef1');
        expect(relayOrders[0].order.params.broadcastIp).toBe('192.168.10.255'); // yönlendirilmiş broadcast
    });

    it('wake: röle yoksa + konsol aynı ağdaysa doğrudan gönderir', async () => {
        const srv = makeServer({ localSubnets: ['192.168.10.0/24'] });
        srv.store.agents['hedef1'] = {
            agentId: 'hedef1',
            inventory: { nics: [{ mac: 'AA:BB:CC:DD:EE:11', subnet: '192.168.10.0/24' }] },
            lastHeartbeatAt: new Date(Date.now() - 3600000).toISOString()
        };
        // UDP gönderimi testte gerçek yapılır (yerel broadcast, zararsız); sonucu değil akışı doğrula
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'pol-yama', type: 'pre-patch-wake', targets: ['hedef1'], params: { wakeTime: '03:00' } },
            OPERATOR);
        expect(res.statusCode).toBe(201);
        expect(res.body.sent).toBe(1);
    });

    it('wake: MACsiz + rölesiz hedef atlanır', async () => {
        const srv = makeServer({ localSubnets: ['10.99.0.0/24'] });
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a9', inventory: { nics: [] } }, AGENT);
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'pol-yama', type: 'pre-patch-wake', targets: ['a9'], params: { wakeTime: '03:00', waveSize: 20, waveGapSec: 5 } },
            OPERATOR);
        expect(res.statusCode).toBe(201);
        expect(res.body.queued).toBe(0);
        expect(res.body.skipped.join(' ')).toContain('a9');
    });

    it('subnet sınıflandırması röleyi gösterir', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/heartbeat', {
            agentId: 'r1',
            inventory: { nics: [{ mac: 'AA:BB:CC:DD:EE:01', subnet: '192.168.5.0/24' }], wolReadiness: { level: 'ready' } }
        }, AGENT);
        const res = await call(srv, 'GET', '/api/v1/subnets', {}, VIEWER);
        expect(res.statusCode).toBe(200);
        const entry = res.body.subnets.find((s) => s.subnet === '192.168.5.0/24');
        expect(entry.status).toBe('ready');
        expect(entry.relay).toBe('r1');
    });

    it('denetim günlüğü zinciri geçerli', async () => {
        const srv = makeServer();
        await call(srv, 'POST', '/api/v1/policies', { id: 'p', type: 'idle-lock', targets: ['a1'], params: { idleMinutes: 5 } }, OPERATOR);
        const res = await call(srv, 'GET', '/api/v1/audit?verify=1', {}, ADMIN);
        expect(res.statusCode).toBe(200);
        expect(res.body.verify.ok).toBe(true);
        // WP-01.T6: audit yalnızca admin'e açıktır.
        expect((await call(srv, 'GET', '/api/v1/audit', {}, VIEWER)).statusCode).toBe(403);
    });

    it('dolu ajan kuyruğu 429 + QUEUE_FULL ile reddedilir (K6)', async () => {
        const srv = makeServer();
        srv.store.queues['dolu'] = Array.from({ length: 200 }, (_, i) => ({ order: { nonce: `n-${i}` } }));
        let err = null;
        try { srv.queueOrder('dolu', 'lock'); } catch (e) { err = e; }
        expect(err && err.code).toBe('QUEUE_FULL');
        const res = await call(srv, 'POST', '/api/v1/agents/dolu/orders', { action: 'lock' }, OPERATOR);
        expect(res.statusCode).toBe(429);
        expect(res.body.code).toBe('QUEUE_FULL');
    });
});

describe('WP-01 ajan kimliği ve rol matrisi (T-ORD-05/06)', () => {
    it('T-ORD-05 A anahtarıyla B heartbeat\'i 403 IDENTITY_MISMATCH', async () => {
        const srv = makeServer();
        const reg = srv.registerAgent({ agentId: 'agent_B' });
        const identity = { role: 'agent', agentId: 'agent_B' };
        const res = fakeRes();
        await srv.route('POST', '/api/v1/heartbeat', { agentId: 'agent_A' }, res, 'agent', null, identity);
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('IDENTITY_MISMATCH');
        expect(srv.store.agents.agent_A).toBeUndefined();
        expect(reg.apiKey).toBeTruthy();
        expect(srv.store.agentKeys[0].hash).not.toContain(reg.apiKey);
    });

    it('T-ORD-06 endpoint → izin matrisi yalnızca izinli hücreleri açar', async () => {
        const srv = makeServer();
        const cases = [
            ['GET', '/api/v1/agents', 'agent', 403],
            ['GET', '/api/v1/agents', 'viewer', 200],
            ['GET', '/api/v1/policies', 'viewer', 200],
            ['GET', '/api/v1/policies', 'agent', 403],
            ['GET', '/api/v1/audit', 'operator', 403],
            ['GET', '/api/v1/audit', 'admin', 200],
            ['GET', '/api/v1/console-key', 'operator', 403],
            ['GET', '/api/v1/console-key', 'admin', 200],
            ['GET', '/api/v1/settings', 'admin', 200],
            ['GET', '/api/v1/settings', 'viewer', 403],
            ['POST', '/api/v1/keys', 'operator', 403],
            ['POST', '/api/v1/keys', 'admin', 201],
            ['POST', '/api/v1/agents/x/orders', 'viewer', 403],
            ['POST', '/api/v1/agents/x/orders', 'operator', 201],
            ['POST', '/api/v1/agents/x/disable', 'operator', 403],
            ['POST', '/api/v1/agents/x/disable', 'admin', 200],
            ['POST', '/api/v1/receipts', 'viewer', 403]
        ];
        for (const [method, path, role, expected] of cases) {
            const res = fakeRes();
            await srv.route(method, path, { action: 'lock' }, res, role);
            expect(res.statusCode, `${method} ${path} ${role}`).toBe(expected);
        }
    });

    it('anahtar kaydı düz anahtarı yalnızca bir kez döndürür ve keyId ile eşleşir', () => {
        const srv = makeServer();
        const reg = srv.registerAgent({ agentId: 'agent_1' });
        const key = reg.apiKey;
        const okReq = { headers: { 'x-api-key': key, 'x-key-id': reg.keyId } };
        expect(srv.identityOf(okReq)).toMatchObject({ role: 'agent', agentId: 'agent_1', keyId: reg.keyId });
        const wrongId = { headers: { 'x-api-key': key, 'x-key-id': 'key_baska' } };
        expect(srv.identityOf(wrongId)).toBeNull();
    });
});

describe('ConsoleServer DB modu (WP-03)', () => {
    it('console.db kalıcıdır: anahtar, ajan, kuyruk, makbuz ve audit yeniden açılışta korunur', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-console-db-'));
        const storePath = path.join(dir, 'console-store.json');
        let srv = makeServer({ storePath });
        const publicKey = srv.store.keypair.publicKey;
        expect(fs.existsSync(path.join(dir, 'console.db'))).toBe(true);
        expect(fs.existsSync(storePath)).toBe(false);

        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: { hostname: 'PC-1' } }, AGENT);
        srv.queueOrder('a1', 'lock');
        let res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: { hostname: 'PC-1' } }, AGENT);
        const nonce = res.body.orders[0].order.nonce;
        await call(srv, 'POST', '/api/v1/receipts', { agentId: 'a1', nonce, code: 'OK' }, AGENT);
        const auditCount = srv.audit.load().length;
        expect(auditCount).toBeGreaterThan(0);
        srv.close();

        srv = makeServer({ storePath });
        expect(srv.store.keypair.publicKey).toBe(publicKey);
        expect(srv.audit.load()).toHaveLength(auditCount);
        res = await call(srv, 'GET', '/api/v1/queues', {}, VIEWER);
        expect(res.body.counts.acked).toBe(1);
        expect(res.body.orders[0].nonce).toBe(nonce);
        res = await call(srv, 'GET', '/api/v1/agents', {}, VIEWER);
        expect(res.body.agents).toHaveLength(1);
        expect(res.body.agents[0].agentId).toBe('a1');
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('özel anahtar dosyası kaybolursa sessizce yeniden üretmez (CONSOLE_KEY_MISSING)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-console-key-'));
        const storePath = path.join(dir, 'console-store.json');
        const srv = makeServer({ storePath });
        const keyFile = srv.signingKeyPath();
        expect(fs.existsSync(keyFile)).toBe(true);
        srv.close();
        fs.rmSync(keyFile, { force: true });
        expect(() => makeServer({ storePath })).toThrowError(/imza anahtarı bulunamadı/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('bakım modunda yazma 503; bellek deposuna sessiz düşüş yok', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-console-maint-'));
        const storePath = path.join(dir, 'console-store.json');
        fs.writeFileSync(storePath, '{bozuk', 'utf8');
        const srv = makeServer({ storePath });
        expect(srv.maintenanceMode).toBe(true);
        const res = await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'a1', inventory: {} }, AGENT);
        expect(res.statusCode).toBe(503);
        expect(res.body.code).toBe('CONSOLE_MAINTENANCE');
        expect(fs.readFileSync(storePath, 'utf8')).toBe('{bozuk');
        srv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
