'use strict';

/**
 * SenderGuard.js - WP-10.T1
 * Her IPC çağrısının çerçeve origin'i `app://powerpilot` olmalıdır.
 * `file://`, `http://`, `https://` ve boş origin reddedilir.
 */

const { isAllowedAppUrl } = require('../security/AppPaths');

function frameUrlOf (event) {
    if (!event) return '';
    if (event.senderFrame && typeof event.senderFrame.url === 'string') return event.senderFrame.url;
    // Bazı Electron sürümlerinde senderFrame yok; webContents.getURL() son çare.
    if (event.sender && typeof event.sender.getURL === 'function') return event.sender.getURL();
    return '';
}

function isTrustedSender (event) {
    return isAllowedAppUrl(frameUrlOf(event));
}

function guardIpcHandler (handler, { onDenied } = {}) {
    return async function guarded (event, ...args) {
        if (!isTrustedSender(event)) {
            if (typeof onDenied === 'function') onDenied(frameUrlOf(event));
            const err = new Error('Güvenilmeyen IPC göndericisi.');
            err.code = 'UNTRUSTED_SENDER';
            throw err;
        }
        return handler(event, ...args);
    };
}

module.exports = { isTrustedSender, frameUrlOf, guardIpcHandler };
