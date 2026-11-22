/**
 * order-executor.test.mjs - FAZ B
 * apply-policy / revoke-policy / wake / güç emri / dalga-erteleme.
 */
import { describe, it, expect, vi } from 'vitest';
import { OrderExecutor } from '../../src/main/services/OrderExecutor.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';

function makeTasks() {
    const tasks = [];
    return {
        tasks,
        createTask: vi.fn((data) => {
            const t = { id: `task_${tasks.length + 1}`, policyId: data.policyId || null, ...data };
            tasks.push(t);
            return t;
        }),
        cancelTask: vi.fn((id) => {
            const t = tasks.find((x) => x.id === id);
            if (t) t.cancelled = true;
        })
    };
}

function rec(action, params = {}, nonce = `n-${Math.random().toString(36).slice(2)}`) {
    return { key: `k-${nonce}`, order: { action, params, nonce, issuedAt: Date.now() }, signature: 'x', status: 'pending' };
}

describe('OrderExecutor', () => {
    it('apply-policy göreve somutlaşır', async () => {
        const tm = makeTasks();
        const ex = new OrderExecutor({ taskManager: tm, deviceService: null, audit: null });
        const policy = { id: 'pol-gece', type: 'nightly-shutdown', targets: ['a1'], params: { timeOfDay: '19:30', days: [1, 2, 3, 4, 5] } };
        const r = await ex.executeRecord(rec('apply-policy', { policy }));
        expect(r.ok).toBe(true);
        expect(tm.createTask).toHaveBeenCalledTimes(1);
        expect(tm.tasks[0].policyId).toBe('pol-gece');
    });

    it('revoke-policy aynı politikalı görevleri iptal eder', async () => {
        const tm = makeTasks();
        tm.tasks.push({ id: 'task_9', policyId: 'pol-gece' }, { id: 'task_10', policyId: 'diger' });
        const ex = new OrderExecutor({ taskManager: tm, deviceService: null, audit: null });
        const r = await ex.executeRecord(rec('revoke-policy', { policyId: 'pol-gece' }));
        expect(r.ok).toBe(true);
        expect(tm.cancelTask).toHaveBeenCalledWith('task_9');
        expect(tm.cancelTask).not.toHaveBeenCalledWith('task_10');
    });

    it('wake WoL gönderir; dalga saati gelmemişse ertelenir', async () => {
        const devices = { sendWakeOnLan: vi.fn(async () => ({ success: true })) };
        const ex = new OrderExecutor({ taskManager: null, deviceService: devices, audit: null, nowFn: () => 1000 });
        const ok = await ex.executeRecord(rec('wake', { mac: 'AA:BB:CC:DD:EE:FF' }));
        expect(ok.ok).toBe(true);
        expect(devices.sendWakeOnLan).toHaveBeenCalled();
        const late = await ex.executeRecord(rec('wake', { mac: 'AA:BB:CC:DD:EE:FF', notBefore: 999999 }));
        expect(late.code).toBe('deferred');
    });

    it('güç emri konsol görevi kurar', async () => {
        const tm = makeTasks();
        const ex = new OrderExecutor({ taskManager: tm, deviceService: null, audit: null });
        const r = await ex.executeRecord(rec('lock'));
        expect(r.ok).toBe(true);
        expect(tm.tasks[0].source).toBe('console');
    });

    it('drain hepsini ackler, deferred hariç', async () => {
        const tm = makeTasks();
        const devices = { sendWakeOnLan: vi.fn(async () => ({ success: true })) };
        const ex = new OrderExecutor({ taskManager: tm, deviceService: devices, audit: null, nowFn: () => 1000 });
        const q = new OrderQueue(null);
        // OrderQueue.enqueue nonce ister - rec key/order yapısı uyumlu:
        q.enqueue({ order: { action: 'lock', nonce: 'd1' }, signature: 'x' });
        q.enqueue({ order: { action: 'wake', nonce: 'd2', params: undefined }, signature: 'x' });
        const out = await ex.drain(q);
        expect(out.executed).toBe(2);
        expect(q.pending()).toHaveLength(0);
    });
});
