/**
 * electron-builder.config.cjs - WP-15.T2
 * package.json'daki sabit yapılandırmanın üzerine yalnızca imzalama
 * alanlarını ortamdan çözer. `WIN_CERT_SUBJECT` yoksa imzalama atlanır
 * (yerel paketleme); release CI'da HSM/TPM sertifika konu adı zorunludur.
 */
'use strict';

const pkg = require('./package.json');
const base = pkg.build || {};
const win = base.win || {};
const signtool = win.signtoolOptions || {};
const appx = base.appx || {};

module.exports = {
    ...base,
    win: {
        ...win,
        signtoolOptions: {
            ...signtool,
            certificateSubjectName: process.env.WIN_CERT_SUBJECT || undefined,
            // Ayni Subject'e sahip birden fazla sertifika varsa (or. yerel
            // kendinden imzali test sertifikasi) parmak izi ile secilir.
            certificateSha1: process.env.WIN_CERT_SHA1 || undefined,
            // electron-builder'in getirdigi eski signtool HTTPS /tr desteklemez.
            // Uretimde (yeni signtool) varsayilan HTTPS kalir; yerel imzada
            // WIN_TIMESTAMP_URL=http://timestamp.digicert.com verilebilir.
            rfc3161TimeStampServer: process.env.WIN_TIMESTAMP_URL || signtool.rfc3161TimeStampServer
        }
    },
    // package.json'daki `appx.publisher` degeri `${env.APPX_PUBLISHER}`
    // olarak **ham** duruyor; bu electron-builder surumunde genisletilmiyor ve
    // MakeAppx manifest dogrulamasinda "Publisher ... ayristirilamadi" hatasi
    // veriyordu. Degeri burada ortamdan coz. Tanimli degilse alani birak
    // (NSIS yolu etkilenmez).
    appx: {
        ...appx,
        publisher: process.env.APPX_PUBLISHER || appx.publisher
    }
};
