/**
 * SttService.js - WBS-8.1
 * Yerel konuşma-metin servisi (whisper.cpp binding, Spike WBS-8.0 kararı:
 * `@fugood/whisper.node`, MIT, win-x64 hazır ikili, API doğrulanmış).
 *
 * Kurallar:
 * - Dil her zaman açıkça verilir (otomatik algılama yok - hızlı + isabetli).
 * - Enerji kapısı: sessizlik/kısa kayıt modele gitmeden reddedilir
 *   (halüsinasyon önlemi, ek VAD modeli indirmeden).
 * - Kayıt tavanı 15sn (240000 örnek @16kHz); uzun kayıt kırpılır + işaretlenir.
 * - Model yoksa fail-closed: {ok:false, code:'STT_MODEL_MISSING'}.
 */

const fs = require('fs');
const path = require('path');
const log = require('../logger');

const SAMPLE_RATE = 16000;
const MIN_SAMPLES = 8000; // 0.5sn
const MAX_SAMPLES = 240000; // 15sn
const SPEECH_THRESHOLD = 0.02; // mutlak genlik eşiği
const MIN_SPEECH_RATIO = 0.10; // kaydın en az %10'u konuşma olmalı

// WBS-8.1 + WP-3.1: 73 arayüz dili → whisper dil kodu (0 dil sızıntısı).
const STT_LANGS = {
    tr: 'tr', en: 'en', de: 'de', es: 'es', fr: 'fr', it: 'it', pt: 'pt',
    nl: 'nl', pl: 'pl', ru: 'ru', ja: 'ja', ko: 'ko', zh: 'zh', 'zh-tw': 'zh',
    sv: 'sv', ar: 'ar', hi: 'hi', id: 'id', vi: 'vi', uk: 'uk', el: 'el',
    cs: 'cs', da: 'da', fi: 'fi', no: 'nn', hu: 'hu', ro: 'ro', th: 'th',
    ms: 'ms', fil: 'tl', bn: 'bn', he: 'he', fa: 'fa', ur: 'ur', az: 'az',
    kk: 'kk', uz: 'uz', bg: 'bg', sk: 'sk', hr: 'hr', et: 'et', ta: 'ta',
    te: 'te', mr: 'mr', kn: 'kn', gu: 'gu', ml: 'ml', pa: 'pa', lt: 'lt',
    lv: 'lv', sr: 'sr', sl: 'sl', bs: 'bs', sq: 'sq', mk: 'mk', is: 'is',
    sw: 'sw', am: 'am', ha: 'ha', yo: 'yo', af: 'af', ka: 'ka', hy: 'hy',
    ky: 'tr', tk: 'tk', mn: 'mn', ca: 'ca', eu: 'eu', gl: 'gl', ga: 'cy',
    my: 'my', km: 'km', si: 'si'
};

// ggerganov/whisper.cpp HuggingFace LFS doğrulanmış değerleri (Tiny / Base / Small-Q5_1).
const STT_MODELS = {
    tiny: {
        file: 'ggml-tiny.bin',
        bytes: 77691713,
        sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
    },
    base: {
        file: 'ggml-base.bin',
        bytes: 147951465,
        sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
    },
    'small-q5_1': {
        file: 'ggml-small-q5_1.bin',
        bytes: 190085487,
        sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
    }
};

const TIER_TO_STT_MODEL = Object.freeze({
    lite: 'tiny',
    balanced: 'base',
    powerful: 'small-q5_1'
});

class SttService {
    // whisperModule: test izolasyonu için (varsayılan: gerçek dinamik import).
    constructor({ modelDir = null, modelId = 'base', whisperModule = null } = {}) {
        this.modelDir = modelDir;
        this.modelId = modelId in STT_MODELS ? modelId : 'base';
        this.whisperModule = whisperModule;
        this.context = null;
        this._initPromise = null;
        this._activeTranscription = null;
    }

    modelPath() {
        if (!this.modelDir) return null;
        return path.join(this.modelDir, STT_MODELS[this.modelId].file);
    }

    async unload() {
        if (this._initPromise) {
            try { await this._initPromise; } catch (_) { /* yut */ }
        }
        if (this._activeTranscription) {
            try { await this._activeTranscription; } catch (_) { /* yut */ }
        }
        if (this.context) {
            const ctx = this.context;
            this.context = null;
            try {
                if (typeof ctx.release === 'function') await ctx.release();
                else if (typeof ctx.dispose === 'function') await ctx.dispose();
            } catch (_) { /* yut */ }
        }
    }

    async setModelId(nextId = 'base') {
        const resolved = nextId in STT_MODELS ? nextId : (TIER_TO_STT_MODEL[nextId] || 'base');
        if (this.modelId !== resolved) {
            await this.unload();
            this.modelId = resolved;
        }
        return this.modelId;
    }

    getStatus() {
        const p = this.modelPath();
        const present = !!(p && fs.existsSync(p));
        return {
            ready: present && !!this.context,
            modelPresent: present,
            modelId: this.modelId,
            modelFile: STT_MODELS[this.modelId].file
        };
    }

    async ensureBinding() {
        if (this.whisperModule) return this.whisperModule;
        const mod = await import('@fugood/whisper.node');
        this.whisperModule = mod.default || mod;
        return this.whisperModule;
    }

    async ensureContext() {
        if (this.context) return this.context;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            const p = this.modelPath();
            if (!p || !fs.existsSync(p)) {
                throw new Error('STT_MODEL_MISSING');
            }
            const binding = await this.ensureBinding();
            if (typeof binding.initWhisper !== 'function') {
                throw new Error('STT_BINDING_UNSUPPORTED');
            }
            this.context = await binding.initWhisper({ filePath: p, useGpu: false });
            return this.context;
        })();
        try {
            return await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    // Enerji kapısı: {speechRatio} - saf, test edilebilir.
    static speechRatio(samples) {
        if (!samples || samples.length === 0) return 0;
        let voiced = 0;
        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i]) >= SPEECH_THRESHOLD) voiced += 1;
        }
        return voiced / samples.length;
    }

    static toFloat32Array(input) {
        if (input instanceof Float32Array) return input;
        if (Array.isArray(input)) return Float32Array.from(input);
        return null;
    }

    /**
     * @param {Float32Array|number[]} pcm16k - 16kHz mono örnekler
     * @param {string} uiLang - arayüz dili (STT_LANGS ile eşlenir; bilinmeyen
     *   dilde İngilizce'ye düşer, Türkçe'ye değil)
     */
    async transcribePcm(pcm16k, uiLang = 'en') {
        const samples = SttService.toFloat32Array(pcm16k);
        if (!samples) {
            return { ok: false, code: 'INVALID_AUDIO', message: 'Ses verisi anlaşılmadı.' };
        }
        if (samples.length < MIN_SAMPLES) {
            return { ok: false, code: 'TOO_SHORT', message: 'Kayıt çok kısa (en az 0.5sn konuşun).' };
        }
        let truncated = false;
        let work = samples;
        if (samples.length > MAX_SAMPLES) {
            work = samples.subarray ? samples.subarray(0, MAX_SAMPLES) : samples.slice(0, MAX_SAMPLES);
            truncated = true;
        }
        if (SttService.speechRatio(work) < MIN_SPEECH_RATIO) {
            return { ok: false, code: 'SILENCE', message: 'Sessizlik algılandı, bir şey duyamadım.' };
        }
        if (this._activeTranscription) {
            try { await this._activeTranscription; } catch (_) { /* önceki işlemi bekle */ }
        }
        const runTask = (async () => {
            let context;
            try {
                context = await this.ensureContext();
            } catch (err) {
                const code = err && err.message === 'STT_MODEL_MISSING' ? 'STT_MODEL_MISSING' : 'STT_UNAVAILABLE';
                return { ok: false, code, message: code === 'STT_MODEL_MISSING' ? 'Ses modeli indirilmedi.' : 'Ses motoru başlatılamadı.' };
            }
            try {
                const { promise } = await context.transcribeData(work.buffer.slice(work.byteOffset, work.byteOffset + work.byteLength), {
                    language: STT_LANGS[uiLang] || 'en'
                });
                const result = await promise;
                const text = String((result && result.result) || '').trim();
                if (!text) {
                    return { ok: false, code: 'NOT_HEARD', message: 'Anlaşılmadı, tekrar deneyin.' };
                }
                return { ok: true, text, truncated };
            } catch (err) {
                log.warn(`[SttService] deşifre hatası: ${err && err.message}`);
                return { ok: false, code: 'TRANSCRIBE_FAILED', message: 'Deşifre başarısız.' };
            }
        })();
        this._activeTranscription = runTask;
        try {
            return await runTask;
        } finally {
            if (this._activeTranscription === runTask) {
                this._activeTranscription = null;
            }
        }
    }
}

module.exports = { SttService, STT_LANGS, STT_MODELS, SAMPLE_RATE, MIN_SAMPLES, MAX_SAMPLES };
