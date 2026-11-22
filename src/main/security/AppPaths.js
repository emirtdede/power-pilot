'use strict';

/**
 * AppPaths.js - WP-10.T1/T2
 * `app://powerpilot/...` isteklerini dosya sistemine güvenli biçimde çözer.
 * Electron bağımlılığı yoktur; birim testleri doğrudan çalıştırır.
 */

const path = require('path');

const APP_ORIGIN = 'app://powerpilot';
const APP_HOST = 'powerpilot';

function decodePathname (pathname) {
    try {
        return decodeURIComponent(pathname);
    } catch (_) {
        return null;
    }
}

/**
 * @param {string} root Serve edilecek kök dizin (src).
 * @param {string} requestUrl `app://powerpilot/index.html` gibi.
 * @returns {{ok:true,filePath:string,relative:string}|{ok:false,code:string}}
 */
function resolveAppPath (root, requestUrl) {
    // URL parseri `..` segmentlerini normalize eder; kaçış denemesini ham
    // URL üzerinde reddet (yüzde kodlu ve ters bölü varyantları dahil).
    if (typeof requestUrl !== 'string' || requestUrl.includes('..') || /%2e|%5c|\\/i.test(requestUrl)) {
        return { ok: false, code: 'INVALID_PATH' };
    }
    let url;
    try {
        url = new URL(requestUrl);
    } catch (_) {
        return { ok: false, code: 'INVALID_URL' };
    }
    if (url.protocol !== 'app:' || url.hostname !== APP_HOST) {
        return { ok: false, code: 'INVALID_ORIGIN' };
    }
    const decoded = decodePathname(url.pathname);
    if (decoded === null) return { ok: false, code: 'INVALID_PATH' };
    if (decoded.includes('\0')) return { ok: false, code: 'INVALID_PATH' };
    // Windows'ta `\` ayırıcıdır; URL'de yol ayırıcısı olarak kabul edilmez.
    if (decoded.includes('\\')) return { ok: false, code: 'INVALID_PATH' };
    const relative = decoded.replace(/^\/+/, '');
    if (!relative || relative.split('/').some((part) => part === '..' || part === '.')) {
        return { ok: false, code: 'INVALID_PATH' };
    }
    const absoluteRoot = path.resolve(root);
    const filePath = path.resolve(absoluteRoot, relative);
    const prefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
    if (!filePath.startsWith(prefix)) {
        return { ok: false, code: 'PATH_TRAVERSAL' };
    }
    return { ok: true, filePath, relative: relative.replace(/\\/g, '/') };
}

const CONTENT_TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
    ['.wasm', 'application/wasm'],
    ['.map', 'application/json; charset=utf-8']
]);

function contentTypeFor (filePath) {
    return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function isAllowedAppUrl (url) {
    if (typeof url !== 'string') return false;
    return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
}

module.exports = { APP_ORIGIN, APP_HOST, resolveAppPath, contentTypeFor, isAllowedAppUrl };
