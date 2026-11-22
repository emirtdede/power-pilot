/**
 * mini-widget.spec.js - PPX-007 / PPX-014
 * TC-48, TC-49.
 *
 * Mini pencere: 3 düğme 24×24, görünür klavye halkası, i18n öncesi de
 * aria-label dolu; 160×48'e zorlandığında yatay taşma yok.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, closeApp } = require('./helpers/launch');
const { waitForStable } = require('./helpers/a11y');

async function waitForMini(app, timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const mini = app.windows().find((w) => /mini\.html/.test(w.url()));
        if (mini) return mini;
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
}

test('PPX-007/014: mini widget hedefleri, odak halkası ve taşma', async () => {
    test.setTimeout(240000);
    const { app, window, userDataDir } = await launchApp('powerpilot-mini-');
    try {
        await setSize(app, 1024, 768);

        // Aktif görev üret (mini pencere yalnız aktif görevde görünür).
        await window.evaluate(() => localStorage.setItem('pp-wizard-done', '1'));
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(
            () => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || '')
        );
        await window.waitForTimeout(700);
        if (await window.locator('#onboarding').isVisible().catch(() => false)) {
            await window.locator('[data-onboarding-choice="duration"]').click().catch(() => {});
            await window.locator('#onboarding-create').click().catch(() => {});
        }

        // Ana pencereyi küçült: mini widget görünür olur.
        await app.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((w) => !/mini\.html/.test(w.webContents.getURL()));
            if (win) win.minimize();
        });

        const mini = await waitForMini(app);
        expect(mini, 'PPX-007: mini pencere açıldı').not.toBeNull();
        await mini.waitForLoadState('domcontentloaded');
        await waitForStable(mini, 400);

        // TC-48: 3 düğme 24×24, aria-label dolu.
        const buttons = await mini.evaluate(() => [...document.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return {
                id: b.id,
                label: b.getAttribute('aria-label') || '',
                title: b.getAttribute('title') || '',
                w: Math.round(r.width),
                h: Math.round(r.height)
            };
        }));
        expect(buttons.map((b) => b.id)).toEqual(['btn-hide', 'btn-restore', 'btn-cancel']);
        for (const b of buttons) {
            expect(b.label.trim().length, `PPX-007: ${b.id} aria-label`).toBeGreaterThan(0);
            expect(b.h, `PPX-007: ${b.id} yüksekliği`).toBeGreaterThanOrEqual(24);
            expect(b.w, `PPX-007: ${b.id} genişliği`).toBeGreaterThanOrEqual(24);
        }

        // TC-48: klavye odağında görünür halka.
        await mini.evaluate(() => document.body.focus());
        const rings = [];
        for (let i = 0; i < 3; i += 1) {
            await mini.keyboard.press('Tab');
            rings.push(await mini.evaluate(() => {
                const el = document.activeElement;
                if (!el || el === document.body) return { id: '', outline: 'none', shadow: 'none' };
                const s = getComputedStyle(el);
                return { id: el.id, outline: s.outlineStyle + ' ' + s.outlineWidth, shadow: s.boxShadow };
            }));
        }
        for (const ring of rings) {
            expect(ring.id, 'PPX-007: odak mini düğmede').not.toBe('');
            const visible = ring.outline.includes('solid') || ring.shadow !== 'none';
            expect(visible, `PPX-007: ${ring.id} odak halkası görünür`).toBe(true);
        }

        // TC-49: 160×48'e zorla; yatay taşma yok, saat clamp ile okunur.
        await app.evaluate(({ BrowserWindow }) => {
            const w = BrowserWindow.getAllWindows().find((win) => /mini\.html/.test(win.webContents.getURL()));
            if (w) w.setBounds({ width: 160, height: 48 });
        });
        await waitForStable(mini, 350);
        const metrics = await mini.evaluate(() => {
            const doc = document.documentElement;
            const clock = document.getElementById('countdown-text');
            const s = clock ? getComputedStyle(clock) : null;
            return {
                scrollWidth: doc.scrollWidth,
                clientWidth: doc.clientWidth,
                fontSize: s ? parseFloat(s.fontSize) : 0,
                innerW: window.innerWidth
            };
        });
        expect(metrics.scrollWidth - metrics.clientWidth, 'PPX-014: yatay taşma').toBe(0);
        expect(metrics.fontSize, 'PPX-014: saat clamp ile ölçeklenir').toBeGreaterThanOrEqual(20);
        expect(metrics.innerW, 'PPX-014: pencere 160 px').toBeLessThanOrEqual(161);
    } finally {
        await closeApp(app, userDataDir);
    }
});
