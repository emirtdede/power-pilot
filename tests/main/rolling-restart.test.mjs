/**
 * rolling-restart.test.mjs - FAZ D
 * Sıralı yeniden başlatma: biri dönmeden diğeri başlamaz, zaman-aşımı atlanır.
 */
import { describe, it, expect } from 'vitest';
import { ConsoleServer, hashKey } from '../../src/console/ConsoleServer.js';

const ADMIN = 'k-admin';
const AGENT = 'k-agent';

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
    const role = key === ADMIN ? 'admin' : 'agent';
    // K-02: ajan anahtarı agentId'ye bağlıdır; testte gövdedeki agentId ile eşlenir.
    const identity = { role, agentId: role === 'agent' ? ((body && body.agentId) || null) : null };
    await srv.route(method, path, body || {}, res, role, null, identity);
    return res;
}

function online(srv, id, bootAt = new Date(Date.now() - 3600000).toISOString()) {
    return call(srv, 'POST', '/api/v1/heartbeat', { agentId: id, inventory: { bootAt } }, AGENT);
}

describe('rolling-restart', () => {
    it('ilk çevrimiçi sunucuya tek emir gider, diğeri bekler', async () => {
        const srv = makeServer();
        await online(srv, 'srv-01');
        await online(srv, 'srv-02');
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'rr-1', type: 'rolling-restart', targets: ['srv-01', 'srv-02'], params: {} }, ADMIN);
        expect(res.statusCode).toBe(201);
        expect(res.body.queued).toBe(1);
        expect((srv.store.queues['srv-01'] || [])[0].order.action).toBe('restart');
        expect(srv.store.queues['srv-02'] || []).toEqual([]);
        // emir bakım-penceresi bayraklı (ajan motoru uygular)
        expect((srv.store.queues['srv-01'] || [])[0].order.params.requiresMaintenanceWindow).toBe(true);
    });

    it('reboot-kanıtı gelince sıradakine geçilir', async () => {
        const srv = makeServer();
        const oldBoot = new Date(Date.now() - 3600000).toISOString();
        await online(srv, 'srv-01', oldBoot);
        await online(srv, 'srv-02', oldBoot);
        await call(srv, 'POST', '/api/v1/policies', { id: 'rr-1', type: 'rolling-restart', targets: ['srv-01', 'srv-02'], params: {} }, ADMIN);
        // srv-01 heartbeat'i tüketir (emri alır), sonra taze bootAt ile döner → kanıt
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'srv-01', inventory: { bootAt: oldBoot } }, AGENT);
        // Kanıt: dağıtımdan SONRAKİ açılış damgası (göreli zaman - sabit tarih bombası yok).
        const freshBoot = new Date(Date.now() + 5000).toISOString();
        await call(srv, 'POST', '/api/v1/heartbeat', { agentId: 'srv-01', inventory: { bootAt: freshBoot } }, AGENT);
        expect((srv.store.queues['srv-02'] || [])[0].order.action).toBe('restart');
        const pol = srv.store.policies.find((p) => p.id === 'rr-1');
        expect(pol.progress.done).toContain('srv-01');
    });

    it('çevrimdışı hedef atlanır, politika bekler', async () => {
        const srv = makeServer();
        await online(srv, 'srv-01');
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'rr-1', type: 'rolling-restart', targets: ['srv-99'], params: {} }, ADMIN);
        expect(res.statusCode).toBe(201);
        expect(res.body.queued).toBe(0);
    });

    it('51 sunucu reddedilir', async () => {
        const srv = makeServer();
        const res = await call(srv, 'POST', '/api/v1/policies',
            { id: 'rr-x', type: 'rolling-restart', targets: new Array(51).fill('s'), params: {} }, ADMIN);
        expect(res.statusCode).toBe(400);
    });
});
