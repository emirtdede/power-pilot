/**
 * Permissions.js - Electron izin kararları (saf, test edilebilir).
 *
 * Neden ayrı modül: izin mantığı `main.js` içinde satır arası duruyordu ve
 * yalnızca `notifications`'a izin veriyordu. Oysa "sesli komut" özelliği
 * `navigator.mediaDevices.getUserMedia({ audio })` çağırıyor; mikrofon izni
 * hiç verilmediği için düğme her seferinde "mikrofon izni yok" hatasına
 * düşüyordu. Bu, kullanıcıya görünen işlevsel bir hataydı.
 *
 * Kurallar (en az yetki ilkesi):
 *  - `notifications`: izinli (uyarı balonları için).
 *  - `media`: yalnızca **ses**, yalnızca kendi origin'imizden; video reddedilir.
 *  - diğer her şey (kamera, konum, ekran yakalama, MIDI, USB, ...): reddedilir.
 */

'use strict';

const APP_ORIGIN = 'app://powerpilot';

/**
 * Verilen origin/URL kendi uygulamamıza mı ait?
 * `app://powerpilot`, `app://powerpilot/`, `app://powerpilot/index.html` kabul.
 * Boş değer "bilinmiyor" sayılır ve güvenli tarafta kalınır (izin verilir;
 * Electron bazı check çağrılarında origin vermez, kendi tek penceremizden
 * geldiği bellidir).
 *
 * @param {string|undefined|null} originOrUrl
 * @returns {boolean}
 */
function isOwnOrigin(originOrUrl) {
    if (!originOrUrl) return true;
    const value = String(originOrUrl);
    return value === APP_ORIGIN || value.startsWith(`${APP_ORIGIN}/`);
}

/**
 * Medya isteği yalnızca ses mi? (video reddedilir)
 * @param {Array<'audio'|'video'>|undefined} mediaTypes
 * @returns {boolean}
 */
function isAudioOnly(mediaTypes) {
    const list = Array.isArray(mediaTypes) ? mediaTypes : [];
    if (list.includes('video')) return false;
    // Liste boşsa Chromium yalnızca ses istediği varsayılır.
    return list.length === 0 || list.includes('audio');
}

/**
 * `setPermissionRequestHandler` kararı.
 *
 * @param {string} permission
 * @param {{ mediaTypes?: Array<'audio'|'video'>, securityOrigin?: string }} [details]
 * @returns {boolean}
 */
function allowRequest(permission, details = {}) {
    if (permission === 'notifications') return true;
    if (permission === 'media') {
        return isAudioOnly(details.mediaTypes) && isOwnOrigin(details.securityOrigin);
    }
    return false;
}

/**
 * `setPermissionCheckHandler` kararı.
 *
 * @param {string} permission
 * @param {{ mediaType?: 'audio'|'video'|'unknown', securityOrigin?: string }} [details]
 * @param {string} [requestingOrigin]
 * @returns {boolean}
 */
function allowCheck(permission, details = {}, requestingOrigin) {
    if (permission === 'notifications') return true;
    if (permission === 'media') {
        if (details.mediaType === 'video') return false;
        return isOwnOrigin(details.securityOrigin || requestingOrigin);
    }
    return false;
}

module.exports = {
    APP_ORIGIN,
    isOwnOrigin,
    isAudioOnly,
    allowRequest,
    allowCheck
};
