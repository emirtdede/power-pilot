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
        expect(app).toMatch(/serverSettings\.autostart === 'boolean'|typeof serverSettings\.autostart === 'boolean'/);
    });
});
