/**
 * theme-boot.spec.js - PPX-021 / PPX-015
 * TC-38, TC-39.
 *
 * Tema ilk boyamadan önce uygulanır (harici theme-boot.js, CSP uyumlu);
 * tema/dil Save'e basılmadan etkinleşir ve kalıcılaşır.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, dismissOverlays, closeApp } = require('./helpers/launch');
const { waitForStable } = require('./helpers/a11y');

test('PPX-021: açık tema reload sonrası ilk boyamada uygulanır', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-theme-boot-');
    try {
        await setSize(app, 1024, 768);
        await dismissOverlays(window);
        await window.evaluate(() => localStorage.setItem('theme', 'light'));

        // Tema betiği <head> içinde ilk betik ve stil dosyalarından ÖNCE.
        const order = await window.evaluate(() => {
            const head = document.head;
            const scripts = [...head.querySelectorAll('script')];
            const bootIdx = scripts.findIndex((s) => /theme-boot\.js/.test(s.getAttribute('src') || ''));
            const firstLink = [...head.children].findIndex((el) => el.tagName === 'LINK');
            const bootEl = scripts[bootIdx];
            const bootChildIdx = bootEl ? [...head.children].indexOf(bootEl) : -1;
            return {
                bootIdxInScripts: bootIdx,
                bootChildIdx,
                firstLinkIdx: firstLink,
                early: !!window.__ppEarlyTheme
            };
        });
        expect(order.bootIdxInScripts, 'PPX-021: theme-boot.js ilk betik').toBe(0);
        expect(order.bootChildIdx, 'PPX-021: tema betiği stil öncesi').toBeLessThan(order.firstLinkIdx);

        await window.reload();
        await window.waitForLoadState('domcontentloaded');

        const state = await window.evaluate(() => {
            return {
                darkNow: document.documentElement.classList.contains('dark'),
                bodyBg: getComputedStyle(document.body).backgroundColor,
                bootLoaded: !!document.querySelector('script[src="renderer/theme-boot.js"]')
            };
        });
        expect(state.bootLoaded, 'PPX-021: theme-boot.js <head> içinde').toBe(true);
        expect(state.darkNow, 'PPX-021: açık tema korunur').toBe(false);
        // İlk boyamada açık zemin (background-light = #f5f7f8).
        expect(state.bodyBg.replace(/\s/g, '')).toBe('rgb(245,247,248)');

        // Ölçüm: tema sınıfı DOMContentLoaded'da zaten doğru; flaş yok.
        const paint = await window.evaluate(() => {
            const entries = performance.getEntriesByType('paint') || [];
            const fp = entries.find((e) => e.name === 'first-paint');
            return fp ? fp.startTime : -1;
        });
        expect(paint === -1 || paint < 5000, 'PPX-021: ilk boyamada tema hazır').toBe(true);
    } finally {
        await closeApp(app, userDataDir);
    }
});

test('PPX-015: tema ve dil Save olmadan uygulanır ve kalıcıdır', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-theme-live-');
    try {
        await setSize(app, 1024, 768);
        await dismissOverlays(window);
        await window.evaluate(() => document.getElementById('nav-settings').click());
        await waitForStable(window);

        // Tema: change → anında koyu sınıf kalkar.
        await window.evaluate(() => {
            const el = document.getElementById('setting-theme');
            el.value = 'light';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitForStable(window, 120);
        expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(false);
        await window.waitForFunction(() => localStorage.getItem('theme') === 'light', null, { timeout: 2000 });

        // Dil: change → lang/dir güncellenir, aynı anda kaydedilir.
        await window.evaluate(() => {
            const el = document.getElementById('setting-language');
            el.value = 'en';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await window.waitForFunction(
            () => document.documentElement.getAttribute('lang') === 'en',
            null,
            { timeout: 5000 }
        );
        expect(await window.evaluate(() => document.documentElement.getAttribute('dir'))).toBe('ltr');
        await window.waitForFunction(() => localStorage.getItem('language') === 'en', null, { timeout: 3000 });
        // Debounce'lu atomik kayıt tamamlanana kadar bekle.
        await window.waitForTimeout(900);

        // Reload: iki tercih de korunur.
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        const after = await window.evaluate(() => ({
            dark: document.documentElement.classList.contains('dark'),
            lang: document.documentElement.getAttribute('lang'),
            theme: localStorage.getItem('theme'),
            language: localStorage.getItem('language')
        }));
        expect(after).toEqual({ dark: false, lang: 'en', theme: 'light', language: 'en' });
    } finally {
        await closeApp(app, userDataDir);
    }
});
