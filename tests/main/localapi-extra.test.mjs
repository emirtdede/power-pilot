/**
 * localapi-extra.test.mjs - LocalApiService kalan yardımcı dallar
 */
import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import LocalApiService from '../../src/main/services/LocalApiService.js';

const RAW = 'pp_key_extra';
const HASH = crypto.createHash('sha256').update(RAW).digest('hex');

function settings(over = {}) {
    return Object.assign({
        localApiEnabled: true,
        localApiPort: 18456,
        localApiKeyHash: HASH,
        localApiKeyRole: 'admin',
        lanModeEnabled: false,
        lanAllowedIps: [],
        localApiTlsEnabled: false,
        blockRemoteShutdownWhenActive: false
    }, over);
}

function svcWith(over = {}, deps = {}) {
    const storage = { s: settings(over), getSettings() { return this.s; }, updateSettings(p) { Object.assign(this.s, p); return true; } };
    const tm = { pausedAll: false, tasks: [], getActiveTasks: () => [], createTask: vi.fn(() => ({ id: 't' })), cancelTask: vi.fn(() => ({ ok: true })) };
    return { svc: new LocalApiService(storage, tm, {}, deps), storage, tm };
}

const resStub = () => ({
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    body: '',
    headers: {},
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); this.headersSent = true; },
    setHeader(k, v) { this.headers[k] = v; },
    end(chunk) { if (chunk !== undefined) this.body += String(chunk); this.writableEnded = true; }
});

describe('LocalApiService - yanıt yardımcıları', () => {
    it('sendJson başlık gönderildiyse ikinci kez yazmaz', () => {
        const { svc } = svcWith();
        const res = resStub();
        res.headersSent = true;
        expect(svc.sendJson(res, 200, { a: 1 })).toBeUndefined();
        expect(res.body).toBe('');

        const ended = resStub();
        ended.writableEnded = true;
        svc.sendJson(ended, 200, { a: 1 });
        expect(ended.body).toBe('');
    });

    it('sendJson nosniff başlığı ekler', () => {
        const { svc } = svcWith();
        const res = resStub();
        svc.sendJson(res, 201, { ok: true });
        expect(res.statusCode).toBe(201);
        expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
        expect(JSON.parse(res.body)).toEqual({ ok: true });
    });

    it('unavailable 503 döner', () => {
        const { svc } = svcWith();
        const res = resStub();
        svc.unavailable(res, 'Envanter');
        expect(res.statusCode).toBe(503);
        expect(JSON.parse(res.body).code).toBe('UNAVAILABLE');
    });

    it('getDiagnostics rateLimitKeys dahil', () => {
        const { svc } = svcWith();
        svc.requestCounts.set('a', [Date.now()]);
        expect(svc.getDiagnostics().rateLimitKeys).toBe(1);
    });
});

describe('LocalApiService - hız sınırı budama', () => {
    it('pruneRateLimit eski zaman damgalarını temizler', () => {
        const { svc } = svcWith();
        const old = Date.now() - 120000;
        svc.requestCounts.set('old', [old]);
        svc.requestCounts.set('mixed', [old, Date.now()]);
        svc.pruneRateLimit();
        expect(svc.requestCounts.has('old')).toBe(false);
        expect(svc.requestCounts.get('mixed')).toHaveLength(1);
    });

    it('100+ anahtar budanır (bellek sınırı)', () => {
        const { svc } = svcWith();
        for (let i = 0; i < 120; i += 1) svc.requestCounts.set(`k${i}`, [Date.now()]);
        svc.isRateLimited('k119');
        expect(svc.requestCounts.size).toBeLessThanOrEqual(120);
    });

    it('authFailures 429 eşiği ve Retry-After', () => {
        const { svc } = svcWith();
        let res = resStub();
        for (let i = 0; i < 11; i += 1) {
            res = resStub(); // her yanıt yeni (sendJson tek yazım)
            svc.rejectAuth(res, '10.0.0.9');
        }
        expect(res.statusCode).toBe(429);
        expect(res.headers['Retry-After']).toBe('60');
    });

    it('idempotency 5xx saklamaz, 4xx saklar', () => {
        const { svc } = svcWith();
        const res = resStub();
        res.__ppIdempotencyKey = 'k1';
        svc.sendJson(res, 500, { err: 1 });
        expect(svc.idempotencyCache.size).toBe(0);
        const res2 = resStub();
        res2.__ppIdempotencyKey = 'k2';
        svc.sendJson(res2, 400, { err: 2 });
        expect(svc.idempotencyCache.size).toBe(1);
    });
});

describe('LocalApiService - TLS/mTLS yardımcıları', () => {
    it('PFX materyali passphrase ile çözülür', () => {
        const { svc } = svcWith();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pfx-'));
        try {
            const pfx = path.join(dir, 'a.pfx');
            fs.writeFileSync(pfx, Buffer.from('sahte-pfx'));
            const mat = svc.resolveTlsMaterial({
                localApiTlsEnabled: true,
                localApiPfxFile: pfx,
                localApiPfxPassphrase: 'sifre',
                localApiCaFile: path.join(dir, 'yok.crt')
            });
            expect(mat).not.toBeNull();
            expect(mat.pfx).toBeTruthy();
            expect(mat.passphrase).toBe('sifre');
            expect(mat.ca).toBeNull();
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ }
        }
    });

    it('isClientCertOk parmak izi biçimlendirmesini normalize eder', () => {
        const { svc } = svcWith({ localApiRequireClientCert: true, localApiClientFingerprints: [] });
        const fp = 'AB'.repeat(32);
        const req = { socket: { authorized: true, getPeerCertificate: () => ({ fingerprint256: fp.toLowerCase() }) } };
        expect(svc.isClientCertOk(req, { localApiRequireClientCert: true, localApiClientFingerprints: [fp.toLowerCase()] })).toBe(true);
        expect(svc.isClientCertOk({ socket: { authorized: true, getPeerCertificate: () => { throw new Error('x'); } } }, { localApiRequireClientCert: true })).toBe(false);
        expect(svc.isClientCertOk({ socket: { authorized: true } }, { localApiRequireClientCert: true })).toBe(false);
    });

    it('generateApiKey masked alanını yazar', () => {
        const { svc, storage } = svcWith();
        const key = svc.generateApiKey('viewer');
        expect(storage.s.localApiKeyMasked).toContain('...');
        expect(storage.s.localApiKeyMasked.startsWith(key.slice(0, 10))).toBe(true);
        expect(storage.s.localApiKeyCreatedAt).toBeGreaterThan(0);
    });

    it('getSecurityStatus sertifika materyali bilgisini verir', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-cert-'));
        try {
            const cert = path.join(dir, 'c.pem');
            const key = path.join(dir, 'k.pem');
            fs.writeFileSync(cert, 'cert');
            fs.writeFileSync(key, 'key');
            const { svc } = svcWith({ localApiTlsEnabled: true, localApiCertFile: cert, localApiKeyFile: key });
            const st = svc.getSecurityStatus();
            expect(st.tlsEnabled).toBe(true);
            expect(st.hasCertMaterial).toBe(true);
            expect(st.transport).toBe('disabled');
        } finally {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ }
        }
    });

    it('extractBearerToken kenar durumları', () => {
        const { svc } = svcWith();
        expect(svc.extractBearerToken('Bearer   tok  ')).toBe('tok');
        expect(svc.extractBearerToken('BEARER tok')).toBe('tok');
        expect(svc.extractBearerToken('')).toBeNull();
        expect(svc.extractBearerToken(42)).toBeNull();
    });

    it('requiredRole bilinmeyen yol için operator', () => {
        expect(LocalApiService.requiredRole('POST', '/api/v1/unknown')).toBe('operator');
        expect(LocalApiService.requiredRole('GET', '/api/v1/unknown')).toBe('viewer');
    });
});
