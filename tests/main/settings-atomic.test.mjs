/**
 * settings-atomic.test.mjs - O-11 / O-20 / K-04
 *
 * O-11/O-20: dil, enerji ve otonomi ayarları tek IPC'de, PIN doğrulandıktan
 * sonra yazılır. Renderer PIN istemini iptal ederse sunucuda kısmi kayıt
 * oluşmaz. K-04: tray otonomi değişikliği doğrudan depoya yazmaz; PIN'li
 * renderer akışına yönlendirir.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.resolve(here, '../../main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.resolve(here, '../../src/renderer/app.js'), 'utf8');
const preloadSource = fs.readFileSync(path.resolve(here, '../../preload.js'), 'utf8');

function handlerBody(source, channel, nextMarker) {
    const start = source.indexOf(`ipcHandle('${channel}'`);
    expect(start, `${channel} handler bulunamadı`).toBeGreaterThan(-1);
    const end = nextMarker ? source.indexOf(nextMarker, start) : -1;
    return source.slice(start, end > start ? end : start + 3000);
}

describe('O-11/O-20 atomik ayar yolu', () => {
    it('renderer dil/uyku/enerji/otonomi için saveSettingsAtomic kullanır ve kritik değişimde onay ister', () => {
        const start = rendererSource.indexOf('async function saveWakeSettings()');
        const end = rendererSource.indexOf('// Split-Nav Smooth Section Jump');
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const body = rendererSource.slice(start, end);

        expect(body).toMatch(/saveSettingsAtomic\(\{ settings: patch, pin \}\)/);
        expect(body).not.toMatch(/electronAPI\.saveSettings\(/);
        // Uyku/enerji ayarları güvenlik alanı taşımadan atomik yazılır;
        // otonomi değişikliği yalnızca onay + PIN kapısıyla ayrı yazılır.
        expect(body).toMatch(/const patch = \{ wakeMode, wakeToleranceMinutes: wakeTolRaw \};/);
        expect(body).toMatch(/const patch = \{ autonomyMode: nextMode \};/);
        expect(body).toMatch(/requestActionConfirm\(/);
        // PIN iptalinde yalnızca form geri alınır; sunucuya yazım yok.
        expect(body).toMatch(/cancel: \(\) => \{ restoreAutonomy\(\); \}/);
    });

    it('main save-settings-atomic önce doğrular + PIN ister, sonra tek kez uygular', () => {
        const body = handlerBody(mainSource, 'save-settings-atomic', "ipcHandle('security-settings-update'");

        expect(body).toMatch(/validateSecuritySettings\(securityPatch, current\)/);
        expect(body).toMatch(/requireSecurityPin\(pin\)/);
        expect(body.indexOf('requireSecurityPin(pin)')).toBeGreaterThan(-1);
        expect(body.indexOf('requireSecurityPin(pin)')).toBeLessThan(body.indexOf('applySettingsPatch(patch'));
        expect(body.match(/applySettingsPatch\(/g)).toHaveLength(1);
    });

    it('normal save-settings güvenlik alanlarını kabul etmez', () => {
        const body = handlerBody(mainSource, 'save-settings', '// O-20:');
        expect(body).toMatch(/validateSettings\(newSettings, current\)/);
        expect(body).not.toMatch(/SECURITY_SETTING_KEYS\.includes/);
    });
});

describe('K-04 tray otonomi akışı', () => {
    it('tray doğrudan autonomyMode yazmaz; renderer PIN akışını başlatır', () => {
        const start = mainSource.indexOf('function createTray()');
        expect(start).toBeGreaterThan(-1);
        const body = mainSource.slice(start, start + 7000);
        expect(body).toMatch(/webContents\.send\('request-autonomy-change'/);
        expect(body).not.toMatch(/updateSettings\(\{ autonomyMode/);
    });

    it('renderer tray isteğini güvenlik ayarı akışıyla uygular', () => {
        const start = rendererSource.indexOf('onRequestAutonomyChange');
        expect(start).toBeGreaterThan(-1);
        const body = rendererSource.slice(start, start + 700);
        expect(body).toMatch(/saveSecuritySettings\(\{ autonomyMode: target \}/);
    });

    it('preload tray otonomi olayını köprüler', () => {
        expect(preloadSource).toMatch(/onRequestAutonomyChange:[\s\S]*?request-autonomy-change/);
    });
});
