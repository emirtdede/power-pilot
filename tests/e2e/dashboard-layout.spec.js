/**
 * dashboard-layout.spec.js - birincil eylemin dar ekranda erişilebilirliği.
 *
 * Neden: `#view-dashboard` diğer tüm görünümlerin aksine `overflow-y-auto`
 * içermiyordu. 1366x768'de "Zamanlayıcıyı Başlat" ilk boyamada 7px, 1024x768'de
 * 163px kesiliyordu ve kaydırma çubuğu görünmüyordu - kullanıcı ana eylemi
 * göremiyordu. Ölçüm (önce): 1366x768 btnBottom=735 / winH=728.
 *
 * Kalıcı sözleşme: yaygın dizüstü boyutlarında birincil CTA **tam görünür**
 * ve kullanılabilir olmalı.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SIZES = [
    { width: 1366, height: 728, label: '1366x768' },
    { width: 1280, height: 680, label: '1280x720' },
    { width: 1024, height: 728, label: '1024x768' },
    { width: 1920, height: 1040, label: '1920x1080' }
];

test('dashboard birincil eylemi dar ekranda kesilmez ve erişilebilir', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-layout-'));
    let app = null;
    try {
        app = await electron.launch({
            args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
                POWERPILOT_E2E: '1'
            }
        });

        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');

        // Onboarding + sihirbaz kalıcı olarak kapalı (gerçek kullanıcı akışı).
        await page.evaluate(() => {
            try {
                localStorage.setItem('onboardingDone', '1');
                localStorage.setItem('pp-wizard-done', '1');
            } catch (_) { /* private mode */ }
        });
        await page.reload();
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2500);

        await expect(page.locator('#onboarding')).toBeHidden();

        for (const size of SIZES) {
            await page.setViewportSize({ width: size.width, height: size.height });
            await page.waitForTimeout(400);

            const metrics = await page.evaluate(() => {
                const view = document.getElementById('view-dashboard');
                const btn = document.getElementById('btn-start');
                const r = btn.getBoundingClientRect();
                return {
                    overflowY: getComputedStyle(view).overflowY,
                    scrollable: view.scrollHeight > view.clientHeight + 1,
                    btnTop: r.top,
                    btnBottom: r.bottom,
                    btnHeight: r.height,
                    winH: window.innerHeight
                };
            });

            // 1) Görünüm kaydırılabilir olmalı (içerik sığmıyorsa).
            expect(metrics.overflowY, `${size.label}: dashboard kaydırılabilir olmalı`).toBe('auto');

            // 2) Birincil CTA tam görünür olmalı (sticky sayesinde).
            expect(
                metrics.btnBottom,
                `${size.label}: CTA alt kenarı pencereyi aşmamalı (${metrics.btnBottom} > ${metrics.winH})`
            ).toBeLessThanOrEqual(metrics.winH + 0.5);
            expect(metrics.btnTop, `${size.label}: CTA üst kenarı negatif olmamalı`).toBeGreaterThanOrEqual(0);
            expect(metrics.btnHeight, `${size.label}: CTA yüksekliği makul olmalı`).toBeGreaterThan(30);

            // 3) Buton gerçekten tıklanabilir olmalı (üstte örten yok).
            await expect(page.locator('#btn-start')).toBeVisible();
        }
    } finally {
        if (app) await app.close().catch(() => {});
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});
