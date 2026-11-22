/**
 * model-bundle.test.mjs - AI paketi (LLM + STT) sıralı indirme orkestrasyonu.
 * Gerçek ağ yok - yerel HTTP bayt sunucusu (Range destekli).
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelManager } from '../../src/main/services/ModelManager.js';

let dirs = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bundle-test-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const servers = [];
afterAll(() => {
    for (const s of servers) s.close();
});

function startByteServer(totalBytes) {
    const data = Buffer.alloc(totalBytes, 0xab);
    const server = http.createServer((req, res) => {
        const m = req.headers.range ? req.headers.range.match(/bytes=(\d+)-/) : null;
        if (m) {
            const start = Math.min(parseInt(m[1], 10), totalBytes);
            const slice = data.subarray(start);
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${totalBytes - 1}/${totalBytes}`,
                'Content-Length': slice.length
            });
            res.end(slice);
        } else {
            res.writeHead(200, { 'Content-Length': totalBytes });
            res.end(data);
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            servers.push(server);
            resolve(`http://127.0.0.1:${server.address().port}/model.bin`);
        });
    });
}

function makeManagers(url, dir) {
    const llm = new ModelManager({ modelDir: dir, url, file: 'llm.gguf' });
    const stt = new ModelManager({ modelDir: dir, url, file: 'stt.bin' });
    return { llm, stt };
}

describe('ModelManager.downloadBundle', () => {
    it('iki dosyayı sırayla indirir, adım etiketli ilerleme üretir', async () => {
        const url = await startByteServer(32768);
        const { llm, stt } = makeManagers(url, freshDir());
        const events = [];
        const out = await ModelManager.downloadBundle(llm, stt, (ev) => events.push(ev));
        expect(out.llm.success).toBe(true);
        expect(out.stt.success).toBe(true);
        expect(out.llm.bytes).toBe(32768);
        expect(out.stt.bytes).toBe(32768);
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].step).toBe(1);
        expect(events[0].steps).toBe(2);
        expect(events[0].file).toBe('llm.gguf');
        const last = events[events.length - 1];
        expect(last.step).toBe(2);
        expect(last.file).toBe('stt.bin');
        expect(last.received).toBe(32768);
        expect(last.total).toBe(32768);
        expect(await llm.verify()).toBe(true);
        expect(await stt.verify()).toBe(true);
    });

    it('doğrulanmış dosya atlanır (skipped:true)', async () => {
        const url = await startByteServer(8192);
        const { llm, stt } = makeManagers(url, freshDir());
        await ModelManager.downloadBundle(llm, stt);
        const events = [];
        const out = await ModelManager.downloadBundle(llm, stt, (ev) => events.push(ev));
        expect(out.llm.skipped).toBe(true);
        expect(out.stt.skipped).toBe(true);
        expect(events.some((e) => e.skipped)).toBe(true);
    });

    it('LLM patlarsa STTye geçilmez', async () => {
        const llm = new ModelManager({ modelDir: freshDir(), url: 'http://127.0.0.1:1/kapali' });
        const stt = new ModelManager({ modelDir: freshDir(), url: 'http://127.0.0.1:1/kapali' });
        const out = await ModelManager.downloadBundle(llm, stt);
        expect(out.llm.success).toBe(false);
        expect(out.stt).toBeUndefined();
    });

    it('çift-başlatma ALREADY_DOWNLOADING döner', async () => {
        const url = await startByteServer(8192);
        const { llm, stt } = makeManagers(url, freshDir());
        llm.downloading = true;
        const out = await ModelManager.downloadBundle(llm, stt);
        expect(out.llm.code).toBe('ALREADY_DOWNLOADING');
        llm.downloading = false;
    });

    it('yöneticisiz çağrı reddedilir', async () => {
        await expect(ModelManager.downloadBundle(null, null)).rejects.toThrow();
    });
});
