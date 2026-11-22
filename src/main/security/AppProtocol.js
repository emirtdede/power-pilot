'use strict';

/**
 * AppProtocol.js - WP-10.T1/T2
 * Renderer `file://` yerine `app://` özel protokolünden yüklenir.
 * Protokol "standard + secure" olarak kaydedilir; böylece origin ayrımı,
 * CSP ve `will-navigate` denetimleri güvenilir çalışır.
 */

const fs = require('fs');
const { protocol } = require('electron');
const { APP_ORIGIN, resolveAppPath, contentTypeFor, isAllowedAppUrl } = require('./AppPaths');

let installed = false;

/** `app.whenReady()` ÖNCESİNDE çağrılmalıdır. */
function registerAppScheme () {
    protocol.registerSchemesAsPrivileged([{
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: false,
            stream: true
        }
    }]);
}

/**
 * @param {string} root `src` dizini.
 */
function installAppProtocol (root) {
    if (installed) return;
    installed = true;
    protocol.handle('app', async (request) => {
        const resolved = resolveAppPath(root, request.url);
        if (!resolved.ok) {
            return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }
        try {
            const body = await fs.promises.readFile(resolved.filePath);
            return new Response(body, {
                status: 200,
                headers: {
                    'content-type': contentTypeFor(resolved.filePath),
                    'cache-control': 'no-store',
                    'x-content-type-options': 'nosniff'
                }
            });
        } catch (err) {
            const status = err && err.code === 'ENOENT' ? 404 : 500;
            return new Response(status === 404 ? 'Not Found' : 'Internal Error', {
                status,
                headers: { 'content-type': 'text/plain; charset=utf-8' }
            });
        }
    });
}

module.exports = { registerAppScheme, installAppProtocol, isAllowedAppUrl, APP_ORIGIN };
