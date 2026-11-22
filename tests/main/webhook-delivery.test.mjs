/**
 * webhook-delivery.test.mjs - WebhookService teslimat/retry/redaksiyon
 *
 * Ağ YOK: https.request, setTimeout ve DNS lookup enjekte edilir.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

import WebhookService from '../../src/main/services/WebhookService.js';
import { isPublicIp, normalizeHostname } from '../../src/main/security/SsrfGuard.js';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function storageWith(hooks = [], settings = {}) {
    return {
        getWebhooks: () => hooks,
        getSettings: () => settings
    };
}

function fakeResponse(statusCode, body = '') {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.destroy = vi.fn();
    setTimeout(() => {
        if (body) res.emit('data', Buffer.from(body));
        res.emit('end');
    }, 5);
    return res;
}

function makeRequestFactory(handler) {
    return vi.fn((options, cb) => {
        const req = new EventEmitter();
        req.destroy = vi.fn();
        req.end = (body) => {
            const res = handler({ options, body });
            if (res instanceof Error) {
                setTimeout(() => req.emit('error', res), 0);
            } else if (res === 'timeout') {
                setTimeout(() => req.emit('timeout'), 0);
            } else if (res) {
                setTimeout(() => cb(res), 0);
            }
            return req;
        };
        return req;
    });
}

function service({ hooks = [], handler, settings = {}, lookupFn = PUBLIC_LOOKUP, retryNow = true } = {}) {
    const retries = [];
    const svc = new WebhookService(storageWith(hooks, settings), {
        lookupFn,
        httpsRequest: makeRequestFactory(handler || (() => fakeResponse(200))),
        setTimeoutFn: (fn, ms) => {
            // 15 sn sert zaman aşımı testte tetiklenmez (yanıtı beklemeden
            // resolve ederdi); retry gecikmeleri hemen çalıştırılır.
            if (ms === 15000) return { unref: () => {} };
            retries.push({ fn, ms });
            if (retryNow) Promise.resolve().then(fn);
            return { unref: () => {} };
        },
        clearTimeoutFn: (t) => clearTimeout(t),
        jitterFn: () => 0
    });
    return { svc, retries };
}

describe('WebhookService - yük ve yardımcılar', () => {
    it('buildPayload yalnızca beyaz listedeki alanları taşır', () => {
        const { svc } = service({ settings: { agentId: 'agent-9' } });
        const p = svc.buildPayload('task_created', { id: 't1', name: 'n', action: 'lock', source: 'ui', status: 'scheduled', consoleOrderId: 'secret' });
        expect(p).toMatchObject({ event: 'task_created', deviceId: 'agent-9', data: { taskId: 't1', action: 'lock' } });
        expect(p.data.consoleOrderId).toBeUndefined();
        expect(p.eventId.startsWith('evt_')).toBe(true);
        expect(p.appVersion).toBeTruthy();
        expect(svc.buildPayload('ping', {}).data).toBeNull();
    });

    it('retryDelay artan taban + jitter', () => {
        expect(WebhookService.retryDelay(1, 0)).toBe(2000);
        expect(WebhookService.retryDelay(2, 0)).toBe(8000);
        expect(WebhookService.retryDelay(3, 1)).toBe(30000 + 250);
        expect(WebhookService.retryDelay(9, 0)).toBe(30000);
        expect(WebhookService.retryDelay(0, -1)).toBe(2000);
    });

    it('secretFields / redactForUi / mergeSecrets', () => {
        expect(WebhookService.secretFields()).toEqual(['bearerToken', 'basicAuthPass', 'hmacSecret']);
        const redacted = WebhookService.redactForUi([
            { url: 'https://a/h', bearerToken: 't', hmacSecret: 's' },
            { url: 'https://b/h', enabled: true }
        ]);
        expect(redacted[0]).toEqual({ url: 'https://a/h', hasSecret: true });
        expect(redacted[1]).toEqual({ url: 'https://b/h', enabled: true, hasSecret: false });
        expect(WebhookService.redactForUi(null)).toEqual([]);

        const merged = WebhookService.mergeSecrets(
            [{ url: 'https://a/h', hmacSecret: '', hasSecret: true }, { url: 'https://c/h', hmacSecret: 'yeni' }],
            [{ url: 'https://a/h', hmacSecret: 'eski' }]
        );
        expect(merged[0].hmacSecret).toBe('eski');
        expect(merged[0].hasSecret).toBeUndefined();
        expect(merged[1].hmacSecret).toBe('yeni');
    });

    it('SSRF yardımcıları', () => {
        expect(isPublicIp('8.8.8.8')).toBe(true);
        expect(isPublicIp('10.0.0.1')).toBe(false);
        expect(normalizeHostname('[::1]')).toBe('::1');
        expect(normalizeHostname('Example.COM.')).toBe('example.com');
    });
});

describe('WebhookService - gönderim yolları', () => {
    it('geçersiz/sarmsız girdi', async () => {
        const { svc } = service();
        expect(await svc.sendPayload(null, {})).toMatchObject({ ok: false, code: 'INVALID_URL' });
        expect(await svc.sendPayload({ url: 'http://a/h' }, {})).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });
    });

    it('özel IP / DNS hatası reddedilir', async () => {
        const priv = service({ lookupFn: async () => [{ address: '10.0.0.5', family: 4 }] });
        expect(await priv.svc.sendPayload({ url: 'https://a.example/h' }, {})).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });

        const fail = service({ lookupFn: async () => { throw new Error('dns'); } });
        expect(await fail.svc.sendPayload({ url: 'https://a.example/h' }, {})).toMatchObject({ ok: false, code: 'SSRF_BLOCKED' });
    });

    it('2xx başarı; HMAC ve bearer başlıkları', async () => {
        let captured = null;
        const { svc } = service({
            handler: ({ options, body }) => { captured = { options, body }; return fakeResponse(201); }
        });
        const res = await svc.sendPayload({ url: 'https://hooks.example/path', hmacSecret: 's3cr3t', bearerToken: 'tok' }, { eventId: 'evt_1', event: 'x' });
        expect(res).toMatchObject({ ok: true, status: 201 });
        expect(captured.options.hostname).toBe('93.184.216.34');
        expect(captured.options.servername).toBe('hooks.example');
        expect(captured.options.port).toBe(443);
        expect(captured.options.headers['X-PowerPilot-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
        expect(captured.options.headers.Authorization).toBeTruthy();
        expect(captured.options.headers['Idempotency-Key']).toBe('evt_1');
        expect(captured.options.headers['Content-Length']).toBe(Buffer.byteLength(captured.body));
    });

    it('basic auth ve özel başlıklar; güvenlik başlıkları ezilemez', async () => {
        let captured = null;
        const { svc } = service({ handler: ({ options }) => { captured = options; return fakeResponse(200); } });
        await svc.sendPayload({
            url: 'https://hooks.example:8443/h',
            basicAuthUser: 'u',
            basicAuthPass: 'p',
            customHeaders: { 'X-Extra': '1', Host: 'evil', 'X-PowerPilot-Signature': 'bad', 'Content-Type': 'text/plain' }
        }, { eventId: 'e' });
        expect(captured.port).toBe(8443);
        expect(captured.headers['X-Extra']).toBe('1');
        expect(captured.headers.Host).toBe('hooks.example:8443');
        expect(captured.headers['X-PowerPilot-Signature']).toBeUndefined();
        expect(captured.headers['Content-Type']).toBe('application/json');
        expect(captured.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });

    it('5xx/429 yeniden denenir, 4xx denenmez', async () => {
        let calls = 0;
        const retrying = service({
            handler: () => { calls += 1; return fakeResponse(calls === 1 ? 503 : 200); },
            retryNow: true
        });
        const res = await retrying.svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(res.ok).toBe(true);
        expect(calls).toBe(2);
        expect(retrying.retries.length).toBeGreaterThan(0);

        let badCalls = 0;
        const noRetry = service({ handler: () => { badCalls += 1; return fakeResponse(400); } });
        const bad = await noRetry.svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(bad).toMatchObject({ ok: false, status: 400, code: 'HTTP_400' });
        expect(badCalls).toBe(1);
    });

    it('ağ hatası yeniden denenir ve maxAttempts sonunda döner', async () => {
        const { svc } = service({ handler: () => new Error('ECONNRESET'), retryNow: true });
        const res = await svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(res).toMatchObject({ ok: false, code: 'NETWORK_ERROR' });
    });

    it('zaman aşımı sonucu WEBHOOK_TIMEOUT', async () => {
        const { svc } = service({ handler: () => 'timeout', retryNow: true });
        const res = await svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(res.ok).toBe(false);
        expect(['WEBHOOK_TIMEOUT', 'NETWORK_ERROR']).toContain(res.code);
    });

    it('httpsRequest fırlatırsa NETWORK_ERROR', async () => {
        const svc = new WebhookService(storageWith(), {
            lookupFn: PUBLIC_LOOKUP,
            httpsRequest: () => { throw new Error('boom'); },
            setTimeoutFn: () => ({ unref: () => {} }),
            clearTimeoutFn: () => {},
            maxAttempts: 1
        });
        const res = await svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(res).toMatchObject({ ok: false, code: 'NETWORK_ERROR' });
    });

    it('büyük yanıt gövdesi 64 KB sonrası kesilir', async () => {
        let destroyed = false;
        const { svc } = service({
            handler: () => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.destroy = () => { destroyed = true; res.emit('end'); };
                setTimeout(() => {
                    res.emit('data', Buffer.alloc(70 * 1024));
                    res.emit('end');
                }, 5);
                return res;
            }
        });
        await svc.sendPayload({ url: 'https://h.example/x' }, { eventId: 'e' });
        expect(destroyed).toBe(true);
    });
});

describe('WebhookService - tetikleme ve eşzamanlılık', () => {
    it('triggerEvent yalnızca etkin + abone hook\'lara gönderir', async () => {
        const hooks = [
            { url: 'https://a.example/h', enabled: true, events: ['task_created'] },
            { url: 'https://b.example/h', enabled: false, events: ['task_created'] },
            { url: 'https://c.example/h', enabled: true, events: ['other'] }
        ];
        const sent = [];
        const { svc } = service({ hooks, handler: ({ options }) => { sent.push(options.servername); return fakeResponse(200); } });
        svc.triggerEvent('task_created', { id: 't1' });
        await new Promise((r) => setTimeout(r, 30));
        expect(sent).toEqual(['a.example']);

        svc.triggerEvent('bilinmeyen', {});
        await new Promise((r) => setTimeout(r, 10));
        expect(sent).toHaveLength(1);
    });

    it('eşzamanlı teslimat maxConcurrent ile sınırlanır', async () => {
        const gates = [];
        const svc = new WebhookService(storageWith(), {
            lookupFn: PUBLIC_LOOKUP,
            httpsRequest: makeRequestFactory(() => {
                const res = new EventEmitter();
                res.statusCode = 200;
                res.destroy = () => {};
                gates.push(res);
                return res;
            }),
            maxConcurrent: 2,
            setTimeoutFn: (fn) => ({ unref: () => {} }),
            clearTimeoutFn: () => {}
        });
        for (let i = 0; i < 4; i += 1) svc._enqueue(() => svc.sendPayload({ url: 'https://h.example/x' }, { eventId: `e${i}` }));
        await new Promise((r) => setTimeout(r, 10));
        expect(svc._activeDeliveries).toBe(2);
        for (const res of gates.slice()) res.emit('end');
        await new Promise((r) => setTimeout(r, 20));
    });

    it('kuyruk görevi hata verirse yutulur ve sayaç düşer', async () => {
        const svc = new WebhookService(storageWith(), { lookupFn: PUBLIC_LOOKUP, maxConcurrent: 1 });
        svc._enqueue(() => { throw new Error('boom'); });
        await new Promise((r) => setTimeout(r, 20));
        expect(svc._activeDeliveries).toBe(0);
        expect(svc._deliveryQueue).toHaveLength(0);
    });
});
