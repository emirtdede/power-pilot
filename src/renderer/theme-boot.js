/**
 * theme-boot.js - PPX-021
 * İlk boyamadan ÖNCE temayı (mod + 14 renk paleti + özel renk), uygulama
 * ikonunu, erişilebilirlik tercihlerini ve kenar çubuğu durumunu uygular.
 * CSP `script-src 'self'` uyumu için harici dosya; inline script/style yok.
 */
(function () {
    'use strict';
    var VALID_THEMES = [
        'obsidian', 'slate', 'navy', 'blue', 'cyan', 'indigo', 'purple',
        'pink', 'red', 'orange', 'yellow', 'emerald', 'grass', 'lime', 'custom'
    ];
    var VALID_ICONS = [
        'monochrome-dark', 'monochrome-light', 'monochrome-contrast', 'classic-cyan',
        'theme-obsidian', 'theme-slate', 'theme-navy', 'theme-blue', 'theme-cyan',
        'theme-indigo', 'theme-purple', 'theme-pink', 'theme-red', 'theme-orange',
        'theme-yellow', 'theme-emerald', 'theme-grass', 'theme-lime', 'custom'
    ];
    var VALID_FONT_SCALES = ['normal', 'large', 'xlarge'];
    var HEX_RE = /^#[0-9a-fA-F]{6}$/;

    var mode = 'dark';
    var themeId = 'obsidian';
    var customThemeColor = '#3b82f6';
    var appIcon = 'monochrome-dark';
    var customIconColor = '#3b82f6';
    var collapsed = false;
    var fontScale = 'normal';
    var highContrast = false;
    var enhancedFocus = false;
    var readableSpacing = false;
    var reduceMotion = false;

    try {
        var savedMode = localStorage.getItem('theme');
        if (savedMode === 'light' || savedMode === 'dark') mode = savedMode;
        var savedId = localStorage.getItem('themeId');
        if (savedId && VALID_THEMES.indexOf(savedId) !== -1) themeId = savedId;
        var savedCustomTheme = localStorage.getItem('customThemeColor');
        if (savedCustomTheme && HEX_RE.test(savedCustomTheme)) customThemeColor = savedCustomTheme.toLowerCase();
        var savedIcon = localStorage.getItem('appIcon');
        if (savedIcon && VALID_ICONS.indexOf(savedIcon) !== -1) appIcon = savedIcon;
        var savedCustomIcon = localStorage.getItem('customIconColor');
        if (savedCustomIcon && HEX_RE.test(savedCustomIcon)) customIconColor = savedCustomIcon.toLowerCase();
        else customIconColor = customThemeColor;
        collapsed = localStorage.getItem('pp-sidebar-collapsed') === 'true';
        var savedScale = localStorage.getItem('pp-font-scale');
        if (savedScale && VALID_FONT_SCALES.indexOf(savedScale) !== -1) fontScale = savedScale;
        highContrast = localStorage.getItem('pp-high-contrast') === 'true';
        enhancedFocus = localStorage.getItem('pp-enhanced-focus') === 'true';
        readableSpacing = localStorage.getItem('pp-readable-spacing') === 'true';
        reduceMotion = localStorage.getItem('pp-reduce-motion') === 'true';
    } catch (_) { /* depolama kapalı: koyu obsidian varsayılan */ }

    var customSheet = null;
    function applyCustomPaletteCss(tHex, iHex) {
        if (!window.PPColorPalette || typeof window.PPColorPalette.buildCustomCssText !== 'function') return;
        var cssText = window.PPColorPalette.buildCustomCssText(tHex, iHex || tHex);
        try {
            if (typeof CSSStyleSheet === 'function' && 'adoptedStyleSheets' in document) {
                if (!customSheet) {
                    customSheet = new CSSStyleSheet();
                    document.adoptedStyleSheets = [].concat(Array.from(document.adoptedStyleSheets || []), [customSheet]);
                }
                customSheet.replaceSync(cssText);
                return;
            }
        } catch (_) { /* fallback aşağıda */ }
    }
    window.__ppApplyCustomCss = applyCustomPaletteCss;

    var root = document.documentElement;
    if (mode === 'light') root.classList.remove('dark');
    else root.classList.add('dark');
    root.setAttribute('data-theme', themeId);
    root.setAttribute('data-app-icon', appIcon);
    root.setAttribute('data-font-scale', fontScale);
    root.classList.toggle('pp-high-contrast', highContrast);
    root.classList.toggle('pp-enhanced-focus', enhancedFocus);
    root.classList.toggle('pp-readable-spacing', readableSpacing);
    // İlk boyamadan önce uygulanır: aksi hâlde hareket azaltma tercih eden
    // kullanıcı, JS açılana kadar geçiş/animasyonları bir kez görür.
    root.classList.toggle('pp-reduce-motion', reduceMotion);
    applyCustomPaletteCss(customThemeColor, customIconColor);

    var syncFav = function () {
        var fav = document.getElementById('pp-favicon');
        if (!fav) return;
        if (appIcon === 'custom' && window.PPColorPalette) {
            var svg = window.PPColorPalette.buildBrandIconSvg(
                window.PPColorPalette.buildCustomIconPalette(customIconColor),
                { includeDropShadow: false }
            );
            fav.setAttribute('href', 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
        } else {
            fav.setAttribute('href', 'assets/icons/' + appIcon + '.png');
        }
    };
    syncFav();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', syncFav, { once: true });
    }
    if (collapsed) root.classList.add('sidebar-collapsed');
    else root.classList.remove('sidebar-collapsed');
    window.__ppEarlyTheme = {
        mode: mode,
        themeId: themeId,
        customThemeColor: customThemeColor,
        appIcon: appIcon,
        customIconColor: customIconColor,
        collapsed: collapsed,
        fontScale: fontScale,
        highContrast: highContrast,
        enhancedFocus: enhancedFocus,
        readableSpacing: readableSpacing
    };
})();
