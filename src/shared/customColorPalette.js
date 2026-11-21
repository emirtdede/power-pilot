/**
 * customColorPalette.js - Tek kaynaklı özel tema rengi ve tema-uyumlu Power Pilot
 * marka ikonu palet üreteci.
 *
 * Hem Node (main process, AppIconService, generate-brand-assets.cjs) hem de
 * tarayıcı (theme-boot.js, app.js) ortamında çalışır. Harici bağımlılık yoktur.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root && typeof root === 'object') {
        root.PPColorPalette = api;
        if (typeof root.__ppApplyCustomCss === 'function' && root.__ppEarlyTheme) {
            root.__ppApplyCustomCss(root.__ppEarlyTheme.customThemeColor, root.__ppEarlyTheme.customIconColor);
        }
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
    const DEFAULT_CUSTOM_COLOR = '#3b82f6';
    const SVG_NS = ['http', '://www.w3.org/2000/svg'].join('');

    const THEME_BASE_HEX = Object.freeze({
        obsidian: '#18181b',
        slate: '#475569',
        navy: '#1e3a8a',
        blue: '#2563eb',
        cyan: '#0891b2',
        indigo: '#4f46e5',
        purple: '#7c3aed',
        pink: '#db2777',
        red: '#dc2626',
        orange: '#ea580c',
        yellow: '#eab308',
        emerald: '#059669',
        grass: '#16a34a',
        lime: '#65a30d'
    });

    const CLASSIC_ICON_PALETTES = Object.freeze({
        'monochrome-dark': Object.freeze({
            bg1: '#09090b', bg2: '#27272a', border: 'rgba(255,255,255,0.12)',
            ringOuter: '#a1a1aa', ringOuterOp: 1,
            ringInner: '#ffffff', ringInnerOp: 0.35,
            bolt1: '#ffffff', bolt2: '#d4d4d8',
            shadow: 'rgba(0,0,0,0.55)', isLightFrame: false
        }),
        'monochrome-light': Object.freeze({
            bg1: '#ffffff', bg2: '#e4e4e7', border: '#d4d4d8',
            ringOuter: '#71717a', ringOuterOp: 1,
            ringInner: '#18181b', ringInnerOp: 0.30,
            bolt1: '#09090b', bolt2: '#27272a',
            shadow: 'rgba(0,0,0,0.22)', isLightFrame: true
        }),
        'monochrome-contrast': Object.freeze({
            bg1: '#000000', bg2: '#000000', border: 'rgba(255,255,255,0.16)',
            ringOuter: '#ffffff', ringOuterOp: 0.55,
            ringInner: '#ffffff', ringInnerOp: 0.30,
            bolt1: '#ffffff', bolt2: '#ffffff',
            shadow: null, isLightFrame: false
        }),
        'classic-cyan': Object.freeze({
            bg1: '#1e272e', bg2: '#485460', border: 'rgba(255,255,255,0.10)',
            ringOuter: '#808e9b', ringOuterOp: 1,
            ringInner: '#d2dae2', ringInnerOp: 0.50,
            bolt1: '#0fbcf9', bolt2: '#00d8d6',
            shadow: 'rgba(0,0,0,0.40)', isLightFrame: false
        })
    });

    const THEME_ICON_PALETTES = Object.freeze({
        'theme-obsidian': Object.freeze({
            bg1: '#111114', bg2: '#2e2e36', border: 'rgba(255,255,255,0.14)',
            ringOuter: '#a1a1aa', ringOuterOp: 0.92,
            ringInner: '#f4f4f5', ringInnerOp: 0.35,
            bolt1: '#ffffff', bolt2: '#e4e4e7',
            shadow: 'rgba(0,0,0,0.50)', isLightFrame: false
        }),
        'theme-slate': Object.freeze({
            bg1: '#1e293b', bg2: '#475569', border: 'rgba(255,255,255,0.14)',
            ringOuter: '#cbd5e1', ringOuterOp: 0.85,
            ringInner: '#f8fafc', ringInnerOp: 0.38,
            bolt1: '#ffffff', bolt2: '#e2e8f0',
            shadow: 'rgba(15,23,42,0.48)', isLightFrame: false
        }),
        'theme-navy': Object.freeze({
            bg1: '#0f1f4d', bg2: '#1e3a8a', border: 'rgba(147,197,253,0.22)',
            ringOuter: '#93c5fd', ringOuterOp: 0.90,
            ringInner: '#dbeafe', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#dbeafe',
            shadow: 'rgba(15,23,42,0.48)', isLightFrame: false
        }),
        'theme-blue': Object.freeze({
            bg1: '#1d4ed8', bg2: '#3b82f6', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#bfdbfe', ringOuterOp: 0.92,
            ringInner: '#ffffff', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#eff6ff',
            shadow: 'rgba(30,58,138,0.42)', isLightFrame: false
        }),
        'theme-cyan': Object.freeze({
            bg1: '#0e7490', bg2: '#06b6d4', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#a5f3fc', ringOuterOp: 0.92,
            ringInner: '#ecfeff', ringInnerOp: 0.44,
            bolt1: '#ffffff', bolt2: '#cffafe',
            shadow: 'rgba(8,51,68,0.42)', isLightFrame: false
        }),
        'theme-indigo': Object.freeze({
            bg1: '#3730a3', bg2: '#6366f1', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#c7d2fe', ringOuterOp: 0.92,
            ringInner: '#eef2ff', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#e0e7ff',
            shadow: 'rgba(30,27,75,0.45)', isLightFrame: false
        }),
        'theme-purple': Object.freeze({
            bg1: '#5b21b6', bg2: '#8b5cf6', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#ddd6fe', ringOuterOp: 0.92,
            ringInner: '#f5f3ff', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#ede9fe',
            shadow: 'rgba(46,16,101,0.45)', isLightFrame: false
        }),
        'theme-pink': Object.freeze({
            bg1: '#9d174d', bg2: '#ec4899', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#fbcfe8', ringOuterOp: 0.92,
            ringInner: '#fdf2f8', ringInnerOp: 0.44,
            bolt1: '#ffffff', bolt2: '#fce7f3',
            shadow: 'rgba(80,7,36,0.45)', isLightFrame: false
        }),
        'theme-red': Object.freeze({
            bg1: '#991b1b', bg2: '#ef4444', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#fecaca', ringOuterOp: 0.92,
            ringInner: '#fef2f2', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#fee2e2',
            shadow: 'rgba(69,10,10,0.45)', isLightFrame: false
        }),
        'theme-orange': Object.freeze({
            bg1: '#c2410c', bg2: '#f97316', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#fed7aa', ringOuterOp: 0.94,
            ringInner: '#fff7ed', ringInnerOp: 0.44,
            bolt1: '#ffffff', bolt2: '#ffedd5',
            shadow: 'rgba(67,20,7,0.42)', isLightFrame: false
        }),
        'theme-yellow': Object.freeze({
            bg1: '#ca8a04', bg2: '#facc15', border: 'rgba(24,24,27,0.16)',
            ringOuter: '#422006', ringOuterOp: 0.58,
            ringInner: '#422006', ringInnerOp: 0.28,
            bolt1: '#18181b', bolt2: '#27272a',
            shadow: 'rgba(66,32,6,0.22)', isLightFrame: false
        }),
        'theme-emerald': Object.freeze({
            bg1: '#065f46', bg2: '#10b981', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#a7f3d0', ringOuterOp: 0.92,
            ringInner: '#ecfdf5', ringInnerOp: 0.42,
            bolt1: '#ffffff', bolt2: '#d1fae5',
            shadow: 'rgba(2,44,34,0.45)', isLightFrame: false
        }),
        'theme-grass': Object.freeze({
            bg1: '#166534', bg2: '#22c55e', border: 'rgba(255,255,255,0.20)',
            ringOuter: '#bbf7d0', ringOuterOp: 0.92,
            ringInner: '#f0fdf4', ringInnerOp: 0.44,
            bolt1: '#ffffff', bolt2: '#dcfce7',
            shadow: 'rgba(5,46,22,0.42)', isLightFrame: false
        }),
        'theme-lime': Object.freeze({
            bg1: '#4d7c0f', bg2: '#a3e635', border: 'rgba(24,24,27,0.16)',
            ringOuter: '#1a2e05', ringOuterOp: 0.58,
            ringInner: '#1a2e05', ringInnerOp: 0.28,
            bolt1: '#142604', bolt2: '#1a2e05',
            shadow: 'rgba(26,46,5,0.22)', isLightFrame: false
        })
    });

    const THEME_ID_TO_ICON_ID = Object.freeze({
        obsidian: 'theme-obsidian',
        slate: 'theme-slate',
        navy: 'theme-navy',
        blue: 'theme-blue',
        cyan: 'theme-cyan',
        indigo: 'theme-indigo',
        purple: 'theme-purple',
        pink: 'theme-pink',
        red: 'theme-red',
        orange: 'theme-orange',
        yellow: 'theme-yellow',
        emerald: 'theme-emerald',
        grass: 'theme-grass',
        lime: 'theme-lime',
        custom: 'custom'
    });

    function clamp(val, min, max) {
        return Math.min(max, Math.max(min, val));
    }

    function normalizeHexColor(raw, fallback) {
        const fb = typeof fallback === 'string' && HEX_COLOR_RE.test(fallback)
            ? fallback.toLowerCase()
            : DEFAULT_CUSTOM_COLOR;
        if (typeof raw !== 'string') return fb;
        let s = raw.trim();
        if (!s) return fb;
        if (s[0] !== '#') s = '#' + s;
        if (/^#[0-9a-fA-F]{3}$/.test(s)) {
            s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        }
        return HEX_COLOR_RE.test(s) ? s.toLowerCase() : fb;
    }

    function isValidHexColor(raw) {
        return typeof raw === 'string' && HEX_COLOR_RE.test(raw.trim());
    }

    function hexToRgb(hex) {
        const clean = normalizeHexColor(hex).slice(1);
        return {
            r: parseInt(clean.slice(0, 2), 16),
            g: parseInt(clean.slice(2, 4), 16),
            b: parseInt(clean.slice(4, 6), 16)
        };
    }

    function rgbToHex(r, g, b) {
        const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    function rgbToHsl(r, g, b) {
        const rn = r / 255;
        const gn = g / 255;
        const bn = b / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const l = (max + min) / 2;
        let h = 0;
        let s = 0;
        if (max !== min) {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
                case gn: h = ((bn - rn) / d + 2) / 6; break;
                default: h = ((rn - gn) / d + 4) / 6; break;
            }
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    function hslToRgb(h, s, l) {
        const hn = ((h % 360) + 360) % 360 / 360;
        const sn = clamp(s, 0, 100) / 100;
        const ln = clamp(l, 0, 100) / 100;
        if (sn === 0) {
            const v = Math.round(ln * 255);
            return { r: v, g: v, b: v };
        }
        const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
        const p = 2 * ln - q;
        const hue2rgb = (t) => {
            let tt = t;
            if (tt < 0) tt += 1;
            if (tt > 1) tt -= 1;
            if (tt < 1 / 6) return p + (q - p) * 6 * tt;
            if (tt < 1 / 2) return q;
            if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
            return p;
        };
        return {
            r: Math.round(hue2rgb(hn + 1 / 3) * 255),
            g: Math.round(hue2rgb(hn) * 255),
            b: Math.round(hue2rgb(hn - 1 / 3) * 255)
        };
    }

    function hslToHex(h, s, l) {
        const rgb = hslToRgb(h, s, l);
        return rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    function relativeLuminance(hex) {
        const { r, g, b } = hexToRgb(hex);
        const lin = (c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    }

    function contrastRatio(hexA, hexB) {
        const l1 = relativeLuminance(hexA);
        const l2 = relativeLuminance(hexB);
        const hi = Math.max(l1, l2);
        const lo = Math.min(l1, l2);
        return (hi + 0.05) / (lo + 0.05);
    }

    function pickBestForeground(bgHex) {
        const whiteRatio = contrastRatio(bgHex, '#ffffff');
        const darkRatio = contrastRatio(bgHex, '#09090b');
        return darkRatio >= whiteRatio ? '#09090b' : '#ffffff';
    }

    /**
     * Metin için okunabilir bir vurgu tonu üretir.
     *
     * `--accent` bir DOLGU rengidir; metin olarak kullanıldığında açık
     * paletlerin çoğu beyaz zemin üzerinde WCAG AA (4.5:1) eşiğinin altında
     * kalır. Bu yüzden metin/ikon için ayrı bir token (`--accent-text`)
     * üretilir: aynı ton korunarak, verilen zeminlerin HEPSİNDE eşiği
     * tutana kadar koyulaştırılır (açık mod) veya aydınlatılır (koyu mod).
     *
     * Yaklaşım GitHub Primer / Material Design ile aynıdır: dolgu ve metin
     * token'ları ayrıdır, metin token'ı kontrast için ölçülerek seçilir.
     */
    function buildAccessibleTextAccent(accentHex, bgHexes, isDark, target = 4.5) {
        const validBgs = (bgHexes || []).filter(isValidHexColor);
        if (!validBgs.length) return accentHex;
        const worstOf = (hex) => Math.min(...validBgs.map((b) => contrastRatio(hex, b)));
        if (worstOf(accentHex) >= target) return accentHex;

        const { r, g, b } = hexToRgb(accentHex);
        let best = accentHex;
        let bestWorst = worstOf(accentHex);
        for (let step = 1; step <= 100; step++) {
            const f = step / 100;
            const cand = isDark
                ? rgbToHex(
                    Math.round(r + (255 - r) * f),
                    Math.round(g + (255 - g) * f),
                    Math.round(b + (255 - b) * f)
                )
                : rgbToHex(
                    Math.round(r * (1 - f)),
                    Math.round(g * (1 - f)),
                    Math.round(b * (1 - f))
                );
            const w = worstOf(cand);
            if (w >= target) return cand;
            if (w > bestWorst) { best = cand; bestWorst = w; }
        }
        return best;
    }

    /**
     * Verilen HEX renginden açık ve koyu modlar için WCAG AA uyumlu
     * eksiksiz CSS değişken paletleri üretir.
     */
    function buildCustomThemeTokens(rawHex) {
        const hex = normalizeHexColor(rawHex);
        const rgb = hexToRgb(hex);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
        const tintS = clamp(hsl.s * 0.28, 0, 26);

        // Açık mod vurgusu: çok açık seçilmişse metin/düğme okunurluğu için hafif koyulaştır.
        let lightAccent = hex;
        if (contrastRatio(lightAccent, '#ffffff') < 2.6) {
            lightAccent = hslToHex(hsl.h, clamp(hsl.s, 15, 92), clamp(hsl.l * 0.56, 26, 46));
        }
        const lightAccentRgb = hexToRgb(lightAccent);
        const lightAccentHsl = rgbToHsl(lightAccentRgb.r, lightAccentRgb.g, lightAccentRgb.b);
        const lightAccentHover = hslToHex(
            lightAccentHsl.h,
            lightAccentHsl.s,
            lightAccentHsl.l > 22 ? clamp(lightAccentHsl.l - 8, 8, 92) : clamp(lightAccentHsl.l + 10, 8, 92)
        );
        const lightAccentFg = pickBestForeground(lightAccent);

        // Koyu mod vurgusu: çok koyu seçilmişse karanlık yüzeyde kaybolmaması için hafif aç.
        const darkSurface = hslToHex(hsl.h, clamp(hsl.s * 0.30, 0, 28), 10.5);
        let darkAccent = hex;
        if (contrastRatio(darkAccent, darkSurface) < 2.8) {
            darkAccent = hslToHex(hsl.h, clamp(hsl.s, 18, 92), clamp(Math.max(hsl.l, 62), 58, 76));
        }
        const darkAccentRgb = hexToRgb(darkAccent);
        const darkAccentHsl = rgbToHsl(darkAccentRgb.r, darkAccentRgb.g, darkAccentRgb.b);
        const darkAccentHover = hslToHex(
            darkAccentHsl.h,
            darkAccentHsl.s,
            darkAccentHsl.l < 82 ? clamp(darkAccentHsl.l + 8, 12, 94) : clamp(darkAccentHsl.l - 9, 12, 94)
        );
        const darkAccentFg = pickBestForeground(darkAccent);

        const lightBg = [
            hslToHex(hsl.h, tintS * 0.72, 97.6),
            '#ffffff',
            hslToHex(hsl.h, tintS * 0.90, 94.8),
            hslToHex(hsl.h, tintS, 91.0)
        ];
        const darkBg = [
            hslToHex(hsl.h, clamp(hsl.s * 0.34, 0, 30), 6.5),
            darkSurface,
            hslToHex(hsl.h, clamp(hsl.s * 0.28, 0, 26), 14.5),
            hslToHex(hsl.h, clamp(hsl.s * 0.26, 0, 24), 19.0)
        ];
        const lightAccentText = buildAccessibleTextAccent(lightAccent, lightBg, false);
        const darkAccentText = buildAccessibleTextAccent(darkAccent, darkBg, true);

        const light = {
            '--canvas': hslToHex(hsl.h, tintS * 0.72, 97.6),
            '--surface': '#ffffff',
            '--surface-subtle': hslToHex(hsl.h, tintS * 0.90, 94.8),
            '--surface-hover': hslToHex(hsl.h, tintS, 91.0),
            '--border': hslToHex(hsl.h, tintS * 0.85, 86.2),
            '--border-strong': hslToHex(hsl.h, tintS * 0.90, 75.5),
            '--text-primary': hslToHex(hsl.h, clamp(tintS * 1.1, 0, 30), 11),
            '--text-secondary': hslToHex(hsl.h, clamp(tintS * 0.7, 0, 20), 34),
            '--text-muted': hslToHex(hsl.h, clamp(tintS * 0.65, 0, 18), 43),
            '--accent': lightAccent,
            '--accent-text': lightAccentText,
            '--accent-hover': lightAccentHover,
            '--accent-soft': `rgba(${lightAccentRgb.r}, ${lightAccentRgb.g}, ${lightAccentRgb.b}, 0.12)`,
            '--accent-ring': `rgba(${lightAccentRgb.r}, ${lightAccentRgb.g}, ${lightAccentRgb.b}, 0.30)`,
            '--accent-fg': lightAccentFg
        };

        const dark = {
            '--canvas': hslToHex(hsl.h, clamp(hsl.s * 0.34, 0, 30), 6.5),
            '--surface': darkSurface,
            '--surface-subtle': hslToHex(hsl.h, clamp(hsl.s * 0.28, 0, 26), 14.5),
            '--surface-hover': hslToHex(hsl.h, clamp(hsl.s * 0.26, 0, 24), 19.0),
            '--border': hslToHex(hsl.h, clamp(hsl.s * 0.25, 0, 24), 22.5),
            '--border-strong': hslToHex(hsl.h, clamp(hsl.s * 0.24, 0, 24), 31.5),
            '--text-primary': hslToHex(hsl.h, clamp(tintS * 0.55, 0, 16), 96),
            '--text-secondary': hslToHex(hsl.h, clamp(tintS * 0.50, 0, 16), 72),
            '--text-muted': hslToHex(hsl.h, clamp(tintS * 0.45, 0, 14), 58),
            '--accent': darkAccent,
            '--accent-text': darkAccentText,
            '--accent-hover': darkAccentHover,
            '--accent-soft': `rgba(${darkAccentRgb.r}, ${darkAccentRgb.g}, ${darkAccentRgb.b}, 0.15)`,
            '--accent-ring': `rgba(${darkAccentRgb.r}, ${darkAccentRgb.g}, ${darkAccentRgb.b}, 0.32)`,
            '--accent-fg': darkAccentFg
        };

        return {
            hex,
            light,
            dark,
            lightContrast: Math.round(contrastRatio(lightAccent, lightAccentFg) * 10) / 10,
            darkContrast: Math.round(contrastRatio(darkAccent, darkAccentFg) * 10) / 10,
            lightAccentTextContrast: Math.round(Math.min(...lightBg.map((b) => contrastRatio(lightAccentText, b))) * 10) / 10,
            darkAccentTextContrast: Math.round(Math.min(...darkBg.map((b) => contrastRatio(darkAccentText, b))) * 10) / 10
        };
    }

    /**
     * Herhangi bir HEX rengi için yüksek kontrastlı Power Pilot uygulama ikonu paleti üretir.
     */
    function buildCustomIconPalette(rawHex) {
        const hex = normalizeHexColor(rawHex);
        const rgb = hexToRgb(hex);
        const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);

        const bg1 = hslToHex(hsl.h, clamp(hsl.s, 0, 96), clamp(hsl.l - 13, 7, 84));
        const bg2 = hslToHex(hsl.h, clamp(hsl.s, 0, 96), clamp(hsl.l + 6, 16, 94));
        const midLum = (relativeLuminance(bg1) + relativeLuminance(bg2)) / 2;
        const useDarkInk = midLum > 0.36;

        return {
            bg1,
            bg2,
            border: useDarkInk ? 'rgba(24,24,27,0.18)' : 'rgba(255,255,255,0.20)',
            ringOuter: useDarkInk ? hslToHex(hsl.h, clamp(hsl.s * 0.45, 0, 40), 16) : hslToHex(hsl.h, clamp(hsl.s * 0.55, 0, 70), 86),
            ringOuterOp: useDarkInk ? 0.58 : 0.90,
            ringInner: useDarkInk ? '#18181b' : '#ffffff',
            ringInnerOp: useDarkInk ? 0.28 : 0.40,
            bolt1: useDarkInk ? '#09090b' : '#ffffff',
            bolt2: useDarkInk ? '#27272a' : hslToHex(hsl.h, clamp(hsl.s * 0.4, 0, 50), 94),
            shadow: useDarkInk ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.44)',
            isLightFrame: useDarkInk && midLum > 0.72
        };
    }

    function getIconPalette(iconId, customHex) {
        if (iconId === 'custom') return buildCustomIconPalette(customHex);
        if (CLASSIC_ICON_PALETTES[iconId]) return CLASSIC_ICON_PALETTES[iconId];
        if (THEME_ICON_PALETTES[iconId]) return THEME_ICON_PALETTES[iconId];
        return CLASSIC_ICON_PALETTES['monochrome-dark'];
    }

    /**
     * Verilen ikon paletinden 256×256 vektör Power Pilot marka SVG'si üretir.
     */
    function buildBrandIconSvg(palette, { includeDropShadow = true } = {}) {
        const p = palette || CLASSIC_ICON_PALETTES['monochrome-dark'];
        const rectTag = p.isLightFrame
            ? `<rect x="2" y="2" width="252" height="252" rx="55" fill="url(#bg-grad)" stroke="${p.border}" stroke-width="4"/>`
            : `<rect width="256" height="256" rx="56" fill="url(#bg-grad)"/>`;
        const filterAttr = includeDropShadow && p.shadow
            ? ` filter="drop-shadow(0px 4px 6px ${p.shadow})"`
            : '';
        const outerOpAttr = p.ringOuterOp !== 1 ? ` opacity="${p.ringOuterOp}"` : '';
        return `<svg xmlns="${SVG_NS}" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${p.bg1}"/>
      <stop offset="100%" stop-color="${p.bg2}"/>
    </linearGradient>
    <linearGradient id="bolt-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${p.bolt1}"/>
      <stop offset="100%" stop-color="${p.bolt2}"/>
    </linearGradient>
  </defs>
  ${rectTag}
  <circle cx="128" cy="128" r="80" fill="none" stroke="${p.ringOuter}" stroke-width="12" stroke-dasharray="20 15" stroke-linecap="round"${outerOpAttr}/>
  <circle cx="128" cy="128" r="62" fill="none" stroke="${p.ringInner}" stroke-width="4" opacity="${p.ringInnerOp}"/>
  <path d="M136 64 L76 148 L120 148 L112 196 L180 108 L136 108 Z" fill="url(#bolt-grad)"${filterAttr}/>
</svg>
`;
    }

    function buildCustomCssText(themeHex, iconHex) {
        const tokens = buildCustomThemeTokens(themeHex);
        const iconP = buildCustomIconPalette(iconHex || themeHex);
        const toDecls = (map) => Object.entries(map).map(([k, v]) => `${k}:${v};`).join('');
        return [
            `html[data-theme='custom']{${toDecls(tokens.light)}}`,
            `html.dark[data-theme='custom']{${toDecls(tokens.dark)}}`,
            `.pp-theme-swatch[data-swatch='custom']{background-color:${tokens.hex};}`,
            `html[data-app-icon='custom']{--pp-icon-bg-1:${iconP.bg1};--pp-icon-bg-2:${iconP.bg2};--pp-icon-border:${iconP.border};--pp-icon-ring-outer:${iconP.ringOuter};--pp-icon-ring-outer-op:${iconP.ringOuterOp};--pp-icon-ring-inner:${iconP.ringInner};--pp-icon-ring-inner-op:${iconP.ringInnerOp};--pp-icon-bolt-1:${iconP.bolt1};--pp-icon-bolt-2:${iconP.bolt2};}`,
            `.pp-icon-preview-custom{--pp-icon-bg-1:${iconP.bg1};--pp-icon-bg-2:${iconP.bg2};--pp-icon-border:${iconP.border};--pp-icon-ring-outer:${iconP.ringOuter};--pp-icon-ring-outer-op:${iconP.ringOuterOp};--pp-icon-ring-inner:${iconP.ringInner};--pp-icon-ring-inner-op:${iconP.ringInnerOp};--pp-icon-bolt-1:${iconP.bolt1};--pp-icon-bolt-2:${iconP.bolt2};}`
        ].join('\n');
    }

    return {
        HEX_COLOR_RE,
        DEFAULT_CUSTOM_COLOR,
        THEME_BASE_HEX,
        CLASSIC_ICON_PALETTES,
        THEME_ICON_PALETTES,
        THEME_ID_TO_ICON_ID,
        normalizeHexColor,
        isValidHexColor,
        hexToRgb,
        rgbToHex,
        rgbToHsl,
        hslToRgb,
        hslToHex,
        relativeLuminance,
        contrastRatio,
        pickBestForeground,
        buildCustomThemeTokens,
        buildCustomIconPalette,
        getIconPalette,
        buildBrandIconSvg,
        buildCustomCssText
    };
}));
