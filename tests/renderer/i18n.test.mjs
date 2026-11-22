/**
 * i18n.test.mjs - WP-14.T2/T6
 * Renderer yalnızca aktif locale'i IPC ile yükler; RTL ve tek sözlük.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/i18n.js'), 'utf8');
const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/locales/en.json'), 'utf8'));
const ar = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/locales/ar.json'), 'utf8'));

function boot({ storedLanguage = 'en' } = {}) {
    const calls = [];
    const attrs = {};
    const doc = { documentElement: { setAttribute: (key, value) => { attrs[key] = value; } } };
    const window = {
        electronAPI: {
            getLocale: async (lang) => {
                calls.push(lang);
                const dictionary = lang === 'ar' ? ar : en;
                return { ok: true, lang, rtl: lang === 'ar', dictionary };
            }
        }
    };
    window.window = window;
    window.document = doc;
    const sandbox = {
        window,
        document: doc,
        navigator: { language: storedLanguage === 'ar' ? 'ar-SA' : 'en-US' },
        localStorage: { getItem: () => storedLanguage, setItem: () => {} },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return { window, attrs, calls };
}

describe('renderer locale yükleyici', () => {
    it('açılışta yalnızca bir locale dosyası okur', async () => {
        const { window, attrs, calls } = boot({ storedLanguage: 'en' });
        await window.PPLocale.ready;
        expect(calls).toEqual(['en']);
        expect(window.PPLocale.language).toBe('en');
        expect(attrs.lang).toBe('en');
        expect(attrs.dir).toBe('ltr');
    });

    it('Arapça seçiminde dir=rtl ve aktif sözlük değişir', async () => {
        const { window, attrs, calls } = boot({ storedLanguage: 'en' });
        await window.PPLocale.ready;
        const dict = await window.PPLocale.load('ar');
        expect(dict).toBeTruthy();
        expect(dict.actionShutdown).toBe(ar.actionShutdown);
        expect(window.PPLocale.language).toBe('ar');
        expect(attrs.dir).toBe('rtl');
        expect(calls).toEqual(['en', 'ar']);
    });

    it('bilinmeyen dil İngilizce’ye düşer', async () => {
        const { window, calls } = boot({ storedLanguage: 'xx' });
        await window.PPLocale.ready;
        // Uluslararası varsayılan 'en'; 'tr' yalnızca gerçek Türkçe sistemde.
        expect(calls[0]).toBe('en');
    });
});
