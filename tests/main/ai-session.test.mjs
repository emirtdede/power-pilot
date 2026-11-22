/**
 * ai-session.test.mjs - WP-13.T1/T2
 * Oturum semaforu, oturum başına sequence, 50 döngü, iptal/quit temizliği.
 */
import { describe, it, expect } from 'vitest';
import { AiBackend } from '../../src/main/services/AiBackend.js';

function makeBackend() {
    let seqId = 0;
    const disposed = [];
    function FakeSession(opts) {
        this.opts = opts;
        this.disposed = false;
    }
    FakeSession.prototype.dispose = async function (options) {
        this.disposed = true;
        disposed.push(options);
    };
    const b = new AiBackend({ modelDir: null, importer: async () => ({ getLlama: async () => ({}) }) });
    b.model = {};
    b.llamaModule = { LlamaChatSession: FakeSession };
    b.context = {
        dispose: async () => {},
        getSequence: async () => {
            const id = ++seqId;
            return { id, dispose: async () => { disposed.push({ sequence: id }); } };
        }
    };
    return { b, disposed, seqId: () => seqId, FakeSession };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('AiBackend oturum havuzu (T-PERF-01/06)', () => {
    it('iki eşzamanlı istek serileşir; ilk kapanınca ikinci hata almaz', async () => {
        const { b } = makeBackend();
        const p1 = b.createSession('S1');
        const p2 = b.createSession('S2');
        const s1 = await p1;
        let second = null;
        p2.then((s) => { second = s; });
        await tick();
        expect(second).toBeNull();
        expect(s1.opts.contextSequence.id).toBe(1);

        await b.disposeSession(s1);
        await tick();
        expect(second).not.toBeNull();
        expect(second.opts.contextSequence.id).toBe(2);
        expect(second.opts.systemPrompt).toBe('S2');
        await b.disposeSession(second);
        expect(b.slotBusy).toBe(false);
        expect(b.activeSessions.size).toBe(0);
    });

    it('50 oturum aç/kapat: sequence sızıntısı yok', async () => {
        const { b, disposed } = makeBackend();
        for (let i = 0; i < 50; i++) {
            const session = await b.createSession('S');
            await b.disposeSession(session);
        }
        expect(b.activeSessions.size).toBe(0);
        expect(b.slotBusy).toBe(false);
        expect(disposed.filter((d) => d.sequence !== undefined).length).toBe(50);
    });

    it('oturum sınıfı yoksa semafor serbest kalır', async () => {
        const { b } = makeBackend();
        b.llamaModule = {};
        await expect(b.createSession()).rejects.toThrow('COMPLETER_UNSUPPORTED');
        expect(b.slotBusy).toBe(false);
        b.llamaModule = { LlamaChatSession: makeBackend().FakeSession };
        const s = await b.createSession();
        await b.disposeSession(s);
    });

    it('quit/close bekleyen isteği reddeder ve tüm sequence’leri kapatır', async () => {
        const { b, disposed } = makeBackend();
        const s1 = await b.createSession('S1');
        const pending = b.createSession('S2');
        await tick();
        await b.close();
        await expect(pending).rejects.toThrow('AI_BACKEND_CLOSED');
        expect(s1.disposed).toBe(true);
        expect(disposed.filter((d) => d.sequence !== undefined).length).toBe(1);
        await expect(b.createSession()).rejects.toThrow('AI_BACKEND_CLOSED');
    });

    it('çift dispose tek seferlik sequence dispose üretir', async () => {
        const { b, disposed } = makeBackend();
        const s = await b.createSession('S');
        await b.disposeSession(s);
        await b.disposeSession(s);
        expect(disposed.filter((d) => d.sequence !== undefined).length).toBe(1);
        expect(disposed.filter((d) => d.disposeSequence === false).length).toBe(1);
    });
});
