/**
 * stt-service.test.mjs - WBS-8.1 / TS-8.1
 * SttService: enerji kapısı, dil eşlemesi, fail-closed yolları (sahte binding).
 * Gerçek model/mikrofon gerekmez.
 */
import { describe, it, expect, vi } from 'vitest';
import { SttService, STT_LANGS, STT_MODELS, SAMPLE_RATE, MIN_SAMPLES, MAX_SAMPLES } from '../../src/main/services/SttService.js';

const UI_LANGS_17 = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];

function voicedArray(n, amp = 0.5) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = (i % 2 === 0 ? amp : -amp);
    return a;
}
function silentArray(n) {
    return new Float32Array(n);
}

// lastOpts ile dili yakalayan sahte binding.
function stubBinding(text = 'bilgisayarı kapat', calls = null) {
    return {
        initWhisper: vi.fn(async () => ({
            transcribeData: vi.fn(async (buf, opts) => {
                if (calls) calls.push({ bytes: buf.byteLength, opts });
                return { promise: Promise.resolve({ result: text, segments: [] }) };
            }),
            release: vi.fn(async () => { })
        }))
    };
}

describe('SttService kapılar (TS-8.1)', () => {
    it('dil eşlemesi 17 dili kapsar', () => {
        for (const lang of UI_LANGS_17) {
            expect(typeof STT_LANGS[lang]).toBe('string');
            expect(STT_LANGS[lang].length).toBeGreaterThan(0);
        }
    });

    it('model sabitleri doğrulanmış değerlerdir', () => {
        expect(STT_MODELS.base.sha256).toBe('60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe');
        expect(STT_MODELS.tiny.sha256).toBe('be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21');
        expect(STT_MODELS['small-q5_1'].sha256).toBe('ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb');
        expect(SAMPLE_RATE).toBe(16000);
        expect(MIN_SAMPLES).toBe(8000);
        expect(MAX_SAMPLES).toBe(240000);
    });

    it('kısa kayıt modele gitmeden reddedilir', async () => {
        const initWhisper = vi.fn();
        const svc = new SttService({ modelDir: '/yok', whisperModule: { initWhisper } });
        const r = await svc.transcribePcm(new Float32Array(100), 'tr');
        expect(r).toMatchObject({ ok: false, code: 'TOO_SHORT' });
        expect(initWhisper).not.toHaveBeenCalled();
    });

    it('sessizlik modele gitmeden reddedilir', async () => {
        const initWhisper = vi.fn();
        const svc = new SttService({ modelDir: '/yok', whisperModule: { initWhisper } });
        const r = await svc.transcribePcm(silentArray(16000), 'tr');
        expect(r).toMatchObject({ ok: false, code: 'SILENCE' });
        expect(initWhisper).not.toHaveBeenCalled();
    });

    it('geçersiz girdi reddedilir', async () => {
        const svc = new SttService({ modelDir: '/yok', whisperModule: stubBinding() });
        expect(await svc.transcribePcm('metin', 'tr')).toMatchObject({ ok: false, code: 'INVALID_AUDIO' });
        expect(await svc.transcribePcm(null, 'tr')).toMatchObject({ ok: false, code: 'INVALID_AUDIO' });
    });

    it('model yoksa STT_MODEL_MISSING (fail-closed)', async () => {
        const svc = new SttService({ modelDir: '/kesinlikle-yok-burasi', whisperModule: stubBinding() });
        const r = await svc.transcribePcm(voicedArray(16000), 'tr');
        expect(r).toMatchObject({ ok: false, code: 'STT_MODEL_MISSING' });
    });

    it('uzun kayıt 15sn kırpılır + işaretlenir', async () => {
        const calls = [];
        const binding = stubBinding('uzun metin', calls);
        const svc = new SttService({ modelDir: '/yok', whisperModule: binding });
        svc.context = await binding.initWhisper({ filePath: 'x' });
        const r = await svc.transcribePcm(voicedArray(300000), 'tr');
        expect(r.ok).toBe(true);
        expect(r.truncated).toBe(true);
        expect(calls[0].bytes).toBe(MAX_SAMPLES * 4);
    });

    it('dil arayüz dilinden eşlenir (no→nn), bilinmeyende en fallback', async () => {
        expect(STT_LANGS.no).toBe('nn');
        expect(STT_LANGS.tr).toBe('tr');
        const calls = [];
        const binding = stubBinding('kapat', calls);
        const svc = new SttService({ modelDir: '/yok', whisperModule: binding });
        svc.context = await binding.initWhisper({ filePath: 'x' });
        const r = await svc.transcribePcm(voicedArray(16000), 'xx-bilinmeyen');
        expect(r.ok).toBe(true);
        // Bilinmeyen arayüz dili İngilizce'ye düşer (Türkçe'ye değil).
        expect(calls[0].opts.language).toBe('en');
    });

    it('boş metin NOT_HEARD döner', async () => {
        const binding = stubBinding('   ');
        const svc = new SttService({ modelDir: '/yok', whisperModule: binding });
        svc.context = await binding.initWhisper({ filePath: 'x' });
        expect(await svc.transcribePcm(voicedArray(16000), 'tr')).toMatchObject({ ok: false, code: 'NOT_HEARD' });
    });

    it('deşifre istisnası TRANSCRIBE_FAILED olur (fırlatma yok)', async () => {
        const binding = {
            initWhisper: vi.fn(async () => ({
                transcribeData: vi.fn(async () => { throw new Error('boom'); }),
                release: vi.fn(async () => { })
            }))
        };
        const svc = new SttService({ modelDir: '/yok', whisperModule: binding });
        svc.context = await binding.initWhisper({ filePath: 'x' });
        expect(await svc.transcribePcm(voicedArray(16000), 'tr')).toMatchObject({ ok: false, code: 'TRANSCRIBE_FAILED' });
    });

    it('speechRatio eşiği doğru hesaplanır', () => {
        expect(SttService.speechRatio(silentArray(1000))).toBe(0);
        expect(SttService.speechRatio(voicedArray(1000))).toBeGreaterThan(0.9);
        expect(SttService.speechRatio([])).toBe(0);
    });

    it('unload bağlamı temizler ve aktif deşifre sürerken bitmesini bekler (BUG-03 / CLEAN-02)', async () => {
        const order = [];
        const binding = {
            initWhisper: vi.fn(async () => ({
                transcribeData: vi.fn(async () => ({
                    promise: new Promise((resolve) => {
                        setTimeout(() => {
                            order.push('transcribe_done');
                            resolve({ result: '45 dakika sonra kapat', segments: [] });
                        }, 30);
                    })
                })),
                release: vi.fn(async () => {
                    order.push('released');
                })
            }))
        };
        const svc = new SttService({ modelDir: '/yok', whisperModule: binding });
        svc.context = await binding.initWhisper({ filePath: 'x' });
        const [txRes] = await Promise.all([
            svc.transcribePcm(voicedArray(16000), 'tr'),
            svc.unload()
        ]);
        expect(txRes.ok).toBe(true);
        expect(svc.context).toBeNull();
        expect(order).toEqual(['transcribe_done', 'released']);
    });
});
