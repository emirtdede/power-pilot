/**
 * deterministic-parser.test.mjs - K1b
 * Türkçe güç cümleleri LLM'siz çözülür; koşul cümleleri LLM'e bırakılır (null).
 */
import { describe, it, expect } from 'vitest';
import { parse, parseDurationMs, parseCount, findAction } from '../../src/main/services/DeterministicParser.js';

describe('findAction', () => {
    it('eylem anahtar sözcükleri', () => {
        expect(findAction('bilgisayarı kapat')).toBe('shutdown');
        expect(findAction('yeniden başlat')).toBe('restart');
        expect(findAction('hazırda beklet')).toBe('hibernate');
        expect(findAction('uyku moduna al')).toBe('sleep');
        expect(findAction('ekranı kilitle')).toBe('lock');
        expect(findAction('oturumu kapat')).toBe('signout');
        expect(findAction('bugün hava güzel')).toBeNull();
    });

    it('oturumu kapat shutdown ile karışmaz', () => {
        expect(findAction('oturumu kapat')).toBe('signout');
    });
});

describe('parseCount', () => {
    it('rakam ve sözcük sayılar', () => {
        expect(parseCount('10 ')).toBe(10);
        expect(parseCount('on beş ')).toBe(15);
        expect(parseCount('yirmi beş ')).toBe(25);
        expect(parseCount('iki ')).toBe(2);
        expect(parseCount('lütfen ')).toBeNull();
    });
});

describe('parseDurationMs', () => {
    it('canlı girdiler', () => {
        expect(parseDurationMs('10 dakika sonra ekranı kilitle')).toBe(600000);
        expect(parseDurationMs('2 saat sonra kapat')).toBe(7200000);
        expect(parseDurationMs('45 saniye sonra yeniden başlat')).toBe(45000);
        expect(parseDurationMs('yarım saat sonra uyut')).toBe(1800000);
        expect(parseDurationMs('on beş dakika sonra uyut')).toBe(900000);
        expect(parseDurationMs('1 saat 30 dakika sonra kapat')).toBe(5400000);
    });

    it('süresiz cümle null', () => {
        expect(parseDurationMs('bilgisayarı kapat')).toBeNull();
    });
});

describe('parse', () => {
    it('tam cümleler öneri girdisi üretir', () => {
        expect(parse('10 dakika sonra ekranı kilitle')).toEqual({ action: 'lock', kind: 'duration', durationMs: 600000 });
        expect(parse('2 saat sonra kapat')).toEqual({ action: 'shutdown', kind: 'duration', durationMs: 7200000 });
    });

    it('süresiz eylem eksik-alan bildirir', () => {
        expect(parse('bilgisayarı kapat')).toEqual({ action: 'shutdown', kind: 'duration', missing: ['durationMs'] });
        expect(parse('oturumu kapat')).toEqual({ action: 'signout', kind: 'duration', missing: ['durationMs'] });
    });

    it('koşul cümleleri LLM’e bırakılır', () => {
        expect(parse('yedek klasörü sabitlenince kapat')).toBeNull();
        expect(parse('bilgisayar kapanınca kapat')).toBeNull();
    });

    it('eylemsiz cümle null', () => {
        expect(parse('')).toBeNull();
        expect(parse('bugün hava nasıl')).toBeNull();
    });

    it('saat cümlesi scheduled_time üretir', () => {
        const in2h = new Date(Date.now() + 7200000);
        const hh = String(in2h.getHours()).padStart(2, '0');
        const mm = String(in2h.getMinutes()).padStart(2, '0');
        const r = parse(`${hh}:${mm} uyut`);
        expect(r.action).toBe('sleep');
        expect(r.kind).toBe('scheduled_time');
        expect(r.targetTime).toBeGreaterThan(Date.now());
    });
});

describe('parseCondition', () => {
    it('yaygın kalıplar', async () => {
        const { parseCondition } = await import('../../src/main/services/DeterministicParser.js');
        expect(parseCondition('indirme bitince kapat')).toEqual({ type: 'network_speed', thresholdKbps: 50 });
        expect(parseCondition('ağ durunca uyut')).toEqual({ type: 'network_speed', thresholdKbps: 50 });
        expect(parseCondition('pil %20 olunca hazırda beklet')).toEqual({ type: 'battery_level', belowPercent: 20 });
        expect(parseCondition('cpu boşta kapat')).toEqual({ type: 'cpu_usage', thresholdPercent: 10 });
        expect(parseCondition('zoom kapanınca kilitle')).toEqual({ type: 'process_running', processName: 'zoom.exe', triggerOnClose: true });
    });

    it('çıkarılamayan koşul null', async () => {
        const { parseCondition } = await import('../../src/main/services/DeterministicParser.js');
        expect(parseCondition('yedek klasörü sabitlenince kapat')).toBeNull();
        expect(parseCondition('bilgisayar kapanınca kapat')).toBeNull();
        expect(parseCondition('10 dakika sonra kapat')).toBeNull();
    });

    it('parse() koşul öneri girdisi üretir', () => {
        expect(parse('indirme bitince kapat')).toEqual({
            action: 'shutdown', kind: 'condition',
            condition: { type: 'network_speed', thresholdKbps: 50 }
        });
        expect(parse('zoom kapanınca kilitle')).toEqual({
            action: 'lock', kind: 'condition',
            condition: { type: 'process_running', processName: 'zoom.exe', triggerOnClose: true }
        });
    });
});
