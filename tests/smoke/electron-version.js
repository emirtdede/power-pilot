/**
 * electron-version.js - WP-00.T2
 * Electron'in kendi içindeki Node sürümünü ve ABI'yi doğrular.
 * Host Node sürümü ne olursa olsun CI bu job'da Electron runtime'ını test eder.
 *
 * Çalıştırma: npx electron tests/smoke/electron-version.js
 */
const { app } = require('electron');

const versions = process.versions;
const major = (v) => Number(String(v || '0').split('.')[0]);

const checks = [
    { name: 'electron', value: versions.electron, ok: major(versions.electron) >= 43 },
    { name: 'node', value: versions.node, ok: major(versions.node) >= 24 },
    { name: 'modules (ABI)', value: versions.modules, ok: Number(versions.modules) >= 130 }
];

let failed = false;
for (const check of checks) {
    const status = check.ok ? 'OK' : 'FAIL';
    console.log(`[smoke] ${check.name}=${check.value} ${status}`);
    if (!check.ok) failed = true;
}

app.whenReady().then(() => {
    process.exitCode = failed ? 1 : 0;
    app.quit();
});
