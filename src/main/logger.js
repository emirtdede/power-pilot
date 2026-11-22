/**
 * logger.js - WBS-3.2 / WP-04.T6
 * Tek log kanalı. electron-log dosyaya yazar (5MB rotasyon, production'da console sessiz).
 * Test ortamında (NODE_ENV=test / vitest) electron-log yerine sessiz no-op kullanılır;
 * böylece birim testleri dosya sistemine yazmaz ve hızlı kalır.
 * Tüm argümanlar yazılmadan önce Redact'ten geçer: PIN/token/PEM/Authorization sızmaz.
 */

const { redact } = require('./security/Redact');

function safeArgs(args) {
    return args.map((a) => redact(a));
}

let log;
if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    const noop = () => {};
    log = {
        info: noop,
        warn: noop,
        error: noop,
        debug: noop,
        _redactArgs: safeArgs
    };
} else {
    // eslint-disable-next-line global-require
    const electronLog = require('electron-log');
    electronLog.transports.file.maxSize = 5 * 1024 * 1024;
    electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
    log = {
        info: (...args) => electronLog.info(...safeArgs(args)),
        warn: (...args) => electronLog.warn(...safeArgs(args)),
        error: (...args) => electronLog.error(...safeArgs(args)),
        debug: (...args) => electronLog.debug(...safeArgs(args)),
        _redactArgs: safeArgs
    };
}

module.exports = log;
