/**
 * webhook-ssrf.test.mjs - WP-12.T1-T4, T-NET-01..05
 * SSRF kapısı, DNS pinleme, HTTPS sınırı, HMAC ve retry davranışı.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import WebhookService from '../../src/main/services/WebhookService.js';
import { SsrfGuard, validateUrl, isPublicIp } from '../../src/main/security/SsrfGuard.js';

const storage = {
    getWebhooks: () => [],
    getSettings: () => ({ agentId: 'agent-1' })
};

const rapidTimers = () => {
    const delays = [];
    return {
        delays,
        setTimeoutFn: (fn, delay) => {
            delays.push(delay);
            if (delay >= 15000) return 1; // hard timeout test tarafından tetiklenmez
            return setTimeout(fn, 0);
        },
        clearTimeoutFn: (id) => clearTimeout(id)
    };
};

function makeRequest(script) {
    const calls = [];
    const fn = (options, onResponse) => {
        const req = new EventEmitter();
        req.destroy = vi.fn();
        req.end = (body) => {
            calls.push({ options, body });
            script({ req, options, body, onResponse, index: calls.length });
        };
        return req;
    };
    fn.calls = calls;
    return fn;
}

function respond (req, onResponse, status, body = '') {
    process.nextTick(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        onResponse(res);
        if (body) res.emit('data', Buffer.from(body));
        res.emit('end');
    });
}

describe('SsrfGuard - adres sınıfları (T-NET-01/02)', () => {
    it('özel/loopback/link-local/CGNAT/mapped/reserved reddedilir', () => {
        const blocked = [
            '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.10',
            '169.254.169.254', '100.64.0.1', '0.0.0.0', '255.255.255.255',
            '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'
        ];
        for (const ip of blocked) expect(isPublicIp(ip), ip).toBe(false);
    });

    it('genel unicast kabul edilir', () => {
        expect(isPublicIp('8.8.8.8')).toBe(true);
        expect(isPublicIp('93.184.216.34')).toBe(true);
        expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    });
});

describe('URL şeması (T-NET-01)', () => {
    it('yalnızca https + 443/8443 + userinfo yok', () => {
        expect(validateUrl('https://example.com/hook').ok).toBe(true);
        expect(validateUrl('https://example.com:8443/hook').ok).toBe(true);
        expect(validateUrl('http://127.0.0.1/hook').ok).toBe(false);
        expect(validateUrl('https://example.com:8080/hook').ok).toBe(false);
        expect(validateUrl('https://user:pass@example.com/hook').ok).toBe(false);
        expect(validateUrl('ftp://example.com/hook').ok).toBe(false);
        expect(validateUrl('not-a-url').ok).toBe(false);
    });

    it('IDN host punycode’a normalize edilir', () => {
        const r = validateUrl('https://türkçe.example/hook');
        expect(r.ok).toBe(true);
        expect(r.hostname).toMatch(/^xn--/);
    });
});

describe('DNS pinleme ve SSRF (T-NET-02)', () => {
    it('DNS özel adres döndürürse istek gitmez', async () => {
        const request = makeRequest(() => {});
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '10.0.0.5', family: 4 }],
            httpsRequest: request
        });
        const res = await svc.sendPayload({ url: 'https://internal.example/hook' }, { eventId: 'e1' });
        expect(res.code).toBe('SSRF_BLOCKED');
        expect(request.calls.length).toBe(0);
    });

    it('karışık DNS yanıtı (genel + özel) reddedilir', async () => {
        const guard = new SsrfGuard({ lookupFn: async () => [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.5', family: 4 }
        ] });
        const r = await guard.resolvePublicAddress('example.com');
        expect(r.ok).toBe(false);
    });

    it('doğrulanmış IP lookup ile pinlenir; SNI ve Host korunur', async () => {
        const request = makeRequest(({ req, onResponse }) => respond(req, onResponse, 200));
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            httpsRequest: request,
            ...rapidTimers()
        });
        const payload = svc.buildPayload('task_created', { id: 't1' });
        const res = await svc.sendPayload({ url: 'https://example.com/hook', hmacSecret: 's3cret' }, payload);
        expect(res.ok).toBe(true);
        const opts = request.calls[0].options;
        expect(opts.hostname).toBe('93.184.216.34');
        expect(opts.servername).toBe('example.com');
        expect(opts.headers.Host).toBe('example.com');
        expect(opts.rejectUnauthorized).toBe(true);
        // Pinlenmiş lookup DNS'i tekrar çözmez (rebinding kapalı).
        let called = 0;
        const lookup = SsrfGuard.pinnedLookup(opts.hostname, 4);
        lookup('evil.example', { all: false }, (err, address) => { called++; expect(address).toBe('93.184.216.34'); });
        expect(called).toBe(1);
    });

    it('özel IP literal ağa çıkmadan reddedilir', async () => {
        const request = makeRequest(() => {});
        const svc = new WebhookService(storage, { httpsRequest: request });
        expect((await svc.sendPayload({ url: 'https://127.0.0.1/hook' }, {})).code).toBe('SSRF_BLOCKED');
        expect((await svc.sendPayload({ url: 'https://[::1]/hook' }, {})).code).toBe('SSRF_BLOCKED');
        expect(request.calls.length).toBe(0);
    });
});

describe('HMAC ve idempotency (T-NET-04/05)', () => {
    it('timestamp + sha256 imza + sabit Idempotency-Key gönderir', async () => {
        const request = makeRequest(({ req, onResponse }) => respond(req, onResponse, 200));
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            httpsRequest: request,
            ...rapidTimers()
        });
        const payload = svc.buildPayload('task_created', { id: 't1', name: 'N' });
        await svc.sendPayload({ url: 'https://example.com/hook', hmacSecret: 's3cret' }, payload);
        const headers = request.calls[0].options.headers;
        expect(headers['Idempotency-Key']).toBe(payload.eventId);
        expect(headers['X-PowerPilot-Timestamp']).toMatch(/^\d+$/);
        expect(headers['X-PowerPilot-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
        expect(headers.Authorization).toBeUndefined();
        expect(JSON.stringify(payload)).not.toMatch(/s3cret/);
    });

    it('302 yönlendirme izlenmez ve tek denemede biter', async () => {
        const request = makeRequest(({ req, onResponse }) => respond(req, onResponse, 302));
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            httpsRequest: request,
            ...rapidTimers()
        });
        const res = await svc.sendPayload({ url: 'https://example.com/hook' }, { eventId: 'e1' });
        expect(res).toMatchObject({ ok: false, status: 302 });
        expect(request.calls.length).toBe(1);
    });
});

describe('Retry ve timeout (T-NET-03)', () => {
    it('ağ hatası + 500 sonrası 3. denemede başarı; sabit idempotency', async () => {
        const timers = rapidTimers();
        const request = makeRequest(({ req, onResponse, index }) => {
            if (index === 1) process.nextTick(() => req.emit('error', new Error('reset')));
            else if (index === 2) respond(req, onResponse, 500);
            else respond(req, onResponse, 200);
        });
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            httpsRequest: request,
            jitterFn: () => 0,
            ...timers
        });
        const res = await svc.sendPayload({ url: 'https://example.com/hook' }, { eventId: 'fixed-id' });
        expect(res.ok).toBe(true);
        expect(request.calls.length).toBe(3);
        expect(request.calls.map((c) => c.options.headers['Idempotency-Key'])).toEqual(['fixed-id', 'fixed-id', 'fixed-id']);
        expect(timers.delays.filter((d) => d < 15000)).toEqual([2000, 8000]);
    });

    it('timeout + error aynı anda çift POST üretmez', async () => {
        const request = makeRequest(({ req }) => {
            process.nextTick(() => {
                req.emit('timeout');
                req.emit('error', new Error('late error'));
            });
        });
        const svc = new WebhookService(storage, {
            lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
            httpsRequest: request,
            jitterFn: () => 0,
            ...rapidTimers()
        });
        const res = await svc.sendPayload({ url: 'https://example.com/hook' }, { eventId: 'e2' });
        expect(res.ok).toBe(false);
        expect(request.calls.length).toBe(3);
    });

    it('retryDelay 2s/8s/30s + jitter', () => {
        expect(WebhookService.retryDelay(1, 0)).toBe(2000);
        expect(WebhookService.retryDelay(2, 0)).toBe(8000);
        expect(WebhookService.retryDelay(3, 0)).toBe(30000);
        expect(WebhookService.retryDelay(1, 0.5)).toBe(2125);
    });
});
