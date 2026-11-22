/**
 * after-pack.cjs - WP-15.T1
 * electron-builder 26'nın şema sürümü `wasmTrapHandlers` fuse'unu tanımıyor;
 * kalan fuses `electronFuses` ile, bu fuse ise doğrudan @electron/fuses ile
 * paketleme sonrası (imzadan önce) çevrilir.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

/**
 * Paket hijyeni: Electron'un `dist` klasöründe geliştirme sırasında oluşmuş
 * artıklar (ör. `debug.log`) olduğu gibi kopyalanır. Kullanıcıya kurulumla
 * birlikte 38 KB'lık eski bir Chromium hata günlüğü göndermek gereksizdir;
 * üstelik içinde yerel yollar olabilir. Yalnızca bilinen artık adları silinir.
 */
const PACK_ARTIFACTS = ['debug.log', 'chrome_debug.log'];

function removePackArtifacts(appOutDir) {
    for (const name of PACK_ARTIFACTS) {
        const target = path.join(appOutDir, name);
        try {
            if (fs.existsSync(target)) {
                fs.rmSync(target, { force: true });
                console.log(`[after-pack] artık silindi: ${name}`);
            }
        } catch (err) {
            console.warn(`[after-pack] artık silinemedi (${name}):`, err && err.message);
        }
    }
}

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    removePackArtifacts(context.appOutDir);
    const executable = path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.exe`
    );
    await flipFuses(executable, {
        version: FuseVersion.V1,
        [FuseV1Options.WasmTrapHandlers]: true
    });
    console.log(`[after-pack] WasmTrapHandlers=true: ${executable}`);
};

module.exports.removePackArtifacts = removePackArtifacts;
module.exports.PACK_ARTIFACTS = PACK_ARTIFACTS;
