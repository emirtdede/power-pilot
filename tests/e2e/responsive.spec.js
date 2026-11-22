/**
 * responsive.spec.js - Premium UI / 100% responsive sözleşmesi
 *
 * Her görünüm, birden çok pencere boyutunda:
 *  - yatay taşma üretmez (scrollWidth <= clientWidth + 1),
 *  - birincil içerik görünür ve en az bir başlık okunur,
 *  - 900px altında sidebar çekmeceye dönüşür ve menü düğmesiyle açılır.
 * Ekran görüntüleri test-results/ui-*.png altına yazılır (inceleme kanıtı).
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const VIEWS = [
    'nav-dashboard', 'nav-active', 'nav-tasks', 'nav-smartfinish', 'nav-assistant',
    'nav-templates', 'nav-history', 'nav-stats', 'nav-integrations', 'nav-settings', 'nav-about'
];
const SIZES = [
    { w: 720, h: 520, name: 'xs' },
    { w: 900, h: 600, name: 'sm' },
    { w: 1119, h: 700, name: 'md' },
    { w: 1280, h: 800, name: 'lg' },
    { w: 1680, h: 1000, name: 'xl' }
];

async function open() {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-ui-'));
    const app = await electron.launch({
        args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
        env: {
            ...process.env,
            NODE_ENV: 'production',
            ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
            POWERPILOT_E2E: '1'
        }
    });
    const window = await app.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
    return { app, window, userDataDir };
}

async function setSize(app, w, h) {
    await app.evaluate(async ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setBounds({ x: 40, y: 40, width: size.w, height: size.h });
    }, { w, h });
    // Yerleşim yeniden akışı için bir kare bekle.
    await new Promise((r) => setTimeout(r, 220));
}

test('tüm görünümler her boyutta taşmasız ve okunabilir', async () => {
    test.setTimeout(240000);
    const { app, window, userDataDir } = await open();
    const problems = [];
    try {
        for (const size of SIZES) {
            await setSize(app, size.w, size.h);
            const os_ = path.join('test-results', `ui-${size.name}-dashboard.png`);
            fs.mkdirSync('test-results', { recursive: true });
            await window.screenshot({ path: os_ }).catch(() => {});

            for (const view of VIEWS) {
                await window.evaluate((id) => document.getElementById(id).click(), view);
                await window.waitForTimeout(90);

                const m = await window.evaluate(() => {
                    const doc = document.documentElement;
                    const body = document.body;
                    const main = document.getElementById('main-content');
                    const visible = document.querySelector('.view-section:not(.hidden)');
                    return {
                        docOverflow: doc.scrollWidth - doc.clientWidth,
                        bodyOverflow: body.scrollWidth - body.clientWidth,
                        mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
                        viewId: visible && visible.id,
                        viewText: (visible && visible.innerText || '').trim().length,
                        sidebarW: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().width),
                        sidebarX: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().x),
                        toggleVisible: getComputedStyle(document.getElementById('btn-nav-toggle')).display !== 'none'
                    };
                });

                if (m.docOverflow > 1 || m.bodyOverflow > 1 || m.mainOverflow > 1) {
                    problems.push(`${size.name}/${view}: overflow doc=${m.docOverflow} body=${m.bodyOverflow} main=${m.mainOverflow}`);
                }
                if (!m.viewId) problems.push(`${size.name}/${view}: hiçbir görünüm açık değil`);
                if (m.viewText < 20) problems.push(`${size.name}/${view}: içerik metni çok kısa (${m.viewText})`);

                const expectDrawer = size.w < 900;
                if (m.toggleVisible !== expectDrawer) {
                    problems.push(`${size.name}/${view}: menü düğmesi görünürlüğü ${m.toggleVisible} (beklenen ${expectDrawer})`);
                }
                if (expectDrawer && m.sidebarX > -40) {
                    problems.push(`${size.name}/${view}: drawer kapalıyken sidebar ekranda (x=${m.sidebarX})`);
                }
            }
        }
        expect(problems).toEqual([]);
    } finally {
        try { await app.close(); } catch (_) { /* yut */ }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* yut */ }
    }
});

test('dar pencerede çekmece açılır, gezinir ve kapanır', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await open();
    try {
        await setSize(app, 760, 560);
        const closed = await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            sidebarX: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().x)
        }));
        expect(closed.open).toBe(false);
        expect(closed.sidebarX).toBeLessThan(0);

        await window.locator('#btn-nav-toggle').click();
        await window.waitForTimeout(320);
        const opened = await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            expanded: document.getElementById('btn-nav-toggle').getAttribute('aria-expanded'),
            sidebarX: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().x),
            scrim: getComputedStyle(document.getElementById('nav-scrim')).pointerEvents
        }));
        expect(opened.open).toBe(true);
        expect(opened.expanded).toBe('true');
        expect(opened.sidebarX).toBe(0);
        expect(opened.scrim).toBe('auto');

        await window.locator('#nav-settings').click();
        await window.waitForTimeout(280);
        const afterNav = await window.evaluate(() => ({
            open: document.body.classList.contains('nav-open'),
            view: document.querySelector('.view-section:not(.hidden)')?.id,
            current: document.querySelector('#nav-settings')?.getAttribute('aria-current')
        }));
        expect(afterNav.open).toBe(false);
        expect(afterNav.view).toBe('view-settings');
        expect(afterNav.current).toBe('page');

        // Escape ile kapanma
        await window.locator('#btn-nav-toggle').click();
        await window.waitForTimeout(250);
        await window.keyboard.press('Escape');
        await window.waitForTimeout(250);
        expect(await window.evaluate(() => document.body.classList.contains('nav-open'))).toBe(false);

        await window.screenshot({ path: path.join('test-results', 'ui-drawer.png') }).catch(() => {});
    } finally {
        try { await app.close(); } catch (_) { /* yut */ }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* yut */ }
    }
});

test('geniş pencerede rail modu: etiket gizli, ipucu ve erişilebilir ad var', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await open();
    try {
        await setSize(app, 1040, 720);
        const rail = await window.evaluate(() => {
            const label = document.querySelector('#nav-settings .nav-label');
            const el = document.getElementById('nav-settings');
            return {
                sidebarW: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().width),
                labelDisplay: getComputedStyle(label).display,
                tip: el.getAttribute('data-tip'),
                aria: el.getAttribute('aria-label'),
                title: el.getAttribute('title')
            };
        });
        expect(rail.sidebarW).toBeLessThanOrEqual(80);
        expect(rail.labelDisplay).toBe('none');
        expect(rail.tip).toBeTruthy();
        expect(rail.aria).toBe(rail.tip);
        expect(rail.title).toBe(rail.tip);

        // Geniş pencerede etiketler yeniden görünür.
        await setSize(app, 1400, 860);
        const full = await window.evaluate(() => ({
            sidebarW: Math.round(document.getElementById('app-sidebar').getBoundingClientRect().width),
            labelDisplay: getComputedStyle(document.querySelector('#nav-settings .nav-label')).display
        }));
        expect(full.sidebarW).toBeGreaterThan(200);
        expect(full.labelDisplay).not.toBe('none');
    } finally {
        try { await app.close(); } catch (_) { /* yut */ }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* yut */ }
    }
});

test('Arapça (RTL) dar pencerede yön ve taşma doğru', async () => {
    test.setTimeout(180000);
    const { app, window, userDataDir } = await open();
    try {
        await window.evaluate(async () => {
            localStorage.setItem('language', 'ar');
            if (window.electronAPI?.saveSettings) await window.electronAPI.saveSettings({ language: 'ar' });
        });
        await window.reload();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));
        await setSize(app, 760, 560);

        const state = await window.evaluate(() => ({
            dir: document.documentElement.getAttribute('dir'),
            overflow: document.body.scrollWidth - document.body.clientWidth,
            toggleVisible: getComputedStyle(document.getElementById('btn-nav-toggle')).display !== 'none'
        }));
        expect(state.dir).toBe('rtl');
        expect(state.overflow).toBeLessThanOrEqual(1);
        expect(state.toggleVisible).toBe(true);

        // RTL'de çekmece sağ kenardan değil, mantıksal başlangıçtan (sağ) girer.
        await window.locator('#btn-nav-toggle').click();
        await window.waitForTimeout(340);
        const opened = await window.evaluate(() => {
            const r = document.getElementById('app-sidebar').getBoundingClientRect();
            return { open: document.body.classList.contains('nav-open'), right: Math.round(r.right), width: Math.round(window.innerWidth) };
        });
        expect(opened.open).toBe(true);
        expect(Math.abs(opened.right - opened.width)).toBeLessThanOrEqual(1);

        await window.screenshot({ path: path.join('test-results', 'ui-rtl.png') }).catch(() => {});
    } finally {
        try { await app.close(); } catch (_) { /* yut */ }
        try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* yut */ }
    }
});
