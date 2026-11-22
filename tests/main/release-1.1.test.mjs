/**
 * release-1.1.test.mjs - WP-15 (T1/T2/T4/T7/T8) statik yayın kapısı.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isAllowedExternalUrl } from '../../src/main/config/externalLinks.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require('../../package.json');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

describe('WP-15.T1 - Electron fuses', () => {
    it('tüm zorunlu fuses sertleştirilmiş değerde', () => {
        expect(pkg.build.electronFuses).toMatchObject({
            runAsNode: false,
            enableCookieEncryption: true,
            enableNodeOptionsEnvironmentVariable: false,
            enableNodeCliInspectArguments: false,
            enableEmbeddedAsarIntegrityValidation: true,
            onlyLoadAppFromAsar: true,
            grantFileProtocolExtraPrivileges: false
        });
    });

    it('wasmTrapHandlers afterPack kancasında çevrilir', () => {
        expect(pkg.build.afterPack).toBe('scripts/after-pack.cjs');
        const hook = fs.readFileSync(path.join(ROOT, 'scripts/after-pack.cjs'), 'utf8');
        expect(hook).toMatch(/WasmTrapHandlers/);
        expect(hook).toMatch(/flipFuses/);
    });
});

describe('WP-15.T1b - paket hijyeni (ASAR integrity)', () => {
    it('build çıktıları ve test artefaktları app.asar dışında tutulur', () => {
        // Regresyon: derleme çıktıları paketlenirse asar her derlemede değişir ve
        // gömülü ASAR integrity özeti ile çakışıp uygulama açılışta çöker.
        const files = pkg.build.files || [];
        expect(files).toEqual(expect.arrayContaining([
            '!dist/**',
            '!dist-*/**',
            '!test-results/**',
            '!playwright-report/**',
            '!coverage/**',
            '!**/*.log'
        ]));
    });
});

describe('WP-15.T2 - kod imzası', () => {
    it('HSM/TPM sertifika deposu, SHA-256 ve HTTPS RFC 3161 kullanır', () => {
        const sign = pkg.build.win.signtoolOptions;
        expect(sign.signingHashAlgorithms).toEqual(['sha256']);
        expect(sign.rfc3161TimeStampServer).toBe('https://timestamp.digicert.com');
        expect(sign.certificateSubjectName).toContain('WIN_CERT_SUBJECT');
        expect(sign.certificateFile).toBeUndefined();
        expect(sign.certificatePassword).toBeUndefined();
    });

    it('verify-signature.ps1 signtool /pa /all ve timestamp doğrular', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/verify-signature.ps1'), 'utf8');
        expect(script).toMatch(/verify \/pa \/all/);
        expect(script).toMatch(/TimeStamperCertificate/);
        expect(script).toMatch(/Get-FileHash/);
    });

    it('CI/dağıtım dokümanı PFX secret kabul etmez', () => {
        const doc = fs.readFileSync(path.join(ROOT, 'docs/release/RELEASE_SIGNING.md'), 'utf8');
        expect(doc).toMatch(/PFX.*kabul edilmez/i);
        expect(doc).not.toMatch(/CSC_LINK.*zorunlu/i);
    });

    it('imza konu adı yalnızca ortamdan çözülür; yerelde imza atlanır', () => {
        // K-13: dosya adı electron-builder.js iken `npm run pack` CWD'deki bu
        // dosyayı .js uzantısıyla çalıştırıp hiç derleme yapmıyordu.
        const config = fs.readFileSync(path.join(ROOT, 'electron-builder.config.cjs'), 'utf8');
        expect(config).toMatch(/WIN_CERT_SUBJECT/);
        expect(config).toMatch(/certificateSubjectName/);
        expect(pkg.scripts.pack).toContain('--config electron-builder.config.cjs');
        expect(pkg.scripts['dist:nsis']).toContain('--config electron-builder.config.cjs');
    });

    it('yapılandırma dosyası CWD gölgelemesine yol açmaz (K-13)', () => {
        // Windows'ta cmd, PATH'ten önce CWD'deki `<ad>.js` dosyasını çalıştırır.
        // `electron-builder.js` varken `npm run pack` gerçek CLI yerine bu dosyayı
        // çalıştırıp 0 koduyla hiç derleme yapmıyordu.
        expect(fs.existsSync(path.join(ROOT, 'electron-builder.js'))).toBe(false);
        expect(fs.existsSync(path.join(ROOT, 'electron-builder.config.cjs'))).toBe(true);
    });
});

describe('WP-15.T4 - yük/soak testi', () => {
    it('100 ajan varsayılanı, kayıp/RSS kabul eşikleri ve soak raporu', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/load-test.mjs'), 'utf8');
        expect(script).toMatch(/arg\('agents', 100\)/);
        expect(script).toMatch(/ordersLost/);
        expect(script).toMatch(/rssGrowthPct/);
        expect(script).toMatch(/lost > 0 \|\| report\.p95Ms >= 150 \|\| growthPct >= 5/);
        expect(fs.existsSync(path.join(ROOT, 'docs/reports/soak.md'))).toBe(true);
        expect(fs.existsSync(path.join(ROOT, 'docs/reports/soak.json'))).toBe(true);
    });
});

describe('WP-15.T7/T8 - sürüm, SBOM, yayın manifesti', () => {
    it('sürüm 1.0.0 ve changelog güncel', () => {
        expect(pkg.version).toBe('1.0.0');
        const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
        expect(changelog).toContain('## [1.0.0]');
        expect(changelog).toContain('## [1.3.1]');
        expect(changelog).toContain('## [1.1.0]');
        expect(changelog).toMatch(/SBOM/);
    });

    it('SBOM imza anahtarı yoksa fail-closed seçeneği sunar', () => {
        const script = fs.readFileSync(path.join(ROOT, 'scripts/sbom.mjs'), 'utf8');
        expect(script).toMatch(/PP_SBOM_SIGNING_KEY/);
        expect(script).toMatch(/--require-signature/);
        expect(script).toMatch(/CycloneDX/);
        expect(script).toMatch(/sha256/);
    });
});

describe('WP-10.T2/T6/T8 - CSP ve dış bağlantı allowlist', () => {
    it('app:// yanıtlarına CSP ve güvenlik başlıkları eklenir', () => {
        expect(mainJs).toMatch(/onHeadersReceived/);
        expect(mainJs).toMatch(/Content-Security-Policy/);
        expect(mainJs).toMatch(/Cross-Origin-Opener-Policy/);
        expect(mainJs).toMatch(/X-Content-Type-Options/);
        expect(mainJs).toMatch(/csp-violation/);
    });

    it('yalnızca allowlist HTTPS host açılır', () => {
        expect(isAllowedExternalUrl('https://vellium.dev/rapor')).toBe(true);
        expect(isAllowedExternalUrl('https://github.com/org/repo')).toBe(true);
        expect(isAllowedExternalUrl('http://vellium.dev')).toBe(false);
        expect(isAllowedExternalUrl('https://evil.example/?vellium.dev')).toBe(false);
        expect(isAllowedExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false);
    });

    it('renderer yerel varlıkları app:// kökü (src) içinde kalır', () => {
        // Regresyon: renderer artık file:// değil app://powerpilot üzerinden
        // yüklenir ve protokol yalnızca `src` dizinini sunar. `src` dışına
        // (`../powerpilot_icon.png` gibi) işaret eden varlıklar 404 döner ve
        // arayüzde kırık görsel olarak görünür.
        const srcRoot = path.join(ROOT, 'src');
        const prefix = path.resolve(srcRoot) + path.sep;
        const htmlFiles = fs.readdirSync(srcRoot).filter((name) => name.endsWith('.html'));
        expect(htmlFiles.length).toBeGreaterThan(0);

        for (const file of htmlFiles) {
            const html = fs.readFileSync(path.join(srcRoot, file), 'utf8');
            const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
                .map((m) => m[1])
                .filter((url) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url));
            expect(refs.length, `${file}: yerel varlık referansı yok`).toBeGreaterThan(0);

            for (const ref of refs) {
                const target = path.resolve(srcRoot, ref);
                expect(target.startsWith(prefix), `${file}: ${ref} src dışına çıkıyor`).toBe(true);
                expect(fs.existsSync(target), `${file}: ${ref} bulunamadı`).toBe(true);
            }
        }
    });
});
