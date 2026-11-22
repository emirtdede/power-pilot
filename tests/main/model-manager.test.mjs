/**
 * model-manager.test.mjs - WBS-7.2 / TS-7.2
 * ModelManager: tam indirme, resume, bozuk-dosya, bağlantı hatası.
 * Gerçek ağ yok - yerel HTTP bayt sunucusu (Range destekli).
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelManager, MODEL_FILE, MODEL_SPECS, AI_TIERS } from '../../src/main/services/ModelManager.js';
import { verifyMetadata } from '../../scripts/verify-models.js';

let dirs = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-model-test-'));
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

// Belirlenen bayt sayısını sunar; Range başlığını anlar.
function startByteServer(totalBytes) {
    const data = Buffer.alloc(totalBytes, 0xab);
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ range: req.headers.range || null });
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
            resolve({ port: server.address().port, requests });
        });
    });
}

describe('ModelManager indirme (TS-7.2)', () => {
    it('tam indirme + manifest + verify geçer', async () => {
        const { port, requests } = await startByteServer(65536);
        const mm = new ModelManager({ modelDir: freshDir(), url: `http://127.0.0.1:${port}/model.gguf` });
        const progress = [];
        const r = await mm.download((rec, total) => progress.push([rec, total]));
        expect(r.success).toBe(true);
        expect(r.bytes).toBe(65536);
        expect(typeof r.sha256).toBe('string');
        expect(r.sha256).toHaveLength(64);
        expect(requests[0].range).toBeNull();
        expect(progress.length).toBeGreaterThan(0);
        expect(progress[progress.length - 1][0]).toBe(65536);
        expect(progress[progress.length - 1][1]).toBe(65536);
        expect(fs.existsSync(path.join(mm.modelDir, MODEL_FILE))).toBe(true);
        expect(await mm.verify()).toBe(true);
        expect(mm.status().present).toBe(true);
    });

    it('yarım dosya kaldığı yerden devam eder (Range)', async () => {
        const { port, requests } = await startByteServer(65536);
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, `${MODEL_FILE}.part`), Buffer.alloc(10000, 0xab));
        const mm = new ModelManager({ modelDir: dir, url: `http://127.0.0.1:${port}/model.gguf` });
        const r = await mm.download();
        expect(r.success).toBe(true);
        expect(r.resumed).toBe(true);
        expect(r.bytes).toBe(65536);
        expect(requests[0].range).toBe('bytes=10000-');
        expect(await mm.verify()).toBe(true);
    });

    it('bozuk dosya verify geçemez + yeniden indirilir', async () => {
        const { port } = await startByteServer(1024);
        const mm = new ModelManager({ modelDir: freshDir(), url: `http://127.0.0.1:${port}/model.gguf` });
        const first = await mm.download();
        expect(first.success).toBe(true);
        // Dosyayı boz
        fs.appendFileSync(path.join(mm.modelDir, MODEL_FILE), Buffer.from([0x00]));
        expect(await mm.verify()).toBe(false);
        // Tekrar indirme bozuk dosyayı değiştirir
        const second = await mm.download();
        expect(second.success).toBe(true);
        expect(await mm.verify()).toBe(true);
    });

    it('mevcut sağlam dosya yeniden indirilmez', async () => {
        let hits = 0;
        const server = http.createServer((req, res) => {
            hits += 1;
            res.writeHead(200, { 'Content-Length': 128 });
            res.end(Buffer.alloc(128, 1));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push(server);
        const mm = new ModelManager({ modelDir: freshDir(), url: `http://127.0.0.1:${server.address().port}/m` });
        await mm.download();
        expect(hits).toBe(1);
        const again = await mm.download();
        expect(again.success).toBe(true);
        expect(hits).toBe(1);
    });

    it('bağlantı hatası fail-closed döner', async () => {
        const mm = new ModelManager({
            modelDir: freshDir(),
            url: 'http://127.0.0.1:1/kapali',
            fetchFn: async () => { throw new Error('ECONNREFUSED'); }
        });
        const r = await mm.download();
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/Bağlantı/);
    });

    it('HTTP 500 fail-closed döner', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(500);
            res.end('hata');
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push(server);
        const mm = new ModelManager({ modelDir: freshDir(), url: `http://127.0.0.1:${server.address().port}/m` });
        const r = await mm.download();
        expect(r.success).toBe(false);
        expect(r.error).toMatch(/500/);
    });

    it('modelDir yoksa fail-closed döner', async () => {
        const mm = new ModelManager({});
        expect((await mm.download()).success).toBe(false);
        expect(mm.status().present).toBe(false);
    });

    it('iki model aynı dizinde çakışmaz (ayrı manifest)', async () => {
        const { port } = await startByteServer(4096);
        const dir = freshDir();
        const url = `http://127.0.0.1:${port}/model.gguf`;
        const llm = new ModelManager({ modelDir: dir, url });
        const stt = new ModelManager({ modelDir: dir, url, modelId: 'whisper-base', file: 'ggml-base.bin' });
        expect((await llm.download()).success).toBe(true);
        expect((await stt.download()).success).toBe(true);
        expect(llm.status().present).toBe(true);
        expect(stt.status().present).toBe(true);
        expect(await llm.verify()).toBe(true);
        expect(await stt.verify()).toBe(true);
        expect(fs.existsSync(path.join(dir, 'ggml-base.bin'))).toBe(true);
    });

    it('eşzamanlı ikinci indirme reddedilir (ALREADY_DOWNLOADING)', async () => {
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Length': 300 });
            let i = 0;
            const iv = setInterval(() => {
                i += 1;
                res.write(Buffer.alloc(100, 7));
                if (i >= 3) {
                    clearInterval(iv);
                    res.end();
                }
            }, 60);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push(server);
        const mm = new ModelManager({ modelDir: freshDir(), url: `http://127.0.0.1:${server.address().port}/m` });
        const first = mm.download();
        const second = await mm.download();
        expect(second.success).toBe(false);
        expect(second.code).toBe('ALREADY_DOWNLOADING');
        const done = await first;
        expect(done.success).toBe(true);
        // Bayrak temizlendi - yeni indirme başlayabilir (dosya sağlam olduğundan kısa devre).
        expect((await mm.download()).success).toBe(true);
    });

    it('TS-1.1: 6 model pininin tamamı (lite/balanced/powerful LLM + STT) verifyMetadata kontrolünden geçer', () => {
        expect(Object.keys(MODEL_SPECS)).toHaveLength(6);
        expect(Object.keys(AI_TIERS)).toEqual(['lite', 'balanced', 'powerful']);
        expect(verifyMetadata(MODEL_SPECS)).toEqual([]);
        expect(AI_TIERS.lite.totalBytes).toBe(484220320 + 77691713);
        expect(AI_TIERS.balanced.totalBytes).toBe(1282439584 + 147951465);
        expect(AI_TIERS.powerful.totalBytes).toBe(2497280960 + 190085487);
    });

    it('TS-1.2: indirme sırasında cancel() çağrıldığında .part korunur ve sonraki download() HTTP Range ile devam eder', async () => {
        const totalBytes = 65536;
        const fullBuf = Buffer.alloc(totalBytes, 0xcd);
        const rangeHeaders = [];
        let slowMode = true;
        const server = http.createServer((req, res) => {
            rangeHeaders.push(req.headers.range || null);
            const m = req.headers.range ? req.headers.range.match(/bytes=(\d+)-/) : null;
            const start = m ? parseInt(m[1], 10) : 0;
            const slice = fullBuf.subarray(start);
            if (m) {
                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${totalBytes - 1}/${totalBytes}`,
                    'Content-Length': slice.length
                });
            } else {
                res.writeHead(200, { 'Content-Length': totalBytes });
            }
            if (slowMode) {
                res.write(slice.subarray(0, 16384));
                // Kalan baytları beklet; test cancel() çağıracak
            } else {
                res.end(slice);
            }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        servers.push(server);

        const dir = freshDir();
        const mm = new ModelManager({
            modelDir: dir,
            url: `http://127.0.0.1:${server.address().port}/model.gguf`
        });

        let cancelledTriggered = false;
        const firstPromise = mm.download((rec) => {
            if (rec >= 16384 && !cancelledTriggered) {
                cancelledTriggered = true;
                mm.cancel();
            }
        });
        const firstRes = await firstPromise;
        expect(firstRes.success).toBe(false);
        expect(firstRes.code).toBe('CANCELLED');
        expect(fs.existsSync(mm.partPath())).toBe(true);
        expect(fs.statSync(mm.partPath()).size).toBeGreaterThanOrEqual(16384);

        slowMode = false;
        const secondRes = await mm.download();
        expect(secondRes.success).toBe(true);
        expect(secondRes.resumed).toBe(true);
        expect(rangeHeaders[1]).toMatch(/^bytes=\d+-$/);
        expect(await mm.verify()).toBe(true);
    });

    it('TS-1.3: deleteTierBundle seçilen kademenin dosyalarını siler, diğer kademelere dokunmaz', () => {
        const dir = freshDir();
        const liteMgrs = ModelManager.createTierManagers(dir, 'lite');
        const balMgrs = ModelManager.createTierManagers(dir, 'balanced');
        fs.writeFileSync(liteMgrs.llm.modelPath(), Buffer.alloc(1024, 1));
        fs.writeFileSync(liteMgrs.stt.modelPath(), Buffer.alloc(512, 2));
        fs.writeFileSync(liteMgrs.llm.manifestPath(), '{}');
        fs.writeFileSync(balMgrs.llm.modelPath(), Buffer.alloc(2048, 3));

        const statusesBefore = ModelManager.getAllTiersStatus(dir);
        expect(statusesBefore.lite.ready).toBe(true);

        const del = ModelManager.deleteTierBundle('lite', dir);
        expect(del.ok).toBe(true);
        expect(del.freedBytes).toBeGreaterThanOrEqual(1536);
        expect(fs.existsSync(liteMgrs.llm.modelPath())).toBe(false);
        expect(fs.existsSync(liteMgrs.stt.modelPath())).toBe(false);
        expect(fs.existsSync(balMgrs.llm.modelPath())).toBe(true);
    });
});
