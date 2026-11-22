#!/usr/bin/env node
/**
 * release-check.js - WBS-12/TS-12: release hijyeni kapısı.
 *
 * Kontroller:
 *  - package.json sürümü 1.1.0 (ve package-lock aynı).
 *  - Node motoru 24.x (release hedefi).
 *  - Varsayılan Windows hedefi YALNIZCA nsis (APPX koşullu/signed).
 *  - ps-list vendor exe asarUnpack dışında kalmıyor.
 *  - Model pinleri ve i18n paritesi (ilgili scriptler çağrılır).
 *  - Üretim kodunda PowerShell idle/tasklist spamı yok.
 *  - Kritik dosyalar mevcut.
 *
 * `--strict-git` ile çalışma ağacı kirliyse hata verir (RC öncesi kullanılır).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const issues = [];
const notes = [];

function readJson(file) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function requireFile(rel) {
    if (!fs.existsSync(path.join(ROOT, rel))) issues.push(`Eksik dosya: ${rel}`);
}

function scanSource(rel, patterns) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const { re, label } of patterns) {
        if (re.test(text)) issues.push(`${rel}: yasak desen bulundu (${label}).`);
    }
}

function main() {
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');

    if (pkg.version !== '1.0.0') issues.push(`package.json sürümü 1.0.0 değil: ${pkg.version}`);
    if (lock.version !== pkg.version) issues.push(`package-lock sürümü uyuşmuyor: ${lock.version}`);
    if (pkg.engines && pkg.engines.node && !/^>=?24/.test(pkg.engines.node)) {
        issues.push(`engines.node 24.x değil: ${pkg.engines.node}`);
    } else if (!pkg.engines || !pkg.engines.node) {
        notes.push('engines.node tanımsız (önerilir: >=24.18.1).');
    }
    // WP-12: sürüm hattı donduruldu; caret/tilde ile sessiz yükseltme yasak.
    // Sürümler Dependabot ile güncellenebilir; kapı belirli bir sürümü değil,
    // aralık işareti içermeyen tam pinleri doğrular.
    const exactPin = /^\d+\.\d+\.\d+$/;
    const pinned = {
        electron: 'devDependencies',
        'electron-builder': 'devDependencies',
        vitest: 'devDependencies',
        '@vitest/coverage-v8': 'devDependencies',
        '@playwright/test': 'devDependencies',
        '@electron/fuses': 'devDependencies',
        'ps-list': 'dependencies',
        'ipaddr.js': 'dependencies'
    };
    for (const [name, section] of Object.entries(pinned)) {
        const actual = pkg[section] && pkg[section][name];
        if (typeof actual !== 'string' || !exactPin.test(actual)) {
            issues.push(`${section}.${name} tam pinli olmalı (x.y.z); mevcut: ${actual}`);
        }
    }
    try {
        const nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
        if (nvmrc !== '24.18.1') issues.push(`.nvmrc 24.18.1 değil: ${nvmrc}`);
    } catch (_) {
        issues.push('.nvmrc eksik.');
    }

    const targets = (pkg.build && pkg.build.win && pkg.build.win.target) || [];
    if (targets.length !== 1 || targets[0] !== 'nsis') {
        issues.push(`Varsayılan win.target yalnızca ["nsis"] olmalı; mevcut: ${JSON.stringify(targets)}`);
    }
    const unpack = (pkg.build && pkg.build.asarUnpack) || [];
    if (!unpack.some((p) => String(p).includes('ps-list'))) {
        issues.push('asarUnpack ps-list vendor exe içermiyor (paketli ps-list çalışmaz).');
    }
    const nsis = (pkg.build && pkg.build.nsis) || {};
    if (nsis.allowToChangeInstallationDirectory === true && nsis.oneClick !== false) {
        issues.push('nsis.allowToChangeInstallationDirectory için oneClick=false zorunlu.');
    }
    // WP-15.T1: Electron fuses sertleştirmesi zorunlu.
    const expectedFuses = {
        runAsNode: false,
        enableCookieEncryption: true,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        enableEmbeddedAsarIntegrityValidation: true,
        onlyLoadAppFromAsar: true,
        grantFileProtocolExtraPrivileges: false
    };
    const fuses = (pkg.build && pkg.build.electronFuses) || {};
    for (const [key, value] of Object.entries(expectedFuses)) {
        if (fuses[key] !== value) issues.push(`electronFuses.${key} ${value} olmalı; mevcut: ${fuses[key]}`);
    }
    if (!pkg.build || pkg.build.afterPack !== 'scripts/after-pack.cjs') {
        issues.push('afterPack wasmTrapHandlers kancası eksik.');
    }
    if (!fs.existsSync(path.join(ROOT, 'electron-builder.config.cjs'))) {
        issues.push('electron-builder.config.cjs (ortamdan imza konusu) eksik.');
    }
    for (const script of ['pack', 'dist:nsis']) {
        if (!String((pkg.scripts && pkg.scripts[script]) || '').includes('--config electron-builder.config.cjs')) {
            issues.push(`scripts.${script} electron-builder.config.cjs yapılandırmasını kullanmalı.`);
        }
    }
    // WP-15.T2: PFX/CI secret kabul edilmez; HSM/TPM sertifika deposu + HTTPS timestamp.
    const signtool = (pkg.build && pkg.build.win && pkg.build.win.signtoolOptions) || {};
    if (signtool.rfc3161TimeStampServer !== 'https://timestamp.digicert.com') {
        issues.push('signtoolOptions.rfc3161TimeStampServer HTTPS DigiCert olmalı.');
    }
    if (signtool.certificateFile || signtool.certificatePassword) {
        issues.push('PFX/certificateFile CI secret olarak kullanılamaz (HSM/TPM sertifika deposu zorunlu).');
    }
    if (!String(signtool.certificateSubjectName || '').includes('WIN_CERT_SUBJECT')) {
        issues.push('signtoolOptions.certificateSubjectName WIN_CERT_SUBJECT ortam değişkenine bağlı olmalı.');
    }
    if (!pkg.scripts || pkg.scripts['locales:check'] !== 'node scripts/check-i18n.js') {
        issues.push('locales:check script eksik.');
    }
    if (!pkg.scripts || !pkg.scripts['release:check']) issues.push('release:check script eksik.');
    if (!pkg.scripts || pkg.scripts['dist:appx'] !== 'node scripts/build-appx.js') {
        issues.push('dist:appx APPX publisher/imza kapısından (scripts/build-appx.js) geçmiyor.');
    }
    if (!pkg.scripts || !pkg.scripts['verify:pack']) issues.push('verify:pack script eksik.');
    if (!pkg.scripts || !pkg.scripts['verify:signature']) issues.push('verify:signature script eksik.');
    if (!pkg.scripts || !pkg.scripts['sbom']) issues.push('sbom script eksik.');
    if (!pkg.scripts || !pkg.scripts['test:load']) issues.push('test:load script eksik.');
    if (!pkg.scripts || !pkg.scripts['spike:pslist']) issues.push('spike:pslist script eksik.');

    // WP-18: APPX publisher env'den gelmeli; gömülü publisher mağaza reddi üretir.
    const appx = pkg.build && pkg.build.appx;
    if (appx) {
        if (appx.publisher !== '${env.APPX_PUBLISHER}') {
            issues.push('build.appx.publisher ${env.APPX_PUBLISHER} olmalı.');
        }
        const appxLangs = Array.isArray(appx.languages) ? appx.languages.length : 0;
        if (appxLangs !== 17) issues.push(`build.appx.languages 17 olmalı; mevcut: ${appxLangs}`);
    }

    for (const rel of [
        'main.js',
        'preload.js',
        'src/main/services/TaskManager.js',
        'src/main/services/net/ipAcl.js',
        'src/main/services/processNames.js',
        'src/main/services/monitors/MetricCollector.js',
        'src/main/services/ModelManager.js',
        'src/main/services/ConsoleClient.js',
        'src/renderer/i18n.js',
        'src/renderer/locales/tr.json',
        'scripts/verify-signature.ps1',
        'scripts/sbom.mjs',
        'scripts/load-test.mjs',
        'tests/e2e/packaged.spec.js',
        'CHANGELOG.md',
        'docs/runbooks/tls-renewal.md',
        'docs/runbooks/db-restore.md',
        'docs/runbooks/key-rotation.md',
        'docs/runbooks/incident-response.md',
        'docs/runbooks/console-maintenance.md',
        'docs/reports/soak.md',
        'docs/reports/licenses.json',
        'docs/release/SBOM.md',
        'docs/release/RELEASE_SIGNING.md',
        'docs/architecture/SAFETY_POLICIES.md',
        'docs/architecture/AUTOMATION_ENGINE.md',
        'docs/README.md'
    ]) requireFile(rel);

    // WP-04/05: PowerShell idle probe ve tasklist spamı üretim kodunda yasak.
    scanSource('src/main/services/monitors/MetricCollector.js', [
        { re: /^(?!\s*\/\/).*GetLastInputInfo/m, label: 'PowerShell idle' },
        { re: /^(?!\s*\/\/).*tasklist/m, label: 'tasklist' }
    ]);
    scanSource('src/main/services/SafetyPolicyEngine.js', [
        { re: /^(?!\s*\/\/).*GetLastInputInfo/m, label: 'PowerShell idle' },
        { re: /^(?!\s*\/\/).*tasklist/m, label: 'tasklist' }
    ]);

    // WP-12: SingletonLock elle silinmemeli (ikinci örnek veriyi bozar).
    scanSource('main.js', [
        { re: /unlinkSync\(lockFile\)/, label: 'SingletonLock elle silme' }
    ]);
    // WP-13: RTL yönü uygulanmalı (ar, he, fa, ur).
    {
        const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
        if (!/lang === 'ar' \? 'rtl' : 'ltr'/.test(appJs) && !(/PPLocale\.isRtl/.test(appJs) && /isRtl \? 'rtl' : 'ltr'/.test(appJs))) {
            issues.push('src/renderer/app.js: Arapça RTL yön ataması eksik.');
        }
        if (!/getActiveState/.test(appJs)) {
            issues.push('src/renderer/app.js: aktif görev/uyarı geri yüklemesi eksik.');
        }
    }

    // Model pinleri (ağsız meta kontrolü).
    try {
        const { verifyMetadata } = require('./verify-models');
        for (const issue of verifyMetadata()) issues.push(issue);
    } catch (err) {
        issues.push(`verify-models çalıştırılamadı: ${err.message}`);
    }

    // i18n paritesi.
    try {
        const { checkLocales } = require('./check-i18n');
        const result = checkLocales();
        for (const issue of result.errors) issues.push(issue);
    } catch (err) {
        issues.push(`check-i18n çalıştırılamadı: ${err.message}`);
    }

    // Kalici uzun cizgi (en-dash, em-dash vb.) yasagi taramasi.
    {
        const skipDirs = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report', 'blob-report']);
        const textExts = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.nsh', '.ps1', '.md', '.yml', '.yaml', '.txt', '.svg']);
        const longDashRe = /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/;
        const emOffenders = [];
        const walkEm = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (skipDirs.has(entry.name)) continue;
                    walkEm(full);
                } else if (entry.isFile() && textExts.has(path.extname(entry.name).toLowerCase())) {
                    if (longDashRe.test(fs.readFileSync(full, 'utf8'))) {
                        emOffenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
                    }
                }
            }
        };
        walkEm(ROOT);
        if (emOffenders.length > 0) {
            issues.push(`Yasaklı uzun çizgi bulundu (${emOffenders.length} dosya): ${emOffenders.slice(0, 5).join(', ')}`);
        }
    }

    if (process.argv.includes('--strict-git')) {
        try {
            const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
            if (out.trim().length > 0) issues.push('Çalışma ağacı kirli (--strict-git).');
        } catch (err) {
            notes.push(`git durumu okunamadı: ${err.message}`);
        }
    }

    if (issues.length > 0) {
        console.error('[release-check] Kapı BAŞARISIZ:');
        for (const issue of issues) console.error(`  - ${issue}`);
        process.exit(1);
    }
    console.log('[release-check] OK - sürüm, hedefler, pinler, i18n ve kaynak hijyeni doğrulandı.');
    for (const note of notes) console.log(`[release-check] NOT: ${note}`);
}

if (require.main === module) main();

module.exports = { main };
