/**
 * model-manager-download.test.mjs - model indirme/bütünlük akışı
 * fetchFn enjekte edilir; ağ YOK. Dosyalar GEÇİCİ dizinde.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ModelManager as ModelManagerClass } from '../../src/main/services/ModelManager.js';

const ModelManager = ModelManagerClass;

let dir;
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-model-')); });
afterEach(() => safeRm(dir));

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function streamOf(chunks) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const c of chunks) yield Buffer.from(c);
        }
    };
}

function res({ status = 200, body = null, headers = {} } = {}) {
    return {
        status,
        body,
        headers: { get: (name) => headers[String(name).toLowerCase()] || null }
    };
}

function manager({ fetchImpl, expectedBytes = null, expectedSha256 = null } = {}) {
    return new ModelManager({
        modelDir: dir,
        modelId: 'stt-test',
        file: 'model.bin',
        url: 'https://models.example/model.bin',
        expectedBytes,
        expectedSha256,
        fetchFn: fetchImpl
    });
}

describe('ModelManager - yollar ve status', () => {
    it('yollar türetilir', () => {
        const m = manager({ fetchImpl: async () => res() });
        expect(m.modelPath()).toBe(path.join(dir, 'model.bin'));
        expect(m.partPath()).toBe(path.join(dir, 'model.bin.part'));
        expect(m.manifestPath()).toBe(path.join(dir, 'model.bin.manifest.json'));
    });

    it('status dosya yokken sıfır değerler', () => {
        const st = manager({ fetchImpl: async () => res() }).status();
        expect(st).toMatchObject({ modelId: 'stt-test', present: false, bytes: 0, partialBytes: 0, manifest: null });
    });

    it('manifest bozuksa null', () => {
        const m = manager({ fetchImpl: async () => res() });
        m.ensureDir();
        fs.writeFileSync(m.manifestPath(), '{bozuk');
        expect(m.readManifest()).toBeNull();
    });

    it('verify: dosya/manifest yoksa false; eşleşirse true', async () => {
        const m = manager({ fetchImpl: async () => res() });
        expect(await m.verify()).toBe(false);

        m.ensureDir();
        const payload = Buffer.from('içerik');
        fs.writeFileSync(m.modelPath(), payload);
        fs.writeFileSync(m.manifestPath(), JSON.stringify({ sha256: sha(payload) }));
        expect(await m.verify()).toBe(true);
    });

    it('verify pin uyuşmazlığında false', async () => {
        const payload = Buffer.from('içerik');
        const pinned = manager({ fetchImpl: async () => res(), expectedBytes: payload.length + 1, expectedSha256: sha(payload) });
        pinned.ensureDir();
        fs.writeFileSync(pinned.modelPath(), payload);
        fs.writeFileSync(pinned.manifestPath(), JSON.stringify({ sha256: sha(payload) }));
        expect(await pinned.verify()).toBe(false);

        const badSha = manager({ fetchImpl: async () => res(), expectedSha256: 'f'.repeat(64) });
        badSha.ensureDir();
        fs.writeFileSync(badSha.modelPath(), payload);
        fs.writeFileSync(badSha.manifestPath(), JSON.stringify({ sha256: sha(payload) }));
        expect(await badSha.verify()).toBe(false);
    });
});

describe('ModelManager - indirme', () => {
    it('model dizini yoksa hata', async () => {
        const m = new ModelManager({ modelDir: null, fetchFn: async () => res() });
        await expect(m.download()).resolves.toMatchObject({ success: false });
    });

    it('çift indirme ALREADY_DOWNLOADING', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const m = manager({ fetchImpl: async () => { await gate; return res({ body: streamOf(['ab']) }); } });
        const first = m.download();
        const second = await m.download();
        expect(second.code).toBe('ALREADY_DOWNLOADING');
        release();
        await first;
    });

    it('başarılı indirme + manifest + onProgress', async () => {
        const payload = Buffer.from('model-içeriği');
        const progress = vi.fn();
        const m = manager({ fetchImpl: async () => res({ body: streamOf([payload]) }), expectedBytes: payload.length, expectedSha256: sha(payload) });
        const out = await m.download(progress);
        expect(out).toMatchObject({ success: true, bytes: payload.length, resumed: false });
        expect(progress).toHaveBeenCalled();
        expect(fs.existsSync(m.modelPath())).toBe(true);
        expect(fs.existsSync(m.partPath())).toBe(false);
        expect(JSON.parse(fs.readFileSync(m.manifestPath(), 'utf8'))).toMatchObject({ sha256: sha(payload), modelId: 'stt-test' });
    });

    it('mevcut geçerli dosya varsa yeniden indirmez', async () => {
        const payload = Buffer.from('mevcut');
        const fetchImpl = vi.fn();
        const m = manager({ fetchImpl, expectedBytes: payload.length, expectedSha256: sha(payload) });
        m.ensureDir();
        fs.writeFileSync(m.modelPath(), payload);
        fs.writeFileSync(m.manifestPath(), JSON.stringify({ sha256: sha(payload) }));
        const out = await m.download();
        expect(out.success).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('bozuk mevcut dosya silinip yeniden indirilir', async () => {
        const payload = Buffer.from('yeni-içerik');
        const m = manager({ fetchImpl: async () => res({ body: streamOf([payload]) }), expectedBytes: payload.length, expectedSha256: sha(payload) });
        m.ensureDir();
        fs.writeFileSync(m.modelPath(), 'eski-bozuk');
        fs.writeFileSync(m.manifestPath(), JSON.stringify({ sha256: 'yanlış' }));
        const out = await m.download();
        expect(out.success).toBe(true);
        expect(fs.readFileSync(m.modelPath(), 'utf8')).toBe('yeni-içerik');
    });

    it('bağlantı hatası / HTTP hatası / boş gövde', async () => {
        await expect(manager({ fetchImpl: async () => { throw new Error('ağ'); } }).download()).resolves.toMatchObject({ success: false });
        await expect(manager({ fetchImpl: async () => res({ status: 500 }) }).download()).resolves.toMatchObject({ success: false });
        await expect(manager({ fetchImpl: async () => res({ status: 200, body: null }) }).download()).resolves.toMatchObject({ success: false });
    });

    it('boyut uyuşmazlığı reddedilir; fazla bayt kesilir', async () => {
        const payload = Buffer.from('abcdef');
        const m = manager({ fetchImpl: async () => res({ body: streamOf([payload]), headers: { 'content-length': '999' } }), expectedBytes: 6 });
        await expect(m.download()).resolves.toMatchObject({ success: false });

        const tooMuch = manager({ fetchImpl: async () => res({ body: streamOf(['abcdefghij']) }), expectedBytes: 3 });
        const out = await tooMuch.download();
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/fazla bayt/);
    });

    it('SHA uyuşmazlığı .part dosyasını siler', async () => {
        const payload = Buffer.from('veri');
        const m = manager({ fetchImpl: async () => res({ body: streamOf([payload]) }), expectedSha256: 'a'.repeat(64) });
        const out = await m.download();
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/SHA-256/);
        expect(fs.existsSync(m.partPath())).toBe(false);
    });

    it('boyut doğrulaması eksik dosyayı resume için bırakır', async () => {
        const m = manager({ fetchImpl: async () => res({ body: streamOf(['abc']) }), expectedBytes: 10 });
        const out = await m.download();
        expect(out.success).toBe(false);
        expect(fs.existsSync(m.partPath())).toBe(true);
    });

    it('Range ile kaldığı yerden devam eder (206)', async () => {
        const full = Buffer.from('0123456789');
        const m = manager({ fetchImpl: async () => res({ status: 206, body: streamOf([full.subarray(5)]), headers: { 'content-range': 'bytes 5-9/10' } }), expectedBytes: 10, expectedSha256: sha(full) });
        m.ensureDir();
        fs.writeFileSync(m.partPath(), full.subarray(0, 5));
        const out = await m.download();
        expect(out).toMatchObject({ success: true, bytes: 10, resumed: true });
        expect(fs.readFileSync(m.modelPath())).toEqual(full);
    });

    it('206 Content-Range başlangıcı uyuşmazsa baştan dener', async () => {
        const full = Buffer.from('abcdef');
        let calls = 0;
        const m = manager({
            expectedBytes: 6,
            expectedSha256: sha(full),
            fetchImpl: async () => {
                calls += 1;
                if (calls === 1) return res({ status: 206, body: streamOf(['x']), headers: { 'content-range': 'bytes 1-2/6' } });
                return res({ status: 200, body: streamOf([full]) });
            }
        });
        m.ensureDir();
        fs.writeFileSync(m.partPath(), 'ab'); // startAt=2, sunucu 1 diyor → uyuşmazlık
        const out = await m.download();
        expect(calls).toBe(2);
        expect(out.success).toBe(true);
    });

    it('416: .part tam ise finalize edilir; değilse baştan dener', async () => {
        const payload = Buffer.from('tam');
        const m = manager({
            expectedBytes: payload.length,
            expectedSha256: sha(payload),
            fetchImpl: async () => res({ status: 416, headers: { 'content-range': `bytes */${payload.length}` } })
        });
        m.ensureDir();
        fs.writeFileSync(m.partPath(), payload);
        const out = await m.download();
        expect(out.success).toBe(true);
        expect(fs.readFileSync(m.modelPath())).toEqual(payload);

        let calls = 0;
        const retry = manager({
            expectedBytes: 10,
            fetchImpl: async () => {
                calls += 1;
                if (calls === 1) return res({ status: 416, headers: { 'content-range': 'bytes */10' } });
                return res({ status: 200, body: streamOf(['0123456789']) });
            }
        });
        retry.ensureDir();
        fs.writeFileSync(retry.partPath(), 'kısa');
        const second = await retry.download();
        expect(calls).toBe(2);
        expect(second.success).toBe(true);
    });

    it('200 yanıtı Range yok sayarsa dosya baştan yazılır', async () => {
        const payload = Buffer.from('baştan');
        const m = manager({ fetchImpl: async () => res({ status: 200, body: streamOf([payload]) }), expectedBytes: payload.length, expectedSha256: sha(payload) });
        m.ensureDir();
        fs.writeFileSync(m.partPath(), 'eski-veri');
        const out = await m.download();
        expect(out.success).toBe(true);
        expect(fs.readFileSync(m.modelPath())).toEqual(payload);
    });

    it('.part beklenenden büyükse silinip baştan başlanır', async () => {
        const payload = Buffer.from('küçük');
        const m = manager({ fetchImpl: async () => res({ body: streamOf([payload]) }), expectedBytes: payload.length });
        m.ensureDir();
        fs.writeFileSync(m.partPath(), Buffer.alloc(100));
        const out = await m.download();
        expect(out.success).toBe(true);
    });

    it('ağ akışı hata verirse İndirme kesildi', async () => {
        const brokenStream = {
            async *[Symbol.asyncIterator]() {
                yield Buffer.from('ab');
                throw new Error('akış koptu');
            }
        };
        const m = manager({ fetchImpl: async () => res({ body: brokenStream }) });
        const out = await m.download();
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/kesildi/);
    });
});
