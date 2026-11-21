/**
 * settings-placibo-gate.test.mjs — P1-6 sınıfı regresyon kapısı
 *
 * Denetimin çekirdek eleştirisi: "arayüzde ayar var, davranışta yok" (plasebo).
 * Bu test, ikinci turda bulunan üç kusuru kalıcı olarak kilitler:
 *
 * 1. `clockFormat` — kaydediliyordu ama HİÇBİR saat render'ı okumuyordu.
 * 2. `lanModeWarning` — depolama katmanı üretiyordu ama arayüz göstermiyordu.
 * 3. `maintenanceWindowWarning` — aynı şekilde sessizce yutuluyordu.
 *
 * Statik doğrulama: bu davranışların bağlı kalması, ayarın sessizce tekrar
 * plaseboya dönmesini engeller.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('`clockFormat` gerçekten uygulanır', () => {
    const app = read('src/renderer/app.js');

    it('saat biçimi tercihi okunur ve biçimlendirici tanımlıdır', () => {
        expect(app).toContain('function getClockFormat()');
        expect(app).toContain('function formatClock(');
        expect(app).toMatch(/localStorage\.getItem\('pp-clock-format'\)/);
        expect(app).toMatch(/hour12:\s*getClockFormat\(\)\s*===\s*'12h'/);
    });

    it('duvar-saati gösterimleri ham toLocaleTimeString yerine formatClock kullanır', () => {
        // Eski plasebo yolu: doğrudan toLocaleTimeString(getCurrentLanguage()).
        expect(app).not.toMatch(/toLocaleTimeString\(getCurrentLanguage\(\)\)/);
        // Zaman damgaları tek yerde biçimlendirilir.
        expect(app).toMatch(/formatClock\(trig\.targetTime\)/);
        expect(app).toMatch(/formatClock\(h\.timestamp\)/);
        expect(app).toMatch(/formatClock\(new Date\(\)\)/);
    });

    it('ayar değişince görünür listeler yeniden çizilir', () => {
        expect(app).toMatch(/bindLocalPref\(elClockFormat, 'pp-clock-format', \(\) => \{/);
    });
});

describe('depolama uyarıları arayüzde gösterilir (sessiz yutma yok)', () => {
    const app = read('src/renderer/app.js');
    const html = read('src/index.html');

    it('LAN modu kapatma nedeni görünür bir kutuya bağlıdır', () => {
        expect(html).toMatch(/<div id="api-lan-warning"[^>]*hidden/);
        expect(html).toContain('id="api-lan-warning-text"');
        expect(app).toContain("getElementById('api-lan-warning')");
        expect(app).toContain('s.lanModeWarning');
        expect(app).toMatch(/lanWarnBox\.classList\.toggle\('hidden',\s*msg === ''\)/);
    });

    it('geçersiz bakım penceresi uyarısı görünür bir kutuya bağlıdır', () => {
        expect(html).toMatch(/<div id="mw-warning"[^>]*hidden/);
        expect(html).toContain('id="mw-warning-text"');
        expect(app).toContain("getElementById('mw-warning')");
        expect(app).toContain('s.maintenanceWindowWarning');
        expect(app).toMatch(/mwBox\.classList\.toggle\('hidden',\s*msg === ''\)/);
    });

    it('uyarı kutuları erişilebilir (aria-live + rol)', () => {
        expect(html).toMatch(/id="api-lan-warning"[^>]*role="status"[^>]*aria-live="polite"/);
        expect(html).toMatch(/id="mw-warning"[^>]*role="status"[^>]*aria-live="polite"/);
    });
});

/**
 * SINIF KAPISI — depolanan HER ayar en az bir mantık tarafından OKUNMALI.
 *
 * Denetim (beşinci tur) 92 varsayılan anahtarı tek tek taradı ve iki plasebo
 * buldu:
 *   - `notifications`: depoda ve şemada vardı, arayüzde anahtarı vardı, ama
 *     arka uçta HİÇBİR yol okumuyordu. Kullanıcı kapatsa da masaüstü balonu
 *     gelmeye devam ediyordu (yalnızca renderer toast'ı susuyordu).
 *   - `autostart`: aynı şekilde hiçbir mantık okumuyor/yazmıyordu; yalnızca
 *     localStorage bayrağı ve bir OS çağrısı vardı. Uygulama, Windows'taki
 *     gerçek durumu bilmiyor ve başlangıçta uzlaştıramıyordu.
 *
 * İki anahtarı tek tek yamalamak sınıfı çözmez. Bu kapı, varsayılan ayar
 * kümesini KAYNAKTAN okur ve her anahtarın en az bir mantık dosyasında
 * (depo/şema hariç) gerçekten okunduğunu doğrular. Yeni bir ayar eklenip
 * hiçbir yerde okunmazsa burada düşer.
 */
describe('her varsayılan ayar en az bir mantık tarafından okunur', () => {
    const ROLE_ALLOW = new Set([
        // Kimlik/şema/anahtar-yönetimi alanları: depo ve güvenlik katmanı
        // tarafından yönetilir, kullanıcı davranışı üretmez.
        'cancelPinHash', 'cancelPinSalt', 'localApiKeyHash', 'localApiKeyMasked',
        'localApiKeyCreatedAt', 'localApiKeyRole', 'localApiKeyFile', 'localApiKeyPem',
        'consoleAgentKey', 'consolePublicKeyPem', 'agentId', 'agentDisabled',
        'deviceRole', 'hiddenBuiltInTemplates', 'templateOverrides'
    ]);

    /** getDefaultData().settings bloğunun üst düzey anahtarları. */
    function defaultSettingKeys() {
        const storage = read('src/main/services/StorageService.js');
        const start = storage.indexOf('getDefaultData()');
        const settingsIdx = storage.indexOf('settings: {', start);
        if (settingsIdx < 0) return [];
        let depth = 0;
        let end = -1;
        for (let i = storage.indexOf('{', settingsIdx); i < storage.length; i++) {
            if (storage[i] === '{') depth += 1;
            else if (storage[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        const block = storage.slice(settingsIdx, end + 1);
        return [...block.matchAll(/^\s{16}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]);
    }

    /** Mantık dosyaları: şema (validate), depo (StorageService) ve çeviriler hariç. */
    function logicSources() {
        const files = ['main.js'];
        const walk = (dir) => {
            const abs = path.join(root, dir);
            for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
                if (['node_modules', '.git', 'dist', 'release', 'out', 'coverage'].includes(e.name)) continue;
                const rel = path.join(dir, e.name).replace(/\\/g, '/');
                if (e.isDirectory()) walk(rel);
                else if (/\.(js|mjs)$/.test(e.name)) files.push(rel);
            }
        };
        walk('src');
        return files
            .filter((f) => !f.endsWith('StorageService.js') && !f.endsWith('ipc/validate.js') && !f.includes('/locales/'))
            .map((f) => read(f));
    }

    it('varsayılan ayar kümesi okunur (taban: 90+)', () => {
        const keys = defaultSettingKeys();
        expect(keys.length, 'varsayılan ayar anahtarı bulunamadı').toBeGreaterThan(90);
    });

    it('hiçbir varsayılan ayar okunmadan (plasebo) kalmaz', () => {
        const keys = defaultSettingKeys();
        const sources = logicSources();
        const unread = [];
        for (const key of keys) {
            if (ROLE_ALLOW.has(key)) continue;
            const dot = new RegExp(`\\.${key}\\b`);
            const bracket = new RegExp(`\\[\\s*['"]${key}['"]\\s*\\]`);
            const quoted = new RegExp(`['"]${key}['"]`);
            const readSomewhere = sources.some((src) => dot.test(src) || bracket.test(src) || quoted.test(src));
            if (!readSomewhere) unread.push(key);
        }
        expect(unread, `hiçbir mantık okumuyor: ${unread.join(', ')}`).toEqual([]);
    });

    it('`notifications` ve `autostart` gerçekten davranışa bağlıdır (bulunan iki kusur)', () => {
        const main = read('main.js');
        const app = read('src/renderer/app.js');

        // notifications: masaüstü bildirim kapısı ayarı okumalı.
        expect(main).toMatch(/settings\.notifications === false/);
        // Ve renderer ayarı arka uca yazmalı (yalnızca localStorage yetmez).
        expect(app).toMatch(/settings: \{ notifications: enabled \}/);

        // autostart: OS durumu geri okunup ayara yazılmalı.
        expect(main).toMatch(/getLoginItemSettings\([^)]*\)\.openAtLogin/);
        expect(main).toMatch(/updateSettings\(\{ autostart: effective \}\)/);
        // Ve renderer sunucu değerini kaynak kabul etmeli.
        expect(app).toMatch(/typeof serverSettings\.autostart === 'boolean'/);
    });
});

/**
 * ŞEMA ↔ VARSAYILAN SÖZLEŞMESİ.
 *
 * Depoda bir varsayılan anahtar varsa, onu ya kullanıcı yazabilmeli (normal
 * veya PIN'li güvenlik şemasında) ya da sunucu kendisi üretmeli/tutmalı.
 * Bu sözleşmenin üçüncü hâli — ne yazılabilir ne sunucu-sahipli — sessiz bir
 * "depoda var, kimse dokunamaz" alanı demektir: kullanıcı arayüzde görür,
 * değiştirir, hiçbir şey olmaz.
 *
 * `SERVER_OWNED` listesi bilinçli bir envanterdir. Yeni bir sunucu-üretimli
 * alan eklenirse buraya da eklenmeli; aksi hâlde kapı düşer ve karar gözden
 * geçirilir.
 */
describe('varsayılan ayarlar şema veya sunucu sahipliğinde', () => {
    function blockAt(src, idx) {
        let depth = 0;
        let start = -1;
        let end = -1;
        for (let i = idx; i < src.length; i++) { if (src[i] === '{') { start = i; break; } }
        if (start < 0) return '';
        for (let i = start; i < src.length; i++) {
            if (src[i] === '{') depth += 1;
            else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
        }
        return src.slice(start, end + 1);
    }

    function topKeys(block, indent) {
        return new Set([...block.matchAll(new RegExp(`^\\s{${indent}}([A-Za-z][A-Za-z0-9_]*)\\s*:`, 'gm'))].map((m) => m[1]));
    }

    const storage = read('src/main/services/StorageService.js');
    const validate = read('src/main/ipc/validate.js');
    const defaults = topKeys(blockAt(storage, storage.indexOf('settings: {', storage.indexOf('getDefaultData()'))), 16);
    const regular = topKeys(blockAt(validate, validate.search(/SETTINGS_SCHEMA\s*=\s*\{/)), 4);
    const security = topKeys(blockAt(validate, validate.search(/SECURITY_SETTINGS_SCHEMA\s*=\s*\{/)), 4);

    const SERVER_OWNED = new Set([
        'cancelPinHash', 'cancelPinSalt', 'localApiKeyHash', 'localApiKeyMasked',
        'localApiKeyCreatedAt', 'localApiKeyRole', 'localApiKeyFile', 'localApiKeyPem',
        'localApiCertFile', 'localApiCertPem', 'localApiCaFile', 'localApiCaPem',
        'localApiPfxFile', 'localApiPfxPassphrase',
        'consoleAgentKey', 'consolePublicKeyPem',
        'consoleClientCertFile', 'consoleClientCertPem', 'consoleClientKeyFile',
        'consoleClientKeyPem', 'consoleClientPfxFile', 'consoleClientPfxPassphrase',
        'consoleClientCaFile', 'consoleClientCaPem',
        'hiddenBuiltInTemplates', 'templateOverrides',
        'lanModeWarning', 'maintenanceWindowWarning'
    ]);

    it('her varsayılan ya yazılabilir ya sunucu sahipliğinde', () => {
        const writable = new Set([...regular, ...security]);
        const orphan = [...defaults].filter((k) => !writable.has(k) && !SERVER_OWNED.has(k));
        expect(orphan, `ne yazılabilir ne sunucu-sahipli: ${orphan.join(', ')}`).toEqual([]);
    });

    it('sunucu-sahipli envanterde bayat kayıt yok (secrets hariç)', () => {
        // Sırlar SecretStore'da tutulur, depo varsayılanında bulunmaz — meşru.
        const SECRETS = new Set(['localApiPfxPassphrase', 'consoleClientPfxPassphrase', 'consoleAgentKey',
            'localApiKeyPem', 'consoleClientKeyPem', 'consolePublicKeyPem']);
        const stale = [...SERVER_OWNED].filter((k) => !defaults.has(k) && !SECRETS.has(k));
        expect(stale, `varsayılanda olmayan sunucu-sahipli kayıt: ${stale.join(', ')}`).toEqual([]);
    });

    it('şemadaki her anahtarın bir varsayılanı veya sır kaydı var', () => {
        // Şemada olup varsayılanda olmayan bir anahtar, kaydedilir ama ilk
        // açılışta `undefined` okunur. Sırlar ve türetilmiş alanlar hariç
        // hepsi varsayılanda bulunmalı.
        const EXEMPT = new Set(['aiSilencedUntil', 'localApiPfxPassphrase', 'consoleClientPfxPassphrase']);
        const missing = [...regular, ...security].filter((k) => !defaults.has(k) && !EXEMPT.has(k));
        expect(missing, `varsayılanı olmayan şema anahtarı: ${missing.join(', ')}`).toEqual([]);
    });
});

/**
 * SIFIRLAMA YOLU da gerçek olmalı.
 *
 * Denetim (beşinci tur): `notifications` ve `autostart` arka uçta gerçek
 * olduktan sonra "Ayarları Varsayılana Döndür" akışı yalnızca onay kutularını
 * ve localStorage'ı geri alıyordu. Arka uçtaki değer eski (kapalı) kalıyordu:
 * kullanıcı sıfırlama yapıp "Bildirimleri Göster" açık görse bile masaüstü
 * balonlarını almıyordu. Bu, düzeltmenin kendi ürettiği ters-plaseboydu.
 */
describe('varsayılana döndürme arka uç anahtarlarını da yazar', () => {
    it('reset patch\'i notifications anahtarını içerir', () => {
        const app = read('src/renderer/app.js');
        const start = app.indexOf('settingsResetConfirmMsg');
        expect(start, 'sıfırlama onay metni bulunamadı').toBeGreaterThan(-1);
        // Sıfırlama patch bloğunu onay işleyicisinden itibaren 2000 karakterde ara.
        const region = app.slice(start, start + 2000);
        const patchBlock = (region.match(/const patch = \{[\s\S]*?\};/) || [])[0] || '';
        expect(patchBlock, 'sıfırlama patch bloğu bulunamadı').not.toBe('');
        expect(patchBlock, 'notifications sıfırlama yamasında yok').toMatch(/notifications:\s*true/);
    });

    it('autostart sıfırlaması arka ucu da günceller', () => {
        const app = read('src/renderer/app.js');
        const start = app.indexOf('settingsResetConfirmMsg');
        // Onay işleyicisinin tamamı: patch bloğu + localStorage + OS çağrısı.
        // (Ölçülen uzaklık ~3.4k karakter; pencere onu kapsamalı.)
        const region = app.slice(start, start + 6000);
        // setAutostart → arka uçta OS durumunu okuyup `autostart` ayarına yazar.
        expect(region, 'sıfırlama setAutostart çağırmıyor').toMatch(/setAutostart\(false\)/);
    });
});
