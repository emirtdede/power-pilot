/**
 * AiBackend.js - WBS-7.1 (+P0-3 düzeltmeleri)
 * node-llama-cpp için ince yaşam-döngüsü yöneticisi.
 *
 * Kurallar (doğrulanmış entegrasyon kısıtları):
 * - Yalnızca main process'te çalışır (renderer'da node-llama-cpp çöker).
 * - Paket ESM-only olduğundan CJS main process'ten `await import()` ile yüklenir.
 * - Model yoksa/kurulu değilse ASLA fırlatmaz: {loaded:false, code} döner,
 *   uygulama AI'sız tam işlevsel açılır.
 * - Tek model örneği (RAM bütçesi); unload ile boşaltılır.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

// Gerçek repo dosya adı (büyük-küçük harfe duyarlı dosya sistemleri için birebir).
const DEFAULT_MODEL_FILE = 'Qwen_Qwen3-1.7B-Q4_K_M.gguf';
const TIER_MODEL_FILES = Object.freeze({
    lite: 'Qwen_Qwen3-0.6B-Q4_K_M.gguf',
    balanced: 'Qwen_Qwen3-1.7B-Q4_K_M.gguf',
    powerful: 'Qwen_Qwen3-4B-Q4_K_M.gguf'
});

// Yardımcı-komut profili için tutumlu bağlam: kısa ayrıştırma girdileri,
// küçük KV önbelleği. "auto", modelin eğitim bağlamını seçip ayırmayı
// patlatabilir (sahada görülen "Failed to create context" hatası).
const ASSISTANT_CONTEXT_OPTIONS = { sequences: 1, contextSize: 2048, batchSize: 512, flashAttention: false };
const FALLBACK_CONTEXT_OPTIONS = { sequences: 1, contextSize: 1024, batchSize: 256, flashAttention: false };

class AiBackend {
    // modelDir: modellerin durduğu dizin (main.js: userData/models).
    // importer: test izolasyonu için (varsayılan: gerçek dinamik import).
    constructor({ modelDir = null, importer = null, idleUnloadMs = 600000, defaultModelFile = DEFAULT_MODEL_FILE } = {}) {
        this.modelDir = modelDir;
        this.importer = importer || (() => import('node-llama-cpp'));
        this.llama = null;
        this.model = null;
        this.context = null;
        this.modelId = null;
        this.preferredModelFile = defaultModelFile || DEFAULT_MODEL_FILE;
        // P2: 10dk kullanılmayan model RAM'den boşaltılır (varsayılan 600000ms).
        // idleUnloadMs <= 0 ise zamanlayıcı kapalıdır (testler/sunucu senaryosu).
        this.idleUnloadMs = idleUnloadMs;
        this.sequence = null;
        this.idleTimer = null;
        this.loading = false; // Eşzamanlı yükleme kilidi (çift-tık yarışı öldürür).
        // WP-13.T1: oturum semaforu (1) + oturum başına sequence.
        this.slotBusy = false;
        this.slotQueue = [];
        this.sessionStates = new WeakMap();
        this.activeSessions = new Set();
        this.closed = false;
    }

    // Her çıkarım yolu buradan geçer - kullanım sayacı sıfırlanır.
    touch() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.model && this.idleUnloadMs > 0) {
            this.idleTimer = setTimeout(() => {
                this.idleTimer = null;
                Promise.resolve(this.unload()).catch(() => {});
                log.info('[AiBackend] boşta kalma: model RAM’den boşaltıldı.');
            }, this.idleUnloadMs);
            if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
        }
    }

    static isRendererProcess() {
        try {
            return typeof process !== 'undefined' && process.type === 'renderer';
        } catch (_) {
            return false;
        }
    }

    static modelFileForTier(tierId = 'balanced') {
        return TIER_MODEL_FILES[tierId] || DEFAULT_MODEL_FILE;
    }

    setPreferredTier(tierId = 'balanced') {
        this.preferredModelFile = AiBackend.modelFileForTier(tierId);
        return this.preferredModelFile;
    }

    modelPathFor(modelFile = this.preferredModelFile || DEFAULT_MODEL_FILE) {
        if (!this.modelDir) return null;
        return path.join(this.modelDir, modelFile);
    }

    getStatus() {
        if (AiBackend.isRendererProcess()) {
            return { loaded: false, code: 'WRONG_PROCESS', message: 'AI yalnızca ana işlemde çalışır.' };
        }
        if (!this.modelDir) {
            return { loaded: false, code: 'NOT_CONFIGURED', message: 'Model dizini tanımlı değil.' };
        }
        const targetFile = this.preferredModelFile || DEFAULT_MODEL_FILE;
        if (!this.model) {
            const p = this.modelPathFor(targetFile);
            const exists = p && fs.existsSync(p);
            return {
                loaded: false,
                code: exists ? 'NOT_LOADED' : 'MODEL_MISSING',
                message: exists ? 'Model yüklü değil.' : 'AI modeli indirilmedi.',
                modelId: targetFile,
                modelDir: this.modelDir
            };
        }
        return { loaded: true, code: 'READY', modelId: this.modelId, modelDir: this.modelDir };
    }

    async ensureLlama() {
        if (this.llama) return this.llama;
        const mod = await this.importer();
        if (!mod || typeof mod.getLlama !== 'function') {
            throw new Error('LLM arka ucu yüklenemedi.');
        }
        this.llamaModule = mod;
        this.llama = await mod.getLlama();
        return this.llama;
    }

    // Modeli RAM'e yükler. Başarısızlık fırlatmaz - sonuç nesnesi döner.
    async loadModel(modelFile = this.preferredModelFile || DEFAULT_MODEL_FILE) {
        if (AiBackend.isRendererProcess()) {
            return { loaded: false, code: 'WRONG_PROCESS' };
        }
        if (!this.modelDir) {
            return { loaded: false, code: 'NOT_CONFIGURED' };
        }
        this.preferredModelFile = modelFile || DEFAULT_MODEL_FILE;
        if (this.model && this.modelId === modelFile) {
            return { loaded: true, code: 'READY', modelId: this.modelId };
        }
        // Çift-tık/çift-çağrı yarışı: ikinci çağrı unload+reload döngüsüne girmez,
        // beklemesi söylenir (yerel dizide sıralı yükleme yarışı context'i öldürüyordu).
        if (this.loading) {
            return { loaded: false, code: 'ALREADY_LOADING', message: 'Model yükleniyor, bekleyin.' };
        }
        const modelPath = this.modelPathFor(modelFile);
        if (!modelPath || !fs.existsSync(modelPath)) {
            return { loaded: false, code: 'MODEL_MISSING', path: modelPath };
        }
        this.loading = true;
        // O-17: yerel değişkenlerle yükle; hata halinde native model/context dispose edilir.
        let model = null;
        let context = null;
        try {
            await this.unload();
            const llama = await this.ensureLlama();
            model = await llama.loadModel({ modelPath });
            try {
                context = await model.createContext(ASSISTANT_CONTEXT_OPTIONS);
            } catch (ctxErr) {
                log.warn('[AiBackend] 2048 context oluşturulamadı, 1024 fallback deneniyor:', ctxErr && ctxErr.message);
                context = await model.createContext(FALLBACK_CONTEXT_OPTIONS);
            }
            this.model = model;
            this.context = context;
            this.modelId = modelFile;
            log.info(`[AiBackend] model yüklendi: ${modelFile}`);
            this.touch();
            return { loaded: true, code: 'READY', modelId: this.modelId };
        } catch (err) {
            log.error('[AiBackend] yükleme hatası:', err && err.message);
            try { if (context && typeof context.dispose === 'function') await context.dispose(); } catch (_) { /* yut */ }
            try { if (model && typeof model.dispose === 'function') await model.dispose(); } catch (_) { /* yut */ }
            this.model = null;
            this.context = null;
            this.modelId = null;
            return { loaded: false, code: 'LOAD_FAILED', error: (err && err.message) || 'unknown' };
        } finally {
            this.loading = false;
        }
    }

    async switchTier(tierId = 'balanced', { autoLoad = false } = {}) {
        const nextFile = AiBackend.modelFileForTier(tierId);
        this.preferredModelFile = nextFile;
        const wasLoaded = !!this.model;
        if (this.model && this.modelId !== nextFile) {
            await this.unload();
        }
        if (autoLoad || wasLoaded) {
            const p = this.modelPathFor(nextFile);
            if (p && fs.existsSync(p)) {
                return await this.loadModel(nextFile);
            }
        }
        return this.getStatus();
    }

    async unload() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        // WP-13.T1: önce açık oturumlar/sequence'ler, sonra context/model.
        await this.disposeAllSessions();
        // Sıra önemli: önce context, sonra model (native dispose).
        if (this.context && typeof this.context.dispose === 'function') {
            try { await this.context.dispose(); } catch (_) {}
        }
        if (this.model && typeof this.model.dispose === 'function') {
            try { await this.model.dispose(); } catch (_) {}
        }
        this.context = null;
        this.model = null;
        this.modelId = null;
        this.sequence = null;
    }

    // WBS-7.3 (legacy): her çağrı taze sequence döndürür; çağıran dispose eder.
    async ensureSequence() {
        if (!this.model || !this.context || typeof this.context.getSequence !== 'function') {
            throw new Error('AI sequence yok (önce loadModel).');
        }
        this.sequence = await this.context.getSequence();
        this.touch();
        return this.sequence;
    }

    _acquireSlot (timeoutMs = 30000) {
        if (this.closed) return Promise.reject(new Error('AI_BACKEND_CLOSED'));
        if (!this.slotBusy) {
            this.slotBusy = true;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const entry = { resolve, reject, timer: null };
            entry.timer = setTimeout(() => {
                const idx = this.slotQueue.indexOf(entry);
                if (idx >= 0) this.slotQueue.splice(idx, 1);
                reject(new Error('AI_BUSY'));
            }, timeoutMs);
            if (typeof entry.timer.unref === 'function') entry.timer.unref();
            this.slotQueue.push(entry);
        });
    }

    _releaseSlot () {
        const next = this.slotQueue.shift();
        if (next) {
            if (next.timer) clearTimeout(next.timer);
            if (this.closed) {
                next.reject(new Error('AI_BACKEND_CLOSED'));
                return;
            }
            next.resolve();
            return;
        }
        this.slotBusy = false;
    }

    /**
     * K1: Sohbet oturumu kurar (çağrı-başı taze oturum; geçmiş kirlenmesi yok).
     * WP-13.T1: semafor=1, oturum başına ayrı `getSequence()`.
     * node-llama-cpp v3'te ham sequence'te prompt()/completion() YOKTUR -
     * tek desteklenen yüksek-seviye yol LlamaChatSession.completePrompt'tur.
     */
    async createSession (systemPrompt = null) {
        await this._acquireSlot(30000);
        let sequence = null;
        try {
            if (!this.context || typeof this.context.getSequence !== 'function') {
                throw new Error('AI sequence yok (önce loadModel).');
            }
            sequence = await this.context.getSequence();
            const mod = this.llamaModule || await this.importer().catch(() => null);
            if (mod) this.llamaModule = mod;
            const Cls = mod && mod.LlamaChatSession;
            if (typeof Cls !== 'function') {
                throw new Error('COMPLETER_UNSUPPORTED');
            }
            const opts = { contextSequence: sequence };
            if (typeof systemPrompt === 'string' && systemPrompt) opts.systemPrompt = systemPrompt;
            const session = new Cls(opts);
            const state = { sequence, session, disposed: false };
            this.sessionStates.set(session, state);
            this.activeSessions.add(state);
            this.touch();
            return session;
        } catch (err) {
            if (sequence && typeof sequence.dispose === 'function') {
                try { await sequence.dispose(); } catch (_) { /* temizlik hatası yutulur */ }
            }
            this._releaseSlot();
            throw err;
        }
    }

    async disposeSession (session) {
        const state = session ? this.sessionStates.get(session) : null;
        if (!state) {
            // Yabancı/çift dispose: semaforu ikinci kez serbest bırakma.
            return;
        }
        if (state.disposed) return;
        state.disposed = true;
        try {
            if (session && typeof session.dispose === 'function') {
                await session.dispose({ disposeSequence: false });
            }
        } catch (_) {
            // Temizlik hatası çağrıyı kirletmez.
        }
        try {
            if (state.sequence && typeof state.sequence.dispose === 'function') {
                await state.sequence.dispose();
            }
        } catch (_) {
            // sequence dispose hatası yutulur
        }
        this.activeSessions.delete(state);
        this.sessionStates.delete(session);
        if (this.sequence === state.sequence) this.sequence = null;
        this._releaseSlot();
    }

    /** WP-13.T1: hata/iptal/quit tek noktadan temizlenir. */
    async disposeAllSessions () {
        // Bekleyen istekler yeni oturum açmadan reddedilir.
        this.slotQueue.splice(0).forEach((entry) => {
            if (entry.timer) clearTimeout(entry.timer);
            entry.reject(new Error('AI_BACKEND_CLOSED'));
        });
        const states = Array.from(this.activeSessions);
        for (const state of states) {
            if (state.session) await this.disposeSession(state.session);
        }
        this.activeSessions.clear();
        this.slotBusy = false;
    }

    async close () {
        this.closed = true;
        await this.disposeAllSessions();
        await this.unload();
    }
}

module.exports = { AiBackend, DEFAULT_MODEL_FILE, TIER_MODEL_FILES, ASSISTANT_CONTEXT_OPTIONS, FALLBACK_CONTEXT_OPTIONS };
