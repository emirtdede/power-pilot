/**
 * build-appx-gate.test.mjs - C1/MSIX üretim kapısı regresyonu
 *
 * Gerçek mağaza paketi üretilirken iki sessiz hata vardı:
 *  1. `build-appx` electron-builder'ı `npx.cmd` ile çağırıyordu; Node 20+
 *     (CVE-2024-27980) `.cmd` spawn'ını `EINVAL` ile reddediyor. Yani Store
 *     paketi hiç üretilemiyordu.
 *  2. Sertifika doğrulaması `WINDOWS_CERT_SUBJECT` okuyordu ama build
 *     `package.json`'daki ham `${env.WIN_CERT_SUBJECT}` üzerinden gidiyordu;
 *     doğru sertifikayla bile "Cannot find certificate" hatası alınıyordu.
 *
 * Bu testler o kapıyı sabitler; üretim ortamı olmadan da çalışır.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appx = require('../../scripts/build-appx.js');

describe('C1 - MSIX üretim kapısı', () => {
    it('imza Subject’i iki ortam adından da çözülür', () => {
        expect(appx.resolveSigningSubject({ WINDOWS_CERT_SUBJECT: 'CN=A, O=B' }).subject).toBe('CN=A, O=B');
        expect(appx.resolveSigningSubject({ WIN_CERT_SUBJECT: 'CN=C' }).subject).toBe('CN=C');
        // İkisi de yoksa ve publisher verilmemişse null.
        expect(appx.resolveSigningSubject({}).subject).toBeNull();
    });

    it('WINDOWS_CERT_SUBJECT öncelikli, boşluklar kırpılır', () => {
        const result = appx.resolveSigningSubject({
            WINDOWS_CERT_SUBJECT: '  CN=Primary  ',
            WIN_CERT_SUBJECT: 'CN=Fallback'
        });
        expect(result.subject).toBe('CN=Primary');
        expect(result.source).toBe('env');
    });

    it('publisher normalize edilir (sıra ve boşluk bağımsız)', () => {
        expect(appx.normalizePublisher('CN=A, O=B')).toBe(appx.normalizePublisher('O=B,CN=A'));
        expect(appx.normalizePublisher('  CN=B ,  O=A ')).toBe('CN=B,O=A');
        expect(appx.normalizePublisher(null)).toBe('');
    });

    it('betik .cmd spawn etmiyor (Node 20+ EINVAL regresyonu)', () => {
        const src = fs.readFileSync(path.join(root, 'scripts/build-appx.js'), 'utf8');
        // Yalnızca kod denetlenir; yorumlarda "npx.cmd" geçebilir.
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/npx\.cmd/);
        expect(code).not.toMatch(/'npx'/);
        // electron-builder CLI doğrudan Node ile çağrılmalı.
        expect(code).toMatch(/electron-builder\/cli\.js/);
        expect(code).toMatch(/process\.execPath/);
    });

    it('build her zaman imza alanını çözen config ile çalışır', () => {
        const src = fs.readFileSync(path.join(root, 'scripts/build-appx.js'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        // Ham `${env.WIN_CERT_SUBJECT}` genişlemesine güvenmek yerine
        // elektron-builder.config.cjs / store config geçilmeli.
        expect(code).toMatch(/electron-builder\.config\.cjs/);
        expect(code).toMatch(/electron-builder\.store\.cjs/);
        expect(code).toMatch(/--config/);
    });

    it('store config runFullTrust + mikrofon ve StartupTask taşır', () => {
        const storeCfg = require('../../electron-builder.store.cjs');
        // Sesli komut `getUserMedia({audio})` kullanır; MSIX'te mikrofon
        // DeviceCapability bildirilmezse ses aygıtına erişilemez.
        expect(storeCfg.appx.capabilities).toContain('runFullTrust');
        expect(storeCfg.appx.capabilities).toContain('microphone');
        expect(storeCfg.appx.capabilities).not.toContain('webcam');
        expect(storeCfg.appx.capabilities).not.toContain('location');
        expect(storeCfg.appx.addAutoLaunchExtension).toBe(false);
        expect(storeCfg.win.target).toEqual(['appx']);
        // StartupTask uzantısı gerçek bir dosyada tanımlı olmalı.
        const extPath = path.join(root, storeCfg.appx.customExtensionsPath);
        expect(fs.existsSync(extPath)).toBe(true);
        const ext = fs.readFileSync(extPath, 'utf8');
        expect(ext).toMatch(/windows\.startupTask/);
        expect(ext).toMatch(/Enabled="false"/);
    });

    it('appx manifest kimliği mağaza beklentisiyle tutarlı', () => {
        const storeCfg = require('../../electron-builder.store.cjs');
        expect(storeCfg.appx.identityName).toBe('Vellium.PowerPilot');
        expect(storeCfg.appx.applicationId).toBe('PowerPilot');
        // 17 arayüz dili mağazada da listelenmeli.
        expect(storeCfg.appx.languages).toHaveLength(17);
    });

    it('store paketi test/doküman/GPU artıklarını dışlar', () => {
        const storeCfg = require('../../electron-builder.store.cjs');
        const files = storeCfg.files.join('\n');
        for (const pattern of ['!tests/**', '!docs/**', '!scratch/**', '!node_modules/@node-llama-cpp/win-x64-cuda/**']) {
            expect(files, pattern).toContain(pattern);
        }
    });
});
