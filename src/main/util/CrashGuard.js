/**
 * CrashGuard.js - yayın öncesi dayanıklılık
 *
 * Neden: Electron ana sürecinde yakalanmamış bir istisna, kullanıcıya hiçbir
 * iz bırakmadan uygulamayı kapatır (pencere kaybolur, log yazılmaz).
 * Bu modül iki süreç olayını tek noktada karşılar:
 *
 *  - `uncaughtException`  : loglanır, uygulama ayakta tutulur (timer/görev
 *                           kaybını önlemek için süreç sonlandırılmaz).
 *  - `unhandledRejection` : loglanır; reddedilen promise'ler sessizce yutulmaz.
 *
 * Saf ve test edilebilir: process nesnesi ve logger dışarıdan enjekte edilir,
 * bu yüzden birim testleri gerçek Electron'a ihtiyaç duymaz.
 */

'use strict';

/**
 * Bir hatayı loglanabilir tek satırlık özete çevirir.
 * Yığın (stack) ilk 5 satırıyla sınırlanır: 5MB log rotasyonunu şişirmesin.
 * @param {unknown} err
 * @returns {{ message: string, stack: string }}
 */
function describeError(err) {
    if (err instanceof Error) {
        return {
            message: err.message || err.name || 'Error',
            stack: String(err.stack || '').split('\n').slice(0, 5).join('\n')
        };
    }
    if (typeof err === 'string') return { message: err, stack: '' };
    if (err && typeof err === 'object') {
        try {
            return { message: JSON.stringify(err).slice(0, 500), stack: '' };
        } catch (_) {
            return { message: '[unserializable rejection]', stack: '' };
        }
    }
    return { message: String(err), stack: '' };
}

/**
 * Süreç seviyesindeki kurtarma kancalarını kurar.
 * @param {object} options
 * @param {NodeJS.Process} options.processRef  process nesnesi (test için enjekte edilir)
 * @param {{error: Function, warn: Function}} options.logger
 * @param {(info: {kind: string, message: string}) => void} [options.onCrash]
 *        İsteğe bağlı ek kanca (ör. tray bildirimi); hata fırlatırsa yutulur.
 * @returns {() => void} kancaları kaldıran fonksiyon
 */
function installCrashGuard({ processRef, logger, onCrash } = {}) {
    if (!processRef || typeof processRef.on !== 'function') {
        throw new TypeError('installCrashGuard: processRef.on gerekli');
    }
    if (!logger || typeof logger.error !== 'function') {
        throw new TypeError('installCrashGuard: logger.error gerekli');
    }

    const notify = (kind, message) => {
        if (typeof onCrash !== 'function') return;
        try {
            onCrash({ kind, message });
        } catch (_) {
            // Bildirim kanalı çökerse asıl hata kaybolmasın.
        }
    };

    const onUncaught = (err) => {
        const info = describeError(err);
        logger.error(`[CrashGuard] Yakalanmamış istisna: ${info.message}`, info.stack);
        notify('uncaughtException', info.message);
    };

    const onRejection = (reason) => {
        const info = describeError(reason);
        logger.error(`[CrashGuard] İşlenmemiş promise reddi: ${info.message}`, info.stack);
        notify('unhandledRejection', info.message);
    };

    processRef.on('uncaughtException', onUncaught);
    processRef.on('unhandledRejection', onRejection);

    return function uninstallCrashGuard() {
        if (typeof processRef.removeListener !== 'function') return;
        processRef.removeListener('uncaughtException', onUncaught);
        processRef.removeListener('unhandledRejection', onRejection);
    };
}

module.exports = { installCrashGuard, describeError };
