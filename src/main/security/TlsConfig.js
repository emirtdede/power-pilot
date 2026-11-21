/**
 * TlsConfig.js — WP-02.T1
 * TLS/mTLS materyalini tek yerden çözer. Runtime'da "TLS yoksa düz HTTP'ye düş"
 * davranışı YOKTUR; eksik materyal null döner ve çağıran katman isteği reddeder.
 */

const fs = require('fs');

const MIN_VERSION = 'TLSv1.2';
const STRONG_CIPHERS = [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384'
].join(':');

function readMaterial(inline, filePath) {
    if (typeof inline === 'string' && inline.trim().length > 0) return inline;
    if (typeof filePath === 'string' && filePath.length > 0) {
        try {
            return fs.readFileSync(filePath);
        } catch (_) {
            return null;
        }
    }
    return null;
}

/**
 * Sunucu tarafı ortak seçenek üretimi. Materyal yoksa null.
 */
function serverOptionsFrom({ cert, key, pfx, passphrase, ca, requireClient, strict }) {
    if (!pfx && (!cert || !key)) return null;
    const options = {
        minVersion: MIN_VERSION,
        ciphers: STRONG_CIPHERS,
        honorCipherOrder: true,
        // TLS oturum yeniden kullanımı istemci sertifikası kontrolünü atlatmasın.
        sessionTimeout: 0,
        requestCert: requireClient === true || strict === true,
        // Sıkı kip de yetkisiz/sertifikasız istemciyi TLS el sıkışmasında reddeder.
        rejectUnauthorized: requireClient === true || strict === true
    };
    if (pfx) {
        options.pfx = pfx;
        if (typeof passphrase === 'string' && passphrase.length > 0) options.passphrase = passphrase;
    } else {
        options.cert = cert;
        options.key = key;
    }
    if (ca) options.ca = ca;
    return options;
}

/**
 * Yerel API (ajan) sunucusu.
 * @param {object} settings
 * @returns {object|null} https.createServer seçenekleri veya null
 */
function buildServerOptions(settings = {}) {
    if (settings.localApiTlsEnabled !== true) return null;
    return serverOptionsFrom({
        pfx: readMaterial(null, settings.localApiPfxFile),
        passphrase: settings.localApiPfxPassphrase,
        cert: readMaterial(settings.localApiCertPem, settings.localApiCertFile),
        key: readMaterial(settings.localApiKeyPem, settings.localApiKeyFile),
        ca: readMaterial(settings.localApiCaPem, settings.localApiCaFile),
        requireClient: settings.localApiRequireClientCert === true,
        strict: settings.localApiTlsStrict === true
    });
}

/**
 * Şirket konsolu sunucusu (WP-02.T2). Varsayılan olarak TLS açıktır;
 * `consoleTlsEnabled === false` yalnızca loopback + PP_ALLOW_INSECURE_CONSOLE
 * kaçış kapısıyla birlikte ConsoleServer tarafından kabul edilir.
 */
function buildConsoleServerOptions(settings = {}) {
    if (settings.consoleTlsEnabled === false) return null;
    return serverOptionsFrom({
        pfx: readMaterial(null, settings.consolePfxFile),
        passphrase: settings.consolePfxPassphrase,
        cert: readMaterial(settings.consoleCertPem, settings.consoleCertFile),
        key: readMaterial(settings.consoleKeyPem, settings.consoleKeyFile),
        ca: readMaterial(settings.consoleCaPem, settings.consoleCaFile),
        requireClient: settings.consoleRequireClientCert === true,
        strict: settings.consoleTlsStrict === true
    });
}

/**
 * Ajan/konsol istemcisi için doğrulanmış TLS seçenekleri.
 * @param {object} settings
 * @returns {object}
 */
function buildClientOptions(settings = {}) {
    // P1-6: `consoleClientCaFile` ajan→konsol mTLS için ayrı CA yoludur;
    // eskiden yalnızca sunucu tarafı `consoleCaFile` okunuyordu, bu yüzden
    // istemciye özel CA ayarı sessizce yok sayılırdı.
    const ca = readMaterial(
        settings.consoleClientCaPem || settings.consoleCaPem || settings.localApiCaPem,
        settings.consoleClientCaFile || settings.consoleCaFile || settings.localApiCaFile
    );
    const cert = readMaterial(settings.consoleClientCertPem, settings.consoleClientCertFile);
    const key = readMaterial(settings.consoleClientKeyPem, settings.consoleClientKeyFile);
    const pfx = readMaterial(null, settings.consoleClientPfxFile);
    const options = {
        minVersion: MIN_VERSION,
        ciphers: STRONG_CIPHERS,
        rejectUnauthorized: true
    };
    if (ca) options.ca = ca;
    if (pfx) {
        options.pfx = pfx;
        if (typeof settings.consoleClientPfxPassphrase === 'string' && settings.consoleClientPfxPassphrase.length > 0) {
            options.passphrase = settings.consoleClientPfxPassphrase;
        }
    } else if (cert && key) {
        options.cert = cert;
        options.key = key;
    }
    return options;
}

function isTlsConfigured(settings = {}) {
    return buildServerOptions(settings) !== null;
}

function isConsoleTlsConfigured(settings = {}) {
    return buildConsoleServerOptions(settings) !== null;
}

module.exports = {
    buildServerOptions,
    buildConsoleServerOptions,
    buildClientOptions,
    isTlsConfigured,
    isConsoleTlsConfigured,
    MIN_VERSION,
    STRONG_CIPHERS
};
