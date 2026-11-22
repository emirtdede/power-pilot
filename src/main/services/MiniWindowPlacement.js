/**
 * MiniWindowPlacement.js - mini zamanlayıcı penceresinin ekran yerleşimi.
 *
 * Neden ayrı ve saf bir modül: mini pencere daha önce her zaman
 * `screen.getPrimaryDisplay()` üzerine sabitleniyordu. Çoklu monitör
 * kurulumlarında (ve DPI ölçeği farklı ekranlarda) kullanıcı ana pencereyi
 * ikincil ekranda tutarken mini widget birincil ekranın köşesinde beliriyor,
 * hatta ekran söküldüğünde görünmez bir koordinatta kalabiliyordu.
 *
 * Çözüm: mini pencere (1) ana pencerenin bulunduğu ekrana, (2) ana pencere
 * yoksa imlecin bulunduğu ekrana yerleşir; (3) her zaman o ekranın çalışma
 * alanı (workArea - görev çubuğu hariç) içinde kalacak şekilde kırpılır.
 *
 * Tüm fonksiyonlar saf: Electron'a bağımlı değil, enjekte edilen display
 * nesneleriyle çalışır; böylece birim testleri gerçek ekran gerektirmez.
 */

'use strict';

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 76;
const DEFAULT_MARGIN = 20;

/**
 * Verilen noktayı içeren ekranı seçer.
 * @param {Array<{bounds:{x:number,y:number,width:number,height:number}}>} displays
 * @param {{x:number,y:number}} point
 * @returns {object|null}
 */
function displayContainingPoint(displays, point) {
    if (!Array.isArray(displays) || !point) return null;
    for (const display of displays) {
        const b = display && display.bounds;
        if (!b) continue;
        if (
            point.x >= b.x &&
            point.x < b.x + b.width &&
            point.y >= b.y &&
            point.y < b.y + b.height
        ) {
            return display;
        }
    }
    return null;
}

/**
 * Mini pencere için ekranı seçer.
 *
 * Öncelik sırası:
 *   1. Ana pencerenin merkezini içeren ekran (kullanıcı orada çalışıyor).
 *   2. İmlecin bulunduğu ekran.
 *   3. Birincil ekran.
 *   4. Listedeki ilk ekran.
 *
 * @param {object} opts
 * @param {Array} opts.displays  screen.getAllDisplays() çıktısı
 * @param {object} [opts.primaryDisplay]
 * @param {{x:number,y:number,width:number,height:number}} [opts.anchorBounds] ana pencere sınırları
 * @param {{x:number,y:number}} [opts.cursorPoint]
 * @returns {object|null} seçilen display
 */
function pickDisplay({ displays, primaryDisplay, anchorBounds, cursorPoint } = {}) {
    const list = Array.isArray(displays) ? displays.filter((d) => d && d.bounds) : [];

    if (anchorBounds) {
        const center = {
            x: anchorBounds.x + Math.floor(anchorBounds.width / 2),
            y: anchorBounds.y + Math.floor(anchorBounds.height / 2)
        };
        const byAnchor = displayContainingPoint(list, center);
        if (byAnchor) return byAnchor;
    }

    if (cursorPoint) {
        const byCursor = displayContainingPoint(list, cursorPoint);
        if (byCursor) return byCursor;
    }

    if (primaryDisplay && primaryDisplay.bounds) return primaryDisplay;
    return list[0] || null;
}

/**
 * Mini pencere koordinatlarını hesaplar.
 *
 * @param {object} opts
 * @param {{x:number,y:number,width:number,height:number}} opts.workArea hedef ekranın çalışma alanı
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {number} [opts.margin]
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computePosition({ workArea, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT, margin = DEFAULT_MARGIN } = {}) {
    if (!workArea || typeof workArea.x !== 'number') {
        // Electron çalışma alanı vermezse güvenli varsayılan: sol üst.
        return { x: 0, y: 0, width, height };
    }

    // Çalışma alanı pencereden küçükse pencereyi alana sığdır; negatif
    // boyut üretme.
    const winWidth = Math.max(1, Math.min(width, workArea.width));
    const winHeight = Math.max(1, Math.min(height, workArea.height));
    const safeMargin = Math.max(0, Math.min(margin, Math.floor(Math.min(workArea.width, workArea.height) / 4)));

    const maxX = workArea.x + workArea.width - winWidth;
    const maxY = workArea.y + workArea.height - winHeight;

    const x = Math.min(Math.max(workArea.x, workArea.x + workArea.width - winWidth - safeMargin), maxX);
    const y = Math.min(Math.max(workArea.y, workArea.y + workArea.height - winHeight - safeMargin), maxY);

    return { x: Math.round(x), y: Math.round(y), width: winWidth, height: winHeight };
}

/**
 * Kısayol: display seç + konum hesapla.
 *
 * @param {object} opts { displays, primaryDisplay, anchorBounds, cursorPoint, width, height, margin }
 * @returns {{x:number,y:number,width:number,height:number}}
 */
function computePlacement(opts = {}) {
    const display = pickDisplay(opts);
    const workArea = (display && (display.workArea || display.bounds)) || null;
    return computePosition({
        workArea,
        width: opts.width,
        height: opts.height,
        margin: opts.margin
    });
}

const DEFAULT_HUD_WIDTH = 440;
const DEFAULT_HUD_HEIGHT = 116;
const DEFAULT_HUD_MARGIN = 18;

/**
 * WP-4.2: Görev çubuğunun tam üst-ortasında (workArea alt-orta) Sesli Dikte HUD konumunu hesaplar.
 */
function computeBottomCenterPosition({ workArea, width = DEFAULT_HUD_WIDTH, height = DEFAULT_HUD_HEIGHT, margin = DEFAULT_HUD_MARGIN } = {}) {
    if (!workArea || typeof workArea.x !== 'number') {
        return { x: 0, y: 0, width, height };
    }
    const winWidth = Math.max(1, Math.min(width, workArea.width));
    const winHeight = Math.max(1, Math.min(height, workArea.height));
    const safeMargin = Math.max(0, Math.min(margin, Math.floor(Math.min(workArea.width, workArea.height) / 4)));

    const centerX = workArea.x + Math.round((workArea.width - winWidth) / 2);
    const maxX = workArea.x + workArea.width - winWidth;
    const maxY = workArea.y + workArea.height - winHeight;

    const x = Math.min(Math.max(workArea.x, centerX), maxX);
    const y = Math.min(Math.max(workArea.y, workArea.y + workArea.height - winHeight - safeMargin), maxY);

    return { x: Math.round(x), y: Math.round(y), width: winWidth, height: winHeight };
}

function computeBottomCenterPlacement(opts = {}) {
    const display = pickDisplay(opts);
    const workArea = (display && (display.workArea || display.bounds)) || null;
    return computeBottomCenterPosition({
        workArea,
        width: opts.width,
        height: opts.height,
        margin: opts.margin
    });
}

module.exports = {
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    DEFAULT_MARGIN,
    DEFAULT_HUD_WIDTH,
    DEFAULT_HUD_HEIGHT,
    DEFAULT_HUD_MARGIN,
    displayContainingPoint,
    pickDisplay,
    computePosition,
    computePlacement,
    computeBottomCenterPosition,
    computeBottomCenterPlacement
};
