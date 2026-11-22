/**
 * settings-controls.spec.js - PPX-002 / PPX-010 / PPX-015 / PPX-026
 * TC-08…TC-11, TC-30.
 *
 * Üç switch (onay kutusu) klavyeyle odaklanabilir ve görünür halka üretir;
 * üç <select> görünür başlık + açıklama ile adlandırılmıştır.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, dismissOverlays, closeApp } = require('./helpers/launch');
const { waitForStable, contrast } = require('./helpers/a11y');

const SWITCHES = ['setting-notifications', 'setting-autostart', 'setting-voice'];
const SELECTS = ['setting-sound-mode', 'setting-theme', 'setting-language'];

test('PPX-002/010/026: switch odak halkası ve select etiketleri', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-settings-');
    try {
        await setSize(app, 1024, 768);
        await dismissOverlays(window);
        await window.evaluate(() => document.getElementById('nav-settings').click());
        await waitForStable(window);

        // TC-08/09: üç switch 24×24 hedef ve klavye odağı.
        for (const id of SWITCHES) {
            const info = await window.evaluate((switchId) => {
                const input = document.getElementById(switchId);
                if (!input) return null;
                input.focus();
                const label = input.closest('label');
                const r = (label || input).getBoundingClientRect();
                const knob = label ? label.querySelector('div > div, .rounded-full') : null;
                const s = knob ? getComputedStyle(knob) : null;
                return {
                    focused: document.activeElement === input,
                    w: r.width,
                    h: r.height,
                    shadow: s ? s.boxShadow : ''
                };
            }, id);
            expect(info, `PPX-002: ${id} DOM'da`).not.toBeNull();
            expect(info.focused, `PPX-002: ${id} odaklanabilir`).toBe(true);
            expect(info.h, `PPX-002: ${id} hedef yüksekliği`).toBeGreaterThanOrEqual(24);
            expect(info.w, `PPX-002: ${id} hedef genişliği`).toBeGreaterThanOrEqual(24);
            // :focus-visible programatik odakta da halka üretmeli.
            expect(info.shadow, `PPX-002: ${id} odak halkası`).not.toBe('none');
        }

        // TC-10: switch'ler alt sayfalarda Tab sırasına girer.
        const reached = new Set();
        await window.evaluate(() => {
            const btn = document.querySelector('[data-scroll-target="settings-sec-general"]');
            if (btn) btn.click();
            const lastPreset = document.querySelector('[data-settings-preset="eco"]');
            if (lastPreset) lastPreset.focus();
        });
        for (let i = 0; i < 30 && reached.size < SWITCHES.length; i += 1) {
            await window.keyboard.press('Tab');
            const id = await window.evaluate(() => document.activeElement?.id || '');
            if (SWITCHES.includes(id)) reached.add(id);
        }
        expect([...reached].sort()).toEqual([...SWITCHES].sort());

        // TC-30: üç select görünür başlık ve açıklama ile adlandırılmış.
        for (const id of SELECTS) {
            const label = await window.evaluate((selectId) => {
                const el = document.getElementById(selectId);
                if (!el) return null;
                el.focus();
                const by = el.getAttribute('aria-labelledby');
                const desc = el.getAttribute('aria-describedby');
                const labelEl = by ? document.getElementById(by) : null;
                const descEl = desc ? document.getElementById(desc) : null;
                return {
                    labelText: labelEl ? labelEl.textContent.trim() : '',
                    labelHidden: labelEl ? getComputedStyle(labelEl).display === 'none' : true,
                    descText: descEl ? descEl.textContent.trim() : ''
                };
            }, id);
            expect(label, `PPX-010: ${id} DOM'da`).not.toBeNull();
            expect(label.labelText.length, `PPX-010: ${id} başlık metni`).toBeGreaterThan(0);
            expect(label.labelText, `PPX-010: ${id} çözülmemiş anahtar`).not.toMatch(/^(setting|desc)[A-Z]/);
            expect(label.labelHidden, `PPX-010: ${id} başlık görünür`).toBe(false);
            expect(label.descText.length, `PPX-010: ${id} açıklama metni`).toBeGreaterThan(0);
        }

        // PPX-002: odaklı switch tamamen örtülmüş değil (2.4.11).
        const covered = await window.evaluate(() => {
            const input = document.getElementById('setting-theme');
            input.focus();
            const r = input.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !!top && (top === input || input.contains(top) || top.contains(input));
        });
        expect(covered, 'PPX-002: odaklı switch erişilebilir').toBe(true);

        // TC-10: Space ile switch durumu değişir.
        await window.evaluate(() => document.getElementById('setting-voice').focus());
        const beforeChecked = await window.evaluate(() => document.getElementById('setting-voice').checked);
        await window.keyboard.press('Space');
        expect(await window.evaluate(() => document.getElementById('setting-voice').checked)).toBe(!beforeChecked);
        await window.keyboard.press('Space');
        expect(await window.evaluate(() => document.getElementById('setting-voice').checked)).toBe(beforeChecked);

        // TC-26/27/28: canlı DOM kontrast kontrolü (#btn-cancel, .pp-sep, #stat-kwh).
        await window.evaluate(() => {
            const el = document.getElementById('setting-theme');
            el.value = 'light';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitForStable(window, 120);
        const lightColors = await window.evaluate(() => {
            const cancel = document.getElementById('btn-cancel');
            const sep = document.querySelector('#view-dashboard .pp-sep');
            const kwh = document.getElementById('stat-kwh');
            return {
                cancelFg: getComputedStyle(cancel).color,
                cancelBg: getComputedStyle(cancel).backgroundColor,
                sepFg: getComputedStyle(sep).color,
                kwhFg: getComputedStyle(kwh).color
            };
        });
        expect(contrast(lightColors.cancelFg, lightColors.cancelBg), 'PPX-005: #btn-cancel >= 4.5').toBeGreaterThanOrEqual(4.5);
        expect(contrast(lightColors.sepFg, '#ffffff'), 'PPX-010: .pp-sep >= 3.0').toBeGreaterThanOrEqual(3.0);
        expect(contrast(lightColors.kwhFg, '#ffffff'), 'PPX-010: #stat-kwh açık tema >= 4.5').toBeGreaterThanOrEqual(4.5);
    } finally {
        await closeApp(app, userDataDir);
    }
});
