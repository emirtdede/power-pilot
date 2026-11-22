/**
 * orderqueue-executor.test.mjs - emir kuyruğu + icra hattı
 * Depo sahte bellek; TaskManager/DeviceService enjekte edilir. Ağ/OS yok.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrderQueue as OrderQueueClass } from '../../src/main/services/OrderQueue.js';
import { OrderExecutor as OrderExecutorClass } from '../../src/main/services/OrderExecutor.js';

const OrderQueue = OrderQueueClass;
const OrderExecutor = OrderExecutorClass;

function memStore(initial = {}) {
    const state = { orders: initial.orders || [] };
    return {
        state,
        getOrders: () => state.orders,
        saveOrders: (list) => { state.orders = list; return true; },
        failNext: false
    };
}

const signed = (nonce = 'n1', over = {}) => ({ order: { nonce, action: 'lock', params: {}, targets: ['a'], ...over }, signature: 'sig' });

describe('OrderQueue - kuyruk', () => {
    it('anahtar türetimi: nonce → idempotencyKey → null', () => {
        expect(OrderQueue.keyOf(signed('abc'))).toBe('nonce:abc');
        expect(OrderQueue.keyOf({ order: {}, idempotencyKey: 'k' })).toBe('key:k');
        expect(OrderQueue.keyOf({ order: {} })).toBeNull();
        expect(OrderQueue.keyOf(null)).toBeNull();
    });

    it('enqueue idempotent; geçersiz emir reddedilir', () => {
        const storage = memStore();
        const q = new OrderQueue(storage);
        const a = q.enqueue(signed('n1'));
        expect(a).toMatchObject({ duplicate: false });
        expect(a.record.status).toBe('pending');
        const b = q.enqueue(signed('n1'));
        expect(b.duplicate).toBe(true);
        expect(b.record.key).toBe(a.record.key);
        expect(q.pending()).toHaveLength(1);
        expect(() => q.enqueue(null)).toThrow(/Geçersiz emir/);
        expect(() => q.enqueue({})).toThrow(/Geçersiz emir/);
    });

    it('explicit idempotencyKey nonce anahtarını geçersiz kılar', () => {
        const q = new OrderQueue(memStore());
        const r = q.enqueue(signed('n1'), { idempotencyKey: 'idem-9' });
        expect(r.record.key).toBe('idem-9');
    });

    it('depo yazımı başarısızsa yarım kayıt bırakmaz', () => {
        const storage = memStore();
        const q = new OrderQueue(storage);
        const spy = vi.spyOn(q, 'persist').mockImplementation(() => { throw new Error('disk'); });
        expect(() => q.enqueue(signed('x'))).toThrow(/disk/);
        spy.mockRestore();
        expect(q.pending()).toHaveLength(0);
    });

    it('kapasite dolunca acked budanır, pending korunur; hepsi pending ise QUEUE_FULL', () => {
        const pendingList = Array.from({ length: 200 }, (_, i) => ({ key: `k${i}`, status: 'pending', order: { nonce: `n${i}` }, receivedAt: new Date().toISOString(), ackedAt: null }));
        const q = new OrderQueue(memStore({ orders: pendingList }));
        expect(() => q.enqueue(signed('yeni'))).toThrow();
        try { q.enqueue(signed('yeni')); } catch (err) { expect(err.code).toBe('QUEUE_FULL'); }

        const mixed = Array.from({ length: 200 }, (_, i) => ({
            key: `k${i}`, status: i === 0 ? 'pending' : 'acked', order: { nonce: `n${i}` },
            receivedAt: new Date().toISOString(), ackedAt: i === 0 ? null : new Date(Date.now() - 30 * 86400000).toISOString()
        }));
        const q2 = new OrderQueue(memStore({ orders: mixed }));
        const r = q2.enqueue(signed('yeni'));
        expect(r.duplicate).toBe(false);
        expect(q2.pending().some((o) => o.order.nonce === 'yeni')).toBe(true);
    });

    it('ack: yok → null; başarılı → acked; depo hatasında geri alınır', () => {
        const storage = memStore();
        const q = new OrderQueue(storage);
        expect(q.ack('yok')).toBeNull();
        const { record } = q.enqueue(signed('n1'));
        const acked = q.ack(record.key, { code: 'OK', message: 'tamam' });
        expect(acked.status).toBe('acked');
        expect(acked.result).toEqual({ code: 'OK', message: 'tamam' });

        const failing = new OrderQueue(storage);
        const rec2 = failing.enqueue(signed('n2')).record;
        const spy = vi.spyOn(failing, 'persist').mockImplementation(() => { throw new Error('disk'); });
        expect(() => failing.ack(rec2.key)).toThrow(/disk/);
        spy.mockRestore();
        expect(failing.load().find((o) => o.key === rec2.key).status).toBe('pending');
    });

    it('makbuz akışı: peek → markSent / markFailed → purge', () => {
        const storage = memStore();
        const q = new OrderQueue(storage);
        const { record } = q.enqueue(signed('n1'));
        q.ack(record.key, { code: 'OS_OK' });
        const pending = q.peekUnsentReceipts();
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ key: record.key, nonce: 'n1', action: 'lock', code: 'OS_OK' });

        expect(q.markReceiptsSent([])).toBe(0);
        expect(q.markReceiptsSent([{ key: record.key }])).toBe(1);
        expect(q.peekUnsentReceipts()).toHaveLength(0);

        const { record: r2 } = q.enqueue(signed('n2'));
        q.ack(r2.key);
        expect(q.markReceiptsFailed([{ key: r2.key }], 'ağ yok')).toBe(1);
        const afterFail = q.load().find((o) => o.key === r2.key);
        expect(afterFail.receiptSent).toBe(false);
        expect(q.peekUnsentReceipts().some((r) => r.key === r2.key)).toBe(true);

        expect(q.takeUnsentReceipts().length).toBeGreaterThanOrEqual(1);
        expect(q.purge()).toBeGreaterThanOrEqual(0);
    });

    it('purge süresi geçmiş acked kayıtları siler', () => {
        const old = new Date(Date.now() - 10 * 86400000).toISOString();
        const storage = memStore({
            orders: [
                { key: 'old', status: 'acked', ackedAt: old, order: { nonce: 'n' }, receivedAt: old },
                { key: 'new', status: 'acked', ackedAt: new Date().toISOString(), order: { nonce: 'm' }, receivedAt: new Date().toISOString() },
                { key: 'pend', status: 'pending', order: { nonce: 'p' }, receivedAt: old }
            ]
        });
        const q = new OrderQueue(storage);
        expect(q.purge()).toBe(1);
        expect(q.load().map((o) => o.key).sort()).toEqual(['new', 'pend']);
    });

    it('depo yoksa boş liste', () => {
        const q = new OrderQueue(null);
        expect(q.load()).toEqual([]);
        expect(q.pending()).toEqual([]);
        q.persist([]);
    });
});

describe('OrderExecutor - icra hattı', () => {
    function harness(over = {}) {
        const taskManager = Object.assign({
            createTask: vi.fn((data) => ({ id: 'task_new', consoleOrderId: data.consoleOrderId })),
            cancelTask: vi.fn()
        }, over.taskManager || {});
        const deviceService = Object.assign({}, over.deviceService || {});
        const audit = Object.assign({ append: vi.fn() }, over.audit || {});
        const executor = new OrderExecutor({ taskManager, deviceService, audit, nowFn: over.nowFn });
        return { executor, taskManager, deviceService, audit };
    }

    const record = (over = {}) => Object.assign({
        key: 'k1',
        order: { nonce: 'n1', action: 'lock', params: {}, targets: ['a'] },
        status: 'pending'
    }, over);

    it('desteklenen güç eylemi göreve dönüşür', async () => {
        const { executor, taskManager } = harness();
        const res = await executor.executeRecord(record());
        expect(res).toMatchObject({ ok: true, code: 'success' });
        expect(taskManager.createTask).toHaveBeenCalled();
        expect(taskManager.createTask.mock.calls[0][0]).toMatchObject({ action: 'lock', source: 'console', consoleOrderId: 'n1' });
    });

    it('desteklenmeyen eylem reddedilir', async () => {
        const { executor, taskManager } = harness();
        const res = await executor.executeRecord(record({ order: { nonce: 'n', action: 'format', params: {} } }));
        expect(res.ok).toBe(false);
        expect(res.code).toBe('unknown_action');
        expect(taskManager.createTask).not.toHaveBeenCalled();
    });

    it('createTask hatası yakalanır ve sonuç kodu döner', async () => {
        const { executor } = harness({ taskManager: { createTask: () => { const e = new Error('kota'); e.code = 'TASK_PERSIST_FAILED'; throw e; } } });
        const res = await executor.executeRecord(record());
        expect(res.ok).toBe(false);
        expect(res.code).toBe('TASK_PERSIST_FAILED');
    });

    it('drain yalnız pending kayıtları işler ve ack eder', async () => {
        const storage = memStore();
        const queue = new OrderQueue(storage);
        const { record: r1 } = queue.enqueue(signed('n1'));
        queue.ack(r1.key); // acked → işlenmez
        const { record: r2 } = queue.enqueue(signed('n2'));
        const { executor, taskManager } = harness();
        const out = await executor.drain(queue);
        expect(out.executed).toBe(1);
        expect(taskManager.createTask).toHaveBeenCalledTimes(1);
        expect(queue.load().find((o) => o.key === r2.key).status).toBe('acked');
    });

    it('queue yoksa drain güvenli', async () => {
        const { executor } = harness();
        await expect(executor.drain({ pending: () => [] })).resolves.toEqual({ executed: 0, failed: 0, deferred: 0 });
    });
});
