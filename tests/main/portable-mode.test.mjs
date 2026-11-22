/**
 * Taşınabilir (portable) sürüm sözleşmeleri.
 *
 * Neden test: taşınabilir paket, kurulum paketiyle aynı kodu çalıştırır ama
 * iki yerde farklı davranmak zorundadır:
 *   1. Veri `%APPDATA%` yerine SFX'in yanında durmalı (yoksa "portable" yalan).
 *   2. Windows Görev Zamanlayıcı kaydı geçici çıkarma dizinini değil SFX'i
 *      göstermeli (yoksa uygulama kapandıktan sonra görev hiç tetiklenmez).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Portable = require('../../src/main/util/Portable.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '../..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('Portable - veri klasörü', () => {
    it('taşınabilir değilken veri yeri dayatmaz', () => {
        expect(Portable.isPortable({})).toBe(false);
        expect(Portable.portableDataDir({})).toBe(null);
        expect(Portable.portableDataDir({ PORTABLE_EXECUTABLE_DIR: '   ' })).toBe(null);
        expect(Portable.portableDataDir(undefined)).toBe(null);
    });

    it('SFX klasörünün yanında PowerPilotData kullanır', () => {
        const dir = Portable.portableDataDir({ PORTABLE_EXECUTABLE_DIR: 'D:\\Araclar\\PowerPilot' });
        expect(dir).toBe(path.join(path.resolve('D:\\Araclar\\PowerPilot'), 'PowerPilotData'));
        expect(Portable.isPortable({ PORTABLE_EXECUTABLE_DIR: 'D:\\Araclar' })).toBe(true);
    });
});

describe('Portable - zamanlayıcı yolu', () => {
    it('taşınabilir değilken null döner (çağıran app.getPath kullanır)', () => {
        expect(Portable.portableExePath({})).toBe(null);
        expect(Portable.portableExePath({ PORTABLE_EXECUTABLE_FILE: '' })).toBe(null);
    });

    it('SFX dosyası varsa onu döner', () => {
        const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\Araclar\\Power Pilot Portable 1.1.0.exe' };
        expect(Portable.portableExePath(env, () => true))
            .toBe(path.resolve('D:\\Araclar\\Power Pilot Portable 1.1.0.exe'));
    });

    it('SFX dosyası yoksa geçersiz yol yazmaz', () => {
        const env = { PORTABLE_EXECUTABLE_FILE: 'D:\\Araclar\\yok.exe' };
        expect(Portable.portableExePath(env, () => false)).toBe(null);
    });
});

describe('main.js bağlantısı', () => {
    it('taşınabilir veri klasörü uygulanır ve hata açılışı engellemez', () => {
        expect(mainSrc).toContain('Portable.portableDataDir(process.env)');
        const idx = mainSrc.indexOf('Portable.portableDataDir(process.env)');
        const block = mainSrc.slice(idx, idx + 600);
        expect(block).toMatch(/app\.setPath\('userData', portableDir\)/);
        // Salt okunur medyada çökmek yerine varsayılana dönülür.
        expect(block).toMatch(/catch \(err\)/);
        // Açık `--user-data-dir` her zaman kazanır (CI/test yolu bozulmaz).
        const explicitIdx = mainSrc.indexOf('const userDataDirOverride = parseUserDataDir(process.argv)');
        expect(explicitIdx).toBeGreaterThan(-1);
        expect(explicitIdx).toBeLessThan(idx);
        expect(mainSrc.slice(explicitIdx, idx)).toContain('} else {');
    });

    it('zamanlayıcı kaydı SFX yolunu kullanır', () => {
        expect(mainSrc).toContain('Portable.portableExePath(process.env, fs.existsSync) || app.getPath(\'exe\')');
    });
});

describe('paketleme yapılandırması', () => {
    it('portable hedefi ayrı artefakt adı üretir (setup ile çakışmaz)', () => {
        expect(pkg.build.portable).toBeTruthy();
        expect(pkg.build.portable.artifactName).toContain('Portable');
        expect(pkg.build.portable.artifactName).toContain('${version}');
        // Kurulum paketi adı değişmemeli.
        expect(pkg.build.nsis.artifactName).toBe('${productName} Setup ${version}.${ext}');
    });

    it('portable derlemesi ayrı npm betiği ve doğru yapılandırma ile çalışır', () => {
        const script = String(pkg.scripts['dist:portable'] || '');
        expect(script).toContain('--win portable');
        expect(script).toContain('--config electron-builder.config.cjs');
        expect(script).toContain('--publish never');
    });

    it('yayın kapısı bozulmaz: varsayılan hedef yalnızca nsis kalır', () => {
        // release-check.js bu kuralı zorunlu tutuyor; portable varsayılan olmamalı.
        expect(pkg.build.win.target).toEqual(['nsis']);
    });
});
