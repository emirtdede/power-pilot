const { test, expect } = require('@playwright/test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SETUP_HTML_URL = pathToFileURL(path.resolve(__dirname, '../../installer/ui/index.html')).href;

async function openSetupUi(page, initEvent) {
    await page.setViewportSize({ width: 712, height: 496 });
    await page.addInitScript(() => {
        window.__CAPTURED_IPC__ = [];
        window.PP_SETUP_BRIDGE = {
            postMessage(raw) {
                window.__CAPTURED_IPC__.push(JSON.parse(raw));
            }
        };
    });
    await page.goto(SETUP_HTML_URL);
    await page.waitForFunction(() => Boolean(window.__PP_SETUP__));
    await page.evaluate((ev) => window.__PP_SETUP__.receive(ev), {
        type: 'init',
        appName: 'Power Pilot',
        version: '1.0.0',
        installedVersion: null,
        mode: 'install',
        lang: 'tr',
        installDir: 'C:\\Users\\Test\\AppData\\Local\\Programs\\Power Pilot',
        userDataDir: 'C:\\Users\\Test\\AppData\\Roaming\\powerpilot',
        requiredMb: 248,
        desktopShortcut: true,
        startMenuShortcut: true,
        runAtStartup: false,
        addToPath: true,
        ...initEvent
    });
}

test.describe('Modern Frameless 640x420 Monochrome Setup & Uninstaller E2E', () => {
    test('welcome -> options sheet -> 73 dil + RTL gecisi -> progress ShimmerBar -> done CheckBurst', async ({ page }) => {
        await openSetupUi(page, { lang: 'tr' });

        // 1. Exact 640x420 frameless card & 42px titlebar with ONLY minimize + close
        const cardBox = await page.locator('#setup-card').boundingBox();
        expect(Math.round(cardBox.width)).toBe(640);
        expect(Math.round(cardBox.height)).toBe(420);

        const barBox = await page.locator('#titlebar').boundingBox();
        expect(Math.round(barBox.height)).toBe(42);
        await expect(page.locator('#titlebar-controls button, .titlebar-controls button')).toHaveCount(2);
        await expect(page.locator('#titlebar-title')).toHaveText('Power Pilot Kurulumu');
        await expect(page.locator('#welcome-version-pill')).toHaveText('v1.0.0');
        await expect(page.locator('#btn-welcome-install')).toHaveText('Kur');

        // 2. Open Options Sheet (slides up to top: 42px)
        await page.click('#btn-open-options');
        await expect(page.locator('#options-sheet')).toHaveClass(/is-open/);
        await expect(page.locator('#opt-language option')).toHaveCount(73);

        // 3. Live language switch including Arabic RTL -> English -> Turkish
        await page.selectOption('#opt-language', 'ar');
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.locator('#titlebar-title')).toHaveText('تثبيت Power Pilot');
        await expect(page.locator('#btn-sheet-install')).toHaveText('تثبيت');

        await page.selectOption('#opt-language', 'de');
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        await expect(page.locator('#titlebar-title')).toHaveText('Power Pilot Einrichtung');

        await page.selectOption('#opt-language', 'tr');
        await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
        await expect(page.locator('#titlebar-title')).toHaveText('Power Pilot Kurulumu');

        // 4. Folder picker IPC + checkbox toggles
        await page.click('#btn-browse-dir');
        await page.evaluate(() => window.__PP_SETUP__.receive({
            type: 'folderSelected',
            path: 'D:\\Apps\\Power Pilot'
        }));
        await expect(page.locator('#opt-install-dir')).toHaveValue('D:\\Apps\\Power Pilot');

        await page.locator('label[for="opt-startup"]').click();
        await expect(page.locator('#opt-startup')).toBeChecked();
        await expect(page.locator('#opt-desktop')).toBeChecked();
        await expect(page.locator('#opt-startmenu')).toBeChecked();
        await expect(page.locator('#opt-path')).toBeChecked();

        // 5. Start install -> Progress screen + ShimmerBar -> Done + CheckBurst
        await page.click('#btn-sheet-install');
        await expect(page.locator('#options-sheet')).not.toHaveClass(/is-open/);
        await expect(page.locator('#screen-progress')).toHaveClass(/is-active/);

        const installMsg = await page.evaluate(() => window.__CAPTURED_IPC__.find((m) => m.action === 'install'));
        expect(installMsg).toMatchObject({
            action: 'install',
            installDir: 'D:\\Apps\\Power Pilot',
            lang: 'tr',
            desktopShortcut: true,
            startMenuShortcut: true,
            runAtStartup: true,
            addToPath: true
        });

        await page.evaluate(() => window.__PP_SETUP__.receive({ type: 'progress', percent: 62, stepKey: 'stepExtract' }));
        await expect(page.locator('#progress-percent')).toHaveText('62%');
        await expect(page.locator('#progress-step')).toHaveText('Uygulama dosyaları çıkarılıyor...');

        await page.evaluate(() => window.__PP_SETUP__.receive({ type: 'done' }));
        await expect(page.locator('#screen-done')).toHaveClass(/is-active/);
        await expect(page.locator('#done-title')).toHaveText('Power Pilot hazır');
        await expect(page.locator('#done-check-burst')).toHaveClass(/play/);

        await page.click('#btn-done-launch');
        const launchMsg = await page.evaluate(() => window.__CAPTURED_IPC__.find((m) => m.action === 'launchAndClose'));
        expect(launchMsg).toMatchObject({ action: 'launchAndClose', installDir: 'D:\\Apps\\Power Pilot' });
    });

    test('uninstall akisi -> kullanici verisi silme secenegi -> progress -> uninstalled', async ({ page }) => {
        await openSetupUi(page, { mode: 'uninstall', lang: 'tr' });

        await expect(page.locator('#titlebar-title')).toHaveText('Power Pilot Kaldırma');
        await expect(page.locator('#screen-uninstall')).toHaveClass(/is-active/);
        await expect(page.locator('#uninstall-heading')).toHaveText("Power Pilot'ı kaldır");
        await expect(page.locator('#chk-delete-data')).not.toBeChecked();
        await expect(page.locator('#uninstall-data-hint')).toContainText('powerpilot');

        // Enable "Also delete saved data, local models, and settings"
        await page.locator('label[for="chk-delete-data"]').click();
        await expect(page.locator('#chk-delete-data')).toBeChecked();

        await page.click('#btn-uninstall-confirm');
        await expect(page.locator('#screen-progress')).toHaveClass(/is-active/);
        await expect(page.locator('#progress-title')).toHaveText('Power Pilot kaldırılıyor');

        const uninstMsg = await page.evaluate(() => window.__CAPTURED_IPC__.find((m) => m.action === 'uninstall'));
        expect(uninstMsg).toMatchObject({
            action: 'uninstall',
            deleteUserData: true,
            lang: 'tr'
        });

        await page.evaluate(() => window.__PP_SETUP__.receive({ type: 'progress', percent: 85, stepKey: 'stepRemoveData' }));
        await expect(page.locator('#progress-percent')).toHaveText('85%');

        await page.evaluate(() => window.__PP_SETUP__.receive({ type: 'done' }));
        await expect(page.locator('#screen-uninstalled')).toHaveClass(/is-active/);
        await expect(page.locator('#uninstalled-title')).toHaveText('Power Pilot kaldırıldı');
        await expect(page.locator('#uninstalled-check-burst')).toHaveClass(/play/);
    });
});
