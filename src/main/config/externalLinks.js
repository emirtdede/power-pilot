'use strict';

/**
 * externalLinks.js - WP-10.T6
 * Dış tarayıcıda açılmasına izin verilen HTTPS host'ları. Alt alan adı
 * eşleşmesi yalnızca listede açıkça belirtilen taban adlar için yapılır.
 */

const ALLOWED_HOSTS = Object.freeze([
    'electronjs.org',
    'fonts.google.com',
    'github.com',
    'tailwindcss.com',
    'vellium.dev'
]);

function isAllowedExternalUrl(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        return false;
    }
    if (url.protocol !== 'https:') return false;
    if (url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function openExternalSafely(shell, raw, logger) {
    if (!isAllowedExternalUrl(raw)) return false;
    shell.openExternal(raw).catch((err) => {
        if (logger && typeof logger.warn === 'function') {
            logger.warn('[Security] Dış bağlantı açılamadı:', err && err.message);
        }
    });
    return true;
}

module.exports = { ALLOWED_HOSTS, isAllowedExternalUrl, openExternalSafely };
