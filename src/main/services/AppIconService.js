/**
 * AppIconService.js - Uygulama, görev çubuğu, sistem tepsisi ve masaüstü ikonu yönetimi.
 *
 * 4 kanonik ikon varyantı sunar (varsayılan: `monochrome-dark` / Koyu Monokrom):
 *  - `monochrome-dark`     : Siyah Zemin · Koyu Monokrom
 *  - `monochrome-light`    : Beyaz Zemin · Açık Monokrom
 *  - `monochrome-contrast` : Saf Siyah-Beyaz · Yüksek Kontrast
 *  - `classic-cyan`        : Klasik · Cyan
 *
 * Seçim değiştiğinde tüm yüzeyler eşzamanlı güncellenir:
 *  1. Ana pencere ve mini pencere görev çubuğu/pencere ikonu (`setIcon`).
 *  2. Sistem tepsisi (Tray) ikonu (`setImage`).
 *  3. Windows Masaüstü, Başlat Menüsü, Sabitlenmiş Görev Çubuğu (`User Pinned\TaskBar`,
 *     `ImplicitAppShortcuts`) ve Başlangıç `.lnk` kısayollarının ikonu + `AppUserModelId`.
 *  4. NSIS kurulumunda `HKCU\...\Uninstall` `DisplayIcon` değeri (no-shell `reg.exe`).
 *  5. Windows Explorer simge önbelleği (`ie4uinit.exe -show` + `Shell32::SHChangeNotify`).
 *  6. Portable kullanıcıları için isteğe bağlı tek tıkla dinamik ikonlu Masaüstü `.lnk` kısayolu.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
    DEFAULT_CUSTOM_COLOR,
    THEME_ICON_PALETTES,
    normalizeHexColor,
    buildCustomIconPalette,
    buildBrandIconSvg
} = require('../../shared/customColorPalette');

const APP_USER_MODEL_ID = 'Vellium.PowerPilot';

const CLASSIC_APP_ICON_IDS = Object.freeze([
    'monochrome-dark',
    'monochrome-light',
    'monochrome-contrast',
    'classic-cyan'
]);

const THEME_APP_ICON_IDS = Object.freeze(Object.keys(THEME_ICON_PALETTES));

const STATIC_APP_ICON_IDS = Object.freeze([
    ...CLASSIC_APP_ICON_IDS,
    ...THEME_APP_ICON_IDS
]);

const APP_ICON_IDS = Object.freeze([
    ...STATIC_APP_ICON_IDS,
    'custom'
]);

const DEFAULT_APP_ICON = 'monochrome-dark';

function isValidAppIcon(id) {
    return typeof id === 'string' && APP_ICON_IDS.includes(id);
}

function normalizeAppIcon(id) {
    return isValidAppIcon(id) ? id : DEFAULT_APP_ICON;
}

function customHexSlug(hex) {
    return normalizeHexColor(hex, DEFAULT_CUSTOM_COLOR).slice(1).toLowerCase();
}

/**
 * 32-bit RGBA tamponundan klasik Windows ICO DIB BMP + 1-bit AND maskesi üretir.
 */
function encodeIcoBmpFrame(rgba, size) {
    const xorSize = size * size * 4;
    const maskRowBytes = Math.ceil(size / 32) * 4;
    const andSize = maskRowBytes * size;
    const buf = Buffer.alloc(40 + xorSize + andSize);

    buf.writeUInt32LE(40, 0);
    buf.writeInt32LE(size, 4);
    buf.writeInt32LE(size * 2, 8);
    buf.writeUInt16LE(1, 12);
    buf.writeUInt16LE(32, 14);
    buf.writeUInt32LE(0, 16);
    buf.writeUInt32LE(xorSize + andSize, 20);

    for (let y = 0; y < size; y++) {
        const srcRow = (size - 1 - y) * size * 4;
        const dstRow = 40 + y * size * 4;
        const maskRow = 40 + xorSize + y * maskRowBytes;
        for (let x = 0; x < size; x++) {
            const s = srcRow + x * 4;
            const d = dstRow + x * 4;
            const r = rgba[s];
            const g = rgba[s + 1];
            const b = rgba[s + 2];
            const a = rgba[s + 3];
            buf[d] = b;
            buf[d + 1] = g;
            buf[d + 2] = r;
            buf[d + 3] = a;
            if (a < 16) {
                buf[maskRow + (x >> 3)] |= (0x80 >> (x & 7));
            }
        }
    }
    return buf;
}

/**
 * Çoklu çözünürlüklü (16/24/32/48/64 BMP DIB + 128/256 PNG) Windows ICO paketler.
 */
function encodeMultiResIco(frames) {
    const valid = (Array.isArray(frames) ? frames : [])
        .filter((f) => f && Number.isInteger(f.size) && f.size >= 16 && f.size <= 256 && Buffer.isBuffer(f.data) && f.data.length > 0)
        .sort((a, b) => a.size - b.size);
    if (valid.length === 0) throw new Error('En az bir geçerli ICO karesi gerekli.');

    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(valid.length, 4);

    let offset = 6 + valid.length * 16;
    const dirEntries = [];
    const payloads = [];
    for (const f of valid) {
        const entry = Buffer.alloc(16);
        entry[0] = f.size >= 256 ? 0 : f.size;
        entry[1] = f.size >= 256 ? 0 : f.size;
        entry[2] = 0;
        entry[3] = 0;
        entry.writeUInt16LE(1, 4);
        entry.writeUInt16LE(32, 6);
        entry.writeUInt32LE(f.data.length, 8);
        entry.writeUInt32LE(offset, 12);
        dirEntries.push(entry);
        payloads.push(f.data);
        offset += f.data.length;
    }
    return Buffer.concat([header, ...dirEntries, ...payloads]);
}

/**
 * Renderer tarafından rasterize edilen özel renkli ikon karelerinden
 * `userData/icons/powerpilot-custom-<hex>.ico` ve `.png` dosyalarını diske yazar.
 */
function writeCustomIconFiles(rawHex, rawFrames, {
    userDataDir,
    fsImpl = fs
} = {}) {
    if (!userDataDir) return { ok: false, code: 'NO_USER_DATA_DIR' };
    const hex = normalizeHexColor(rawHex, DEFAULT_CUSTOM_COLOR);
    const slug = customHexSlug(hex);
    if (!Array.isArray(rawFrames) || rawFrames.length === 0 || rawFrames.length > 10) {
        return { ok: false, code: 'INVALID_FRAMES' };
    }

    const icoFrames = [];
    let png256 = null;
    for (const item of rawFrames) {
        if (!item || typeof item !== 'object') return { ok: false, code: 'INVALID_FRAME' };
        const size = Number(item.size);
        if (![16, 24, 32, 48, 64, 128, 256].includes(size)) return { ok: false, code: 'INVALID_FRAME_SIZE' };
        if (item.kind === 'rgba' && typeof item.base64 === 'string') {
            const raw = Buffer.from(item.base64, 'base64');
            if (raw.length !== size * size * 4) return { ok: false, code: 'INVALID_RGBA_LEN' };
            icoFrames.push({ size, data: encodeIcoBmpFrame(raw, size) });
        } else if (item.kind === 'png' && typeof item.base64 === 'string') {
            if (item.base64.length > 400000) return { ok: false, code: 'FRAME_TOO_LARGE' };
            const pngBuf = Buffer.from(item.base64, 'base64');
            // PNG sihirli bayt doğrulaması (89 50 4E 47)
            if (pngBuf.length < 24 || pngBuf[0] !== 0x89 || pngBuf[1] !== 0x50 || pngBuf[2] !== 0x4e || pngBuf[3] !== 0x47) {
                return { ok: false, code: 'INVALID_PNG' };
            }
            icoFrames.push({ size, data: pngBuf });
            if (size === 256 || !png256) png256 = pngBuf;
        } else {
            return { ok: false, code: 'INVALID_FRAME_KIND' };
        }
    }

    if (icoFrames.length === 0) return { ok: false, code: 'EMPTY_FRAMES' };

    const icoBuf = encodeMultiResIco(icoFrames);
    const iconStoreDir = path.join(userDataDir, 'icons');
    fsImpl.mkdirSync(iconStoreDir, { recursive: true });

    const baseName = `powerpilot-custom-${slug}`;
    const icoPath = path.join(iconStoreDir, `${baseName}.ico`);
    const pngPath = path.join(iconStoreDir, `${baseName}.png`);
    const svgPath = path.join(iconStoreDir, `${baseName}.svg`);

    fsImpl.writeFileSync(icoPath, icoBuf);
    if (png256) fsImpl.writeFileSync(pngPath, png256);
    fsImpl.writeFileSync(svgPath, buildBrandIconSvg(buildCustomIconPalette(hex)), 'utf8');

    // Eski özel renk ikon dosyalarını temizle (sadece etkin olanı tut).
    try {
        for (const name of fsImpl.readdirSync(iconStoreDir)) {
            if (!name.startsWith('powerpilot-custom-')) continue;
            if (name === `${baseName}.ico` || name === `${baseName}.png` || name === `${baseName}.svg`) continue;
            try { fsImpl.unlinkSync(path.join(iconStoreDir, name)); } catch (_) { /* kilitli olabilir */ }
        }
    } catch (_) { /* best-effort */ }

    return { ok: true, hex, icoPath, pngPath: png256 ? pngPath : null, svgPath };
}

/**
 * Seçili ikon varyantı için disk üzerindeki gerçek `.ico` yolunu çözer.
 */
function resolveIconIcoPath(iconId, {
    rootDir = path.resolve(__dirname, '..', '..', '..'),
    resourcesPath = process.resourcesPath || null,
    userDataDir = null,
    customIconColor = null,
    isPackaged = false,
    fsImpl = fs
} = {}) {
    const id = normalizeAppIcon(iconId);
    const candidates = [];
    if (id === 'custom' && userDataDir) {
        const slug = customHexSlug(customIconColor);
        candidates.push(path.join(userDataDir, 'icons', `powerpilot-custom-${slug}.ico`));
    }
    if (isPackaged && resourcesPath) {
        if (id !== 'custom') {
            candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'icons', `${id}.ico`));
        }
        candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'icons', `${DEFAULT_APP_ICON}.ico`));
    }
    if (id !== 'custom') {
        candidates.push(path.join(rootDir, 'src', 'assets', 'icons', `${id}.ico`));
    }
    candidates.push(path.join(rootDir, 'src', 'assets', 'icons', `${DEFAULT_APP_ICON}.ico`));

    for (const candidate of candidates) {
        try {
            if (fsImpl.existsSync(candidate)) return candidate;
        } catch (_) { /* sonraki adaya düş */ }
    }
    return path.join(rootDir, 'src', 'assets', 'icons', `${DEFAULT_APP_ICON}.ico`);
}

/**
 * Seçili ikon varyantı için disk üzerindeki gerçek `.png` (256x256) yolunu çözer.
 */
function resolveIconPngPath(iconId, {
    rootDir = path.resolve(__dirname, '..', '..', '..'),
    resourcesPath = process.resourcesPath || null,
    userDataDir = null,
    customIconColor = null,
    isPackaged = false,
    fsImpl = fs
} = {}) {
    const id = normalizeAppIcon(iconId);
    const candidates = [];
    if (id === 'custom' && userDataDir) {
        const slug = customHexSlug(customIconColor);
        candidates.push(path.join(userDataDir, 'icons', `powerpilot-custom-${slug}.png`));
    }
    if (isPackaged && resourcesPath && id !== 'custom') {
        candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'src', 'assets', 'icons', `${id}.png`));
    }
    if (id !== 'custom') {
        candidates.push(path.join(rootDir, 'src', 'assets', 'icons', `${id}.png`));
    }
    candidates.push(path.join(rootDir, 'src', 'assets', 'icons', `${DEFAULT_APP_ICON}.png`));

    for (const candidate of candidates) {
        try {
            if (fsImpl.existsSync(candidate)) return candidate;
        } catch (_) { /* sonraki adaya düş */ }
    }
    return null;
}

/**
 * Electron `BrowserWindow.setIcon` / `Tray.setImage` için Windows DPI uyumlu
 * ikon yükü oluşturur:
 *  - Windows pencere / görev çubuğu ikonu (`!targetSize`): doğrudan 7-kareli
 *    `.ico` dosya yolu dönülür; böylece Win32 `LoadImageW` hem `ICON_SMALL`
 *    (16/24px) hem `ICON_BIG` (32/48px) karelerini anında ve beyaz çerçeve
 *    gecikmesi olmadan yükler.
 *  - Sistem tepsisi / bildirim (`targetSize` verildiyse): PNG üzerinden hedef
 *    boyuta en yüksek kalitede ölçeklenmiş `NativeImage` dönülür.
 */
function buildRuntimeIconPayload(iconId, {
    icoPath,
    pngPath = null,
    nativeImage = null,
    targetSize = null,
    platform = process.platform
} = {}) {
    if (!targetSize && platform === 'win32' && icoPath) {
        return icoPath;
    }
    if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
        return icoPath;
    }
    try {
        const srcPath = pngPath || icoPath;
        const img = nativeImage.createFromPath(srcPath);
        if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) {
            if (targetSize && typeof img.resize === 'function') {
                const resized = img.resize({ width: targetSize, height: targetSize, quality: 'best' });
                if (resized && !resized.isEmpty()) return resized;
            }
            return img;
        }
    } catch (_) { /* icoPath fallback */ }
    return icoPath;
}

/**
 * Windows `.lnk` kısayolunun işaret edeceği kalıcı `.ico` yolunu hazırlar.
 * Her varyantın dosya adı farklı olduğu için Windows Explorer simge önbelleği
 * eski ikonu göstermez.
 */
function ensureStableShortcutIco(iconId, {
    sourceIcoPath,
    userDataDir = null,
    customIconColor = null,
    isPortable = false,
    isPackaged = false,
    fsImpl = fs
} = {}) {
    const id = normalizeAppIcon(iconId);
    if (!sourceIcoPath) return null;

    // Özel renkli ikon zaten `userDataDir/icons/powerpilot-custom-<hex>.ico` altında
    // benzersiz adla kalıcıdır; yeniden kopyalamadan doğrudan döndür.
    if (id === 'custom' && userDataDir && sourceIcoPath.startsWith(path.join(userDataDir, 'icons'))) {
        return sourceIcoPath;
    }

    const isPermanentUnpacked = isPackaged && !isPortable
        && sourceIcoPath.includes('app.asar.unpacked')
        && !/[\\/]Temp[\\/]/i.test(sourceIcoPath);
    if (isPermanentUnpacked) return sourceIcoPath;

    if (!userDataDir) return sourceIcoPath;
    try {
        const iconStoreDir = path.join(userDataDir, 'icons');
        fsImpl.mkdirSync(iconStoreDir, { recursive: true });
        const fileName = id === 'custom'
            ? `powerpilot-custom-${customHexSlug(customIconColor)}.ico`
            : `powerpilot-${id}.ico`;
        const target = path.join(iconStoreDir, fileName);
        if (path.resolve(sourceIcoPath) !== path.resolve(target)) {
            fsImpl.copyFileSync(sourceIcoPath, target);
        }
        return target;
    } catch (_) {
        return sourceIcoPath;
    }
}

function looksLikePowerPilotShortcut(lnkPath, details) {
    const base = path.basename(lnkPath).toLowerCase();
    if (base.includes('power pilot') || base.includes('powerpilot')) return true;
    const target = String((details && details.target) || '').toLowerCase();
    if ((target.includes('power pilot') || target.includes('powerpilot')) && target.endsWith('.exe')) return true;
    return target.endsWith('\\power pilot.exe') || target.endsWith('/power pilot.exe')
        || target.endsWith('\\powerpilot.exe') || target.endsWith('/powerpilot.exe');
}

function collectCandidateLnkFiles(dirs, fsImpl = fs, maxDepth = 2) {
    const found = [];
    const seen = new Set();
    const scan = (dir, depth) => {
        if (!dir || typeof dir !== 'string' || depth > maxDepth) return;
        let entries;
        try {
            if (!fsImpl.existsSync(dir)) return;
            entries = fsImpl.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (depth < maxDepth) scan(full, depth + 1);
                continue;
            }
            if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue;
            const norm = full.toLowerCase();
            if (seen.has(norm)) continue;
            seen.add(norm);
            found.push(full);
        }
    };
    for (const dir of dirs) scan(dir, 0);
    return found;
}

/**
 * Mevcut Power Pilot Masaüstü / Başlat Menüsü / Sabitlenmiş Görev Çubuğu `.lnk`
 * kısayollarının ikonunu ve `appUserModelId` değerini günceller.
 */
function updateWindowsShortcuts(icoPath, {
    shell,
    desktopDirs = [],
    startMenuDirs = [],
    taskbarDirs = [],
    isStoreBuild = false,
    platform = process.platform,
    fsImpl = fs,
    logger = null
} = {}) {
    if (platform !== 'win32' || !icoPath || !shell
        || typeof shell.readShortcutLink !== 'function'
        || typeof shell.writeShortcutLink !== 'function') {
        return { updated: [], skipped: true };
    }

    // Store (MSIX) sürümünde Başlat Menüsü kutucuğu Windows paket manifestiyle
    // yönetilir; yalnızca kullanıcının masaüstü/görev çubuğu kısayolları güncellenir.
    const dirs = isStoreBuild
        ? [...desktopDirs, ...taskbarDirs]
        : [...desktopDirs, ...startMenuDirs, ...taskbarDirs];
    const candidates = collectCandidateLnkFiles(dirs, fsImpl, 2);
    const updated = [];

    for (const lnkPath of candidates) {
        let existing;
        try {
            existing = shell.readShortcutLink(lnkPath);
        } catch (_) {
            continue;
        }
        if (!looksLikePowerPilotShortcut(lnkPath, existing)) continue;
        try {
            const shortcutDetails = {
                target: existing.target,
                cwd: existing.cwd || (existing.target ? path.dirname(existing.target) : undefined),
                args: existing.args || undefined,
                description: existing.description || undefined,
                icon: icoPath,
                iconIndex: 0,
                appUserModelId: existing.appUserModelId || APP_USER_MODEL_ID
            };
            let ok = shell.writeShortcutLink(lnkPath, 'update', shortcutDetails);
            // Windows 11'de NSIS kısayolları 'update' çağrısında mevcut IconLocation'ı
            // korumaya çalışabilir; doğrulama farklı ikon gösterirse 'replace' ile yenile.
            if (ok) {
                try {
                    const verify = shell.readShortcutLink(lnkPath);
                    if (verify && typeof verify.icon === 'string' && verify.icon.length > 0
                        && verify.icon.toLowerCase() !== icoPath.toLowerCase()) {
                        ok = shell.writeShortcutLink(lnkPath, 'replace', shortcutDetails);
                    }
                } catch (_) { /* yut */ }
            } else {
                ok = shell.writeShortcutLink(lnkPath, 'replace', shortcutDetails);
            }
            if (ok) {
                // Explorer'ın değişikliği hemen algılaması için dosya zaman damgasını tazele.
                try {
                    const now = new Date();
                    fsImpl.utimesSync(lnkPath, now, now);
                } catch (_) { /* best-effort */ }
                updated.push(lnkPath);
            }
        } catch (err) {
            if (logger) logger.warn(`[AppIcon] kısayol güncellenemedi (${lnkPath}):`, err && err.message);
        }
    }
    return { updated, skipped: false };
}

/**
 * Masaüstünde (özellikle Portable kullanıcıları için) seçili dinamik ikona sahip
 * bir `.lnk` kısayolu oluşturur / günceller.
 */
function createDesktopShortcut({
    desktopDir,
    targetExePath,
    icoPath,
    shell,
    isPortable = false,
    shortcutName = null,
    platform = process.platform,
    execFileImpl = execFile,
    logger = null
} = {}) {
    if (platform !== 'win32' || !desktopDir || !targetExePath || !icoPath
        || !shell || typeof shell.writeShortcutLink !== 'function') {
        return { ok: false, code: 'UNSUPPORTED' };
    }
    const fileName = shortcutName || (isPortable ? 'Power Pilot Portable.lnk' : 'Power Pilot.lnk');
    const lnkPath = path.join(desktopDir, fileName);
    try {
        const ok = shell.writeShortcutLink(lnkPath, 'replace', {
            target: targetExePath,
            cwd: path.dirname(targetExePath),
            description: isPortable
                ? 'Power Pilot Portable - Smart Power Automation'
                : 'Power Pilot - Smart Power Automation',
            icon: icoPath,
            iconIndex: 0,
            appUserModelId: APP_USER_MODEL_ID
        });
        if (!ok) return { ok: false, code: 'WRITE_FAILED' };
        refreshWindowsIconCache({
            platform,
            execFileImpl,
            updatedPaths: [lnkPath],
            affectedDirs: [desktopDir]
        });
        return { ok: true, shortcutPath: lnkPath, iconPath: icoPath };
    } catch (err) {
        if (logger) logger.warn('[AppIcon] masaüstü kısayolu oluşturulamadı:', err && err.message);
        return { ok: false, code: 'WRITE_ERROR', error: err && err.message };
    }
}

function psSingleQuote(value) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

function encodePowerShellUtf16(script) {
    return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

/**
 * NSIS kurulumunda Windows "Yüklü Uygulamalar" `DisplayIcon` kaydını günceller.
 */
function updateUninstallDisplayIcon(icoPath, {
    platform = process.platform,
    isStoreBuild = false,
    isPortable = false,
    isPackaged = false,
    execFileImpl = execFile
} = {}) {
    if (platform !== 'win32' || !icoPath || isStoreBuild || isPortable || !isPackaged) return;
    const psScript = [
        "$ErrorActionPreference='SilentlyContinue'",
        `$ico = ${psSingleQuote(`${icoPath},0`)}`,
        "$roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
        "Get-ItemProperty $roots | Where-Object { $_.DisplayName -eq 'Power Pilot' -and $_.Publisher -like 'Vellium*' } | ForEach-Object { Set-ItemProperty -Path $_.PSPath -Name DisplayIcon -Value $ico }"
    ].join('\n');
    try {
        execFileImpl(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellUtf16(psScript)],
            { windowsHide: true, timeout: 15000 },
            () => { }
        );
    } catch (_) { /* best-effort */ }
}

/**
 * Windows Explorer masaüstü ve görev çubuğu simge önbelleğini tazeler (no-shell execFile).
 * Hem `ie4uinit.exe -show` hem de Win32 `Shell32::SHChangeNotify` (UPDATEITEM + UPDATEDIR + ASSOCCHANGED)
 * UTF-16LE `-EncodedCommand` ile tırnak bozulması olmadan tetiklenir.
 */
function refreshWindowsIconCache({
    platform = process.platform,
    execFileImpl = execFile,
    updatedPaths = [],
    affectedDirs = []
} = {}) {
    if (platform !== 'win32') return;
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const ie4uinit = path.join(sysRoot, 'System32', 'ie4uinit.exe');
    try {
        if (fs.existsSync(ie4uinit)) {
            execFileImpl(ie4uinit, ['-show'], { windowsHide: true, timeout: 8000 }, () => { });
        }
    } catch (_) { /* best-effort */ }

    const itemLines = Array.from(new Set((updatedPaths || []).filter(Boolean)))
        .map((p) => `[PPShNotify]::SHChangeNotify(0x00002000, 0x1005, ${psSingleQuote(p)}, $null)`);
    const dirSet = new Set((affectedDirs || []).filter(Boolean));
    for (const p of updatedPaths || []) {
        if (p) dirSet.add(path.dirname(p));
    }
    const dirLines = Array.from(dirSet)
        .map((d) => `[PPShNotify]::SHChangeNotify(0x00001000, 0x1005, ${psSingleQuote(d)}, $null)`);

    const psScript = [
        "$ErrorActionPreference='SilentlyContinue'",
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class PPShNotify {',
        '  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]',
        '  public static extern void SHChangeNotify(int wEventId, uint uFlags, string dwItem1, string dwItem2);',
        '  [DllImport("shell32.dll")]',
        '  public static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);',
        '}',
        '"@',
        ...itemLines,
        ...dirLines,
        '[PPShNotify]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)'
    ].join('\n');

    try {
        execFileImpl(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellUtf16(psScript)],
            { windowsHide: true, timeout: 15000 },
            () => { }
        );
    } catch (_) { /* best-effort */ }
}

/**
 * Seçilen ikonu çalışma zamanında tüm hedeflere uygular:
 * ana pencere, mini pencere, sistem tepsisi, kısayollar ve önbellek.
 */
function applyAppIcon(iconId, {
    mainWindow = null,
    miniWindow = null,
    tray = null,
    shell = null,
    nativeImage = null,
    rootDir = path.resolve(__dirname, '..', '..', '..'),
    resourcesPath = process.resourcesPath || null,
    userDataDir = null,
    customIconColor = null,
    desktopDirs = [],
    startMenuDirs = [],
    taskbarDirs = [],
    isPortable = false,
    isStoreBuild = false,
    isPackaged = false,
    updateShortcuts = true,
    platform = process.platform,
    fsImpl = fs,
    execFileImpl = execFile,
    logger = null
} = {}) {
    const id = normalizeAppIcon(iconId);
    const icoPath = resolveIconIcoPath(id, { rootDir, resourcesPath, userDataDir, customIconColor, isPackaged, fsImpl });
    const pngPath = resolveIconPngPath(id, { rootDir, resourcesPath, userDataDir, customIconColor, isPackaged, fsImpl });

    const windowIcon = buildRuntimeIconPayload(id, { icoPath, pngPath, nativeImage });
    const trayIcon = buildRuntimeIconPayload(id, { icoPath, pngPath, nativeImage, targetSize: 32 });

    if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setIcon === 'function') {
        try {
            mainWindow.setIcon(windowIcon);
            if (typeof mainWindow.setOverlayIcon === 'function') {
                try { mainWindow.setOverlayIcon(null, ''); } catch (_) { /* yut */ }
            }
        } catch (err) {
            if (logger) logger.warn('[AppIcon] ana pencere ikonu güncellenemedi:', err && err.message);
        }
    }

    if (miniWindow && !miniWindow.isDestroyed() && typeof miniWindow.setIcon === 'function') {
        try {
            miniWindow.setIcon(windowIcon);
        } catch (err) {
            if (logger) logger.warn('[AppIcon] mini pencere ikonu güncellenemedi:', err && err.message);
        }
    }

    if (tray && !tray.isDestroyed() && typeof tray.setImage === 'function') {
        try {
            tray.setImage(trayIcon);
        } catch (err) {
            if (logger) logger.warn('[AppIcon] tepsi ikonu güncellenemedi:', err && err.message);
        }
    }

    let shortcuts = { updated: [], skipped: !updateShortcuts };
    if (updateShortcuts && platform === 'win32') {
        const stableIco = ensureStableShortcutIco(id, {
            sourceIcoPath: icoPath,
            userDataDir,
            customIconColor,
            isPortable,
            isPackaged,
            fsImpl
        });
        shortcuts = updateWindowsShortcuts(stableIco, {
            shell,
            desktopDirs,
            startMenuDirs,
            taskbarDirs,
            isStoreBuild,
            platform,
            fsImpl,
            logger
        });
        updateUninstallDisplayIcon(stableIco, {
            platform,
            isStoreBuild,
            isPortable,
            isPackaged,
            execFileImpl
        });
        if (shortcuts.updated.length > 0) {
            refreshWindowsIconCache({
                platform,
                execFileImpl,
                updatedPaths: shortcuts.updated,
                affectedDirs: [...desktopDirs, ...startMenuDirs, ...taskbarDirs]
            });
        }
    }

    return {
        ok: true,
        iconId: id,
        customIconColor: id === 'custom' ? normalizeHexColor(customIconColor, DEFAULT_CUSTOM_COLOR) : null,
        icoPath,
        pngPath,
        shortcutsUpdated: shortcuts.updated,
        isPortable: !!isPortable
    };
}

module.exports = {
    APP_USER_MODEL_ID,
    CLASSIC_APP_ICON_IDS,
    THEME_APP_ICON_IDS,
    STATIC_APP_ICON_IDS,
    APP_ICON_IDS,
    DEFAULT_APP_ICON,
    isValidAppIcon,
    normalizeAppIcon,
    encodeIcoBmpFrame,
    encodeMultiResIco,
    writeCustomIconFiles,
    resolveIconIcoPath,
    resolveIconPngPath,
    buildRuntimeIconPayload,
    ensureStableShortcutIco,
    updateWindowsShortcuts,
    createDesktopShortcut,
    updateUninstallDisplayIcon,
    refreshWindowsIconCache,
    applyAppIcon
};
