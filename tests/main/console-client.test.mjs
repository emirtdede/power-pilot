/**
 * console-client.test.mjs - FAZ B
 * Outbound senkron: heartbeat → imzalı emirler kuyruğa, imzasız red.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { generateKeyPair, sign } from '../../src/main/services/SignedOrderService.js';

function signedOrder(keypair, action = 'lock') {
    const now = Date.now();
    return sign({ action, targets: ['a1'], nonce: `n-${Math.random().toString(36).slice(2)}`, issuedAt: now, expiresAt: now + 60000, issuer: 'console' }, keypair.privateKey);
}

function makeClient({ serverKeypair, orders = [], consoleUrl = 'https://srv:8443', agentKey = 'k-agent-test' } = {}) {
    const storage = {
        getSettings: () => ({ consoleUrl, consolePublicKeyPem: serverKeypair.publicKey, agentId: 'a1', consoleAgentKey: agentKey })
    };
    const inventory = { collect: vi.fn(async () => ({ agentId: 'a1', hostname: 'PC-01' })) };
    const queue = new OrderQueue(null);
    const appended = [];
    const audit = { append: (e) => { appended.push(e); return e; } };
    const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({ serverTime: new Date().toISOString(), orders }) }));
    const client = new ConsoleClient({ storage, inventoryService: inventory, orderQueue: queue, auditLog: audit, fetchFn });
    return { client, queue, appended, fetchFn, inventory };
}

describe('ConsoleClient.sync', () => {
    it('yapılandırma yoksa NOT_CONFIGURED', async () => {
        const storage = { getSettings: () => ({}) };
        const c = new ConsoleClient({ storage, inventoryService: null, orderQueue: new OrderQueue(null), auditLog: null, fetchFn: vi.fn() });
        const res = await c.sync();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('NOT_CONFIGURED');
    });

    it('imzalı emirler kuyruğa girer', async () => {
        const kp = generateKeyPair();
        const orders = [signedOrder(kp), signedOrder(kp, 'apply-policy')];
        const { client, queue, fetchFn } = makeClient({ serverKeypair: kp, orders });
        const res = await client.sync();
        expect(res.ok).toBe(true);
        expect(res.accepted).toBe(2);
        expect(queue.pending()).toHaveLength(2);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(fetchFn.mock.calls[0][0]).toBe('https://srv:8443/api/v1/heartbeat');
    });

    it('yanlış anahtarla imzalı emir reddedilir, kuyruğa girmez', async () => {
        const serverKp = generateKeyPair();
        const attackerKp = generateKeyPair();
        const orders = [signedOrder(attackerKp)];
        const { client, queue, appended } = makeClient({ serverKeypair: serverKp, orders });
        const res = await client.sync();
        expect(res.ok).toBe(true);
        expect(res.accepted).toBe(0);
        expect(res.rejected).toBe(1);
        expect(queue.pending()).toHaveLength(0);
        expect(appended.some((e) => e.action === 'order_rejected')).toBe(true);
    });

    it('heartbeat ajan anahtarıyla kimliklenir', async () => {
        const kp = generateKeyPair();
        const { client, fetchFn } = makeClient({ serverKeypair: kp, agentKey: 'gizli-ajan-anahtari' });
        await client.sync();
        expect(fetchFn.mock.calls[0][1].headers['X-API-Key']).toBe('gizli-ajan-anahtari');
    });

    it('401 → CONSOLE_UNAUTHORIZED (açık hata, sessiz geçilmez)', async () => {
        const kp = generateKeyPair();
        const storage = { getSettings: () => ({ consoleUrl: 'https://srv', consolePublicKeyPem: kp.publicKey, consoleAgentKey: 'yanlis' }) };
        const client = new ConsoleClient({
            storage,
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: new OrderQueue(null),
            auditLog: null,
            fetchFn: async () => ({ ok: false, status: 401 })
        });
        const res = await client.sync();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('CONSOLE_UNAUTHORIZED');
    });

    it('konsol erişilemezse CONSOLE_UNREACHABLE (sessiz, çökme yok)', async () => {
        const kp = generateKeyPair();
        const { client } = makeClient({ serverKeypair: kp });
        client.request = async () => { throw new Error('ECONNREFUSED'); };
        const res = await client.sync();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('CONSOLE_UNREACHABLE');
    });
});

describe('ConsoleClient kill-switch fail-closed (Y-04)', () => {
    function killSwitchClient(updateSettings) {
        const kp = generateKeyPair();
        const storage = {
            getSettings: () => ({
                consoleUrl: 'https://srv',
                consolePublicKeyPem: kp.publicKey,
                agentId: 'a1',
                consoleAgentKey: 'k-agent',
                agentDisabled: false
            }),
            updateSettings
        };
        const queue = new OrderQueue(null);
        const fetchFn = vi.fn(async () => ({
            ok: true,
            json: async () => ({ disabled: true, orders: [signedOrder(kp)] })
        }));
        const client = new ConsoleClient({
            storage,
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: queue,
            auditLog: null,
            fetchFn
        });
        return { client, queue };
    }

    it('bayrak yazılamazsa KILL_SWITCH_PERSIST_FAILED; emir kuyruğa girmez', async () => {
        const { client, queue } = killSwitchClient(() => false);
        const res = await client.sync();
        expect(res).toMatchObject({ ok: false, code: 'KILL_SWITCH_PERSIST_FAILED', disabled: true });
        expect(queue.pending()).toHaveLength(0);
    });

    it('ayar deposu hata fırlatırsa da fail-closed', async () => {
        const { client, queue } = killSwitchClient(() => { throw new Error('disk'); });
        const res = await client.sync();
        expect(res).toMatchObject({ ok: false, code: 'KILL_SWITCH_PERSIST_FAILED', disabled: true });
        expect(queue.pending()).toHaveLength(0);
    });
});
