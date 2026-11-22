/**
 * target-size.spec.js - PPX-005 / PPX-032 / PPX-033 / PPX-036
 * TC-31…TC-33 (TC-48 mini-widget.spec.js'te).
 *
 * Hiçbir onay kutusu/radyo hedefi 24×24'ün altında değil; istatistik çipleri
 * ≥32 px; metin içi bağlantılar ≥24 px.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, closeApp } = require('./helpers/launch');
const { waitForStable } = require('./helpers/a11y');

const VIEWS = [
    'nav-dashboard', 'nav-active', 'nav-tasks', 'nav-smartfinish', 'nav-assistant',
    'nav-templates', 'nav-history', 'nav-stats', 'nav-integrations', 'nav-settings', 'nav-about'
];

test('PPX-032/033/036: dokunma hedefleri ≥24 px (chip ≥32 px)', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await launchApp('powerpilot-target-');
    try {
        await setSize(app, 1280, 800);
        await window.evaluate(() => {
            // Rehber/sihirbaz katmanları ölçümü kapatmasın (görünürlük korunur).
            document.getElementById('wizard-overlay')?.classList.add('hidden');
            localStorage.setItem('pp-wizard-skipped', '1');
            document.getElementById('onboarding')?.classList.add('hidden');
        });
        await waitForStable(window);

        const offenders = [];
        for (const navId of VIEWS) {
            await window.evaluate((id) => document.getElementById(id).click(), navId);
            await waitForStable(window, 120);
            const bad = await window.evaluate(() => {
                const view = document.querySelector('.view-section:not(.hidden)');
                if (!view) return [];
                const out = [];
                view.querySelectorAll('label').forEach((label) => {
                    const input = label.querySelector('input[type="checkbox"], input[type="radio"]');
                    if (!input) return;
                    const r = label.getBoundingClientRect();
                    const w = Math.round(r.width);
                    const h = Math.round(r.height);
                    if (w === 0 && h === 0) return;
                    if (h < 24 || w < 24) {
                        out.push({
                            view: view.id,
                            text: (label.innerText || '').trim().slice(0, 40),
                            w,
                            h
                        });
                    }
                });
                return out;
            });
            offenders.push(...bad);
        }
        expect(offenders, `PPX-032: 24 px altı hedefler\n${JSON.stringify(offenders, null, 2)}`).toEqual([]);

        // TC-32: istatistik çipleri ≥32 px yüksekliğinde ve ≥120 px genişliğinde.
        await window.evaluate(() => document.getElementById('nav-stats').click());
        await waitForStable(window, 120);
        const chips = await window.evaluate(() => ['chip-watt', 'chip-price'].map((id) => {
            const el = document.getElementById(id);
            if (!el) return { id, missing: true };
            el.classList.remove('hidden');
            const r = el.getBoundingClientRect();
            return { id, w: Math.round(r.width), h: Math.round(r.height) };
        }));
        for (const chip of chips) {
            expect(chip.missing, `PPX-033: ${chip.id} DOM'da`).toBeFalsy();
            expect(chip.h, `PPX-033: ${chip.id} yüksekliği`).toBeGreaterThanOrEqual(32);
            expect(chip.w, `PPX-033: ${chip.id} genişliği`).toBeGreaterThanOrEqual(120);
        }

        // TC-33: metin içi bağlantılar ve rehber atlama düğmesi ≥24 px.
        await window.evaluate(() => document.getElementById('nav-about').click());
        await waitForStable(window, 120);
        const link = await window.evaluate(() => {
            const a = [...document.querySelectorAll('#view-about a')]
                .find((el) => /vellium\.dev/i.test(el.textContent || ''));
            if (!a) return null;
            const r = a.getBoundingClientRect();
            return { h: Math.round(r.height) };
        });
        expect(link, 'PPX-036: vellium.dev bağlantısı').not.toBeNull();
        expect(link.h, 'PPX-036: bağlantı yüksekliği').toBeGreaterThanOrEqual(24);

        const skip = await window.evaluate(() => {
            const onboarding = document.getElementById('onboarding');
            onboarding?.classList.remove('hidden');
            const el = document.getElementById('onboarding-skip');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            onboarding?.classList.add('hidden');
            return { h: Math.round(r.height) };
        });
        expect(skip, 'PPX-036: onboarding-skip').not.toBeNull();
        expect(skip.h, 'PPX-036: onboarding-skip yüksekliği').toBeGreaterThanOrEqual(24);
    } finally {
        await closeApp(app, userDataDir);
    }
});
