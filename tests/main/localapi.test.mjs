/**
 * localapi.test.mjs - WBS-0.3 / TS-0.3
 * Güç rotaları: 6/6 parite, bilinmeyen path 404.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LocalApiService from '../../src/main/services/LocalApiService.js';

function makeService() {
    const storage = {
        getSettings: () => ({ localApiKeyHash: 'abc', localApiEnabled: true, localApiPort: 18456 }),
        updateSettings: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        tasks: [],
        createTask: vi.fn((data) => ({ id: 'task_api_1', toJSON: () => ({ id: 'task_api_1', ...data }) })),
        cancelTask: vi.fn()
    };
    const powerService = { execute: vi.fn(async () => ({ success: true })) };
    const svc = new LocalApiService(storage, taskManager, powerService);
    return { svc, storage, taskManager, powerService };
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { this.body = JSON.parse(payload); }
    };
}

describe('LocalApiService güç rotaları (TS-0.3)', () => {
    let ctx;
    beforeEach(() => { ctx = makeService(); });

    for (const action of ['lock', 'signout', 'restart', 'sleep', 'hibernate']) {
        it(`POST /power/${action} → 200 + görev kurar, anında çalıştırmaz (K3)`, () => {
            const res = fakeRes();
            ctx.svc.route('POST', `/api/v1/power/${action}`, {}, res, { role: 'admin' });
            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.taskId).toBe('task_api_1');
            expect(ctx.powerService.execute).not.toHaveBeenCalled();
            expect(ctx.taskManager.createTask).toHaveBeenCalledTimes(1);
            const arg = ctx.taskManager.createTask.mock.calls[0][0];
            expect(arg.action).toBe(action);
            expect(arg.source).toBe('local_api');
            expect(arg.trigger.durationMs).toBe(5000);
        });
    }

    it('POST /power/shutdown → görev zamanlar (5sn)', () => {
        const res = fakeRes();
        ctx.svc.route('POST', '/api/v1/power/shutdown', {}, res, { role: 'admin' });
        expect(res.statusCode).toBe(200);
        expect(ctx.taskManager.createTask).toHaveBeenCalled();
        const arg = ctx.taskManager.createTask.mock.calls[0][0];
        expect(arg.action).toBe('shutdown');
        expect(arg.trigger.durationMs).toBe(5000);
    });

    it('POST /tasks/timer geçersiz eylemi 400 ile reddeder (fail-fast)', () => {
        const res = fakeRes();
        ctx.svc.route('POST', '/api/v1/tasks/timer', { action: 'format', durationMs: 60000 }, res, { role: 'admin' });
        expect(res.statusCode).toBe(400);
        expect(ctx.taskManager.createTask).not.toHaveBeenCalled();
    });

    it('POST /tasks/timer bozuk süreyi 400 ile reddeder', () => {
        for (const durationMs of [-5, 0, 2500000001, '15dk', 1.5]) {
            const res = fakeRes();
            ctx.svc.route('POST', '/api/v1/tasks/timer', { action: 'shutdown', durationMs }, res, { role: 'admin' });
            expect(res.statusCode).toBe(400);
        }
        expect(ctx.taskManager.createTask).not.toHaveBeenCalled();
    });

    it('POST /tasks/timer geçerli gövdeyi kabul eder (201)', () => {
        const res = fakeRes();
        ctx.svc.route('POST', '/api/v1/tasks/timer', { action: 'sleep', durationMs: 900000 }, res, { role: 'admin' });
        expect(res.statusCode).toBe(201);
        expect(ctx.taskManager.createTask).toHaveBeenCalledTimes(1);
    });

    it('POST /tasks/timer HTML/uzun adı 400 ile reddeder (K2)', () => {
        for (const name of ['<img src=x onerror=alert(1)>', 'a'.repeat(121), 12345]) {
            const res = fakeRes();
            ctx.svc.route('POST', '/api/v1/tasks/timer', { action: 'sleep', durationMs: 900000, name }, res, { role: 'admin' });
            expect(res.statusCode).toBe(400);
        }
        expect(ctx.taskManager.createTask).not.toHaveBeenCalled();
    });
    it('bilinmeyen güç eylemi → 404', () => {
        const res = fakeRes();
        ctx.svc.route('POST', '/api/v1/power/format', {}, res, { role: 'admin' });
        expect(res.statusCode).toBe(404);
    });

    it('GET /status görev sayısını raporlar', () => {
        const res = fakeRes();
        ctx.svc.route('GET', '/api/v1/status', {}, res, { role: 'admin' });
        expect(res.statusCode).toBe(200);
        expect(res.body.app).toBe('Power Pilot');
    });

    it('generateApiKey hash + maske + zaman damgası yazar (plan kapanışı)', () => {
        const key = ctx.svc.generateApiKey();
        expect(key.startsWith('pp_key_')).toBe(true);
        expect(ctx.storage.updateSettings).toHaveBeenCalledTimes(1);
        const patch = ctx.storage.updateSettings.mock.calls[0][0];
        expect(typeof patch.localApiKeyHash).toBe('string');
        expect(patch.localApiKeyHash).toHaveLength(64);
        expect(typeof patch.localApiKeyMasked).toBe('string');
        expect(typeof patch.localApiKeyCreatedAt).toBe('number');
    });
});
