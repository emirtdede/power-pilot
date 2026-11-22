/**
 * pin-management.test.mjs - K-01 / Y-02 regresyon testi.
 *
 * K-01: PIN kurulduktan sonra değiştirme/silme mevcut PIN doğrulaması ister;
 * aksi halde yerel erişimi olan biri PIN'i sıfırlayıp korumalı işlemleri
 * açabilirdi.
 * Y-02: tray duraklat/çıkış PIN kuruluysa doğrudan uygulanmaz; PIN'li renderer
 * akışına yönlendirilir. IPC gövdeleri de PIN kapısını tekrar doğrular.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    setCancelPinAction,
    clearCancelPinAction
} from '../../src/main/ipc/cancelPinActions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.resolve(here, '../../main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.resolve(here, '../../src/renderer/app.js'), 'utf8');

const t = (key) => `tr:${key}`;
const hashPin = vi.fn(async (pin) => `hash:${pin}`);

function makeStorage(existingHash = null) {
    const data = { cancelPinHash: existingHash, cancelPinSalt: 'legacy-salt' };
    return {
        data,
        getSettings: () => ({ ...data }),
        updateSettings: vi.fn((patch) => Object.assign(data, patch))
    };
}

function makeAudit() {
    return { append: vi.fn() };
}

describe('K-01 set-cancel-pin mevcut PIN ister', () => {
    it('PIN yokken mevcut PIN sorulmaz; Argon2 hash ve denetim yazılır', async () => {
        const storageService = makeStorage(null);
        const auditLog = makeAudit();
        const requireCancelPin = vi.fn(async () => null);

        const res = await setCancelPinAction({
            pin: '1234', currentPin: undefined, requireCancelPin,
            storageService, auditLog, t, hashPin
        });

        expect(res).toEqual({ success: true });
        expect(requireCancelPin).not.toHaveBeenCalled();
        expect(storageService.updateSettings).toHaveBeenCalledWith({
            cancelPinSalt: null,
            cancelPinHash: 'hash:1234'
        });
        expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_pin_set' }));
    });

    it('PIN kuruluyken doğru mevcut PIN ile değiştirilir ve changed denetlenir', async () => {
        const storageService = makeStorage('eski-hash');
        const auditLog = makeAudit();
        const requireCancelPin = vi.fn(async () => null);

        const res = await setCancelPinAction({
            pin: '5678', currentPin: '1234', requireCancelPin,
            storageService, auditLog, t, hashPin
        });

        expect(res).toEqual({ success: true });
        expect(requireCancelPin).toHaveBeenCalledWith('1234');
        expect(storageService.updateSettings).toHaveBeenCalledWith({
            cancelPinSalt: null,
            cancelPinHash: 'hash:5678'
        });
        expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_pin_changed' }));
    });

    it('mevcut PIN yoksa/yanlışsa yeni PIN yazılmaz', async () => {
        const storageService = makeStorage('eski-hash');
        const auditLog = makeAudit();
        const challenge = { success: false, code: 'PIN_WRONG', attemptsLeft: 2 };
        const requireCancelPin = vi.fn(async () => challenge);

        const res = await setCancelPinAction({
            pin: '5678', currentPin: '0000', requireCancelPin,
            storageService, auditLog, t, hashPin
        });

        expect(res).toEqual(challenge);
        expect(storageService.updateSettings).not.toHaveBeenCalled();
        expect(auditLog.append).not.toHaveBeenCalled();
        expect(hashPin).not.toHaveBeenCalledWith('5678');
    });

    it('kalıcılaştırma hatası sessizce yutulmaz, denetim yazılmaz', async () => {
        const storageService = makeStorage(null);
        storageService.updateSettings.mockImplementation(() => {
            throw Object.assign(new Error('disk'), { code: 'SETTINGS_PERSIST_FAILED' });
        });
        const auditLog = makeAudit();

        const res = await setCancelPinAction({
            pin: '1234', currentPin: undefined, requireCancelPin: vi.fn(async () => null),
            storageService, auditLog, t, hashPin
        });

        expect(res).toMatchObject({ success: false, code: 'SETTINGS_PERSIST_FAILED' });
        expect(auditLog.append).not.toHaveBeenCalled();
    });
});

describe('K-01 clear-cancel-pin mevcut PIN ister', () => {
    it('PIN kuruluyken yanlış mevcut PIN silmeyi engeller', async () => {
        const storageService = makeStorage('eski-hash');
        const auditLog = makeAudit();
        const challenge = { success: false, code: 'PIN_REQUIRED' };
        const requireCancelPin = vi.fn(async () => challenge);

        const res = await clearCancelPinAction({
            currentPin: undefined, requireCancelPin, storageService, auditLog, t
        });

        expect(res).toEqual(challenge);
        expect(storageService.updateSettings).not.toHaveBeenCalled();
        expect(auditLog.append).not.toHaveBeenCalled();
    });

    it('doğru mevcut PIN ile PIN kaldırılır ve cleared denetlenir', async () => {
        const storageService = makeStorage('eski-hash');
        const auditLog = makeAudit();
        const requireCancelPin = vi.fn(async () => null);

        const res = await clearCancelPinAction({
            currentPin: '1234', requireCancelPin, storageService, auditLog, t
        });

        expect(res).toEqual({ success: true });
        expect(requireCancelPin).toHaveBeenCalledWith('1234');
        expect(storageService.updateSettings).toHaveBeenCalledWith({
            cancelPinSalt: null,
            cancelPinHash: null
        });
        expect(auditLog.append).toHaveBeenCalledWith(expect.objectContaining({ action: 'cancel_pin_cleared' }));
    });

    it('kalıcılaştırma hatası raporlanır', async () => {
        const storageService = makeStorage('eski-hash');
        storageService.updateSettings.mockImplementation(() => {
            throw Object.assign(new Error('disk'), { code: 'SETTINGS_PERSIST_FAILED' });
        });

        const res = await clearCancelPinAction({
            currentPin: '1234', requireCancelPin: vi.fn(async () => null),
            storageService, auditLog: makeAudit(), t
        });

        expect(res).toMatchObject({ success: false, code: 'SETTINGS_PERSIST_FAILED' });
    });
});

describe('K-01/Y-02 main.js sözleşmesi', () => {
    function handlerBody(channel) {
        const start = mainSource.indexOf(`ipcHandle('${channel}'`);
        expect(start, `${channel} handler bulunamadı`).toBeGreaterThan(-1);
        return mainSource.slice(start, start + 700);
    }

    it('set/clear handler mevcut PIN eylemini await eder', () => {
        expect(handlerBody('set-cancel-pin')).toMatch(/await\s+setCancelPinAction\(/);
        expect(handlerBody('set-cancel-pin')).toMatch(/currentPin/);
        expect(handlerBody('clear-cancel-pin')).toMatch(/await\s+clearCancelPinAction\(/);
        expect(handlerBody('clear-cancel-pin')).toMatch(/currentPin/);
    });

    it('tray duraklat/çıkış PIN varsa renderer akışına yönlendirilir', () => {
        const trayStart = mainSource.indexOf('function createTray()');
        const trayBody = mainSource.slice(trayStart, trayStart + 6000);
        expect(trayBody).toMatch(/if \(settings\.cancelPinHash\) return showMainWindowForPin\('pause'\)/);
        expect(trayBody).toMatch(/if \(settings\.cancelPinHash\) return showMainWindowForPin\('quit'\)/);
        expect(trayBody).toMatch(/trayCancelNearest[\s\S]*?settings\.cancelPinHash/);
    });

    it('durum-değiştiren tray IPC’leri PIN kapısından geçer', () => {
        expect(handlerBody('toggle-pause-all')).toMatch(/requireCancelPin\(args && args\.pin\)/);
        expect(handlerBody('quit-app')).toMatch(/requireCancelPin\(args && args\.pin\)/);
    });

    it('renderer PIN istemini gösterip eylemi yeniden dener', () => {
        expect(rendererSource).toMatch(/onRequestTrayPinAction/);
        expect(rendererSource).toMatch(/requestPin\(/);
        expect(rendererSource).toMatch(/togglePauseAll|quitApp/);
    });
});
