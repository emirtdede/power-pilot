/**
 * localapi-mtls.test.mjs - FAZ A
 * mTLS iskeleti + rol-bazlı anahtar + rotasyon + güvenlik özeti.
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import LocalApiService from '../../src/main/services/LocalApiService.js';

const TEST_KEY = 'pp_key_test123';
const TEST_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex');

function makeService(settingsOverrides = {}) {
    const storage = {
        getSettings: () => Object.assign(
            { localApiKeyHash: TEST_HASH, localApiKeyRole: 'admin', localApiEnabled: true, localApiPort: 18456, lanModeEnabled: false, lanAllowedIps: ['127.0.0.1'] },
            settingsOverrides
        ),
        updateSettings: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        pausedAll: false,
        tasks: [],
        createTask: vi.fn((data) => ({ id: 't1', toJSON: () => ({ id: 't1', ...data }) })),
        cancelTask: vi.fn()
    };
    const powerService = { execute: vi.fn(async () => ({ success: true })) };
    return { svc: new LocalApiService(storage, taskManager, powerService), storage, taskManager, powerService };
}

function fakeReq({ ip = '127.0.0.1', headers = {}, url = '/api/v1/status', method = 'GET', socketExtra = {} } = {}) {
    const handlers = {};
    return {
        socket: { remoteAddress: ip, ...socketExtra },
        headers, url, method,
        on(ev, fn) { handlers[ev] = fn; return this; },
        __send(bodyStr) {
            if (bodyStr && handlers.data) handlers.data(bodyStr);
            handlers.end();
        },
        __hasBodyListener() { return typeof handlers.end === 'function'; }
    };
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
    };
}

function authed(svc, path, { role, ...extra } = {}) {
    const req = fakeReq({ url: path, method: 'GET', headers: { 'x-api-key': TEST_KEY }, ...extra });
    const res = fakeRes();
    svc.handleRequest(req, res);
    if (req.__hasBodyListener()) req.__send('');
    return res;
}

function postAuthed(svc, path, body, extra = {}) {
    const req = fakeReq({ url: path, method: 'POST', headers: { 'x-api-key': TEST_KEY, 'content-type': 'application/json' }, ...extra });
    const res = fakeRes();
    svc.handleRequest(req, res);
    if (req.__hasBodyListener()) req.__send(JSON.stringify(body));
    return res;
}

describe('FAZ A: mTLS kapısı', () => {
    it('sertifika zorunlu değilse eski istemciler çalışır (geriye uyumlu)', () => {
        const { svc } = makeService();
        const res = authed(svc, '/api/v1/status');
        expect(res.statusCode).toBe(200);
    });

    it('mTLS zorunlu + sertifikasız istemci → 401 MTLS_REQUIRED', () => {
        const { svc } = makeService({ localApiRequireClientCert: true });
        const res = authed(svc, '/api/v1/status');
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('MTLS_REQUIRED');
    });

    it('mTLS zorunlu + doğrulanmış sertifikalı istemci → geçer', () => {
        const { svc } = makeService({ localApiRequireClientCert: true });
        const res = authed(svc, '/api/v1/status', {
            socketExtra: {
                authorized: true,
                authorizationError: null,
                getPeerCertificate: () => ({ subject: { CN: 'pilot-pc-01' }, fingerprint256: 'AA:BB' })
            }
        });
        expect(res.statusCode).toBe(200);
    });

    it('T-TLS-05: self-signed / doğrulanmamış sertifika 401 (authorized=false)', () => {
        const { svc } = makeService({ localApiRequireClientCert: true });
        const res = authed(svc, '/api/v1/status', {
            socketExtra: {
                authorized: false,
                authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
                getPeerCertificate: () => ({ subject: { CN: 'saldirgan' }, fingerprint256: 'CC:DD' })
            }
        });
        expect(res.statusCode).toBe(401);
        expect(res.body.code).toBe('MTLS_REQUIRED');
    });

    it('T-TLS-05: authorizationError doluysa 401', () => {
        const { svc } = makeService({ localApiRequireClientCert: true });
        const res = authed(svc, '/api/v1/status', {
            socketExtra: {
                authorized: true,
                authorizationError: 'CERT_HAS_EXPIRED',
                getPeerCertificate: () => ({ subject: { CN: 'suresi-gecmis' }, fingerprint256: 'EE:FF' })
            }
        });
        expect(res.statusCode).toBe(401);
    });

    it('T-TLS-11: parmak izi allowlist dışındaki istemci 401', () => {
        const { svc } = makeService({
            localApiRequireClientCert: true,
            localApiClientFingerprints: ['11:22:33']
        });
        const res = authed(svc, '/api/v1/status', {
            socketExtra: {
                authorized: true,
                authorizationError: null,
                getPeerCertificate: () => ({ subject: { CN: 'baska' }, fingerprint256: 'AA:BB:CC' })
            }
        });
        expect(res.statusCode).toBe(401);
    });

    it('T-TLS-11: allowlist içindeki parmak izi geçer', () => {
        const { svc } = makeService({
            localApiRequireClientCert: true,
            localApiClientFingerprints: ['aa:bb:cc']
        });
        const res = authed(svc, '/api/v1/status', {
            socketExtra: {
                authorized: true,
                authorizationError: null,
                getPeerCertificate: () => ({ subject: { CN: 'pilot' }, fingerprint256: 'AA:BB:CC' })
            }
        });
        expect(res.statusCode).toBe(200);
    });
});

describe('FAZ A: rol-bazlı anahtar', () => {
    it('viewer salt-okunur: GET serbest, güç yasak (403)', () => {
        const { svc } = makeService({ localApiKeyRole: 'viewer' });
        expect(authed(svc, '/api/v1/status').statusCode).toBe(200);
        const res = postAuthed(svc, '/api/v1/power/lock', {});
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
    });

    it('operator: lock serbest, shutdown yasak (403)', () => {
        const { svc, powerService, taskManager } = makeService({ localApiKeyRole: 'operator' });
        expect(postAuthed(svc, '/api/v1/power/lock', {}).statusCode).toBe(200);
        // K3: doğrudan icra YOK - görev hattı kurulur (güvenlik+uyarı+denetim).
        expect(powerService.execute).not.toHaveBeenCalled();
        expect(taskManager.createTask).toHaveBeenCalledTimes(1);
        const arg = taskManager.createTask.mock.calls[0][0];
        expect(arg.action).toBe('lock');
        expect(arg.source).toBe('local_api');
        expect(arg.trigger.durationMs).toBe(5000);
        expect(postAuthed(svc, '/api/v1/power/shutdown', {}).statusCode).toBe(403);
    });

    it('güç uçları görev kurar, anında çalıştırmaz (K3, 5/5 eylem)', () => {
        const { svc, powerService, taskManager } = makeService({ localApiKeyRole: 'admin' });
        for (const action of ['lock', 'signout', 'restart', 'sleep', 'hibernate']) {
            const res = postAuthed(svc, `/api/v1/power/${action}`, {});
            expect(res.statusCode).toBe(200);
            expect(res.body.taskId).toBe('t1');
        }
        expect(powerService.execute).not.toHaveBeenCalled();
        expect(taskManager.createTask).toHaveBeenCalledTimes(5);
    });

    it('admin: her şey serbest', () => {
        const { svc } = makeService({ localApiKeyRole: 'admin' });
        expect(postAuthed(svc, '/api/v1/power/shutdown', {}).statusCode).toBe(200);
    });

    it('kayıtsız rol fail-closed reddedilir', () => {
        const { svc } = makeService({ localApiKeyRole: undefined });
        // Y-06: roleOf undefined → null; hiçbir uç yetkili sayılmaz.
        expect(LocalApiService.roleOf({})).toBe(null);
        const res = postAuthed(svc, '/api/v1/power/shutdown', {});
        expect(res.statusCode).toBe(403);
    });

    it('generateApiKey rolü saklar', () => {
        const { svc, storage } = makeService();
        const key = svc.generateApiKey('viewer');
        expect(key.startsWith('pp_key_')).toBe(true);
        expect(storage.updateSettings).toHaveBeenCalledTimes(1);
        expect(storage.updateSettings.mock.calls[0][0].localApiKeyRole).toBe('viewer');
    });
});

describe('FAZ A: rotasyon + güvenlik özeti', () => {
    it('90 günü geçen anahtar rotationDue=true', () => {
        const { svc } = makeService({ localApiKeyCreatedAt: Date.now() - 91 * 86400000 });
        expect(svc.getSecurityStatus().rotationDue).toBe(true);
    });

    it('yeni anahtar rotationDue=false', () => {
        const { svc } = makeService({ localApiKeyCreatedAt: Date.now() });
        expect(svc.getSecurityStatus().rotationDue).toBe(false);
    });

    it('TLS açık ama materyal yoksa seçenek null (sessiz http fallback yok)', () => {
        const { svc } = makeService({ localApiTlsEnabled: true });
        expect(svc.getServerOptions(svc.storage.getSettings())).toBeNull();
        expect(svc.getSecurityStatus().hasCertMaterial).toBe(false);
    });
});
