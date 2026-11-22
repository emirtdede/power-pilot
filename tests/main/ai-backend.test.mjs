/**
 * ai-backend.test.mjs - WBS-7.1 / TS-7.1
 * AiBackend: fail-closed davranışlar + yaşam döngüsü (sahte importer).
 * Gerçek model dosyası gerekmez; tek test gerçek dinamik importu doğrular.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiBackend, DEFAULT_MODEL_FILE, ASSISTANT_CONTEXT_OPTIONS } from '../../src/main/services/AiBackend.js';

let dirs = [];
function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ai-test-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function stubImporter(loadImpl) {
    return vi.fn(async () => ({
        getLlama: vi.fn(async () => ({
            loadModel: loadImpl || (async ({ modelPath }) => ({
                path: modelPath,
                createContext: async () => ({ dispose: vi.fn(async () => {}) }),
                dispose: vi.fn(async () => {})
            }))
        }))
    }));
}

function backendWithModel(opts = {}) {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), 'sahte-model');
    return new AiBackend({ modelDir: dir, importer: stubImporter(), ...opts });
}

describe('AiBackend durum makinesi (TS-7.1)', () => {
    it('modelDir yoksa NOT_CONFIGURED, fırlatmaz', () => {
        const b = new AiBackend({});
        expect(b.getStatus()).toMatchObject({ loaded: false, code: 'NOT_CONFIGURED' });
    });

    it('model dosyası yoksa MODEL_MISSING + yolu bildirir', async () => {
        const b = new AiBackend({ modelDir: freshDir(), importer: stubImporter() });
        expect(b.getStatus().code).toBe('MODEL_MISSING');
        const r = await b.loadModel();
        expect(r).toMatchObject({ loaded: false, code: 'MODEL_MISSING' });
    });

    it('model varsa yüklenir, tekrar yükleme kısa devre yapar', async () => {
        const b = backendWithModel();
        const r1 = await b.loadModel();
        expect(r1).toMatchObject({ loaded: true, code: 'READY', modelId: DEFAULT_MODEL_FILE });
        expect(b.getStatus().loaded).toBe(true);
        const r2 = await b.loadModel();
        expect(r2.code).toBe('READY');
        await b.unload();
        expect(b.getStatus().loaded).toBe(false);
    });

    it('yükleyici patlarsa LOAD_FAILED + temiz durum', async () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), 'sahte-model');
        const b = new AiBackend({
            modelDir: dir,
            importer: stubImporter(async () => { throw new Error('ABI uyuşmazlığı'); })
        });
        const r = await b.loadModel();
        expect(r).toMatchObject({ loaded: false, code: 'LOAD_FAILED' });
        expect(b.getStatus().loaded).toBe(false);
    });

    it('renderer sürecinde WRONG_PROCESS döner (P0-3)', async () => {
        const prev = process.type;
        process.type = 'renderer';
        try {
            const b = backendWithModel();
            expect(b.getStatus().code).toBe('WRONG_PROCESS');
            expect(await b.loadModel()).toMatchObject({ loaded: false, code: 'WRONG_PROCESS' });
        } finally {
            if (prev === undefined) delete process.type;
            else process.type = prev;
        }
    });

    it('gerçek dinamik import + getLlama çalışır (P0-3 ESM kanıtı)', async () => {
        const mod = await import('node-llama-cpp');
        expect(typeof mod.getLlama).toBe('function');
        const llama = await mod.getLlama();
        expect(llama).toBeDefined();
        await llama.dispose?.();
    }, 120000);

    it('boşta kalınca model RAM’den boşaltılır (P2)', async () => {
        const b = backendWithModel({ idleUnloadMs: 60 });
        await b.loadModel();
        expect(b.getStatus().loaded).toBe(true);
        await new Promise((r) => setTimeout(r, 150));
        expect(b.getStatus().loaded).toBe(false);
        expect(b.getStatus().code).toBe('NOT_LOADED');
    }, 10000);

    it('kullanım sayacı sıfırlar, kapalıyken boşaltmaz (P2)', async () => {
        const b = backendWithModel({ idleUnloadMs: 80 });
        await b.loadModel();
        await new Promise((r) => setTimeout(r, 40));
        b.touch();
        await new Promise((r) => setTimeout(r, 50));
        expect(b.getStatus().loaded).toBe(true);
        const b2 = backendWithModel({ idleUnloadMs: 0 });
        await b2.loadModel();
        await new Promise((r) => setTimeout(r, 30));
        expect(b2.getStatus().loaded).toBe(true);
        await b.unload();
        await b2.unload();
    }, 10000);

    it('eşzamanlı ikinci yükleme ALREADY_LOADING döner, diziyi bozmaz', async () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), 'sahte-model');
        let release;
        const gate = new Promise((r) => { release = r; });
        const b = new AiBackend({
            modelDir: dir,
            importer: stubImporter(async () => {
                await gate;
                return { createContext: async () => ({ dispose: vi.fn(async () => {}) }), dispose: vi.fn(async () => {}) };
            })
        });
        const first = b.loadModel();
        const second = await b.loadModel();
        expect(second).toMatchObject({ loaded: false, code: 'ALREADY_LOADING' });
        release();
        const r1 = await first;
        expect(r1).toMatchObject({ loaded: true, code: 'READY' });
        await b.unload();
    });

    it('başarısız yükleme kilidi serbest bırakır (sonraki deneme çalışır)', async () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), 'sahte-model');
        const b = new AiBackend({
            modelDir: dir,
            importer: stubImporter(async () => { throw new Error('yerel patladı'); })
        });
        expect((await b.loadModel()).code).toBe('LOAD_FAILED');
        expect(b.loading).toBe(false);
    });

    it('bağlam tutumlu profille açılır (sequences/contextSize/batch/flash)', async () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, DEFAULT_MODEL_FILE), 'sahte-model');
        let seenOpts = null;
        const b = new AiBackend({
            modelDir: dir,
            importer: stubImporter(async () => ({
                createContext: async (opts) => { seenOpts = opts; return { dispose: vi.fn(async () => {}) }; },
                dispose: vi.fn(async () => {})
            }))
        });
        expect((await b.loadModel()).code).toBe('READY');
        expect(seenOpts).toMatchObject(ASSISTANT_CONTEXT_OPTIONS);
        expect(ASSISTANT_CONTEXT_OPTIONS.contextSize).toBeLessThanOrEqual(2048);
        await b.unload();
    });

    it('createSession oturumu kurar, disposeSession kotayı iade eder', async () => {
        const disposed = [];
        const seqDisposed = [];
        function FakeSession(opts) { this.seq = opts.contextSequence; this.sys = opts.systemPrompt || null; }
        FakeSession.prototype.dispose = async function (o) { disposed.push(o); };
        const b = backendWithModel();
        b.model = {};
        b.context = { getSequence: () => ({ id: 'seq', dispose: async () => { seqDisposed.push(true); } }) };
        b.llamaModule = { LlamaChatSession: FakeSession };
        const session = await b.createSession('SİSTEM');
        expect(session.seq.id).toBe('seq');
        expect(session.sys).toBe('SİSTEM');
        expect(b.slotBusy).toBe(true);
        await b.disposeSession(session);
        expect(disposed).toEqual([{ disposeSequence: false }]);
        expect(seqDisposed).toEqual([true]);
        expect(b.slotBusy).toBe(false);
        expect(b.sequence).toBeNull();
        await b.disposeSession(session); // çift dispose slotu tekrar açmaz
        expect(b.slotBusy).toBe(false);
    });

    it('oturum sınıfı yoksa COMPLETER_UNSUPPORTED', async () => {
        const b = backendWithModel();
        b.model = {};
        b.context = { getSequence: () => ({}) };
        b.llamaModule = {};
        await expect(b.createSession()).rejects.toThrow('COMPLETER_UNSUPPORTED');
    });
});
