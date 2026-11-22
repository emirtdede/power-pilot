/**
 * store-packaging.test.mjs - MSIX paket sözleşmesi (statik)
 *
 * Store yapılandırmasının kapsamı, StartupTask uzantısı ve paket hijyeni
 * sessizce bozulmasın.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('Store (MSIX) paket sözleşmesi', () => {
    it('store config appx hedefler, runFullTrust ve mikrofon ister', async () => {
        const mod = await import('../../electron-builder.store.cjs');
        const config = mod.default || mod;
        expect(config.win.target).toEqual(['appx']);
        expect(config.appx.capabilities).toContain('runFullTrust');
        expect(config.appx.capabilities).toContain('microphone');
        expect(config.appx.addAutoLaunchExtension).toBe(false);
        expect(config.appx.customExtensionsPath).toBe('build/appx-extensions.xml');
    });

    it('StartupTask uzantısı kullanıcı onaylı ve doğru EXE adında', () => {
        const xml = read('build/appx-extensions.xml');
        expect(xml).toContain('Category="windows.startupTask"');
        expect(xml).toContain('TaskId="PowerPilotStartup"');
        expect(xml).toContain('Enabled="false"');
        // Bu dosya AppxManifest.xml içine gömülür; EXE orada `app\` altında.
        // (Gerçek MakeAppx doğrulaması bunu zorunlu kıldı.)
        expect(xml).toContain(`Executable="app\\${pkg.build.productName}.exe"`);
        // Gömülen dosyada XML bildirimi olmamalı; aksi halde manifest
        // içinde ikinci bir `<?xml?>` oluşur ve paket reddedilir.
        expect(xml.trimStart().startsWith('<?xml')).toBe(false);
    });

    it('paket hijyeni: test/doküman ve GPU AI ikilileri dışarıda', async () => {
        const mod = await import('../../electron-builder.store.cjs');
        const files = (mod.default || mod).files.join('\n');
        for (const pattern of ['!tests/**', '!docs/**', '!node_modules/@node-llama-cpp/win-x64-cuda/**', '!node_modules/@fugood/node-whisper-win32-x64-cuda/**']) {
            expect(files, pattern).toContain(pattern);
        }
        expect(pkg.build.files).toContain('!tests/**');
        expect(pkg.build.files).toContain('!docs/**');
    });

    it('NSIS (Pro) paketi de GPU-özel AI ikililerini dışarıda bırakır', () => {
        // Aksi halde kurulum ~507 MB olur (CUDA+Vulkan). CPU yedeği
        // doğrulandı: scratch/verify-llama-without-cuda.js → getLlama() PASS.
        const files = pkg.build.files.join('\n');
        for (const pattern of [
            '!node_modules/@node-llama-cpp/win-x64-cuda/**',
            '!node_modules/@node-llama-cpp/win-x64-cuda-ext/**',
            '!node_modules/@node-llama-cpp/win-arm64/**',
            '!node_modules/@fugood/node-whisper-win32-x64-cuda/**'
        ]) {
            expect(files, pattern).toContain(pattern);
        }
    });

    it('NSIS (Pro) paketi ölü ağırlıkları dışarıda bırakır (boyut kapısı)', () => {
        // Kurulum 507 MB -> 155 MB. Bu dışlamalar kaldırılırsa boyut sessizce geri
        // döner. Her biri doğrulandı:
        //  - whisper Vulkan: SttService initWhisper({...}) varyant vermez -> CPU paketi.
        //  - better-sqlite3 yabancı prebuild'ler: binding.js yalnız <platform>-<arch>.node.
        //  - better-sqlite3 deps/src/build: C kaynağı ve üretim artefaktları.
        const files = pkg.build.files.join('\n');
        for (const pattern of [
            '!node_modules/@fugood/node-whisper-win32-x64-vulkan/**',
            '!node_modules/better-sqlite3/prebuilds/darwin-*.node',
            '!node_modules/better-sqlite3/prebuilds/linux-*.node',
            '!node_modules/better-sqlite3/prebuilds/linuxmusl-*.node',
            '!node_modules/better-sqlite3/deps/**',
            '!node_modules/better-sqlite3/src/**',
            '!node_modules/better-sqlite3/build/**',
            // node-llama-cpp: CUDA/Vulkan + arm64 (CPU paketi kalır)
            '!node_modules/@node-llama-cpp/win-x64-vulkan/**',
            // CI'nin llama.cpp kaynak paketi (34 MB) çalışma zamanında okunmaz.
            '!node_modules/node-llama-cpp/llama/gitRelease.bundle',
            // whisper.node vendor C++ kaynağı ve yalnız tarayıcıda yüklenen WASM.
            '!node_modules/@fugood/whisper.node/src/**',
            '!node_modules/@fugood/node-whisper-wasm/**',
            '!**/*.map'
        ]) {
            expect(files, pattern).toContain(pattern);
        }
    });

    it('Electron dil paketleri 17 arayüz diliyle sınırlı (55 Chromium yereli değil)', () => {
        // Chromium 55 yerel paketi ~47 MB taşır; arayüz 17 dil. Liste
        // `electronLanguages` ile kırpılır ve tr/en-US dahil olmalıdır.
        const langs = pkg.build.electronLanguages;
        expect(Array.isArray(langs)).toBe(true);
        expect(langs.length).toBe(18);
        for (const required of ['en-US', 'tr', 'de', 'ja', 'zh-CN', 'ar']) {
            expect(langs, required).toContain(required);
        }
        // Sözlükte olmayan bir arayüz dili paketlenmemeli.
        expect(langs).not.toContain('ru');
        expect(langs.length).toBeLessThan(25);
    });

    it('store scriptleri tanımlı', () => {
        expect(pkg.scripts['pack:store']).toContain('electron-builder.store.cjs');
        expect(pkg.scripts['dist:store']).toContain('build-appx.js --store');
    });
});
