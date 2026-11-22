/**
 * deterministic-parser.test.mjs - Türkçe kural tabanlı ayrıştırıcı (K1b)
 */
import { describe, it, expect } from 'vitest';
import { parse, parseDurationMs, parseClockTarget, parseCount, parseCondition, findAction } from '../../src/main/services/DeterministicParser.js';

describe('parseDurationMs', () => {
    it('tek birimler', () => {
        expect(parseDurationMs('30 dakika sonra kapat')).toBe(30 * 60000);
        expect(parseDurationMs('45 saniye')).toBe(45000);
        expect(parseDurationMs('2 saat')).toBe(2 * 3600000);
        expect(parseDurationMs('1 gün')).toBe(86400000);
    });

    it('birleşik öbekler toplanır', () => {
        expect(parseDurationMs('1 saat 30 dakika')).toBe(90 * 60000);
        expect(parseDurationMs('1 saat 30 dakika 10 saniye')).toBe(90 * 60000 + 10000);
    });

    it('Türkçe sayı sözcükleri', () => {
        expect(parseDurationMs('yirmi beş dakika')).toBe(25 * 60000);
        expect(parseDurationMs('on beş dakika')).toBe(15 * 60000);
        expect(parseDurationMs('yarım saat')).toBe(1800000);
    });

    it('ondalık virgül ve sınır', () => {
        expect(parseDurationMs('1,5 saat')).toBe(5400000);
        expect(parseDurationMs('999999 saat')).toBeNull();
    });

    it('süre yoksa null', () => {
        expect(parseDurationMs('kapat')).toBeNull();
        expect(parseDurationMs('')).toBeNull();
        expect(parseDurationMs(null)).toBeNull();
    });
});

describe('parseCount', () => {
    it('rakam ve sözcük', () => {
        expect(parseCount('15')).toBe(15);
        expect(parseCount('yirmi beş')).toBe(25);
        expect(parseCount('üç')).toBe(3);
        expect(parseCount('abc')).toBeNull();
        expect(parseCount('')).toBeNull();
    });

    it('en sondaki rakamı alır', () => {
        expect(parseCount('1 saat 30')).toBe(30);
    });
});

describe('parseClockTarget', () => {
    const now = new Date('2026-01-01T10:00:00').getTime();

    it('HH:MM biçimi', () => {
        const t = parseClockTarget('23:30 kapat', now);
        expect(new Date(t).getHours()).toBe(23);
        expect(new Date(t).getMinutes()).toBe(30);
    });

    it('geçmiş saat ertesi güne kayar', () => {
        const t = parseClockTarget('09:00 kapat', now);
        expect(t).toBeGreaterThan(now);
        expect(new Date(t).getDate()).toBe(new Date(now).getDate() + 1);
    });

    it('yarın ipucu', () => {
        const t = parseClockTarget('yarın 23:00 kapat', now);
        expect(new Date(t).getDate()).toBe(new Date(now).getDate() + 1);
    });

    it('akşam/sabah ipuçları 12 saat dönüşümü', () => {
        const pm = parseClockTarget('akşam 8 kapat', now);
        expect(new Date(pm).getHours()).toBe(20);
        const am12 = parseClockTarget('sabah 12 kapat', now);
        expect(new Date(am12).getHours()).toBe(0);
        const night = parseClockTarget('gece 3 kapat', now);
        expect(new Date(night).getHours()).toBe(3);
    });

    it('geçersiz değerler null', () => {
        expect(parseClockTarget('25:00', now)).toBeNull();
        expect(parseClockTarget('12:75', now)).toBeNull();
        expect(parseClockTarget('24:00', now)).toBeNull();
        expect(parseClockTarget('kapat', now)).toBeNull();
        expect(parseClockTarget('akşam 30', now)).toBeNull();
    });
});

describe('findAction', () => {
    it('eylemleri tanır', () => {
        expect(findAction('bilgisayarı kapat')).toBe('shutdown');
        expect(findAction('yeniden başlat')).toBe('restart');
        expect(findAction('hazırda beklet')).toBe('hibernate');
        expect(findAction('uyku moduna al')).toBe('sleep');
        expect(findAction('ekranı kilitle')).toBe('lock');
        expect(findAction('oturumu kapat')).toBe('signout');
        expect(findAction('çıkış yap')).toBe('signout');
        expect(findAction('merhaba')).toBeNull();
    });
});

describe('parseCondition', () => {
    it('indirme/ağ/pil/cpu koşulları', () => {
        expect(parseCondition('indirme bitince kapat')).toEqual({ type: 'network_speed', thresholdKbps: 50 });
        expect(parseCondition('ağ durunca kapat')).toEqual({ type: 'network_speed', thresholdKbps: 50 });
        expect(parseCondition('pil %15 olunca kapat')).toEqual({ type: 'battery_level', belowPercent: 15 });
        expect(parseCondition('pil azalınca kapat')).toEqual({ type: 'battery_level', belowPercent: 20 });
        expect(parseCondition('pil %150 olunca')).toBeNull();
        expect(parseCondition('cpu boş kalınca kapat')).toEqual({ type: 'cpu_usage', thresholdPercent: 10 });
    });

    it('süreç kapanması', () => {
        expect(parseCondition('chrome kapanınca kapat')).toEqual({ type: 'process_running', processName: 'chrome.exe', triggerOnClose: true });
        expect(parseCondition('game.exe kapanınca kapat')).toMatchObject({ processName: 'game.exe' });
        expect(parseCondition('bilgisayar kapanınca kapat')).toBeNull();
    });

    it('dosya sabitlenmesi', () => {
        expect(parseCondition('c:\\yedek bitince kapat')).toMatchObject({ type: 'file_stable', filePath: 'c:\\yedek' });
    });

    it('koşul yoksa null', () => {
        expect(parseCondition('kapat')).toBeNull();
    });
});

describe('parse (uçtan uca)', () => {
    it('boş/olumsuz/eylemsiz girdi null', () => {
        expect(parse('')).toBeNull();
        expect(parse(null)).toBeNull();
        expect(parse('   ')).toBeNull();
        expect(parse('kapatma')).toBeNull(); // olumsuzluk
        expect(parse('merhaba')).toBeNull();
    });

    it('süreli görev', () => {
        expect(parse('30 dakika sonra kapat')).toEqual({ action: 'shutdown', kind: 'duration', durationMs: 1800000 });
        expect(parse('2 saat sonra uyku')).toEqual({ action: 'sleep', kind: 'duration', durationMs: 7200000 });
    });

    it('koşullu görev', () => {
        expect(parse('chrome kapanınca kapat')).toMatchObject({ action: 'shutdown', kind: 'condition' });
        expect(parse('pil %10 olunca uyku')).toMatchObject({ action: 'sleep', kind: 'condition' });
    });

    it('koşul ipucu ama çıkarılamayan kalıp null (LLM\'e)', () => {
        expect(parse('render bitince kapat')).toBeNull();
    });

    it('saatli görev', () => {
        const now = Date.now();
        const r = parse('23:59 kapat');
        expect(r.kind).toBe('scheduled_time');
        expect(r.targetTime).toBeGreaterThan(now - 1000);
    });

    it('süre yoksa eksik alan raporlanır', () => {
        expect(parse('kapat')).toEqual({ action: 'shutdown', kind: 'duration', missing: ['durationMs'] });
    });
});
