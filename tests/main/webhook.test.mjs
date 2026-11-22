/**
 * webhook.test.mjs - WebhookService: gizlilik (secret sızıntısı yok), eşleşme filtresi, geçersiz protokol.
 */
import { describe, it, expect, vi } from 'vitest';
import WebhookService from '../../src/main/services/WebhookService.js';

function makeService(webhooks) {
    const storage = {
        getWebhooks: () => webhooks,
        getSettings: () => ({ agentId: 'agent-1' })
    };
    return new WebhookService(storage);
}

const flush = () => new Promise((r) => setImmediate(r));

describe('WebhookService', () => {
    it('buildPayload secret/token içermez', () => {
        const svc = makeService([]);
        const payload = svc.buildPayload('task_created', {
            id: 't1', name: 'N', source: 'local_api', status: 'scheduled', action: 'shutdown',
            apiKey: 'pp_key_GİZLİ', bearerToken: 'GİZLİ', hmacSecret: 'GİZLİ'
        });
        const json = JSON.stringify(payload);
        expect(json).not.toMatch(/GİZLİ/);
        expect(payload).toMatchObject({
            event: 'task_created',
            deviceId: 'agent-1',
            appVersion: expect.any(String)
        });
        expect(payload.eventId).toMatch(/^evt_/);
        expect(payload.data).toEqual({
            taskId: 't1',
            name: 'N',
            source: 'local_api',
            status: 'scheduled',
            action: 'shutdown'
        });
        expect(payload).not.toHaveProperty('schemaVersion');
        expect(payload).not.toHaveProperty('task');
    });

    it('webhook yoksa gönderim yapılmaz', async () => {
        const svc = makeService([]);
        const spy = vi.spyOn(svc, 'sendPayload').mockImplementation(() => {});
        svc.triggerEvent('task_created', { id: 't' });
        await flush();
        expect(spy).not.toHaveBeenCalled();
    });

    it('devre dışı veya eşleşmeyen olay gönderilmez', async () => {
        const svc = makeService([
            { url: 'https://x/1', enabled: false, events: ['task_created'] },
            { url: 'https://x/2', enabled: true, events: ['task_blocked'] }
        ]);
        const spy = vi.spyOn(svc, 'sendPayload').mockImplementation(() => {});
        svc.triggerEvent('task_created', { id: 't' });
        await flush();
        expect(spy).not.toHaveBeenCalled();
    });

    it('eşleşen aktif hook gönderilir (non-blocking)', async () => {
        const svc = makeService([{ url: 'https://x/1', enabled: true, events: ['task_created'] }]);
        const spy = vi.spyOn(svc, 'sendPayload').mockImplementation(() => {});
        svc.triggerEvent('task_created', { id: 't' });
        await flush();
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('geçersiz protokol ağa çıkmadan reddedilir', () => {
        const svc = makeService([]);
        expect(() => svc.sendPayload({ url: 'ftp://x/y' }, { eventType: 't' })).not.toThrow();
        expect(() => svc.sendPayload({ url: 'not-a-url' }, { eventType: 't' })).not.toThrow();
        expect(() => svc.sendPayload({}, { eventType: 't' })).not.toThrow();
    });
});

describe('WebhookService secret gizliliği (WBS-5.2)', () => {
    it('redactForUi secretları çıkarır + hasSecret bayrağı koyar', () => {
        const out = WebhookService.redactForUi([
            { url: 'https://x/1', bearerToken: 'GİZLİ', basicAuthUser: 'u', basicAuthPass: 'GİZLİ', hmacSecret: 'GİZLİ' },
            { url: 'https://x/2', enabled: true }
        ]);
        const json = JSON.stringify(out);
        expect(json).not.toMatch(/GİZLİ/);
        expect(out[0].hasSecret).toBe(true);
        expect(out[0].basicAuthUser).toBe('u');
        expect(out[1].hasSecret).toBe(false);
    });

    it('mergeSecrets boş secretları mevcutla doldurur', () => {
        const existing = [{ url: 'https://x/1', bearerToken: 'ESKİ', hmacSecret: 'ESKİ-H' }];
        const incoming = [{ url: 'https://x/1', enabled: true, hasSecret: true }];
        const merged = WebhookService.mergeSecrets(incoming, existing);
        expect(merged[0].bearerToken).toBe('ESKİ');
        expect(merged[0].hmacSecret).toBe('ESKİ-H');
        expect(merged[0]).not.toHaveProperty('hasSecret');
    });

    it('mergeSecrets dolu geleni üzerine yazar, yeni URL boş kalır', () => {
        const existing = [{ url: 'https://x/1', bearerToken: 'ESKİ' }];
        const merged = WebhookService.mergeSecrets([
            { url: 'https://x/1', bearerToken: 'YENİ' },
            { url: 'https://x/yeni', enabled: true }
        ], existing);
        expect(merged[0].bearerToken).toBe('YENİ');
        expect(merged[1]).not.toHaveProperty('bearerToken');
    });
});
