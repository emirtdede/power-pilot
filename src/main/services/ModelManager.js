/**
 * ModelManager.js - WBS-7.2
 * AI model dosyalarının indirme + bütünlük yöneticisi.
 *
 * Dürüstlük notu: üst-akış (HuggingFace) published-SHA değeri indirme anında
 * sabitlenemediğinden, bütünlük zinciri şu şekildedir:
 *  1. İndirme tamamlanınca SHA256 hesaplanıp manifest'e yazılır.
 *  2. Her yükleme öncesi manifest'teki SHA ile dosya yeniden doğrulanır.
 *  3. Boyut/resume HTTP Range ile yönetilir; yarım dosya `.part` uzantılıdır.
 * Ağ gerekir - yalnızca kullanıcı "AI Paketini Kur" dediğinde çalışır.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const log = require('../logger');

const LITE_MODEL_ID = 'qwen3-0.6b-q4_k_m';
const LITE_MODEL_FILE = 'Qwen_Qwen3-0.6B-Q4_K_M.gguf';
const QWEN_LITE_COMMIT = '60b85c0e3d8fe0f6474f406922a26d12aca4550d';
const LITE_MODEL_URL = `https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/${QWEN_LITE_COMMIT}/${LITE_MODEL_FILE}`;
const LITE_MODEL_BYTES = 484220320;
const LITE_MODEL_SHA256 = '9acfc1e001311f34b4252001b626f2e466d592a42065f66571bff3790d4e1b14';

const MODEL_ID = 'qwen3-1.7b-q4_k_m';
const MODEL_FILE = 'Qwen_Qwen3-1.7B-Q4_K_M.gguf';
// WP-06: `main` yerine immutable commit; boyut + gerçek HuggingFace LFS SHA-256 sabit.
const QWEN_COMMIT = 'dcb19155b962dbb6389f4691a982043a8e651022';
const MODEL_URL = `https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/${QWEN_COMMIT}/Qwen_Qwen3-1.7B-Q4_K_M.gguf`;
const MODEL_BYTES = 1282439584;
const MODEL_SHA256 = '72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb';

const POWERFUL_MODEL_ID = 'qwen3-4b-q4_k_m';
const POWERFUL_MODEL_FILE = 'Qwen_Qwen3-4B-Q4_K_M.gguf';
const QWEN_POWERFUL_COMMIT = 'cb76885dc66d50759b207c5a48c4e78dfa00c638';
const POWERFUL_MODEL_URL = `https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/${QWEN_POWERFUL_COMMIT}/${POWERFUL_MODEL_FILE}`;
const POWERFUL_MODEL_BYTES = 2497280960;
const POWERFUL_MODEL_SHA256 = 'fbe1d5edd4ce802ae3ae7c7e4ab7d09789d697fdac1fc7929f8df4ca3c41bae3';

// STT modelleri (WBS-8.1 + 3 kademeli paket; SttService ile birebir uyumlu).
const WHISPER_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';

const STT_TINY_MODEL_ID = 'whisper-tiny';
const STT_TINY_MODEL_FILE = 'ggml-tiny.bin';
const STT_TINY_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/${STT_TINY_MODEL_FILE}`;
const STT_TINY_MODEL_BYTES = 77691713;
const STT_TINY_MODEL_SHA256 = 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21';

const STT_MODEL_ID = 'whisper-base';
const STT_MODEL_FILE = 'ggml-base.bin';
const STT_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/ggml-base.bin`;
const STT_MODEL_BYTES = 147951465;
const STT_MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';

const STT_SMALL_MODEL_ID = 'whisper-small-q5_1';
const STT_SMALL_MODEL_FILE = 'ggml-small-q5_1.bin';
const STT_SMALL_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/${STT_SMALL_MODEL_FILE}`;
const STT_SMALL_MODEL_BYTES = 190085487;
const STT_SMALL_MODEL_SHA256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb';

const MODEL_SPECS = {
    [LITE_MODEL_ID]: { file: LITE_MODEL_FILE, url: LITE_MODEL_URL, bytes: LITE_MODEL_BYTES, sha256: LITE_MODEL_SHA256 },
    [MODEL_ID]: { file: MODEL_FILE, url: MODEL_URL, bytes: MODEL_BYTES, sha256: MODEL_SHA256 },
    [POWERFUL_MODEL_ID]: { file: POWERFUL_MODEL_FILE, url: POWERFUL_MODEL_URL, bytes: POWERFUL_MODEL_BYTES, sha256: POWERFUL_MODEL_SHA256 },
    [STT_TINY_MODEL_ID]: { file: STT_TINY_MODEL_FILE, url: STT_TINY_MODEL_URL, bytes: STT_TINY_MODEL_BYTES, sha256: STT_TINY_MODEL_SHA256 },
    [STT_MODEL_ID]: { file: STT_MODEL_FILE, url: STT_MODEL_URL, bytes: STT_MODEL_BYTES, sha256: STT_MODEL_SHA256 },
    [STT_SMALL_MODEL_ID]: { file: STT_SMALL_MODEL_FILE, url: STT_SMALL_MODEL_URL, bytes: STT_SMALL_MODEL_BYTES, sha256: STT_SMALL_MODEL_SHA256 }
};

const DEFAULT_AI_TIER = 'balanced';

const AI_TIERS = Object.freeze({
    lite: Object.freeze({
        id: 'lite',
        llmModelId: LITE_MODEL_ID,
        sttModelId: STT_TINY_MODEL_ID,
        sttServiceKey: 'tiny',
        totalBytes: LITE_MODEL_BYTES + STT_TINY_MODEL_BYTES,
        estimatedRamMb: 650,
        minRamGb: 4,
        minFreeDiskMb: 650
    }),
    balanced: Object.freeze({
        id: 'balanced',
        llmModelId: MODEL_ID,
        sttModelId: STT_MODEL_ID,
        sttServiceKey: 'base',
        totalBytes: MODEL_BYTES + STT_MODEL_BYTES,
        estimatedRamMb: 1600,
        minRamGb: 8,
        minFreeDiskMb: 1600
    }),
    powerful: Object.freeze({
        id: 'powerful',
        llmModelId: POWERFUL_MODEL_ID,
        sttModelId: STT_SMALL_MODEL_ID,
        sttServiceKey: 'small-q5_1',
        totalBytes: POWERFUL_MODEL_BYTES + STT_SMALL_MODEL_BYTES,
        estimatedRamMb: 3100,
        minRamGb: 16,
        minFreeDiskMb: 3100
    })
});

class ModelManager {
    // fetchFn/url/file/modelId: test izolasyonu + yedek ayna + ek modeller için.
    // expectedBytes/expectedSha256: WP-06 bütünlük sözleşmesi (test/özel model).
    constructor({
        modelDir = null,
        fetchFn = null,
        url = null,
        modelId = null,
        file = null,
        expectedBytes = null,
        expectedSha256 = null
    } = {}) {
        const id = modelId || MODEL_ID;
        const spec = MODEL_SPECS[id] || null;
        // Pinler yalnızca resmî URL kullanılırken uygulanır. Test/ayna URL'si
        // verilmişse bütünlük için expectedBytes/SHA açıkça geçilmelidir.
        const useSpec = !!(spec && (!url || url === spec.url));
        this.modelDir = modelDir;
        this.fetchFn = fetchFn || ((...args) => fetch(...args));
        this.url = url || (spec && spec.url) || MODEL_URL;
        this.modelId = id;
        this.file = file || (spec && spec.file) || MODEL_FILE;
        this.expectedBytes = Number.isInteger(expectedBytes) ? expectedBytes : (useSpec ? spec.bytes : null);
        this.expectedSha256 = typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/i.test(expectedSha256)
            ? expectedSha256.toLowerCase()
            : (useSpec ? spec.sha256 : null);
        this.downloading = false;
        this._abortController = null;
        this._cancelled = false;
    }

    static getTierSpec(tierId = DEFAULT_AI_TIER) {
        return AI_TIERS[tierId] || AI_TIERS[DEFAULT_AI_TIER];
    }

    static createTierManagers(modelDir, tierId = DEFAULT_AI_TIER, opts = {}) {
        const tier = ModelManager.getTierSpec(tierId);
        return {
            tier,
            llm: new ModelManager({ modelDir, modelId: tier.llmModelId, fetchFn: opts.fetchFn || null }),
            stt: new ModelManager({ modelDir, modelId: tier.sttModelId, fetchFn: opts.fetchFn || null })
        };
    }

    static invalidateTiersStatusCache() {
        ModelManager._tiersStatusCache = null;
    }

    static getAllTiersStatus(modelDir, { cacheTtlMs = 0 } = {}) {
        const now = Date.now();
        if (
            cacheTtlMs > 0 &&
            ModelManager._tiersStatusCache &&
            ModelManager._tiersStatusCache.modelDir === modelDir &&
            (now - ModelManager._tiersStatusCache.at) < cacheTtlMs
        ) {
            return ModelManager._tiersStatusCache.value;
        }
        const out = {};
        for (const [tierId, tier] of Object.entries(AI_TIERS)) {
            const llm = new ModelManager({ modelDir, modelId: tier.llmModelId }).status();
            const stt = new ModelManager({ modelDir, modelId: tier.sttModelId }).status();
            const downloadedBytes = (llm.present ? llm.bytes : llm.partialBytes) + (stt.present ? stt.bytes : stt.partialBytes);
            out[tierId] = {
                id: tierId,
                llmModelId: tier.llmModelId,
                sttModelId: tier.sttModelId,
                sttServiceKey: tier.sttServiceKey,
                llmFile: llm.file,
                sttFile: stt.file,
                totalBytes: tier.totalBytes,
                downloadedBytes,
                estimatedRamMb: tier.estimatedRamMb,
                minRamGb: tier.minRamGb,
                minFreeDiskMb: tier.minFreeDiskMb,
                ready: !!(llm.present && stt.present),
                partial: !!(
                    (!llm.present && llm.partialBytes > 0) ||
                    (!stt.present && stt.partialBytes > 0) ||
                    (llm.present && !stt.present) ||
                    (!llm.present && stt.present)
                ),
                llm,
                stt
            };
        }
        ModelManager._tiersStatusCache = { at: now, modelDir, value: out };
        return out;
    }

    cancel() {
        if (!this.downloading) return { cancelled: false, reason: 'NOT_DOWNLOADING' };
        this._cancelled = true;
        if (this._abortController) {
            try { this._abortController.abort(); } catch (_) { /* yut */ }
        }
        return { cancelled: true };
    }

    deleteFiles() {
        ModelManager.invalidateTiersStatusCache();
        let freedBytes = 0;
        for (const p of [this.modelPath(), this.partPath(), this.manifestPath()]) {
            if (!p || !fs.existsSync(p)) continue;
            try {
                const st = fs.statSync(p);
                fs.rmSync(p, { force: true });
                freedBytes += st.size || 0;
            } catch (err) {
                return { ok: false, code: 'DELETE_FAILED', error: err && err.message, freedBytes };
            }
        }
        return { ok: true, freedBytes };
    }

    static deleteTierBundle(tierId, modelDir) {
        if (!modelDir || !AI_TIERS[tierId]) {
            return { ok: false, code: 'INVALID_TIER', freedBytes: 0 };
        }
        const { llm, stt } = ModelManager.createTierManagers(modelDir, tierId);
        const r1 = llm.deleteFiles();
        const r2 = stt.deleteFiles();
        return {
            ok: r1.ok && r2.ok,
            code: (!r1.ok && r1.code) || (!r2.ok && r2.code) || 'DELETED',
            freedBytes: (r1.freedBytes || 0) + (r2.freedBytes || 0)
        };
    }

    modelPath() {
        if (!this.modelDir) return null;
        return path.join(this.modelDir, this.file);
    }

    partPath() {
        const full = this.modelPath();
        return full ? `${full}.part` : null;
    }

    manifestPath() {
        if (!this.modelDir) return null;
        // Her model dosyasının kendi manifesti (LLM + STT aynı dizinde çakışmaz).
        return path.join(this.modelDir, `${this.file}.manifest.json`);
    }

    ensureDir() {
        if (!this.modelDir) throw new Error('Model dizini tanımlı değil.');
        fs.mkdirSync(this.modelDir, { recursive: true });
    }

    readManifest() {
        try {
            const raw = fs.readFileSync(this.manifestPath(), 'utf8');
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    status() {
        const full = this.modelPath();
        const part = this.partPath();
        const manifest = this.readManifest();
        const present = !!(full && fs.existsSync(full));
        return {
            modelId: this.modelId,
            file: this.file,
            url: this.url,
            present,
            bytes: present ? fs.statSync(full).size : 0,
            expectedBytes: this.expectedBytes,
            expectedSha256: this.expectedSha256,
            partialBytes: !!(part && fs.existsSync(part)) ? fs.statSync(part).size : 0,
            manifest
        };
    }

    computeSha256(filePath) {
        return new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            const stream = fs.createReadStream(filePath);
            stream.on('data', (chunk) => hash.update(chunk));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }

    // Tam dosyayı manifest + pinlenmiş boyut/SHA'ya karşı doğrular.
    async verify() {
        const full = this.modelPath();
        const manifest = this.readManifest();
        if (!full || !fs.existsSync(full) || !manifest || !manifest.sha256) return false;
        const stat = fs.statSync(full);
        if (this.expectedBytes != null && stat.size !== this.expectedBytes) return false;
        if (this.expectedSha256 && manifest.sha256 !== this.expectedSha256) return false;
        const actual = await this.computeSha256(full);
        return actual === manifest.sha256 && (!this.expectedSha256 || actual === this.expectedSha256);
    }

    /**
     * Modeli indirir (varsa kaldığı yerden). Başarıda manifest yazar.
     * @param {(received:number,total:number|null)=>void} onProgress
     * @returns {Promise<{success:boolean, bytes:number, sha256?:string, resumed?:boolean, error?:string}>}
     */
    async download(onProgress = null) {
        if (!this.modelDir) {
            return { success: false, code: 'MODEL_DIR_MISSING', error: 'Model dizini tanımlı değil.' };
        }
        // Eşzamanlı çift indirme aynı .part dosyasını bozar - ikinci çağrı reddedilir.
        if (this.downloading) {
            return { success: false, code: 'ALREADY_DOWNLOADING', error: 'İndirme zaten sürüyor.' };
        }
        this.downloading = true;
        this._cancelled = false;
        this._abortController = typeof AbortController === 'function' ? new AbortController() : null;
        try {
            return await this.downloadInner(onProgress);
        } finally {
            this.downloading = false;
            this._abortController = null;
        }
    }

    async downloadInner(onProgress = null, attempt = 0) {
        this.ensureDir();
        const full = this.modelPath();
        const part = this.partPath();

        if (fs.existsSync(full)) {
            const ok = await this.verify();
            if (ok) {
                return { success: true, bytes: fs.statSync(full).size, sha256: this.readManifest().sha256, resumed: false };
            }
            log.warn('[ModelManager] mevcut dosya manifest/pin ile uyuşmuyor, yeniden indiriliyor.');
            fs.rmSync(full, { force: true });
        }

        let startAt = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (this.expectedBytes != null && startAt > this.expectedBytes) {
            fs.rmSync(part, { force: true });
            startAt = 0;
        }
        // L-16: indirme öncesi boş disk alanı kontrolü (yarıda kalma yok).
        if (this.expectedBytes != null && typeof fs.promises.statfs === 'function') {
            try {
                const stat = await fs.promises.statfs(path.dirname(full));
                const free = Number(stat.bavail) * Number(stat.bsize);
                if (Number.isFinite(free) && free < this.expectedBytes * 1.1) {
                    return {
                        success: false,
                        code: 'DISK_FULL',
                        params: {
                            requiredMb: Math.ceil(this.expectedBytes * 1.1 / 1048576),
                            freeMb: Math.floor(free / 1048576)
                        },
                        error: `Yeterli disk alanı yok (gerekli ~${Math.ceil(this.expectedBytes * 1.1 / 1048576)} MB, boş ${Math.floor(free / 1048576)} MB).`
                    };
                }
            } catch (_) { /* statfs desteklenmiyorsa indirme engellenmez */ }
        }
        const hadPartial = startAt > 0;
        const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {};
        const fetchOpts = { headers };
        if (this._abortController && this._abortController.signal) {
            fetchOpts.signal = this._abortController.signal;
        }
        let res;
        try {
            res = await this.fetchFn(this.url, fetchOpts);
        } catch (err) {
            if (this._cancelled || (err && err.name === 'AbortError')) {
                return { success: false, code: 'CANCELLED', cancelled: true, error: 'İndirme duraklatıldı.', bytes: startAt };
            }
            return { success: false, code: 'CONNECTION_FAILED', error: `Bağlantı hatası: ${err.message}` };
        }

        // 416: .part zaten tam olabilir; değilse baştan tek deneme.
        if (res.status === 416) {
            const total = this.parseUnsatisfiedTotal(res);
            if (this.expectedBytes != null && startAt === this.expectedBytes && total === this.expectedBytes) {
                // Aşağıdaki doğrulama akışına devam etmek için gövdesiz finalize.
                return this.finalizeDownload(part, full, startAt, onProgress, hadPartial);
            }
            if (attempt < 1) {
                fs.rmSync(part, { force: true });
                return this.downloadInner(onProgress, attempt + 1);
            }
            return { success: false, code: 'RANGE_REJECTED', error: 'Sunucu Range isteğini reddetti (HTTP 416).', bytes: startAt };
        }

        if (res.status === 200 && startAt > 0) {
            // Sunucu Range'i yok saydı: dosya baştan yazılır.
            startAt = 0;
        }
        if (res.status !== 200 && res.status !== 206) {
            return { success: false, code: 'HTTP_STATUS', params: { status: res.status }, error: `Sunucu hatası: HTTP ${res.status}` };
        }

        if (res.status === 206) {
            const rangeStart = this.parseContentRangeStart(res);
            if (rangeStart != null && rangeStart !== startAt) {
                if (attempt < 1) {
                    fs.rmSync(part, { force: true });
                    return this.downloadInner(onProgress, attempt + 1);
                }
                return { success: false, code: 'RANGE_MISMATCH', error: `Content-Range uyuşmazlığı (beklenen ${startAt}, gelen ${rangeStart}).` };
            }
        }

        if (!res.body) {
            return { success: false, code: 'EMPTY_BODY', error: 'Sunucu gövdesi boş (res.body null).' };
        }

        const total = this.parseTotal(res, startAt);
        if (this.expectedBytes != null && total != null && total !== this.expectedBytes) {
            return { success: false, code: 'SIZE_MISMATCH', error: `Boyut uyuşmazlığı (beklenen ${this.expectedBytes}, sunucu ${total}).` };
        }

        const out = fs.createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
        // Akış hatası try/catch ile raporlanır; dinleyici olmadan 'error' olayı
        // süreci uyarı/çökme ile bozmasın.
        out.on('error', () => {});
        let received = startAt;
        try {
            for await (const chunk of res.body) {
                if (this._cancelled) {
                    throw Object.assign(new Error('İndirme duraklatıldı.'), { code: 'CANCELLED' });
                }
                received += chunk.length;
                if (this.expectedBytes != null && received > this.expectedBytes) {
                    throw new Error(`Beklenenden fazla bayt: ${received} > ${this.expectedBytes}`);
                }
                if (!out.write(chunk)) {
                    await once(out, 'drain');
                }
                if (onProgress) {
                    try { onProgress(received, total); } catch (_) {}
                }
            }
            out.end();
            await once(out, 'finish');
        } catch (err) {
            try {
                out.end();
                await Promise.race([once(out, 'close'), new Promise((r) => setTimeout(r, 150))]);
            } catch (_) {
                try { out.destroy(); } catch (_2) {}
            }
            if (this._cancelled || (err && (err.code === 'CANCELLED' || err.name === 'AbortError'))) {
                return { success: false, code: 'CANCELLED', cancelled: true, error: 'İndirme duraklatıldı.', bytes: received };
            }
            return { success: false, code: 'INTERRUPTED', error: `İndirme kesildi: ${err.message}`, bytes: received };
        }

        return this.finalizeDownload(part, full, received, onProgress, hadPartial && res.status === 206);
    }

    async finalizeDownload(part, full, received, onProgress, resumed = false) {
        let actualBytes;
        try {
            actualBytes = fs.statSync(part).size;
        } catch (_) {
            return { success: false, code: 'PART_MISSING', error: 'İndirilen .part dosyası bulunamadı.' };
        }

        if (this.expectedBytes != null && actualBytes !== this.expectedBytes) {
            // Eksik dosya resume için saklanır; fazla dosya silinir.
            if (actualBytes > this.expectedBytes) fs.rmSync(part, { force: true });
            return { success: false, code: 'SIZE_VERIFY_FAILED', error: `Boyut doğrulaması başarısız (${actualBytes}/${this.expectedBytes}).`, bytes: actualBytes };
        }

        let sha256;
        try {
            sha256 = await this.computeSha256(part);
        } catch (err) {
            return { success: false, code: 'SHA_COMPUTE_FAILED', error: `SHA-256 hesaplanamadı: ${err.message}`, bytes: actualBytes };
        }
        if (this.expectedSha256 && sha256 !== this.expectedSha256) {
            fs.rmSync(part, { force: true });
            return { success: false, code: 'SHA_MISMATCH', error: `SHA-256 uyuşmazlığı (${sha256}).`, bytes: actualBytes };
        }

        try {
            fs.renameSync(part, full);
        } catch (err) {
            return { success: false, code: 'MOVE_FAILED', error: `Dosya taşınamadı: ${err.message}`, bytes: actualBytes };
        }

        const manifest = {
            modelId: this.modelId,
            file: this.file,
            url: this.url,
            bytes: actualBytes,
            sha256,
            expectedBytes: this.expectedBytes,
            downloadedAt: new Date().toISOString()
        };
        fs.writeFileSync(this.manifestPath(), JSON.stringify(manifest, null, 2), 'utf8');
        ModelManager.invalidateTiersStatusCache();
        log.info(`[ModelManager] indirildi: ${this.file} (${actualBytes} bayt)`);
        return { success: true, bytes: actualBytes, sha256, resumed: resumed === true };
    }

    parseUnsatisfiedTotal(res) {
        try {
            const cr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
            const m = cr && cr.match(/^bytes\s+\*\/(\d+)$/i);
            return m ? parseInt(m[1], 10) : null;
        } catch (_) {
            return null;
        }
    }

    parseContentRangeStart(res) {
        try {
            const cr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
            const m = cr && cr.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
            return m ? parseInt(m[1], 10) : null;
        } catch (_) {
            return null;
        }
    }

    parseTotal(res, startAt) {
        // 206: Content-Range: bytes 100-999/1234 ; 200: Content-Length.
        try {
            const cr = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
            if (cr) {
                const m = cr.match(/\/(\d+)\s*$/);
                if (m) return parseInt(m[1], 10);
            }
            const cl = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
            if (cl) return parseInt(cl, 10) + startAt;
        } catch (_) {}
        return null;
    }

    /**
     * AI paketi (LLM + STT) sıralı indirilir. onProgress({file, received, total,
     * step, steps}) her chunk'ta çağrılır; indirme bitmiş dosya atlanır
     * (sonuçta skipped:true). Çift-başlatma ALREADY_DOWNLOADING ile reddedilir.
     * @param {ModelManager} llm
     * @param {ModelManager} stt
     * @param {(ev:{file:string,received:number,total:number|null,step:number,steps:number})=>void} onProgress
     * @returns {Promise<{llm:object, stt:object}>}
     */
    static async downloadBundle(llm, stt, onProgress = null) {
        if (!llm || !stt) {
            throw Object.assign(new Error('LLM ve STT yöneticileri gerekli.'), { code: 'INVALID_MANAGERS' });
        }
        if (llm.downloading || stt.downloading) {
            return { llm: { success: false, code: 'ALREADY_DOWNLOADING', error: 'İndirme zaten sürüyor.' }, stt: { success: false, code: 'ALREADY_DOWNLOADING', error: 'İndirme zaten sürüyor.' } };
        }
        const steps = [
            { mgr: llm, step: 1 },
            { mgr: stt, step: 2 }
        ];
        const out = {};
        for (const { mgr, step } of steps) {
            const tag = step === 1 ? 'llm' : 'stt';
            const probe = mgr.status();
            if (probe.present) {
                const ok = await mgr.verify().catch(() => false);
                if (ok) {
                    out[tag] = { success: true, skipped: true, bytes: probe.bytes };
                    if (onProgress) {
                        try { onProgress({ file: mgr.file, received: probe.bytes, total: probe.bytes, step, steps: 2, skipped: true }); } catch (_) {}
                    }
                    continue;
                }
            }
            const res = await mgr.download((received, total) => {
                if (!onProgress) return;
                try { onProgress({ file: mgr.file, received, total, step, steps: 2 }); } catch (_) {}
            });
            out[tag] = res;
            if (!res.success) break; // LLM patlarsa STT'ye geçilmez
        }
        return out;
    }
}

module.exports = {
    ModelManager,
    MODEL_SPECS,
    AI_TIERS,
    DEFAULT_AI_TIER,
    LITE_MODEL_ID,
    LITE_MODEL_FILE,
    LITE_MODEL_URL,
    LITE_MODEL_BYTES,
    LITE_MODEL_SHA256,
    MODEL_ID,
    MODEL_FILE,
    MODEL_URL,
    MODEL_BYTES,
    MODEL_SHA256,
    POWERFUL_MODEL_ID,
    POWERFUL_MODEL_FILE,
    POWERFUL_MODEL_URL,
    POWERFUL_MODEL_BYTES,
    POWERFUL_MODEL_SHA256,
    STT_TINY_MODEL_ID,
    STT_TINY_MODEL_FILE,
    STT_TINY_MODEL_URL,
    STT_TINY_MODEL_BYTES,
    STT_TINY_MODEL_SHA256,
    STT_MODEL_ID,
    STT_MODEL_FILE,
    STT_MODEL_URL,
    STT_MODEL_BYTES,
    STT_MODEL_SHA256,
    STT_SMALL_MODEL_ID,
    STT_SMALL_MODEL_FILE,
    STT_SMALL_MODEL_URL,
    STT_SMALL_MODEL_BYTES,
    STT_SMALL_MODEL_SHA256
};
