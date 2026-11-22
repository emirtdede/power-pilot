import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import {
    translate, actionLabel, taskName, loadTranslations, loadLocale,
    loadLocaleForRenderer, normalizeLanguage, normalizeCatalogLanguage,
    LANGUAGE_ORDER, ALL_LANGUAGES, ALL_LANGUAGE_CODES, RTL_LANGUAGES, resetCache
} from '../../src/main/i18n.js';

afterEach(() => {
    vi.restoreAllMocks();
    resetCache();
});

describe('dil normalizasyonu - desteklenmeyen sistem dili İngilizceye düşer', () => {
    // Regresyon: önceden hepsi 'tr'ye düşüyordu; Rusça/Hintçe/Vietnamca bir
    // Windows'ta uygulama ilk açılışta Türkçe görünüyordu.
    it('desteklenmeyen diller İngilizceye düşer', () => {
        for (const lang of ['ru', 'hi', 'uk', 'he', 'th', 'vi', 'id', 'sr', 'bg', 'ro', 'hu', 'fi', 'el', 'xx']) {
            expect(normalizeLanguage(lang), `${lang} → en olmalı`).toBe('en');
        }
    });

    it('bölge ekli bilinmeyen diller de İngilizceye düşer', () => {
        expect(normalizeLanguage('ru-RU')).toBe('en');
        expect(normalizeLanguage('hi-IN')).toBe('en');
    });

    it('boş/geçersiz girdi İngilizceye düşer (çökmez)', () => {
        expect(normalizeLanguage('')).toBe('en');
        expect(normalizeLanguage(null)).toBe('en');
        expect(normalizeLanguage(undefined)).toBe('en');
        expect(normalizeLanguage(42)).toBe('en');
    });

    it('desteklenen diller korunur, bölge ekleri kırpılır', () => {
        expect(normalizeLanguage('tr-TR')).toBe('tr');
        expect(normalizeLanguage('en-US')).toBe('en');
        expect(normalizeLanguage('de-DE')).toBe('de');
        expect(normalizeLanguage('nb-NO')).toBe('no');
        expect(normalizeLanguage('zh-CN')).toBe('zh');
        expect(normalizeLanguage('pt-BR')).toBe('pt');
    });

    it('Türkçe yalnızca gerçekten Türkçe sistemde gelir', () => {
        expect(normalizeLanguage('tr')).toBe('tr');
        expect(normalizeLanguage('tr-TR')).toBe('tr');
    });
});

describe('ana süreç i18n (WP-14.T3)', () => {
    it('17 dil dosyası JSON olarak mevcut', () => {
        expect(LANGUAGE_ORDER).toHaveLength(17);
        for (const lang of LANGUAGE_ORDER) {
            const dict = loadLocale(lang);
            expect(typeof dict.trayShow, lang).toBe('string');
        }
    });

    it('açılışta yalnızca tek locale dosyası okur', () => {
        const spy = vi.spyOn(fs, 'readFileSync');
        resetCache();
        const en = loadTranslations('en');
        expect(en.trayShow).toBe('Show App');
        const localeReads = spy.mock.calls
            .map((c) => String(c[0]))
            .filter((p) => p.includes(`${fsPathSep()}locales${fsPathSep()}`));
        expect(localeReads).toHaveLength(1);
    });

    it('vm kullanımı yok', () => {
        const source = fs.readFileSync(new URL('../../src/main/i18n.js', import.meta.url), 'utf8');
        expect(source).not.toMatch(/require\(['"]vm['"]\)|runInContext/);
    });

    it('placeholder ve dil fallback uygular', () => {
        expect(translate('en', 'balloonMeasured', { watt: 42 })).toContain('42W');
        expect(translate('tr', 'balloonMeasured', { watt: 42 })).toContain('42W');
        // Desteklenmeyen dil İngilizceye düşer (Türkçe'ye değil): uluslararası
        // bir kullanıcı Rusça/Hintçe sistemde Türkçe arayüz görmemeli.
        expect(translate('xx', 'trayQuit')).toBe('Quit');
        expect(translate('ru', 'trayQuit')).toBe('Quit');
        expect(translate('en', 'bilinmeyen_anahtar')).toBe('bilinmeyen_anahtar');
    });

    it('güç eylemlerini yerelleştirir', () => {
        expect(actionLabel('en', 'shutdown')).toBe('Shut Down');
        expect(actionLabel('tr', 'shutdown')).toBe('Bilgisayarı Kapat');
        expect(actionLabel('de', 'sleep')).toBe('Energiesparmodus');
    });

    it('tray görev adını tetikleyiciden türetir', () => {
        const quick = taskName('en', {
            name: 'Hızlı Zamanlayıcı (Kapat)',
            action: 'shutdown',
            source: 'user_interface',
            trigger: { type: 'duration' }
        });
        expect(quick).toBe('Quick Timer (Shut Down)');

        const builtin = taskName('en', { name: 'Chrome Kapanınca Kilitle', trigger: { type: 'composite' } });
        expect(builtin).toBe('Lock When Chrome Closes');

        const apiTask = taskName('en', { name: 'My CI task', source: 'local_api', trigger: {} });
        expect(apiTask).toBe('My CI task');
    });

    it('73 dil kataloğu ve İngilizce fallback (loadLocaleForRenderer)', () => {
        expect(ALL_LANGUAGES).toHaveLength(73);
        expect(ALL_LANGUAGE_CODES).toHaveLength(73);
        expect([...RTL_LANGUAGES].sort()).toEqual(['ar', 'fa', 'he', 'ur']);

        expect(normalizeCatalogLanguage('az')).toBe('az');
        expect(normalizeCatalogLanguage('ru-RU')).toBe('ru');
        expect(normalizeCatalogLanguage('he-IL')).toBe('he');
        expect(normalizeCatalogLanguage('xx')).toBe('en');

        const trRes = loadLocaleForRenderer('tr');
        expect(trRes.lang).toBe('tr');
        expect(trRes.resolvedLang).toBe('tr');
        expect(trRes.fallback).toBe(false);
        expect(trRes.rtl).toBe(false);
        expect(trRes.dictionary.about).toBe('Hakkında');

        const ruRes = loadLocaleForRenderer('ru');
        expect(ruRes.lang).toBe('ru');
        expect(ruRes.resolvedLang).toBe('en');
        expect(ruRes.fallback).toBe(true);
        expect(ruRes.rtl).toBe(false);
        expect(ruRes.dictionary.about).toBe(loadLocaleForRenderer('en').dictionary.about);

        const heRes = loadLocaleForRenderer('he');
        expect(heRes.lang).toBe('he');
        expect(heRes.resolvedLang).toBe('en');
        expect(heRes.fallback).toBe(true);
        expect(heRes.rtl).toBe(true);
    });
});

function fsPathSep() {
    return process.platform === 'win32' ? '\\' : '/';
}
