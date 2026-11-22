/**
 * overlay-geometry.spec.js - PPX-003 / PPX-006 / PPX-013 / PPX-020
 * TC-19…TC-22, TC-37 ve 22×11 boyut matrisi.
 *
 * Hiçbir pencerede yatay taşma yok; banner/toast/H2/filtre/sticky CTA
 * birbirini örtmez. Alt sınır isteği 720×520'ye kenetlenir.
 */
const { test, expect } = require('@playwright/test');
const { launchApp, setSize, closeApp } = require('./helpers/launch');
const { waitForStable, rectOverlap } = require('./helpers/a11y');

const SIZES = [
    [640, 480], [720, 520], [768, 1024], [800, 600], [899, 600], [900, 600],
    [1000, 1000], [1024, 600], [1024, 768], [1024, 1366], [1119, 700],
    [1120, 700], [1150, 720], [1200, 500], [1280, 720], [1280, 800],
    [1366, 768], [1440, 900], [1600, 900], [1920, 1080], [2560, 1440], [3440, 1440]
];

const VIEWS = [
    'nav-dashboard', 'nav-active', 'nav-tasks', 'nav-smartfinish', 'nav-assistant',
    'nav-templates', 'nav-history', 'nav-stats', 'nav-integrations', 'nav-docs', 'nav-settings', 'nav-about'
];

test('TC-19/22/37: 22 boyut × 11 görünüm - yatay taşma yok', async () => {
    test.setTimeout(900000);
    const { app, window, userDataDir } = await launchApp('powerpilot-geometry-');
    try {
        await window.evaluate(() => {
            document.getElementById('wizard-overlay')?.classList.add('hidden');
            localStorage.setItem('pp-wizard-skipped', '1');
            document.getElementById('onboarding')?.classList.add('hidden');
        });

        // TC-37: 640×480 isteği 720×520'ye kenetlenir.
        const clamped = await app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            win.setBounds({ x: 40, y: 40, width: 640, height: 480 });
            const b = win.getBounds();
            return { width: b.width, height: b.height };
        });
        expect(clamped, 'PPX-013: alt sınır 720×520').toEqual({ width: 720, height: 520 });

        const failures = [];
        for (const [width, height] of SIZES) {
            await setSize(app, width, height);
            const actual = await app.evaluate(({ BrowserWindow }) => {
                const b = BrowserWindow.getAllWindows()[0].getBounds();
                return { width: b.width, height: b.height };
            });
            for (const navId of VIEWS) {
                await window.evaluate((id) => document.getElementById(id).click(), navId);
                await waitForStable(window, 60);
                const m = await window.evaluate(() => {
                    const doc = document.documentElement;
                    const body = document.body;
                    const main = document.getElementById('main-content');
                    const view = document.querySelector('.view-section:not(.hidden)');
                    const overflow = (el) => (el ? el.scrollWidth - el.clientWidth : 0);
                    return {
                        view: view ? view.id : '',
                        doc: overflow(doc),
                        body: overflow(body),
                        main: overflow(main),
                        section: overflow(view)
                    };
                });
                if (m.doc > 1 || m.body > 1 || m.main > 1 || m.section > 1 || !m.view) {
                    failures.push({ size: `${actual.width}x${actual.height}`, navId, ...m });
                }
            }
        }
        expect(failures, `TC-22: yatay taşma\n${JSON.stringify(failures, null, 2)}`).toEqual([]);
    } finally {
        await closeApp(app, userDataDir);
    }
});

test('TC-20/21: banner ve toast hiçbir kontrolü örtmez', async () => {
    test.setTimeout(240000);
    const { app, window, userDataDir } = await launchApp('powerpilot-overlay-');
    try {
        await window.evaluate(() => {
            document.getElementById('wizard-overlay')?.classList.add('hidden');
            localStorage.setItem('pp-wizard-skipped', '1');
            document.getElementById('onboarding')?.classList.add('hidden');
        });

        for (const [width, height] of [[720, 520], [1366, 768]]) {
            await setSize(app, width, height);
            await window.evaluate(() => {
                const banner = document.getElementById('warning-banner');
                if (banner) {
                    banner.classList.remove('hidden');
                    const text = banner.querySelector('[data-i18n], p, span');
                    if (text) text.textContent = 'Test uyarısı: oturum kapanmak üzere.';
                }
                document.getElementById('nav-dashboard').click();
                if (typeof showToast === 'function') showToast('Test bildirimi', 'info');
            });
            await waitForStable(window, 400);

            const geo = await window.evaluate(() => {
                const rect = (sel) => {
                    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return null;
                    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
                };
                const banner = rect('#warning-banner');
                const toast = rect('#toast-container > *');
                const h2 = rect('#view-dashboard h2');
                const cta = rect('#btn-start');
                const filters = rect('#view-tasks [data-task-filter]');
                const view = rect('#view-dashboard');
                const toastContainer = rect('#toast-container');
                return { banner, toast, h2, cta, filters, view, toastContainer };
            });

            const report = [];
            if (geo.banner) {
                for (const key of ['toast', 'h2', 'cta']) {
                    if (geo[key] && rectOverlap(geo.banner, geo[key]) > 0) report.push(`banner×${key}`);
                }
                if (geo.view && geo.view.top + 1 < geo.banner.bottom) report.push('view banner altında başlamıyor');
            }
            if (geo.toast) {
                if (geo.toast.width > 320 + 1) report.push('toast > 320 px');
                if (geo.filters && rectOverlap(geo.toast, geo.filters) > 0) report.push('toast×filtre');
                if (geo.h2 && rectOverlap(geo.toast, geo.h2) > 0) report.push('toast×h2');
                if (geo.cta && rectOverlap(geo.toast, geo.cta) > 0) report.push('toast×CTA');
            }
            expect(report, `TC-20/21: ${width}x${height} örtüşme`).toEqual([]);

            await window.evaluate(() => {
                document.getElementById('warning-banner')?.classList.add('hidden');
                document.querySelectorAll('#toast-container > *').forEach((t) => t.remove());
            });
        }

        // TC-18/19: --pp-cta-h ölçülür ve #view-dashboard scrollTop=0'da
        // #input-days/hours/mins ve 6 stepper %5'ten fazla örtülmez.
        for (const [w, h] of [[720, 520], [1024, 600], [1024, 768], [1280, 800], [1366, 768]]) {
            await setSize(app, w, h);
            await window.evaluate(() => {
                document.getElementById('nav-dashboard').click();
                const v = document.getElementById('view-dashboard');
                if (v) v.scrollTop = 0;
            });
            await waitForStable(window, 180);
            const ctaCheck = await window.evaluate(() => {
                const ctaVar = getComputedStyle(document.documentElement).getPropertyValue('--pp-cta-h').trim();
                const bar = document.getElementById('dashboard-cta')?.getBoundingClientRect();
                const targets = [
                    ...['input-days', 'input-hours', 'input-mins'].map((id) => document.getElementById(id)),
                    ...document.querySelectorAll('[data-pp-step]')
                ].filter(Boolean);
                const covered = [];
                for (const el of targets) {
                    const r = el.getBoundingClientRect();
                    const area = r.width * r.height;
                    if (!bar || area <= 0) continue;
                    const ox = Math.max(0, Math.min(r.right, bar.right) - Math.max(r.left, bar.left));
                    const oy = Math.max(0, Math.min(r.bottom, bar.bottom) - Math.max(r.top, bar.top));
                    const ratio = (ox * oy) / area;
                    if (ratio > 0.05) covered.push({ id: el.id || el.getAttribute('data-pp-step'), ratio: Number(ratio.toFixed(2)) });
                }
                return { ctaVar, covered };
            });
            expect(ctaCheck.ctaVar, `TC-18: ${w}x${h} --pp-cta-h`).not.toBe('0px');
            expect(ctaCheck.covered, `TC-19: ${w}x${h} sticky CTA örtüşmesi`).toEqual([]);
        }

        // TC-23/24/25: MAX_TOASTS=2, kapatma düğmesi 24x24, region aria-label.
        const toastMeta = await window.evaluate(() => {
            const c = document.getElementById('toast-container');
            for (let i = 0; i < 5; i += 1) {
                if (typeof showToast === 'function') showToast(`Toast ${i}`, 'info');
            }
            const btn = c?.querySelector('button');
            const r = btn ? btn.getBoundingClientRect() : null;
            return {
                role: c?.getAttribute('role'),
                label: c?.getAttribute('aria-label') || '',
                count: c ? c.children.length : 0,
                btnW: r ? Math.round(r.width) : 0,
                btnH: r ? Math.round(r.height) : 0,
                btnLabel: btn?.getAttribute('aria-label') || ''
            };
        });
        expect(toastMeta.role, 'TC-25: toast container role').toBe('region');
        expect(toastMeta.label.length, 'TC-25: toast container aria-label').toBeGreaterThan(0);
        expect(toastMeta.count, 'TC-23: MAX_TOASTS = 2').toBeLessThanOrEqual(2);
        expect(toastMeta.btnW, 'TC-24: toast kapatma genişlik >= 24').toBeGreaterThanOrEqual(24);
        expect(toastMeta.btnH, 'TC-24: toast kapatma yükseklik >= 24').toBeGreaterThanOrEqual(24);
        expect(toastMeta.btnLabel.length, 'TC-24: toast kapatma aria-label').toBeGreaterThan(0);
        await window.evaluate(() => {
            document.querySelectorAll('#toast-container > *').forEach((t) => t.remove());
        });

        // TC-40: 720x520'de #api-ips genişliği >= 260 px.
        await setSize(app, 720, 520);
        await window.evaluate(() => document.getElementById('nav-integrations').click());
        await waitForStable(window, 150);
        const ipsInfo = await window.evaluate(() => {
            const el = document.getElementById('api-ips');
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), sw: el.scrollWidth, cw: el.clientWidth };
        });
        expect(ipsInfo.w, 'TC-40: #api-ips genişlik >= 260 px').toBeGreaterThanOrEqual(260);
        expect(ipsInfo.sw - ipsInfo.cw, 'TC-40: #api-ips kırpma yok').toBeLessThanOrEqual(1);
    } finally {
        await closeApp(app, userDataDir);
    }
});
