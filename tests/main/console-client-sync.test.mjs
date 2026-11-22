/**
 * console-client-sync.test.mjs - ajan → konsol heartbeat/sync hattı
 * Taşıma enjekte edilir (fetchFn); gerçek ağ yok.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import orderModule from '../../src/main/services/SignedOrderService.js';

const { generateKeyPair, sign } = orderModule;
const { publicKey, privateKey } = generateKeyPair();

function storage(over = {}) {
    const state = Object.assign({
        consoleUrl: 'https://console.example',
        consolePublicKeyPem: publicKey,
        consoleAgentKey: 'agent-key',
        agentId: 'agent-1',
        agentDisabled: false
    }, over);
    return {
        state,
        getSettings: () => state,
        updateSettings: (patch) => { Object.assign(state, patch); return true; }
    };
}

function res(status, payload = {}, okOverride = null) {
    return {
        ok: okOverride === null ? status >= 200 && status < 300 : okOverride,
        status,
        json: async () => {
            if (payload === 'bad-json') throw new Error('JSON değil');
            return payload;
        }
    };
}

function client({ store = storage(), fetchImpl = async () => res(200, {}), queue = null, audit = null, inventory = null } = {}) {
    return new ConsoleClient({
        storage: store,
        inventoryService: inventory || { collect: async () => ({ agentId: 'agent-1', hostname: 'pc' }) },
        orderQueue: queue,
        auditLog: audit,
        fetchFn: fetchImpl
    });
}

describe('ConsoleClient - yapılandırma ve taşıma', () => {
    it('isConfigured üç alanı ister', () => {
        expect(client().isConfigured()).toBe(true);
        expect(client({ store: storage({ consoleUrl: null }) }).isConfigured()).toBe(false);
        expect(client({ store: storage({ consolePublicKeyPem: null }) }).isConfigured()).toBe(false);
        expect(client({ store: storage({ consoleAgentKey: null }) }).isConfigured()).toBe(false);
        const bare = new ConsoleClient({});
        expect(bare.settings()).toEqual({});
        expect(bare.isConfigured()).toBe(false);
    });

    it('yapılandırma yoksa NOT_CONFIGURED', async () => {
        const c = client({ store: storage({ consoleUrl: null }) });
        await expect(c.sync()).resolves.toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    });

    it('https olmayan URL istek atmadan reddedilir', async () => {
        const fetchImpl = vi.fn();
        const c = client({ store: storage({ consoleUrl: 'http://console.example' }), fetchImpl });
        await expect(c.sync()).resolves.toMatchObject({ ok: false, code: 'TLS_REQUIRED' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('envanter hatası INVENTORY_FAILED', async () => {
        const c = client({ inventory: { collect: async () => { throw new Error('envanter'); } } });
        await expect(c.sync()).resolves.toMatchObject({ ok: false, code: 'INVENTORY_FAILED' });
    });

    it('sync tek-uçuşludur (aynı Promise paylaşılır)', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const fetchImpl = vi.fn(async () => { await gate; return res(200, {}); });
        const c = client({ fetchImpl });
        const a = c.sync();
        const b = c.sync();
        expect(a).toBe(b);
        release();
        await a;
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        await c.sync();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('ConsoleClient - yanıt hata kodları', () => {
    it('TLS sertifika hatası ayrı kodla döner ve makbuzlar başarısız işaretlenir', async () => {
        const queue = { peekUnsentReceipts: () => [{ key: 'r1' }], markReceiptsFailed: vi.fn(), markReceiptsSent: vi.fn() };
        const c = client({
            queue,
            fetchImpl: async () => {
                const err = new Error('self signed certificate');
                err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
                throw err;
            }
        });
        const out = await c.sync();
        expect(out.code).toBe('TLS_CERTIFICATE_ERROR');
        expect(queue.markReceiptsFailed).toHaveBeenCalled();
    });

    it('TLS_REQUIRED ve genel ağ hatası', async () => {
        // 'TLS_REQUIRED' kodu da TLS sınıfına girer → sertifika hatası kodu döner.
        const tls = client({ fetchImpl: async () => { throw Object.assign(new Error('tls'), { code: 'TLS_REQUIRED' }); } });
        await expect(tls.sync()).resolves.toMatchObject({ code: 'TLS_CERTIFICATE_ERROR' });

        const generic = client({ fetchImpl: async () => { throw new Error('ağ yok'); } });
        await expect(generic.sync()).resolves.toMatchObject({ code: 'CONSOLE_UNREACHABLE' });
    });

    it('401/403 → CONSOLE_UNAUTHORIZED; 3xx → CONSOLE_REDIRECT; 5xx → CONSOLE_ERROR', async () => {
        await expect(client({ fetchImpl: async () => res(401) }).sync()).resolves.toMatchObject({ code: 'CONSOLE_UNAUTHORIZED' });
        await expect(client({ fetchImpl: async () => res(403) }).sync()).resolves.toMatchObject({ code: 'CONSOLE_UNAUTHORIZED' });
        await expect(client({ fetchImpl: async () => res(302, {}, false) }).sync()).resolves.toMatchObject({ code: 'CONSOLE_REDIRECT' });
        await expect(client({ fetchImpl: async () => res(500) }).sync()).resolves.toMatchObject({ code: 'CONSOLE_ERROR' });
    });

    it('204 boş gövde makbuzları gönderilmiş sayar', async () => {
        const queue = { peekUnsentReceipts: () => [{ key: 'r1' }], markReceiptsSent: vi.fn(), markReceiptsFailed: vi.fn() };
        const c = client({ queue, fetchImpl: async () => res(204, 'bad-json') });
        const out = await c.sync();
        expect(out).toMatchObject({ ok: true, accepted: 0, rejected: 0 });
        expect(queue.markReceiptsSent).toHaveBeenCalledWith([{ key: 'r1' }]);
    });

    it('JSON olmayan 2xx yanıtı BAD_RESPONSE', async () => {
        const c = client({ fetchImpl: async () => res(200, 'bad-json') });
        await expect(c.sync()).resolves.toMatchObject({ code: 'BAD_RESPONSE' });
    });

    it('takeUnsentReceipts geriye uyum adaptörü', async () => {
        const queue = { takeUnsentReceipts: () => [{ key: 'legacy' }], markReceiptsSent: vi.fn() };
        const c = client({ queue, fetchImpl: async () => res(204) });
        await c.sync();
        expect(queue.markReceiptsSent).toHaveBeenCalledWith([{ key: 'legacy' }]);
    });
});

describe('ConsoleClient - kill-switch', () => {
    it('sunucu disabled=true → kalıcı ayar + audit, icra durur', async () => {
        const store = storage();
        const audit = { append: vi.fn() };
        const c = client({ store, audit, fetchImpl: async () => res(200, { disabled: true }) });
        const out = await c.sync();
        expect(out).toMatchObject({ ok: true, disabled: true, accepted: 0 });
        expect(store.state.agentDisabled).toBe(true);
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_disabled' }));
    });

    it('disabled kalıcılaştırılamazsa fail-closed', async () => {
        const store = storage();
        store.updateSettings = () => false;
        const c = client({ store, fetchImpl: async () => res(200, { disabled: true }) });
        await expect(c.sync()).resolves.toMatchObject({ ok: false, code: 'KILL_SWITCH_PERSIST_FAILED', disabled: true });

        const noStore = storage();
        const broken = new ConsoleClient({ storage: { getSettings: () => ({ ...noStore.state, consoleUrl: 'https://c', consolePublicKeyPem: publicKey, consoleAgentKey: 'k' }) }, fetchFn: async () => res(200, { disabled: true }) });
        await expect(broken.sync()).resolves.toMatchObject({ code: 'KILL_SWITCH_PERSIST_FAILED' });
    });

    it('zaten disabled ise emir işlenmez', async () => {
        const c = client({ store: storage({ agentDisabled: true }), fetchImpl: async () => res(200, { disabled: true, orders: [] }) });
        await expect(c.sync()).resolves.toMatchObject({ ok: true, disabled: true });
    });
});

describe('ConsoleClient - emir doğrulama ve kuyruk', () => {
    function queueSpy({ duplicate = false, throwOnEnqueue = false } = {}) {
        return {
            peekUnsentReceipts: () => [],
            markReceiptsSent: vi.fn(),
            markReceiptsFailed: vi.fn(),
            enqueue: vi.fn(() => {
                if (throwOnEnqueue) throw Object.assign(new Error('dolu'), { code: 'QUEUE_FULL' });
                return { duplicate };
            })
        };
    }

    it('geçerli emir kuyruğa girer, geçersiz reddedilir ve denetlenir', async () => {
        const queue = queueSpy();
        const audit = { append: vi.fn() };
        const good = sign({ action: 'lock', targets: ['agent-1'] }, privateKey);
        const bad = { order: { ...good.order, action: 'LOCK' }, signature: good.signature };
        const c = client({ queue, audit, fetchImpl: async () => res(200, { orders: [good, bad] }) });
        const out = await c.sync();
        expect(out).toMatchObject({ ok: true, accepted: 1, rejected: 1 });
        expect(queue.enqueue).toHaveBeenCalledTimes(1);
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_queued' }));
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_rejected' }));
    });

    it('yinelenen emir order_duplicate olarak denetlenir', async () => {
        const queue = queueSpy({ duplicate: true });
        const audit = { append: vi.fn() };
        const good = sign({ action: 'lock', targets: ['agent-1'] }, privateKey);
        const c = client({ queue, audit, fetchImpl: async () => res(200, { orders: [good] }) });
        const out = await c.sync();
        expect(out.accepted).toBe(1);
        expect(audit.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_duplicate' }));
    });

    it('kuyruk hatası rejected sayılır', async () => {
        const queue = queueSpy({ throwOnEnqueue: true });
        const good = sign({ action: 'lock', targets: ['agent-1'] }, privateKey);
        const c = client({ queue, fetchImpl: async () => res(200, { orders: [good] }) });
        const out = await c.sync();
        expect(out).toMatchObject({ accepted: 0, rejected: 1 });
        expect(out.details[0].code).toBe('QUEUE_FULL');
    });

    it('orders alanı yoksa boş kabul', async () => {
        const c = client({ fetchImpl: async () => res(200, {}) });
        await expect(c.sync()).resolves.toMatchObject({ ok: true, accepted: 0, rejected: 0, serverTime: null });
    });
});
