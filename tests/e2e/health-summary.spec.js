/**
 * health-summary.spec.js - C5 yerel sağlık özeti (E2E)
 *
 * Ürün "telemetri yok, her şey cihazda" diyor. Bu test Hakkında
 * ekranındaki özetin gerçekten dolduğunu, ham kod sızdırmadığını ve
 * "veri yok" durumunda çökmediğini doğrular.
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

test('C5: sağlık özeti cihazda hesaplanır, ham kod sızdırmaz', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpilot-health-'));
    let app = null;
    try {
        app = await launch(userDataDir);
        const window = await app.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        await window.waitForFunction(() => /^v\d+\.\d+\.\d+/.test(document.getElementById('app-version')?.innerText || ''));

        // IPC sözleşmesi: yalnızca özet alanları, ham sonuç kodu yok.
        const summary = await window.evaluate(() => window.electronAPI.getHealthSummary());
        expect(summary).toBeTruthy();
        expect(summary).toHaveProperty('successRatePercent');
        expect(summary).toHaveProperty('daysInstalled');
        expect(JSON.stringify(summary)).not.toMatch(/os_execution_failed|blocked_by_policy/);

        // Hakkında görünümü açılınca kart dolar.
        await window.locator('#nav-about').click();
        await window.waitForTimeout(400);
        await expect(window.locator('#health-success-rate')).toBeVisible();
        await expect(window.locator('#health-runs')).toBeVisible();
        await expect(window.locator('#health-days')).toBeVisible();

        const rateText = (await window.locator('#health-success-rate').innerText()).trim();
        expect(rateText.length).toBeGreaterThan(0);
        // Ham anahtar sızıntısı yok.
        expect(rateText).not.toMatch(/health[A-Z]/);
        const noteText = await window.locator('#health-note').innerText();
        expect(noteText.trim().length).toBeGreaterThan(0);
        expect(noteText).not.toContain('healthNoTelemetry');
    } finally {
        if (app) { try { await app.close(); } catch (_) { /* zaten kapalı */ } }
        cleanup(userDataDir);
    }
});
