/**
 * a11y.spec.js - C4 erişilebilirlik kapısı (E2E)
 *
 * Kilitleyen gerçek hata: süre seçicideki 6 ikon-only artır/azalt düğmesinin
 * erişilebilir adı yoktu; ekran okuyucu "düğme" diyordu (WCAG 4.1.2).
 * Bu test tüm görünür düğmelerin adı olduğunu ve adların aktif dilde
 * çevrildiğini doğrular.
 */
const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launch = (userDataDir) => electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    env: {
        ...process.env,
        NODE_ENV: 'production',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        POWERPILOT_E2E: '1'
    }
});

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (_) { /* Windows kilidi: geçici dizin */ }
}

test('C4: her düğmenin erişilebilir adı var ve süre adımlayıcıları bağlam taşıyor', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-a11y-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

        // Uygulama yüklendiğinde i18n kapısı açılmalı.
        await window.waitForFunction(() => !document.documentElement.classList.contains('i18n-pending'));

        const unnamed = await window.evaluate(() => {
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
            };
            const out = [];
            document.querySelectorAll('button').forEach((b) => {
                if (!visible(b)) return;
                const name = (b.getAttribute('aria-label') || b.innerText || b.textContent || '')
                    .replace(/\s+/g, ' ').trim();
                const imgAlt = b.querySelector('img[alt]:not([alt=""])');
                if (!name && !imgAlt) out.push(b.id || b.outerHTML.slice(0, 120));
            });
            return out;
        });
        expect(unnamed, `adsız düğmeler: ${unnamed.join(' | ')}`).toEqual([]);

        // Süre adımlayıcıları çevrilmiş bağlam taşır ("Gün: Değeri artır" gibi).
        const stepperLabels = await window.evaluate(() =>
            [...document.querySelectorAll('[data-pp-step]')].map((b) => b.getAttribute('aria-label') || '')
        );
        expect(stepperLabels.length).toBe(6);
        for (const label of stepperLabels) {
            expect(label.length).toBeGreaterThan(0);
            // Ham anahtar sızıntısı yok.
            expect(label).not.toMatch(/a11yIncrease|a11yDecrease|data-i18n/);
        }
        // Bağlam gerçekten eklenmiş ("X: Y" biçimi).
        expect(stepperLabels.filter((l) => l.includes(':')).length).toBe(6);
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});
