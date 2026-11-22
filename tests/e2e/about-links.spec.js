/**
 * about-links.spec.js - Hakkında görünümü bağlantı sözleşmesi.
 *
 * Neden: Store Politikası 10.5.1 ve 11.16, gizlilik ve "uygunsuz içerik
 * bildirimi" için ÇALIŞAN bir kanal zorunlu kılar. Daha önce
 * `btn-report-content` ana sayfayı açıyordu (bildirim kanalı değil) ve
 * Hakkında görünümünde hiçbir destek girişi yoktu - kullanıcının sorun
 * bildirebileceği bir yol bulunmuyordu.
 *
 * Bu test üç şeyi kilitler:
 *   1. Düğmeler DOM'da ve görünür.
 *   2. Tıklama gerçekten `shell.openExternal` çağırıyor (ölü düğme yok).
 *   3. Her URL https + vellium.dev allowlist'inde ve çıplak ana sayfa değil.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Hakkında: destek ve bildirim düğmeleri allowlist URL açar', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-about-'));
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

        // Ana süreçte gerçek tarayıcı açılışını engelle, argümanı yakala.
        await app.evaluate(({ shell }) => {
            globalThis.__ppOpened = [];
            shell.openExternal = (url) => {
                globalThis.__ppOpened.push(url);
                return Promise.resolve();
            };
        });

        const window = await app.firstWindow();
        const pageErrors = [];
        window.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e)));
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(
            () => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || '')
        );

        // İlk çalıştırma katmanlarını kapat (mevcut E2E'lerle aynı desen).
        const wizard = window.locator('#wizard-overlay');
        if (await wizard.isVisible().catch(() => false)) {
            await window.locator('#btn-wz-skip').click();
            await expect(wizard).toBeHidden();
        }
        const onboarding = window.locator('#onboarding');
        if (await onboarding.isVisible().catch(() => false)) {
            await window.locator('#onboarding-skip').click().catch(async () => {
                await window.evaluate(() => {
                    localStorage.setItem('onboardingDone', '1');
                    document.getElementById('onboarding')?.classList.add('hidden');
                });
            });
            await expect(onboarding).toBeHidden();
        }

        await window.locator('#nav-about').click();
        await window.waitForTimeout(400);

        // --- 1) Düğmeler mevcut ve metinleri çevrilmiş -------------------
        await expect(window.locator('#btn-support')).toBeVisible();
        await expect(window.locator('#btn-report-content')).toBeVisible();
        await expect(window.locator('#btn-support [data-i18n="supportTitle"]')).not.toBeEmpty();

        // --- 2/3) Her düğme allowlist URL'i açar -------------------------
        const openAndAssert = async (selector) => {
            await app.evaluate(() => { globalThis.__ppOpened = []; });
            await window.locator(selector).click();
            await window.waitForTimeout(300);
            const opened = await app.evaluate(() => globalThis.__ppOpened || []);
            expect(opened.length, `${selector} hiç URL açmadı (ölü düğme)`).toBeGreaterThan(0);
            const url = opened[0];
            expect(url, `${selector} https değil: ${url}`).toMatch(/^https:\/\//);
            expect(url, `${selector} vellium.dev dışına çıkıyor: ${url}`).toMatch(
                /^https:\/\/([a-z0-9-]+\.)*vellium\.dev(\/|$)/
            );
            // Çıplak ana sayfa bir destek/bildirim kanalı değildir.
            expect(url.replace(/\/+$/, '')).not.toBe('https://vellium.dev');
            return url;
        };

        const supportUrl = await openAndAssert('#btn-support');
        const reportUrl = await openAndAssert('#btn-report-content');

        expect(supportUrl).toContain('/legal/support');
        expect(reportUrl).toContain('/contact');

        expect(pageErrors).toEqual([]);
    } finally {
        if (app) await app.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
    }
});
