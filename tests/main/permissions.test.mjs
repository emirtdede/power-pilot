/**
 * permissions.test.mjs - izin kararları (mikrofon regresyonu)
 *
 * "Sesli komut" `getUserMedia({ audio })` çağırıyor; eski izin tutucusu
 * yalnızca `notifications`'a izin verdiği için mikrofon her seferinde
 * reddediliyor ve özellik hiç çalışmıyordu. En az yetki ilkesi korunmalı:
 * ses serbest, kamera/konum/ekran reddedilir.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../src/main/security/Permissions.js');

describe('izin kararları (en az yetki)', () => {
    it('bildirimlere izin verir', () => {
        expect(P.allowRequest('notifications')).toBe(true);
        expect(P.allowCheck('notifications')).toBe(true);
    });

    it('kendi origin’inden ses isteğine izin verir (mikrofon regresyonu)', () => {
        expect(P.allowRequest('media', {
            mediaTypes: ['audio'],
            securityOrigin: 'app://powerpilot'
        })).toBe(true);
        expect(P.allowCheck('media', { mediaType: 'audio' }, 'app://powerpilot')).toBe(true);
    });

    it('video (kamera) reddedilir', () => {
        expect(P.allowRequest('media', {
            mediaTypes: ['video'],
            securityOrigin: 'app://powerpilot'
        })).toBe(false);
        expect(P.allowRequest('media', {
            mediaTypes: ['audio', 'video'],
            securityOrigin: 'app://powerpilot'
        })).toBe(false);
        expect(P.allowCheck('media', { mediaType: 'video' }, 'app://powerpilot')).toBe(false);
    });

    it('yabancı origin’den medya reddedilir', () => {
        expect(P.allowRequest('media', {
            mediaTypes: ['audio'],
            securityOrigin: 'https://evil.example'
        })).toBe(false);
        expect(P.allowCheck('media', { mediaType: 'audio' }, 'https://evil.example')).toBe(false);
    });

    it('diğer izinler reddedilir', () => {
        for (const permission of ['geolocation', 'midi', 'usb', 'serial', 'display-capture', 'openExternal']) {
            expect(P.allowRequest(permission), permission).toBe(false);
            expect(P.allowCheck(permission), permission).toBe(false);
        }
    });

    it('origin ayrıştırma app://powerpilot alt yollarını kabul eder', () => {
        expect(P.isOwnOrigin('app://powerpilot')).toBe(true);
        expect(P.isOwnOrigin('app://powerpilot/index.html')).toBe(true);
        expect(P.isOwnOrigin('app://powerpilot-evil/')).toBe(false);
        expect(P.isOwnOrigin('https://powerpilot.app')).toBe(false);
    });

    it('boş medya listesi yalnızca ses sayılır', () => {
        expect(P.isAudioOnly([])).toBe(true);
        expect(P.isAudioOnly(undefined)).toBe(true);
        expect(P.isAudioOnly(['audio'])).toBe(true);
        expect(P.isAudioOnly(['video'])).toBe(false);
    });
});
