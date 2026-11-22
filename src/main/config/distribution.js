'use strict';

/**
 * distribution.js - dağıtım kanalı ve özellik kapsamı.
 *
 * İki yüzey vardır:
 *  - Store (MSIX): Microsoft Store politikalarına uygun tüketici sürümü.
 *    Servis/ajan/konsol/LAN sunucu ve Task Scheduler yedeği YOKTUR.
 *  - Pro (NSIS/MSI): kurumsal/ileri seviye özelliklerin tamamı.
 *
 * Electron, AppX paketinde `process.windowsStore === true` yapar. Yerel
 * doğrulama/CI için `PP_STORE_BUILD=1` ile aynı kapsam simüle edilir.
 */

const IS_STORE = process.windowsStore === true || process.env.PP_STORE_BUILD === '1';

const FEATURES = Object.freeze({
    /** `--headless` ajan modu (Store'da yok). */
    headless: !IS_STORE,
    /** Konsol ajanı + periyodik senkron (Store'da yok). */
    consoleAgent: !IS_STORE,
    /** LAN'a açılan Local API + TLS/mTLS sunucusu (Store'da yok). */
    lanApi: !IS_STORE,
    /** schtasks.exe tabanlı uyandırma yedeği (Store'da yok). */
    taskScheduler: !IS_STORE,
    /** Autostart, Windows Ayarlar > Başlangıç üzerinden yönetilir. */
    startupViaWindowsSettings: IS_STORE,
    /** Store kurulumları yalnızca Store üzerinden güncellenir. */
    storeUpdatesOnly: IS_STORE
});

function isFeatureEnabled(name) {
    return FEATURES[name] === true;
}

/** Renderer'a yalnızca gereken kadarı gider. */
function publicInfo() {
    return {
        store: IS_STORE,
        features: {
            headless: FEATURES.headless,
            consoleAgent: FEATURES.consoleAgent,
            lanApi: FEATURES.lanApi,
            startupViaWindowsSettings: FEATURES.startupViaWindowsSettings
        }
    };
}

module.exports = { IS_STORE, FEATURES, isFeatureEnabled, publicInfo };
