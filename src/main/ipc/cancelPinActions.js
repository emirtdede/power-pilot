'use strict';

/**
 * cancelPinActions.js - K-01
 *
 * PIN kurulduktan sonra değiştirme/silme işlemleri mevcut PIN doğrulamasından
 * geçmelidir. Aksi halde yerel erişimi olan biri PIN'i sıfırlayıp korumalı
 * işlemleri (iptal, çıkış, güvenlik ayarları) açabilirdi.
 *
 * Gövdeler main.js'ten ayrıldı; böylece Electron'a ihtiyaç duymadan
 * davranış test edilebilir (warningActions.js ile aynı desen).
 */

/**
 * @param {object} deps
 * @param {string} deps.pin Yeni PIN
 * @param {string|undefined} deps.currentPin Mevcut PIN (kuruluysa zorunlu)
 * @param {(pin?: string) => Promise<object|null>} deps.requireCancelPin
 * @param {object} deps.storageService
 * @param {object|null} deps.auditLog
 * @param {(key: string) => string} deps.t
 * @param {(pin: string) => Promise<string>} deps.hashPin
 */
async function setCancelPinAction({ pin, currentPin, requireCancelPin, storageService, auditLog, t, hashPin }) {
    const hasExisting = !!(storageService.getSettings() || {}).cancelPinHash;
    if (hasExisting) {
        const pinCheck = await requireCancelPin(currentPin);
        if (pinCheck) return pinCheck;
    }

    const hash = await hashPin(pin);
    try {
        storageService.updateSettings({ cancelPinSalt: null, cancelPinHash: hash });
    } catch (err) {
        return {
            success: false,
            code: (err && err.code) || 'SETTINGS_PERSIST_FAILED',
            message: t('errorSaveFailed')
        };
    }

    try {
        if (auditLog) {
            auditLog.append({
                actor: 'local_user',
                action: hasExisting ? 'cancel_pin_changed' : 'cancel_pin_set',
                target: 'cancel-pin',
                detail: hasExisting ? 'Mevcut PIN doğrulandıktan sonra değiştirildi.' : 'İptal PIN’i kuruldu.'
            });
        }
    } catch (_) { /* denetim best-effort */ }
    return { success: true };
}

/**
 * @param {object} deps
 * @param {string|undefined} deps.currentPin Mevcut PIN (kuruluysa zorunlu)
 * @param {(pin?: string) => Promise<object|null>} deps.requireCancelPin
 * @param {object} deps.storageService
 * @param {object|null} deps.auditLog
 * @param {(key: string) => string} deps.t
 */
async function clearCancelPinAction({ currentPin, requireCancelPin, storageService, auditLog, t }) {
    const hasExisting = !!(storageService.getSettings() || {}).cancelPinHash;
    if (hasExisting) {
        const pinCheck = await requireCancelPin(currentPin);
        if (pinCheck) return pinCheck;
    }

    try {
        storageService.updateSettings({ cancelPinSalt: null, cancelPinHash: null });
    } catch (err) {
        return {
            success: false,
            code: (err && err.code) || 'SETTINGS_PERSIST_FAILED',
            message: t('errorSaveFailed')
        };
    }

    try {
        if (auditLog) {
            auditLog.append({
                actor: 'local_user',
                action: 'cancel_pin_cleared',
                target: 'cancel-pin',
                detail: 'İptal PIN’i mevcut PIN doğrulandıktan sonra kaldırıldı.'
            });
        }
    } catch (_) { /* denetim best-effort */ }
    return { success: true };
}

module.exports = { setCancelPinAction, clearCancelPinAction };
