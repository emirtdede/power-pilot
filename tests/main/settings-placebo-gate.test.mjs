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
