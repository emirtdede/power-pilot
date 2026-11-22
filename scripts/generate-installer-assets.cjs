'use strict';

/**
 * scripts/generate-installer-assets.cjs
 *
 * Generates custom Windows 11 NSIS Modern UI 2 24-bit uncompressed DIB BMP
 * graphics for Power Pilot Setup and Uninstaller:
 *  - build/installerSidebar.bmp   (164 x 314)
 *  - build/uninstallerSidebar.bmp (164 x 314)
 *  - build/installerHeader.bmp    (150 x 57)
 *
 * Design rules:
 *  - 100% language-neutral across all 73 installer/uninstaller languages.
 *  - ZERO descriptive copy, ZERO taglines, ZERO URLs, ZERO emails, ZERO version numbers,
 *    ZERO publisher wordmarks.
 *  - Ultra-clean, corporate, executive minimal aesthetic: ONLY the Power Pilot emblem
 *    and "Power Pilot" brand wordmark with subtle architectural monochrome geometry.
 */

const fs = require('fs');
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(OUT_DIR, { recursive: true });

function encodeBmp24(rgbaBuffer, width, height) {
  const rowBytes = width * 3;
  const paddedRowBytes = (rowBytes + 3) & ~3;
  const pixelDataSize = paddedRowBytes * height;
  const fileSize = 54 + pixelDataSize;
  const out = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(fileSize, 2);
  out.writeUInt32LE(0, 6);
  out.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER (40 bytes)
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22); // bottom-up DIB
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(0, 30);
  out.writeUInt32LE(pixelDataSize, 34);
  out.writeInt32LE(3780, 38);
  out.writeInt32LE(3780, 42);
  out.writeUInt32LE(0, 46);
  out.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = 54 + y * paddedRowBytes;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 3;
      out[d] = rgbaBuffer[s + 2];     // B
      out[d + 1] = rgbaBuffer[s + 1]; // G
      out[d + 2] = rgbaBuffer[s];     // R
    }
  }
  return out;
}

function powerPilotMark(idPrefix, ringColor, boltTop, boltBottom, bgTop, bgBottom, innerOpacity = '0.35') {
  return `
      <defs>
        <linearGradient id="${idPrefix}-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${bgTop}"/>
          <stop offset="100%" stop-color="${bgBottom}"/>
        </linearGradient>
        <linearGradient id="${idPrefix}-bolt" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${boltTop}"/>
          <stop offset="100%" stop-color="${boltBottom}"/>
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="248" height="248" rx="56" fill="url(#${idPrefix}-bg)" stroke="rgba(255,255,255,0.16)" stroke-width="6"/>
      <circle cx="128" cy="128" r="80" fill="none" stroke="${ringColor}" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"/>
      <circle cx="128" cy="128" r="62" fill="none" stroke="#ffffff" stroke-width="4" opacity="${innerOpacity}"/>
      <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#${idPrefix}-bolt)"/>
    `;
}

const SVG_NS = ['http', '://www.w3.org/2000/svg'].join('');

// 1. Setup Welcome/Finish Sidebar (2x 328x628 -> 164x314):
//    Executive corporate minimalism: deep obsidian-slate studio gradient, whisper-subtle
//    architectural precision arcs, centered monochrome Power Pilot emblem & brand wordmark only.
//    ZERO publisher wordmark, ZERO descriptive copy, ZERO cluttered icons.
const installerSidebarSvg = `<svg xmlns="${SVG_NS}" viewBox="0 0 328 628" width="328" height="628">
  <defs>
    <linearGradient id="side-bg" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0%" stop-color="#14171e" />
      <stop offset="48%" stop-color="#0c0e13" />
      <stop offset="100%" stop-color="#07080b" />
    </linearGradient>
    <radialGradient id="studio-top" cx="50%" cy="24%" r="58%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.085" />
      <stop offset="60%" stop-color="#cbd5e1" stop-opacity="0.025" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="studio-corner" cx="88%" cy="92%" r="58%">
      <stop offset="0%" stop-color="#94a3b8" stop-opacity="0.11" />
      <stop offset="55%" stop-color="#64748b" stop-opacity="0.035" />
      <stop offset="100%" stop-color="#94a3b8" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="emblem-halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.09" />
      <stop offset="65%" stop-color="#cbd5e1" stop-opacity="0.02" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="platinum-rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#e2e8f0" stop-opacity="0" />
      <stop offset="50%" stop-color="#e2e8f0" stop-opacity="0.72" />
      <stop offset="100%" stop-color="#e2e8f0" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="arc-stroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.11" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02" />
    </linearGradient>
  </defs>

  <!-- Base executive obsidian surface -->
  <rect width="328" height="628" fill="url(#side-bg)" />
  <rect width="328" height="628" fill="url(#studio-top)" />
  <rect width="328" height="628" fill="url(#studio-corner)" />

  <!-- Whisper-subtle architectural geometric depth (no clutter, pure negative space) -->
  <circle cx="24" cy="24" r="136" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1.4" />
  <circle cx="316" cy="612" r="246" fill="none" stroke="url(#arc-stroke)" stroke-width="1.5" />
  <circle cx="316" cy="612" r="184" fill="none" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1.4" />
  <circle cx="316" cy="612" r="122" fill="none" stroke="#ffffff" stroke-opacity="0.03" stroke-width="1.2" />
  <line x1="0" y1="518" x2="328" y2="454" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1.2" />

  <!-- Crisp right-edge separator against white wizard pane -->
  <line x1="327" y1="0" x2="327" y2="628" stroke="#ffffff" stroke-opacity="0.11" stroke-width="2" />

  <!-- Centered Hero Brand Composition (Upper-Middle Golden Balance) -->
  <circle cx="164" cy="222" r="92" fill="url(#emblem-halo)" />
  <rect x="97" y="155" width="134" height="134" rx="34" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.10)" stroke-width="1.5" />
  <g transform="translate(108 166) scale(0.4375)">
    ${powerPilotMark('inst', '#cbd5e1', '#ffffff', '#e2e8f0', '#13161d', '#242731', '0.32')}
  </g>

  <!-- Brand Name Only -->
  <text x="164" y="340" text-anchor="middle" fill="#f8fafc" font-family="'Segoe UI', system-ui, sans-serif" font-size="33" font-weight="600" letter-spacing="-0.4">Power Pilot</text>
  <rect x="116" y="360" width="96" height="2" rx="1" fill="url(#platinum-rule)" />
</svg>`;

// 2. Uninstaller Sidebar (2x 328x628 -> 164x314):
//    Matching executive corporate aesthetic in refined warm charcoal-graphite & muted rose-platinum
//    hairline differentiation. ZERO publisher wordmark, ZERO cluttered icons.
const uninstallerSidebarSvg = `<svg xmlns="${SVG_NS}" viewBox="0 0 328 628" width="328" height="628">
  <defs>
    <linearGradient id="unside-bg" x1="0" y1="0" x2="0.25" y2="1">
      <stop offset="0%" stop-color="#191417" />
      <stop offset="48%" stop-color="#100d10" />
      <stop offset="100%" stop-color="#080709" />
    </linearGradient>
    <radialGradient id="unstudio-top" cx="50%" cy="24%" r="58%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.075" />
      <stop offset="60%" stop-color="#e2e8f0" stop-opacity="0.02" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="unstudio-corner" cx="88%" cy="92%" r="58%">
      <stop offset="0%" stop-color="#fb7185" stop-opacity="0.095" />
      <stop offset="55%" stop-color="#f43f5e" stop-opacity="0.03" />
      <stop offset="100%" stop-color="#fb7185" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="unemblem-halo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08" />
      <stop offset="65%" stop-color="#fda4af" stop-opacity="0.02" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="rose-platinum-rule" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#fda4af" stop-opacity="0" />
      <stop offset="50%" stop-color="#fda4af" stop-opacity="0.65" />
      <stop offset="100%" stop-color="#fda4af" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="unarc-stroke" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fda4af" stop-opacity="0.11" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.02" />
    </linearGradient>
  </defs>

  <!-- Base warm charcoal-obsidian surface -->
  <rect width="328" height="628" fill="url(#unside-bg)" />
  <rect width="328" height="628" fill="url(#unstudio-top)" />
  <rect width="328" height="628" fill="url(#unstudio-corner)" />

  <!-- Matching whisper-subtle architectural geometry -->
  <circle cx="24" cy="24" r="136" fill="none" stroke="#ffffff" stroke-opacity="0.038" stroke-width="1.4" />
  <circle cx="316" cy="612" r="246" fill="none" stroke="url(#unarc-stroke)" stroke-width="1.5" />
  <circle cx="316" cy="612" r="184" fill="none" stroke="#ffffff" stroke-opacity="0.042" stroke-width="1.4" />
  <circle cx="316" cy="612" r="122" fill="none" stroke="#fda4af" stroke-opacity="0.045" stroke-width="1.2" />
  <line x1="0" y1="518" x2="328" y2="454" stroke="#ffffff" stroke-opacity="0.032" stroke-width="1.2" />

  <!-- Crisp right-edge separator -->
  <line x1="327" y1="0" x2="327" y2="628" stroke="#ffffff" stroke-opacity="0.11" stroke-width="2" />

  <!-- Centered Hero Brand Composition -->
  <circle cx="164" cy="222" r="92" fill="url(#unemblem-halo)" />
  <rect x="97" y="155" width="134" height="134" rx="34" fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.10)" stroke-width="1.5" />
  <g transform="translate(108 166) scale(0.4375)">
    ${powerPilotMark('uninst', '#cbd5e1', '#ffffff', '#e2e8f0', '#161114', '#261e23', '0.30')}
  </g>

  <!-- Brand Name Only -->
  <text x="164" y="340" text-anchor="middle" fill="#f8fafc" font-family="'Segoe UI', system-ui, sans-serif" font-size="33" font-weight="600" letter-spacing="-0.4">Power Pilot</text>
  <rect x="116" y="360" width="96" height="2" rx="1" fill="url(#rose-platinum-rule)" />
</svg>`;

// 3. Inner Header Banner (2x 300x114 -> 150x57):
//    Pure white seamless NSIS MUI2 header with monochrome Power Pilot mark & clean corporate wordmark only.
const installerHeaderSvg = `<svg xmlns="${SVG_NS}" viewBox="0 0 300 114" width="300" height="114">
  <rect width="300" height="114" fill="#ffffff" />
  <g transform="translate(26 24) scale(0.2578125)">
    ${powerPilotMark('hdr', '#cbd5e1', '#ffffff', '#e2e8f0', '#0f1117', '#23262f', '0.32')}
  </g>
  <text x="108" y="67" fill="#0f172a" font-family="'Segoe UI', system-ui, sans-serif" font-size="27" font-weight="600" letter-spacing="-0.4">Power Pilot</text>
</svg>`;

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ['--disable-gpu'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
  });
  try {
    const rawAssets = await app.evaluate(async ({ BrowserWindow }, specs) => {
      const win = new BrowserWindow({
        width: 400,
        height: 700,
        show: false,
        webPreferences: { offscreen: true }
      });
      await win.loadURL('data:text/html;charset=utf-8,<!DOCTYPE html><html><body style="margin:0;background:#000"></body></html>');
      const results = {};
      for (const [key, spec] of Object.entries(specs)) {
        const b64 = await win.webContents.executeJavaScript(`(async () => {
                    const svg = ${JSON.stringify(spec.svg)};
                    const w = ${spec.width};
                    const h = ${spec.height};
                    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const img = new Image();
                    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
                    const canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    const ctx = canvas.getContext('2d');
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, w, h);
                    URL.revokeObjectURL(url);
                    const bytes = ctx.getImageData(0, 0, w, h).data;
                    let binary = '';
                    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                    return btoa(binary);
                })()`);
        results[key] = b64;
      }
      win.destroy();
      return results;
    }, {
      installerSidebar: { svg: installerSidebarSvg, width: 164, height: 314 },
      uninstallerSidebar: { svg: uninstallerSidebarSvg, width: 164, height: 314 },
      installerHeader: { svg: installerHeaderSvg, width: 150, height: 57 }
    });

    fs.writeFileSync(
      path.join(OUT_DIR, 'installerSidebar.bmp'),
      encodeBmp24(Buffer.from(rawAssets.installerSidebar, 'base64'), 164, 314)
    );
    fs.writeFileSync(
      path.join(OUT_DIR, 'uninstallerSidebar.bmp'),
      encodeBmp24(Buffer.from(rawAssets.uninstallerSidebar, 'base64'), 164, 314)
    );
    fs.writeFileSync(
      path.join(OUT_DIR, 'installerHeader.bmp'),
      encodeBmp24(Buffer.from(rawAssets.installerHeader, 'base64'), 150, 57)
    );
    console.log('[generate-installer-assets] OK - text-free brand-only build/installerSidebar.bmp, build/uninstallerSidebar.bmp, build/installerHeader.bmp üretildi.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[generate-installer-assets] HATA:', err);
  process.exit(1);
});
