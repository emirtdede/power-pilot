/**
 * app-icon.test.mjs - Çoklu çözünürlüklü marka ikonları, Microsoft Store MSIX
 * varlık bütünlüğü ve 4 seçilebilir masaüstü/uygulama ikonu sözleşmesi.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AppIconService = require('../../src/main/services/AppIconService.js');
const ColorPalette = require('../../src/shared/customColorPalette.js');
const { ALL_LANGUAGES } = require('../../src/main/i18n.js');
const { validateSettings } = require('../../src/main/ipc/validate.js');
const StorageService = require('../../src/main/services/StorageService.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmpDirs = [];
function freshDir(prefix = 'pp-icon-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* yut */ }
    }
});

/** ICO dosyasının başlık dizininden gömülü kare boyutlarını okur. */
function readIcoSizes(filePath) {
    const buf = fs.readFileSync(filePath);
    expect(buf.readUInt16LE(0)).toBe(0);
    expect(buf.readUInt16LE(2)).toBe(1);
    const count = buf.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
        const off = 6 + i * 16;
        const w = buf[off] === 0 ? 256 : buf[off];
        sizes.push(w);
    }
    return sizes.sort((a, b) => a - b);
}

describe('AppIconService - varlık bütünlüğü ve Microsoft Store uyumu', () => {
    it('4 klasik + 14 tema-uyumlu (18 statik) + özel renk (19 toplam) ikonun varlıkları mevcut', () => {
        expect(AppIconService.DEFAULT_APP_ICON).toBe('monochrome-dark');
        expect(AppIconService.CLASSIC_APP_ICON_IDS).toEqual([
            'monochrome-dark', 'monochrome-light', 'monochrome-contrast', 'classic-cyan'
        ]);
        expect(AppIconService.THEME_APP_ICON_IDS).toHaveLength(14);
        expect(AppIconService.STATIC_APP_ICON_IDS).toHaveLength(18);
        expect(AppIconService.APP_ICON_IDS).toHaveLength(19);
        expect(AppIconService.APP_ICON_IDS).toContain('custom');
        for (const id of AppIconService.STATIC_APP_ICON_IDS) {
            for (const ext of ['svg', 'png', 'ico']) {
                const file = path.join(root, 'src', 'assets', 'icons', `${id}.${ext}`);
                expect(fs.existsSync(file), `${id}.${ext} eksik`).toBe(true);
            }
            const ico = path.join(root, 'src', 'assets', 'icons', `${id}.ico`);
            expect(readIcoSizes(ico), `${id}.ico kareleri`).toEqual([16, 24, 32, 48, 64, 128, 256]);
        }
        // Kök dizinde dağınık powerpilot_icon.ico / powerpilot_icon.png bulunmamalı;
        // kanonik ikonlar src/assets/icons/ altında tutulur.
        expect(fs.existsSync(path.join(root, 'powerpilot_icon.ico'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'powerpilot_icon.png'))).toBe(false);
    });

    it('build/appx tam çoklu-DPI (scale-100..400 + targetsize unplated) Store setini içerir', () => {
        const appxDir = path.join(root, 'build', 'appx');
        const files = fs.readdirSync(appxDir);
        const required = [
            'StoreLogo.scale-100.png', 'StoreLogo.scale-200.png', 'StoreLogo.scale-400.png',
            'Square44x44Logo.scale-100.png', 'Square44x44Logo.scale-200.png',
            'Square44x44Logo.targetsize-16_altform-unplated.png',
            'Square44x44Logo.targetsize-32_altform-unplated.png',
            'Square44x44Logo.targetsize-256_altform-unplated.png',
            'Square44x44Logo.targetsize-32_altform-lightunplated.png',
            'SmallTile.scale-100.png', 'SmallTile.scale-400.png',
            'Square150x150Logo.scale-100.png', 'Square150x150Logo.scale-400.png',
            'Wide310x150Logo.scale-100.png', 'Wide310x150Logo.scale-400.png',
            'LargeTile.scale-100.png', 'LargeTile.scale-400.png',
            'SplashScreen.scale-100.png', 'SplashScreen.scale-200.png',
            'BadgeLogo.scale-100.png', 'BadgeLogo.scale-400.png'
        ];
        for (const name of required) {
            expect(files, `Store varlığı eksik: ${name}`).toContain(name);
        }
        // MakePRI çakışması yaratacak çıplak StoreLogo.png / Square44x44Logo.png olmamalı.
        expect(files).not.toContain('StoreLogo.png');
        expect(files).not.toContain('Square44x44Logo.png');
    });

    it('package.json NSIS ikonları ve asarUnpack yapılandırılmış', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        expect(pkg.build.win.icon).toBe('src/assets/icons/monochrome-dark.ico');
        expect(pkg.build.nsis.installerIcon).toBe('src/assets/icons/monochrome-dark.ico');
        expect(pkg.build.nsis.uninstallerIcon).toBe('src/assets/icons/monochrome-dark.ico');
        expect(pkg.build.nsis.installerHeaderIcon).toBe('src/assets/icons/monochrome-dark.ico');
        expect(pkg.build.asarUnpack).toContain('src/assets/icons/*.ico');
        expect(pkg.build.asarUnpack).toContain('src/assets/icons/*.png');
    });
});

describe('AppIconService - ayar doğrulama ve çalışma zamanı uygulaması', () => {
    it('validateSettings 4 geçerli ikonu kabul eder, geçersizi reddeder', () => {
        for (const id of AppIconService.APP_ICON_IDS) {
            expect(validateSettings({ appIcon: id }).ok).toBe(true);
        }
        expect(validateSettings({ appIcon: 'invalid-icon' }).ok).toBe(false);
        expect(validateSettings({ appIcon: '../evil.ico' }).ok).toBe(false);
    });

    it('StorageService varsayılan ayarı monochrome-dark', () => {
        const dir = freshDir();
        const storage = new StorageService(dir);
        try {
            expect(storage.getSettings().appIcon).toBe('monochrome-dark');
        } finally {
            storage.close();
        }
    });

    it('applyAppIcon pencere, mini pencere, tray ve Power Pilot kısayollarını günceller (diğerlerine dokunmaz)', () => {
        const desktop = freshDir('pp-desktop-');
        const startMenu = freshDir('pp-start-');
        const userData = freshDir('pp-ud-');
        const ppDesktopLnk = path.join(desktop, 'Power Pilot.lnk');
        const otherLnk = path.join(desktop, 'NotDefteri.lnk');
        const ppStartLnk = path.join(startMenu, 'Power Pilot.lnk');
        fs.writeFileSync(ppDesktopLnk, '');
        fs.writeFileSync(otherLnk, '');
        fs.writeFileSync(ppStartLnk, '');

        const mainWin = { isDestroyed: () => false, setIcon: vi.fn() };
        const miniWin = { isDestroyed: () => false, setIcon: vi.fn() };
        const tray = { isDestroyed: () => false, setImage: vi.fn() };
        const written = [];
        const fakeShell = {
            readShortcutLink: (p) => (p === otherLnk
                ? { target: 'C:\\Windows\\notepad.exe' }
                : { target: 'C:\\Users\\test\\AppData\\Local\\Programs\\Power Pilot\\Power Pilot.exe' }),
            writeShortcutLink: (p, op, details) => {
                written.push({ p, op, details });
                return true;
            }
        };
        const fakeExecFile = vi.fn();

        const res = AppIconService.applyAppIcon('monochrome-light', {
            mainWindow: mainWin,
            miniWindow: miniWin,
            tray,
            shell: fakeShell,
            rootDir: root,
            userDataDir: userData,
            desktopDirs: [desktop],
            startMenuDirs: [startMenu],
            isPortable: true,
            isStoreBuild: false,
            isPackaged: false,
            platform: 'win32',
            execFileImpl: fakeExecFile
        });

        expect(res.ok).toBe(true);
        expect(res.iconId).toBe('monochrome-light');
        expect(mainWin.setIcon).toHaveBeenCalledWith(res.icoPath);
        expect(miniWin.setIcon).toHaveBeenCalledWith(res.icoPath);
        expect(tray.setImage).toHaveBeenCalledWith(res.icoPath);
        expect(written.map((w) => w.p).sort()).toEqual([ppDesktopLnk, ppStartLnk].sort());
        expect(written.every((w) => w.op === 'update' && w.details.icon.endsWith('powerpilot-monochrome-light.ico'))).toBe(true);
        expect(fs.existsSync(path.join(userData, 'icons', 'powerpilot-monochrome-light.ico'))).toBe(true);
    });

    it('Store (MSIX) modunda Başlat Menüsü kısayollarına dokunmaz', () => {
        const desktop = freshDir('pp-store-desktop-');
        const startMenu = freshDir('pp-store-start-');
        const ppStartLnk = path.join(startMenu, 'Power Pilot.lnk');
        fs.writeFileSync(ppStartLnk, '');

        const written = [];
        const fakeShell = {
            readShortcutLink: () => ({ target: 'C:\\Program Files\\WindowsApps\\Power Pilot.exe' }),
            writeShortcutLink: (p) => { written.push(p); return true; }
        };

        const res = AppIconService.updateWindowsShortcuts(path.join(root, 'src', 'assets', 'icons', 'monochrome-dark.ico'), {
            shell: fakeShell,
            desktopDirs: [desktop],
            startMenuDirs: [startMenu],
            isStoreBuild: true,
            platform: 'win32'
        });

        expect(res.updated).toEqual([]);
        expect(written).toEqual([]);
    });

    it('WP-2: sabitlenmiş görev çubuğu kısayollarını günceller ve appUserModelId yazar', () => {
        const taskbar = freshDir('pp-taskbar-');
        const subDir = path.join(taskbar, 'SubApp');
        fs.mkdirSync(subDir, { recursive: true });
        const pinnedLnk = path.join(subDir, 'Power Pilot.lnk');
        fs.writeFileSync(pinnedLnk, '');

        const written = [];
        const fakeShell = {
            readShortcutLink: () => ({ target: 'C:\\Users\\test\\Power Pilot.exe' }),
            writeShortcutLink: (p, op, details) => { written.push({ p, op, details }); return true; }
        };

        const res = AppIconService.updateWindowsShortcuts(path.join(root, 'src', 'assets', 'icons', 'classic-cyan.ico'), {
            shell: fakeShell,
            desktopDirs: [],
            startMenuDirs: [],
            taskbarDirs: [taskbar],
            isStoreBuild: false,
            platform: 'win32'
        });

        expect(res.updated).toEqual([pinnedLnk]);
        expect(written[0].details.appUserModelId).toBe(AppIconService.APP_USER_MODEL_ID);
    });

    it('WP-2: createDesktopShortcut dinamik ikonlu masaüstü kısayolu oluşturur', () => {
        const desktop = freshDir('pp-create-lnk-');
        const created = [];
        const fakeShell = {
            writeShortcutLink: (p, op, details) => { created.push({ p, op, details }); return true; }
        };
        const r = AppIconService.createDesktopShortcut({
            desktopDir: desktop,
            targetExePath: 'C:\\Tools\\PowerPilot.exe',
            icoPath: path.join(root, 'src', 'assets', 'icons', 'classic-cyan.ico'),
            shell: fakeShell
        });
        expect(r.ok).toBe(true);
        expect(created).toHaveLength(1);
        expect(created[0].op).toBe('replace');
        expect(created[0].details.appUserModelId).toBe(AppIconService.APP_USER_MODEL_ID);
    });

    it('Portable modda ayrı Power Pilot Portable.lnk oluşturur ve SHChangeNotify -EncodedCommand ile tetikler', () => {
        const desktop = freshDir('pp-portable-lnk-');
        const created = [];
        const execCalls = [];
        const fakeShell = {
            writeShortcutLink: (p, op, details) => { created.push({ p, op, details }); return true; }
        };
        const fakeExecFile = (file, args) => { execCalls.push({ file, args }); };
        const r = AppIconService.createDesktopShortcut({
            desktopDir: desktop,
            targetExePath: 'C:\\Users\\test\\Desktop\\Power Pilot Portable 1.0.0.exe',
            icoPath: path.join(root, 'src', 'assets', 'icons', 'classic-cyan.ico'),
            shell: fakeShell,
            isPortable: true,
            execFileImpl: fakeExecFile
        });
        expect(r.ok).toBe(true);
        expect(path.basename(r.shortcutPath)).toBe('Power Pilot Portable.lnk');
        const psCall = execCalls.find((c) => /powershell/i.test(c.file));
        expect(psCall).toBeTruthy();
        expect(psCall.args).toContain('-EncodedCommand');
        const decoded = Buffer.from(psCall.args[psCall.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
        expect(decoded).toContain('SHChangeNotify(0x00002000');
        expect(decoded).toContain('SHChangeNotify(0x00001000');
        expect(decoded).toContain('SHChangeNotify(0x08000000');
    });

    it('paketli yol çözümü, NativeImage ölçekleme, replace fallback ve DisplayIcon dallarını kapsar', () => {
        const fakeResources = freshDir('pp-res-');
        const unpackedIcons = path.join(fakeResources, 'app.asar.unpacked', 'src', 'assets', 'icons');
        fs.mkdirSync(unpackedIcons, { recursive: true });
        const packedIco = path.join(unpackedIcons, 'classic-cyan.ico');
        const packedPng = path.join(unpackedIcons, 'classic-cyan.png');
        fs.copyFileSync(path.join(root, 'src', 'assets', 'icons', 'classic-cyan.ico'), packedIco);
        fs.copyFileSync(path.join(root, 'src', 'assets', 'icons', 'classic-cyan.png'), packedPng);

        expect(AppIconService.resolveIconIcoPath('classic-cyan', {
            rootDir: root,
            resourcesPath: fakeResources,
            isPackaged: true
        })).toBe(packedIco);
        expect(AppIconService.resolveIconPngPath('classic-cyan', {
            rootDir: root,
            resourcesPath: fakeResources,
            isPackaged: true
        })).toBe(packedPng);

        // Kalıcı unpacked kurulumda kopyalama yapmadan doğrudan unpacked yolu döner
        expect(AppIconService.ensureStableShortcutIco('classic-cyan', {
            sourceIcoPath: packedIco,
            isPackaged: true,
            isPortable: false
        })).toBe(packedIco);
        expect(AppIconService.ensureStableShortcutIco('classic-cyan', { sourceIcoPath: null })).toBeNull();

        // NativeImage resize dalı
        const resizedImg = { isEmpty: () => false, resized: true };
        const baseImg = {
            isEmpty: () => false,
            resize: vi.fn(() => resizedImg)
        };
        // Windows pencere/görev çubuğu ikonu (targetSize: null) doğrudan 7-kareli .ico yolunu döner
        expect(AppIconService.buildRuntimeIconPayload('classic-cyan', {
            icoPath: packedIco,
            pngPath: packedPng,
            nativeImage: { createFromPath: () => baseImg },
            targetSize: null,
            platform: 'win32'
        })).toBe(packedIco);

        // NativeImage resize dalı (Tray / Notification)
        const payload = AppIconService.buildRuntimeIconPayload('classic-cyan', {
            icoPath: packedIco,
            pngPath: packedPng,
            nativeImage: { createFromPath: () => baseImg },
            targetSize: 32,
            platform: 'win32'
        });
        expect(payload).toBe(resizedImg);

        // updateWindowsShortcuts: 'update' eski ikonu korursa 'replace' fallback çalışır
        const desktop = freshDir('pp-replace-');
        const lnk = path.join(desktop, 'Power Pilot.lnk');
        fs.writeFileSync(lnk, '');
        const ops = [];
        const shellReplaceFallback = {
            readShortcutLink: () => ({
                target: 'C:\\Program Files\\Power Pilot\\Power Pilot.exe',
                icon: 'C:\\old-icon.ico'
            }),
            writeShortcutLink: (p, op) => {
                ops.push(op);
                return true;
            }
        };
        const upd = AppIconService.updateWindowsShortcuts(packedIco, {
            shell: shellReplaceFallback,
            desktopDirs: [desktop],
            platform: 'win32'
        });
        expect(upd.updated).toEqual([lnk]);
        expect(ops).toEqual(['update', 'replace']);

        // Paketli kurulumda applyAppIcon hem setOverlayIcon hem DisplayIcon tetikler
        const execCalls = [];
        const overlayFn = vi.fn();
        AppIconService.applyAppIcon('classic-cyan', {
            mainWindow: { isDestroyed: () => false, setIcon: vi.fn(), setOverlayIcon: overlayFn },
            miniWindow: { isDestroyed: () => false, setIcon: vi.fn() },
            tray: { isDestroyed: () => false, setImage: vi.fn() },
            shell: shellReplaceFallback,
            rootDir: root,
            resourcesPath: fakeResources,
            desktopDirs: [desktop],
            isPortable: false,
            isStoreBuild: false,
            isPackaged: true,
            platform: 'win32',
            execFileImpl: (file, args) => execCalls.push({ file, args })
        });
        expect(overlayFn).toHaveBeenCalledWith(null, '');
        expect(execCalls.filter((c) => /powershell/i.test(c.file)).length).toBeGreaterThanOrEqual(2);
    });

    it('writeCustomIconFiles çoklu çözünürlüklü özel renk ICO/PNG/SVG üretir, eskiyi temizler ve uygular', () => {
        const userData = freshDir('pp-custom-icon-');
        const desktop = freshDir('pp-custom-desktop-');
        const lnk = path.join(desktop, 'Power Pilot.lnk');
        fs.writeFileSync(lnk, '');
        const realPng = fs.readFileSync(path.join(root, 'src', 'assets', 'icons', 'theme-purple.png')).toString('base64');
        const makeFrames = () => [16, 24, 32, 48, 64].map((size) => ({
            size,
            kind: 'rgba',
            base64: Buffer.alloc(size * size * 4, 220).toString('base64')
        })).concat([
            { size: 128, kind: 'png', base64: realPng },
            { size: 256, kind: 'png', base64: realPng }
        ]);

        const first = AppIconService.writeCustomIconFiles('#8b5cf6', makeFrames(), { userDataDir: userData });
        expect(first.ok).toBe(true);
        expect(fs.existsSync(first.icoPath)).toBe(true);
        expect(fs.existsSync(first.pngPath)).toBe(true);
        expect(fs.existsSync(first.svgPath)).toBe(true);
        expect(readIcoSizes(first.icoPath)).toEqual([16, 24, 32, 48, 64, 128, 256]);

        const second = AppIconService.writeCustomIconFiles('#e11d48', makeFrames(), { userDataDir: userData });
        expect(second.ok).toBe(true);
        expect(fs.existsSync(second.icoPath)).toBe(true);
        expect(fs.existsSync(first.icoPath)).toBe(false);

        const mainWin = { isDestroyed: () => false, setIcon: vi.fn() };
        const miniWin = { isDestroyed: () => false, setIcon: vi.fn() };
        const tray = { isDestroyed: () => false, setImage: vi.fn() };
        const written = [];
        const fakeShell = {
            readShortcutLink: () => ({ target: 'C:\\Program Files\\Power Pilot\\Power Pilot.exe' }),
            writeShortcutLink: (p, op, details) => { written.push({ p, op, details }); return true; }
        };
        const applied = AppIconService.applyAppIcon('custom', {
            customIconColor: '#e11d48',
            userDataDir: userData,
            mainWindow: mainWin,
            miniWindow: miniWin,
            tray,
            shell: fakeShell,
            rootDir: root,
            desktopDirs: [desktop],
            startMenuDirs: [],
            taskbarDirs: [],
            isPortable: false,
            isStoreBuild: false,
            isPackaged: false,
            platform: 'win32',
            execFileImpl: vi.fn()
        });
        expect(applied.ok).toBe(true);
        expect(applied.iconId).toBe('custom');
        expect(applied.icoPath).toBe(second.icoPath);
        expect(mainWin.setIcon).toHaveBeenCalledWith(second.icoPath);
        expect(tray.setImage).toHaveBeenCalledWith(second.icoPath);
        expect(written[0].details.icon).toBe(second.icoPath);
    });
});

describe('Özel Renk Teması, Erişilebilirlik ve NSIS 73-Dil Kurulum Sözleşmesi', () => {
    it('customColorPalette WCAG AA kontrastlı açık/koyu tema ve ikon paleti üretir', () => {
        for (const hex of ['#09090b', '#facc15', '#8b5cf6', '#e11d48', '#06b6d4']) {
            const tokens = ColorPalette.buildCustomThemeTokens(hex);
            expect(tokens.hex).toBe(hex);
            expect(tokens.light['--accent']).toMatch(/^#[0-9a-f]{6}$/);
            expect(tokens.dark['--accent']).toMatch(/^#[0-9a-f]{6}$/);
            expect(tokens.lightContrast).toBeGreaterThanOrEqual(4.5);
            expect(tokens.darkContrast).toBeGreaterThanOrEqual(4.5);
            const iconP = ColorPalette.buildCustomIconPalette(hex);
            const svg = ColorPalette.buildBrandIconSvg(iconP);
            expect(svg).toContain('<svg');
            expect(svg).toContain(iconP.bg1);
        }
        const css = ColorPalette.buildCustomCssText('#8b5cf6', '#e11d48');
        expect(css).toContain("html[data-theme='custom']");
        expect(css).toContain("html.dark[data-theme='custom']");
        expect(css).toContain("html[data-app-icon='custom']");
    });

    it('validateSettings yeni özel tema, ikon, yakınlaştırma ve erişilebilirlik ayarlarını doğrular', () => {
        expect(validateSettings({
            themeId: 'custom',
            customThemeColor: '#8b5cf6',
            customIconColor: '#e11d48',
            syncIconWithTheme: true,
            uiZoom: 125,
            fontScale: 'xlarge',
            highContrast: true,
            enhancedFocus: true,
            readableSpacing: true,
            reduceMotion: true,
            onboardingCompleted: true
        }).ok).toBe(true);

        expect(validateSettings({ customThemeColor: 'red' }).ok).toBe(false);
        expect(validateSettings({ customIconColor: '#12345' }).ok).toBe(false);
        expect(validateSettings({ uiZoom: 74 }).ok).toBe(false);
        expect(validateSettings({ uiZoom: 151 }).ok).toBe(false);
        expect(validateSettings({ uiZoom: 75 }).ok).toBe(true);
        expect(validateSettings({ uiZoom: 150 }).ok).toBe(true);
        expect(validateSettings({ fontScale: 'giant' }).ok).toBe(false);
    });

    it('build/installer.nsh 73 dilin tamamını, 0 dil sızıntısı NLF/LangString tablolarını, yazısız görselleri ve anında ikon tazelemeyi doğrular', () => {
        const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
        const langPack = fs.readFileSync(path.join(root, 'build', 'nsis-langs', 'powerpilot-73langs.nsh'), 'utf8');
        const dlgTitles = fs.readFileSync(path.join(root, 'build', 'nsis-langs', 'langdialog-titles.nsh'), 'utf8');
        const assetsScript = fs.readFileSync(path.join(root, 'scripts', 'generate-installer-assets.cjs'), 'utf8');

        expect(ALL_LANGUAGES).toHaveLength(73);
        for (const lang of ALL_LANGUAGES) {
            expect(nsh, `NSIS kurulumunda dil kodu eksik: ${lang.id}`).toContain(`"${lang.id}"`);
            if (lang.id !== 'en') {
                expect(dlgTitles, `LangDLL başlığı eksik: ${lang.id}`).toContain(`\${Case} "${lang.id}"`);
            }
        }
        // 53 yerlesik NSIS .nlf (Ingilizce addLangs ile) + 19 ozel Unicode NLF (Turkiye Turkcesi dahil) = 73 tam yerel NSIS tablosu
        const builtinNlfMatches = langPack.match(/^LoadLanguageFile "\$\{NSISDIR\}/gm) || [];
        const customNlfMatches = langPack.match(/^LoadLanguageFile "\$\{BUILD_RESOURCES_DIR\}/gm) || [];
        expect(builtinNlfMatches).toHaveLength(53);
        expect(customNlfMatches).toHaveLength(19);
        const nlfFiles = fs.readdirSync(path.join(root, 'build', 'nsis-langs')).filter((f) => f.endsWith('.nlf'));
        expect(nlfFiles).toHaveLength(19);
        expect(nlfFiles).toContain('TurkishTR.nlf');

        // UTF-8 BOM zorunlulugu: NSIS 3.0.4.1 !include dosyalarini BOM olmadan ANSI codepage ile okuyarak Turkce karakterleri bozar
        const bomRequiredFiles = [
            path.join(root, 'build', 'installer.nsh'),
            path.join(root, 'build', 'nsis-langs', 'powerpilot-73langs.nsh'),
            path.join(root, 'build', 'nsis-langs', 'langdialog-titles.nsh'),
            ...nlfFiles.map((f) => path.join(root, 'build', 'nsis-langs', f))
        ];
        for (const f of bomRequiredFiles) {
            const raw = fs.readFileSync(f);
            expect([raw[0], raw[1], raw[2]], `UTF-8 BOM eksik: ${path.basename(f)}`).toEqual([0xef, 0xbb, 0xbf]);
        }

        // Tum dillerde mojibake yasak + Turkiye Turkcesi (tr-TR / LCID 1055) satirlarinda eski NSIS yazim hatalari olmamali
        const mojibakeRe = /[\uFFFD]|Ã[\u0080-\u00BF]|Ä[\u0080-\u00BF]|Å[\u0080-\u00BF]/;
        const brokenTrRe = /şeçiniz|Litfen|Tamamlandır|kadırılım|Kaldırım işlemeni|bilgisayariniza|programlari|Programi|dizinde kurulacak/;
        expect(langPack).not.toMatch(mojibakeRe);
        expect(nsh).not.toMatch(mojibakeRe);
        const trLines = langPack.split(/\r?\n/).filter((line) => /\s1055\s/.test(line)).join('\n');
        expect(trLines.length).toBeGreaterThan(500);
        expect(trLines).not.toMatch(brokenTrRe);
        const trNlf = fs.readFileSync(path.join(root, 'build', 'nsis-langs', 'TurkishTR.nlf'), 'utf8');
        expect(trNlf).toContain('\r\n1055\r\n');
        expect(trNlf).toContain('\r\n1200\r\n');
        expect(trNlf).toContain('Kurulum Klasörü');
        expect(trNlf).not.toMatch(mojibakeRe);
        expect(trNlf).not.toMatch(brokenTrRe);

        // Tum 73 dil icin ozel Setup + Uninstall LangString sayilari birebir 73 olmali
        expect((langPack.match(/LangString PP_WelcomeTitle /g) || [])).toHaveLength(73);
        expect((langPack.match(/LangString PP_UnWelcomeTitle /g) || [])).toHaveLength(73);
        expect((langPack.match(/LangString PP_UnDataCheck /g) || [])).toHaveLength(73);
        // 72 Ingilizce disi dilin tamaminda electron-builder assistedMessages + messages cevrilmis olmali
        expect((langPack.match(/LangString chooseInstallationOptions /g) || [])).toHaveLength(72);
        expect((langPack.match(/LangString onlyForMe /g) || [])).toHaveLength(72);
        expect((langPack.match(/LangString appRunning /g) || [])).toHaveLength(72);

        expect(nsh).toContain('GetUserDefaultUILanguage');
        expect(nsh).toContain('StrCpy $SelectedLangCode "en"');
        expect(nsh).toContain('installer-language.json');
        expect(nsh).toContain('LangDLL::LangDialog');
        expect(nsh).toContain('InstallLanguageLcid');
        expect(nsh).toContain('DeleteUserDataFlag');
        expect(nsh).toContain('UAC_IsInnerInstance');
        // Aninda ikon gorunumu: DisplayIcon & kisayollar uninstallerIcon.ico + SHCNF_FLUSH + ie4uinit -show
        expect(nsh).toContain('uninstallerIcon.ico');
        expect(nsh).toContain('ie4uinit.exe');
        expect(nsh).toContain('0x1005');
        // AV sezgisel kural temizligi: kaldirmada -ExecutionPolicy Bypass kullanilmamali (yorum satirlari haric)
        const nshCode = nsh.replace(/^\s*;.*$/gm, '');
        expect(nshCode).not.toMatch(/ExecutionPolicy\s+Bypass/i);
        // LogicLib Switch dize karşılaştırır: onaltılık 0x.. etiket kalmamalı.
        expect(nsh).not.toMatch(/\$\{Case\}\s+0x/i);

        // Setup ve Uninstall SVG gorsellerindeki tum <text> ogeleri yalnizca "Power Pilot" olmali (VELLIUM ve aciklayici yazi yasak)
        const svgTexts = [...assetsScript.matchAll(/<text\b[^>]*>([^<]+)<\/text>/g)].map((m) => m[1].trim());
        expect(svgTexts).toEqual(['Power Pilot', 'Power Pilot', 'Power Pilot']);
        expect(assetsScript).not.toMatch(/VELLIUM/i);
    });
});
