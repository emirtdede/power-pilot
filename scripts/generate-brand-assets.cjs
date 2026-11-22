'use strict';

/**
 * scripts/generate-brand-assets.cjs
 *
 * Tek kaynaklı (vektör SVG) marka ve ikon üretim hattı:
 *  - 4 seçilebilir uygulama ikonu varyantı (SVG + 256px PNG + 7-kareli multi-DPI ICO)
 *    1. monochrome-dark     (VARSAYILAN - Siyah Zemin · Koyu Monokrom)
 *    2. monochrome-light    (Beyaz Zemin · Açık Monokrom)
 *    3. monochrome-contrast (Saf Siyah-Beyaz · Yüksek Kontrast)
 *    4. classic-cyan        (Klasik · Cyan)
 *  - Kök & renderer varsayılan ikonları (powerpilot_icon.ico, powerpilot_icon.png,
 *    src/assets/powerpilot_icon.png, public/power-pilot.svg)
 *  - Microsoft Store / MSIX tam çoklu-DPI varlık seti (build/appx/*.png:
 *    scale-100/125/150/200/400 + targetsize-16/24/32/48/256 + unplated/lightunplated
 *    + saf beyaz şeffaf BadgeLogo)
 *  - Partner Center mağaza listeleme logoları (docs/store/assets/microsoft-store/Logo/)
 *
 * Tüm PNG ve ICO kareleri Electron Chromium'un yerel SVG motoruyla 2x süper-örnekleme
 * (supersampling) ile kayıpsız üretilir; küçük boyutlarda (16/24/32/44px) bulanıklık olmaz.
 */

const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('@playwright/test');
const { THEME_ICON_PALETTES, buildBrandIconSvg } = require('../src/shared/customColorPalette');

const ROOT = path.resolve(__dirname, '..');
const SVG_NS = ['http', '://www.w3.org/2000/svg'].join('');

const THEME_VARIANT_SVGS = Object.fromEntries(
    Object.entries(THEME_ICON_PALETTES).map(([id, palette]) => [id, buildBrandIconSvg(palette)])
);

const ICON_VARIANTS = {
    'monochrome-dark': `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#27272a"/>
    </linearGradient>
    <linearGradient id="bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d4d4d8"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg-grad)"/>
  <circle cx="128" cy="128" r="80" fill="none" stroke="#a1a1aa" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="62" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.35"/>
  <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#bolt-grad)" filter="drop-shadow(0px 4px 6px rgba(0,0,0,0.55))"/>
</svg>
`,
    'monochrome-light': `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#e4e4e7"/>
    </linearGradient>
    <linearGradient id="bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#27272a"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="252" height="252" rx="55" fill="url(#bg-grad)" stroke="#d4d4d8" stroke-width="4"/>
  <circle cx="128" cy="128" r="80" fill="none" stroke="#71717a" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="62" fill="none" stroke="#18181b" stroke-width="4" opacity="0.3"/>
  <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#bolt-grad)" filter="drop-shadow(0px 4px 6px rgba(0,0,0,0.22))"/>
</svg>
`,
    'monochrome-contrast': `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="56" fill="#000000"/>
  <circle cx="128" cy="128" r="80" fill="none" stroke="#ffffff" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round" opacity="0.55"/>
  <circle cx="128" cy="128" r="62" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.3"/>
  <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="#ffffff"/>
</svg>
`,
    'classic-cyan': `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#1e272e"/>
      <stop offset="100%" stop-color="#485460"/>
    </linearGradient>
    <linearGradient id="bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0fbcf9"/>
      <stop offset="100%" stop-color="#00d8d6"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#bg-grad)"/>
  <circle cx="128" cy="128" r="80" fill="none" stroke="#808e9b" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"/>
  <circle cx="128" cy="128" r="62" fill="none" stroke="#d2dae2" stroke-width="4" opacity="0.5"/>
  <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#bolt-grad)" filter="drop-shadow(0px 4px 6px rgba(0,0,0,0.4))"/>
</svg>
`,
    ...THEME_VARIANT_SVGS
};

// Microsoft Store sertifikasyonu: BadgeLogo tamamen şeffaf arka plan üzerinde
// YALNIZCA saf beyaz (#ffffff) pikseller içermelidir.
const STORE_BADGE_SVG = `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <circle cx="128" cy="128" r="98" fill="none" stroke="#ffffff" stroke-width="20" stroke-dasharray="26 18" stroke-linecap="round"/>
  <path d="M140 50 L68 150 L118 150 L108 208 L188 104 L138 104 Z" fill="#ffffff"/>
</svg>
`;

// Geniş kutucuk ve SplashScreen için şeffaf tuvalde ortalanmış Koyu Monokrom logo.
function buildCenteredTileSvg(canvasW, canvasH, iconSize) {
    const x = Math.round((canvasW - iconSize) / 2);
    const y = Math.round((canvasH - iconSize) / 2);
    const scale = iconSize / 256;
    return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${canvasW} ${canvasH}" width="${canvasW}" height="${canvasH}">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#27272a"/>
    </linearGradient>
    <linearGradient id="bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#d4d4d8"/>
    </linearGradient>
  </defs>
  <g transform="translate(${x} ${y}) scale(${scale})">
    <rect width="256" height="256" rx="56" fill="url(#bg-grad)"/>
    <circle cx="128" cy="128" r="80" fill="none" stroke="#a1a1aa" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"/>
    <circle cx="128" cy="128" r="62" fill="none" stroke="#ffffff" stroke-width="4" opacity="0.35"/>
    <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#bolt-grad)" filter="drop-shadow(0px 4px 6px rgba(0,0,0,0.55))"/>
  </g>
</svg>`;
}

/**
 * 32-bit RGBA tamponundan klasik Windows ICO DIB BMP + 1-bit AND maskesi üretir.
 * NSIS makensis, Explorer ve klasik Win32 API'lerle %100 uyumludur.
 */
function encodeIcoBmpFrame(rgba, size) {
    const xorSize = size * size * 4;
    const maskRowBytes = Math.ceil(size / 32) * 4;
    const andSize = maskRowBytes * size;
    const buf = Buffer.alloc(40 + xorSize + andSize);

    // BITMAPINFOHEADER (40 bayt, yükseklik 2*size: XOR + AND)
    buf.writeUInt32LE(40, 0);
    buf.writeInt32LE(size, 4);
    buf.writeInt32LE(size * 2, 8);
    buf.writeUInt16LE(1, 12);
    buf.writeUInt16LE(32, 14);
    buf.writeUInt32LE(0, 16);
    buf.writeUInt32LE(xorSize + andSize, 20);

    // XOR bitmap (bottom-up BGRA)
    for (let y = 0; y < size; y++) {
        const srcRow = (size - 1 - y) * size * 4;
        const dstRow = 40 + y * size * 4;
        const maskRow = 40 + xorSize + y * maskRowBytes;
        for (let x = 0; x < size; x++) {
            const s = srcRow + x * 4;
            const d = dstRow + x * 4;
            const a = rgba[s + 3];
            buf[d] = rgba[s + 2];     // B
            buf[d + 1] = rgba[s + 1]; // G
            buf[d + 2] = rgba[s];     // R
            buf[d + 3] = a;           // A
            if (a === 0) {
                buf[maskRow + (x >> 3)] |= (0x80 >> (x & 7));
            }
        }
    }
    return buf;
}

/**
 * Çoklu çözünürlüklü ICO dosyası oluşturur:
 *  - 16, 24, 32, 48, 64, 128 px: 32-bit BGRA BMP DIB (NSIS + Explorer + Denetim Masası evrensel uyum)
 *  - 256 px: kayıpsız RGBA PNG (Windows Vista/10/11 yüksek DPI standardı)
 */
function encodeMultiResIco(frames) {
    const count = frames.length;
    const headerSize = 6 + count * 16;
    const payloads = frames.map((f) => (f.size <= 128 ? encodeIcoBmpFrame(f.rgba, f.size) : f.png));
    const totalSize = headerSize + payloads.reduce((sum, p) => sum + p.length, 0);
    const out = Buffer.alloc(totalSize);

    // ICONDIR
    out.writeUInt16LE(0, 0);
    out.writeUInt16LE(1, 2); // 1 = ICO
    out.writeUInt16LE(count, 4);

    let offset = headerSize;
    for (let i = 0; i < count; i++) {
        const { size } = frames[i];
        const data = payloads[i];
        const entry = 6 + i * 16;
        out[entry] = size >= 256 ? 0 : size;
        out[entry + 1] = size >= 256 ? 0 : size;
        out[entry + 2] = 0;
        out[entry + 3] = 0;
        out.writeUInt16LE(1, entry + 4);
        out.writeUInt16LE(32, entry + 6);
        out.writeUInt32LE(data.length, entry + 8);
        out.writeUInt32LE(offset, entry + 12);
        data.copy(out, offset);
        offset += data.length;
    }
    return out;
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const STORE_SCALES = [
    // StoreLogo (base 50x50)
    ['StoreLogo.scale-100.png', 50, 50, 'icon'],
    ['StoreLogo.scale-125.png', 63, 63, 'icon'],
    ['StoreLogo.scale-150.png', 75, 75, 'icon'],
    ['StoreLogo.scale-200.png', 100, 100, 'icon'],
    ['StoreLogo.scale-400.png', 200, 200, 'icon'],

    // Square44x44Logo (app list / taskbar / shell)
    ['Square44x44Logo.scale-100.png', 44, 44, 'icon'],
    ['Square44x44Logo.scale-125.png', 55, 55, 'icon'],
    ['Square44x44Logo.scale-150.png', 66, 66, 'icon'],
    ['Square44x44Logo.scale-200.png', 88, 88, 'icon'],
    ['Square44x44Logo.scale-400.png', 176, 176, 'icon'],

    // Targetsize + Unplated + LightUnplated (Windows 10/11 görev çubuğu plakasız keskin ikon)
    ...[16, 24, 32, 48, 256].flatMap((s) => ([
        [`Square44x44Logo.targetsize-${s}.png`, s, s, 'icon'],
        [`Square44x44Logo.targetsize-${s}_altform-unplated.png`, s, s, 'icon'],
        [`Square44x44Logo.targetsize-${s}_altform-lightunplated.png`, s, s, 'icon']
    ])),

    // SmallTile (base 71x71)
    ['SmallTile.scale-100.png', 71, 71, 'icon'],
    ['SmallTile.scale-125.png', 89, 89, 'icon'],
    ['SmallTile.scale-150.png', 107, 107, 'icon'],
    ['SmallTile.scale-200.png', 142, 142, 'icon'],
    ['SmallTile.scale-400.png', 284, 284, 'icon'],

    // Square150x150Logo (Medium Tile)
    ['Square150x150Logo.scale-100.png', 150, 150, 'icon'],
    ['Square150x150Logo.scale-125.png', 188, 188, 'icon'],
    ['Square150x150Logo.scale-150.png', 225, 225, 'icon'],
    ['Square150x150Logo.scale-200.png', 300, 300, 'icon'],
    ['Square150x150Logo.scale-400.png', 600, 600, 'icon'],

    // Wide310x150Logo (Wide Tile: şeffaf zemin + dengeli ortalanmış marka ikonu)
    ['Wide310x150Logo.scale-100.png', 310, 150, 'wide'],
    ['Wide310x150Logo.scale-125.png', 388, 188, 'wide'],
    ['Wide310x150Logo.scale-150.png', 465, 225, 'wide'],
    ['Wide310x150Logo.scale-200.png', 620, 300, 'wide'],
    ['Wide310x150Logo.scale-400.png', 1240, 600, 'wide'],

    // LargeTile (base 310x310)
    ['LargeTile.scale-100.png', 310, 310, 'icon'],
    ['LargeTile.scale-125.png', 388, 388, 'icon'],
    ['LargeTile.scale-150.png', 465, 465, 'icon'],
    ['LargeTile.scale-200.png', 620, 620, 'icon'],
    ['LargeTile.scale-400.png', 1240, 1240, 'icon'],

    // SplashScreen (base 620x300, max scale-200 = 1240x600)
    ['SplashScreen.scale-100.png', 620, 300, 'splash'],
    ['SplashScreen.scale-125.png', 775, 375, 'splash'],
    ['SplashScreen.scale-150.png', 930, 450, 'splash'],
    ['SplashScreen.scale-200.png', 1240, 600, 'splash'],

    // BadgeLogo (saf beyaz monokrom, şeffaf zemin)
    ['BadgeLogo.scale-100.png', 24, 24, 'badge'],
    ['BadgeLogo.scale-125.png', 30, 30, 'badge'],
    ['BadgeLogo.scale-150.png', 36, 36, 'badge'],
    ['BadgeLogo.scale-200.png', 48, 48, 'badge'],
    ['BadgeLogo.scale-400.png', 96, 96, 'badge']
];

async function rasterizeBatch(app, jobs) {
    return app.evaluate(async ({ BrowserWindow }, batch) => {
        const win = new BrowserWindow({
            width: 1280,
            height: 1280,
            show: false,
            webPreferences: { offscreen: true }
        });
        await win.loadURL('data:text/html;charset=utf-8,<!DOCTYPE html><html><body style="margin:0;background:transparent"></body></html>');
        const out = {};
        for (const job of batch) {
            const res = await win.webContents.executeJavaScript(`(async () => {
                const svg = ${JSON.stringify(job.svg)};
                const w = ${job.width};
                const h = ${job.height};
                const wantRgba = ${Boolean(job.wantRgba)};
                const superScale = w <= 256 && h <= 256 ? 2 : 1;
                const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
                const url = URL.createObjectURL(blob);
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = url;
                });
                let srcCanvas = img;
                if (superScale > 1) {
                    const hi = document.createElement('canvas');
                    hi.width = w * superScale;
                    hi.height = h * superScale;
                    const hctx = hi.getContext('2d');
                    hctx.imageSmoothingEnabled = true;
                    hctx.imageSmoothingQuality = 'high';
                    hctx.drawImage(img, 0, 0, hi.width, hi.height);
                    srcCanvas = hi;
                }
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(srcCanvas, 0, 0, w, h);
                URL.revokeObjectURL(url);
                const pngDataUrl = canvas.toDataURL('image/png');
                const png = pngDataUrl.slice(pngDataUrl.indexOf(',') + 1);
                let rgba = null;
                if (wantRgba) {
                    const bytes = ctx.getImageData(0, 0, w, h).data;
                    let bin = '';
                    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                    rgba = btoa(bin);
                }
                return { png, rgba };
            })()`);
            out[job.id] = res;
        }
        win.destroy();
        return out;
    }, jobs);
}

async function main() {
    delete process.env.ELECTRON_RUN_AS_NODE;

    const iconsDir = path.join(ROOT, 'src', 'assets', 'icons');
    const appxDir = path.join(ROOT, 'build', 'appx');
    const storeLogoDir = path.join(ROOT, 'docs', 'store', 'assets', 'microsoft-store', 'Logo');

    fs.mkdirSync(iconsDir, { recursive: true });
    fs.mkdirSync(appxDir, { recursive: true });
    fs.mkdirSync(storeLogoDir, { recursive: true });

    // 1) SVG kaynaklarını yaz
    for (const [id, svg] of Object.entries(ICON_VARIANTS)) {
        fs.writeFileSync(path.join(iconsDir, `${id}.svg`), svg, 'utf8');
    }
    const defaultSvg = ICON_VARIANTS['monochrome-dark'];
    fs.writeFileSync(path.join(ROOT, 'public', 'power-pilot.svg'), defaultSvg, 'utf8');
    fs.writeFileSync(path.join(storeLogoDir, 'power-pilot.svg'), defaultSvg, 'utf8');

    // 2) Tüm raster işlerini hazırla
    const jobs = [];
    for (const [id, svg] of Object.entries(ICON_VARIANTS)) {
        for (const size of ICO_SIZES) {
            jobs.push({
                id: `var:${id}:${size}`,
                svg,
                width: size,
                height: size,
                wantRgba: size <= 128
            });
        }
    }

    // Yüksek çözünürlüklü uygulama ve Partner Center PNG'leri
    for (const size of [71, 150, 300, 512, 1024]) {
        jobs.push({ id: `hero:${size}`, svg: defaultSvg, width: size, height: size, wantRgba: false });
    }

    // Microsoft Store / MSIX çoklu-DPI kutucuk ve ikonlar
    for (const [fileName, width, height, kind] of STORE_SCALES) {
        let svg;
        if (kind === 'icon') {
            svg = defaultSvg;
        } else if (kind === 'badge') {
            svg = STORE_BADGE_SVG;
        } else if (kind === 'wide') {
            svg = buildCenteredTileSvg(width, height, Math.round(height * 0.72));
        } else {
            // splash: geniş ekranda orantılı büyük merkez simge
            svg = buildCenteredTileSvg(width, height, Math.round(height * 0.64));
        }
        jobs.push({ id: `appx:${fileName}`, svg, width, height, wantRgba: false });
    }

    const app = await electron.launch({
        args: ['--disable-gpu'],
        env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
    });
    try {
        const rendered = await rasterizeBatch(app, jobs);

        // 3) 4 seçilebilir varyantın PNG + 7-kareli ICO dosyalarını yaz
        for (const id of Object.keys(ICON_VARIANTS)) {
            const frames = ICO_SIZES.map((size) => {
                const r = rendered[`var:${id}:${size}`];
                return {
                    size,
                    png: Buffer.from(r.png, 'base64'),
                    rgba: r.rgba ? Buffer.from(r.rgba, 'base64') : null
                };
            });
            const icoBuf = encodeMultiResIco(frames);
            fs.writeFileSync(path.join(iconsDir, `${id}.ico`), icoBuf);
            fs.writeFileSync(path.join(iconsDir, `${id}.png`), frames.find((f) => f.size === 256).png);
        }

        // 4) src/assets varsayılan 512px PNG
        const png512 = Buffer.from(rendered['hero:512'].png, 'base64');
        fs.writeFileSync(path.join(ROOT, 'src', 'assets', 'powerpilot_icon.png'), png512);

        // 5) Partner Center mağaza logoları
        for (const size of [71, 150, 300, 512, 1024]) {
            const buf = Buffer.from(rendered[`hero:${size}`].png, 'base64');
            fs.writeFileSync(path.join(storeLogoDir, `power-pilot-${size}-${size}.png`), buf);
        }

        // 6) build/appx temizliği (eski nitelemesiz PNG'ler MakePRI çakışması yaratmasın)
        for (const existing of fs.readdirSync(appxDir)) {
            if (existing.endsWith('.png')) {
                fs.rmSync(path.join(appxDir, existing), { force: true });
            }
        }
        for (const [fileName] of STORE_SCALES) {
            const buf = Buffer.from(rendered[`appx:${fileName}`].png, 'base64');
            fs.writeFileSync(path.join(appxDir, fileName), buf);
        }

        console.log(`[generate-brand-assets] OK - 4 ikon varyantı (SVG/PNG/7-boyutlu ICO), kök ikonlar, ${STORE_SCALES.length} Microsoft Store MSIX varlığı ve Partner Center logoları üretildi.`);
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[generate-brand-assets] HATA:', err);
        process.exit(1);
    });
}

module.exports = { ICON_VARIANTS, ICO_SIZES, STORE_SCALES, encodeMultiResIco };
