'use strict';

/**
 * electron-builder.store.cjs - Microsoft Store (MSIX) dağıtımı.
 *
 * NSIS yapılandırmasının üzerine:
 *  - yalnızca `appx` hedefi,
 *  - StartupTask uzantısı (autostart Windows Başlangıç ayarlarından),
 *  - yalnızca runFullTrust capability (LAN/konsol Store'da yok),
 *  - test/doküman/CI artıkları ve GPU AI ikilileri paket dışında.
 */

const base = require('./electron-builder.config.cjs');

const prune = [
    // Test ve geliştirme artıkları pakete girmez.
    '!tests/**',
    '!docs/**',
    '!QA_AUDIT_RAPORU.md',
    '!README.md',
    '!CHANGELOG.md',
    '!.github/**',
    '!spikes/**',
    '!scratch/**',
    '!integrations/**',
    '!build/**',
    '!*.log',
    // AI çalışma zamanı: CPU yeterli; CUDA (~545 MB) ve arm64 dışarıda.
    '!node_modules/@node-llama-cpp/win-x64-cuda/**',
    '!node_modules/@node-llama-cpp/win-x64-cuda-ext/**',
    '!node_modules/@node-llama-cpp/win-x64-vulkan/**',
    '!node_modules/@node-llama-cpp/win-arm64/**',
    '!node_modules/@fugood/node-whisper-win32-x64-cuda/**',
    '!node_modules/@fugood/node-whisper-win32-x64-vulkan/**',
    // Yalnız derleme/CI için gereken ağırlıklar (bkz. package.json).
    '!node_modules/node-llama-cpp/llama/gitRelease.bundle',
    '!node_modules/@fugood/whisper.node/src/**',
    '!node_modules/@fugood/node-whisper-wasm/**',
    '!node_modules/better-sqlite3/prebuilds/darwin-*.node',
    '!node_modules/better-sqlite3/prebuilds/linux-*.node',
    '!node_modules/better-sqlite3/prebuilds/linuxmusl-*.node',
    '!node_modules/better-sqlite3/deps/**',
    '!node_modules/better-sqlite3/src/**',
    '!node_modules/better-sqlite3/build/**',
    '!**/*.map',
    // Store kapsamı dışı kurumsal kurulum betikleri.
    '!scripts/install-service.ps1',
    '!scripts/firewall.ps1',
    '!scripts/packaged-e2e.ps1',
    '!scripts/*.mjs',
    // Microsoft Store kurulumlari yalnizca Store uzerinden guncellenir; kendi guncelleyicisi paketlenmez.
    '!node_modules/electron-updater/**'
];

module.exports = {
    ...base,
    publish: null,
    win: {
        ...base.win,
        target: ['appx']
    },
    appx: {
        applicationId: 'PowerPilot',
        identityName: 'Vellium.PowerPilot',
        displayName: 'Power Pilot',
        backgroundColor: '#09090b',
        publisher: process.env.APPX_PUBLISHER,
        publisherDisplayName: 'Vellium.dev',
        languages: [
            'TR-TR', 'EN-US', 'DE-DE', 'SV-SE', 'NB-NO', 'DA-DK', 'FR-FR', 'PL-PL',
            'IT-IT', 'NL-NL', 'CS-CZ', 'ES-ES', 'PT-PT', 'JA-JP', 'ZH-CN', 'KO-KR', 'AR-SA'
        ],
        // Sesli komut `getUserMedia({audio})` kullanır; MSIX paketinde mikrofon
        // cihaz yetkisi bildirilmezse ses aygıtına erişilemez (Store 10.2/11.16).
        capabilities: ['runFullTrust', 'microphone'],
        // StartupTask'ı kendimiz tanımlıyoruz (TaskId/DisplayName okunur olsun).
        addAutoLaunchExtension: false,
        customExtensionsPath: 'build/appx-extensions.xml',
        artifactName: 'PowerPilot_${version}_${arch}.${ext}'
    },
    files: [...(base.files || []), ...prune]
};
