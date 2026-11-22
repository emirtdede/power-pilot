/**
 * nav-keyboard.spec.js - PPX-001 / PPX-011 / PPX-012 /
 * PPX-004 (drawer) / PPX-017 (filtre) klavye sözleşmesi.
 * TC-01…TC-07, TC-13…TC-17, TC-53.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, dismissOverlays, closeApp } = require('./helpers/launch');
const { waitForStable } = require('./helpers/a11y');

const NAV = [
    'nav-dashboard', 'nav-active', 'nav-tasks', 'nav-smartfinish', 'nav-assistant',
    'nav-templates', 'nav-history', 'nav-stats', 'nav-integrations', 'nav-docs', 'nav-settings', 'nav-about'
];

test('PPX-001/011/012: nav klavyeyle erişilir, görünüm odağı ve başlığı güncellenir', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-nav-');
    try {
        await setSize(app, 1280, 800);
        await dismissOverlays(window);

        // 11 nav öğesi gerçek <button> ve görünür.
        const navInfo = await window.evaluate(() => [...document.querySelectorAll('.nav-btn')].map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.id, tag: el.tagName, h: r.height, visible: getComputedStyle(el).visibility };
        }));
        expect(navInfo.map((n) => n.id), 'PPX-001: 11 nav kimliği').toEqual(NAV);
        for (const n of navInfo) {
            expect(n.tag, `PPX-001: ${n.id} <button> olmalı`).toBe('BUTTON');
            expect(n.h, `PPX-001: ${n.id} yüksekliği`).toBeGreaterThan(0);
            expect(n.visible, `PPX-001: ${n.id} görünürlüğü`).toBe('visible');
        }

        // TC-01: Tab ile 11 nav durağının tamamı odaklanabilir.
        await window.evaluate(() => { document.activeElement?.blur?.(); document.body.setAttribute('tabindex', '-1'); document.body.focus(); });
        const seen = new Set();
        for (let i = 0; i < 45 && seen.size < NAV.length; i += 1) {
            await window.keyboard.press('Tab');
            const id = await window.evaluate(() => document.activeElement?.id || '');
            if (NAV.includes(id)) seen.add(id);
        }
        expect([...seen].sort(), 'PPX-001: Tab ile ulaşılan nav öğeleri').toEqual([...NAV].sort());

        // TC-02: Enter ve Space native button davranışıyla aktive eder.
        await window.evaluate(() => document.getElementById('nav-settings').focus());
        await window.keyboard.press('Enter');
        await waitForStable(window);
        expect(await window.evaluate(() => ({
            view: document.querySelector('.view-section:not(.hidden)')?.id,
            count: document.querySelectorAll('.view-section:not(.hidden)').length,
            current: document.querySelectorAll('[aria-current="page"]').length
        }))).toEqual({ view: 'view-settings', count: 1, current: 1 });

        await window.evaluate(() => document.getElementById('nav-tasks').focus());
        await window.keyboard.press('Space');
        await waitForStable(window);
        expect(await window.evaluate(() => document.querySelector('.view-section:not(.hidden)')?.id)).toBe('view-tasks');

        // TC-03: odak görünüme taşınır (tabindex -1).
        await window.evaluate(() => document.getElementById('nav-stats').focus());
        await window.keyboard.press('Enter');
        await waitForStable(window);
        const focused = await window.evaluate(() => ({
            id: document.activeElement?.id,
            tabindex: document.activeElement?.getAttribute('tabindex'),
            body: document.activeElement === document.body
        }));
        expect(focused.id, 'PPX-011: odak hedef görünümde').toBe('view-stats');
        expect(focused.tabindex).toBe('-1');
        expect(focused.body).toBe(false);

        // TC-04: her geçişte document.title güncellenir.
        const titles = [];
        for (const id of NAV) {
            await window.evaluate((navId) => document.getElementById(navId).click(), id);
            await waitForStable(window, 80);
            const title = await window.evaluate(() => document.title);
            expect(title, `PPX-011: ${id} başlığı`).toMatch(/ - Power Pilot$/);
            expect(title, `PPX-011: ${id} ham i18n anahtarı içermez`).not.toMatch(/^[a-zA-Z]+\.[a-zA-Z]+/);
            titles.push(title);
        }
        expect(new Set(titles).size, 'PPX-011: 11 farklı başlık').toBe(NAV.length);

        // TC-05: ok tuşları odak taşır, görünümü değiştirmez.
        await window.evaluate(() => document.getElementById('nav-dashboard').click());
        await waitForStable(window);
        await window.evaluate(() => document.getElementById('nav-dashboard').focus());
        const order = [];
        for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown']) {
            await window.keyboard.press(key);
            order.push(await window.evaluate(() => document.activeElement?.id));
        }
        await window.keyboard.press('Home');
        const home = await window.evaluate(() => document.activeElement?.id);
        await window.keyboard.press('End');
        const end = await window.evaluate(() => document.activeElement?.id);
        expect(order).toEqual(['nav-active', 'nav-tasks', 'nav-smartfinish']);
        expect(home).toBe('nav-dashboard');
        expect(end).toBe('nav-about');
        expect(await window.evaluate(() => document.querySelector('.view-section:not(.hidden)')?.id)).toBe('view-dashboard');

        // TC-06: dört landmark aktif dilde adlandırılmış.
        const landmarks = await window.evaluate(() => ({
            nav: document.querySelector('nav')?.getAttribute('aria-label'),
            main: document.querySelector('main')?.getAttribute('aria-label'),
            header: document.querySelector('header')?.getAttribute('aria-label'),
            footer: document.querySelector('footer')?.getAttribute('aria-label')
        }));
        for (const [name, value] of Object.entries(landmarks)) {
            expect(value, `PPX-012: ${name} aria-label`).toBeTruthy();
            expect(value, `PPX-012: ${name} ham anahtar değil`).not.toMatch(/^a11y[A-Z]/);
        }

        // TC-07: skip link DOM'da ilk öğe, görünür ve içeriğe odak taşır.
        expect(await window.evaluate(() => document.body.firstElementChild?.id), 'PPX-012: skip link ilk öğe').toBe('pp-skip');
        await window.evaluate(() => document.getElementById('pp-skip').focus());
        await waitForStable(window, 260);
        const skipBox = await window.evaluate(() => {
            const el = document.getElementById('pp-skip');
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return { opacity: s.opacity, h: r.height, w: r.width };
        });
        expect(Number(skipBox.opacity), 'PPX-012: skip link odakta görünür').toBeGreaterThan(0.9);
        expect(skipBox.h, 'PPX-012: skip link yüksekliği').toBeGreaterThanOrEqual(32);
        await window.keyboard.press('Enter');
        await waitForStable(window);
        expect(await window.evaluate(() => document.activeElement?.id), 'PPX-012: skip hedefi').toBe('main-content');

        // PPX-017: filtre düğmeleri aria-pressed taşır ve durum tek kaynaktan yazılır.
        await window.evaluate(() => document.getElementById('nav-tasks').click());
        await waitForStable(window);
        const filters = await window.evaluate(() => [...document.querySelectorAll('[data-task-filter]')].map((b) => ({
            key: b.getAttribute('data-task-filter'),
            pressed: b.getAttribute('aria-pressed')
        })));
        expect(filters).toEqual([{ key: 'active', pressed: 'true' }, { key: 'all', pressed: 'false' }]);
        await window.locator('[data-task-filter="all"]').click();
        await waitForStable(window);
        expect(await window.evaluate(() => [...document.querySelectorAll('[data-task-filter]')]
            .map((b) => b.getAttribute('aria-pressed')))).toEqual(['false', 'true']);
    } finally {
        await closeApp(app, userDataDir);
    }
});

test('PPX-004: çekmece odağı yönetir, Tab tuzağı ve Escape çalışır', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-drawer-');
    try {
        await setSize(app, 760, 560);
        await dismissOverlays(window);

        // TC-12: kapalı çekmece görünmez (visibility:hidden), ekranda değil.
        const closed = await window.evaluate(() => {
            const sb = document.getElementById('app-sidebar');
            const s = getComputedStyle(sb);
            const r = sb.getBoundingClientRect();
            return { visibility: s.visibility, x: Math.round(r.x) };
        });
        expect(closed.visibility, 'PPX-004: kapalı çekmece görünmez').toBe('hidden');
        expect(closed.x).toBeLessThan(0);

        // TC-13: açılışta odak ilk nav öğesi, arka plan inert.
        await window.locator('#btn-nav-toggle').click();
        await waitForStable(window, 320);
        expect(await window.evaluate(() => document.activeElement?.id), 'PPX-004: ilk odak').toBe('nav-dashboard');
        expect(await window.evaluate(() => document.getElementById('main-content').hasAttribute('inert')), 'PPX-004: main inert').toBe(true);

        // TC-14: 20 Tab sonrası odak hâlâ çekmecede.
        for (let i = 0; i < 20; i += 1) await window.keyboard.press('Tab');
        expect(await window.evaluate(() => !!document.activeElement?.closest('.app-sidebar')), 'PPX-004: Tab tuzağı').toBe(true);

        // TC-15: Escape kapatır, odağı toggle'a verir.
        await window.keyboard.press('Escape');
        await waitForStable(window, 120);
        expect(await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            inert: document.getElementById('main-content').hasAttribute('inert'),
            focus: document.activeElement?.id
        })), 'PPX-004: Escape').toEqual({ open: false, inert: false, focus: 'btn-nav-toggle' });

        // TC-16: Scrim tıklaması çekmeceyi kapatır, main.inert temizlenir, odak toggle'a döner.
        await window.locator('#btn-nav-toggle').click();
        await waitForStable(window, 320);
        await window.evaluate(() => document.getElementById('nav-scrim').click());
        await waitForStable(window, 120);
        expect(await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            inert: document.getElementById('main-content').hasAttribute('inert'),
            focus: document.activeElement?.id
        })), 'PPX-004: Scrim').toEqual({ open: false, inert: false, focus: 'btn-nav-toggle' });

        // TC-15b: nav öğesiyle kapanışta odak toggle değil görünüm olur.
        await window.locator('#btn-nav-toggle').click();
        await waitForStable(window, 320);
        await window.locator('#nav-settings').click();
        await waitForStable(window);
        expect(await window.evaluate(() => ({
            view: document.querySelector('.view-section:not(.hidden)')?.id,
            open: document.body.classList.contains('nav-open'),
            focus: document.activeElement?.id
        })), 'PPX-004: nav ile kapanış').toEqual({ view: 'view-settings', open: false, focus: 'view-settings' });

        // TC-17: genişlik ≥900 olunca inert ve nav-open temizlenir.
        await window.locator('#btn-nav-toggle').click();
        await waitForStable(window, 320);
        await setSize(app, 1000, 700);
        await waitForStable(window, 260);
        expect(await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            inert: document.getElementById('main-content').hasAttribute('inert'),
            visibility: getComputedStyle(document.getElementById('app-sidebar')).visibility
        })), 'PPX-004: resize temizliği').toEqual({ open: false, inert: false, visibility: 'visible' });
    } finally {
        await closeApp(app, userDataDir);
    }
});
