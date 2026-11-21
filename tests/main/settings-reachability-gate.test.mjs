/**
 * settings-reachability-gate.test.mjs — P1-6 sınıfı ikinci tur kapısı
 *
 * Denetimin çekirdek eleştirisi iki yönlüdür:
 *   1. "Arayüzde ayar var, davranışta yok"  → plasebo.
 *   2. "Davranış var, arayüzde ayar yok"    → ULAŞILAMAYAN ayar (o da plasebo).
 *
 * Bu ikinci turda bulunan gerçek kusurlar:
 *   A. `quietHoursEnabled` — arka uç sessiz saatleri YALNIZCA bu anahtar
 *      `true` iken uygular; hiçbir arayüz kontrolü bu anahtarı yazmıyordu.
 *      Sonuç: "Gece Sessiz Saat Aralığı" ayarı hiç çalışmadı.
 *   B. `protectedApps` / `forceCloseApps` / `remoteApprovalRequired` — arka uçta
 *      gerçekten uygulanıyordu ama arayüzde hiçbir kontrolü yoktu.
 *   C. `statsEnabled` / `assumedOffHours` / `bootGuardSeconds` — arka uçta
 *      okunuyordu, arayüzde kontrolü yoktu.
 *   D. `priceEffectiveFrom` — doğrulanıyor ve saklanıyordu, hiç okunmuyordu.
 *   E. mTLS'de `localApiCaFile` — istemci sertifikası doğrulaması için gerekli,
 *      arayüzden yazılamıyordu.
 *
 * Statik doğrulama: her ayarın hem bir kontrolü hem de gerçek bir okuyucusu
 * olduğunu kilitler; sessizce plaseboya dönmesini engeller.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/index.html');
const app = read('src/renderer/app.js');
const main = read('main.js');

/** HTML'de bir kontrolün var olduğunu doğrular. */
function hasControl(id, type) {
    if (type === 'checkbox') return new RegExp(`<input id="${id}"[^>]*type="checkbox"`).test(html);
    if (type === 'select') return new RegExp(`<select id="${id}"`).test(html);
    if (type === 'text') return new RegExp(`<input id="${id}"[^>]*type="text"`).test(html);
    if (type === 'number') return new RegExp(`<input id="${id}"[^>]*type="number"`).test(html);
    return html.includes(`id="${id}"`);
}

describe('A. Sessiz saatler gerçekten etkinleştirilebilir', () => {
    it('arayüzde sessiz saat anahtarı var', () => {
        expect(hasControl('setting-quiet-enabled', 'checkbox')).toBe(true);
    });

    it('arka uç yalnızca bu anahtar açıkken uygular', () => {
        expect(main).toMatch(/settings\.quietHoursEnabled\s*!==\s*true\)\s*return false/);
        expect(main).toMatch(/settings\.quietHoursEnabled === true && isQuietHoursNow\(settings\)/);
    });

    it('renderer anahtarı hem kaydeder hem sunucudan yükler', () => {
        expect(app).toContain("getElementById('setting-quiet-enabled')");
        expect(app).toMatch(/bindLocalPref\(elQuietEnabled, 'pp-quiet-enabled'/);
        expect(app).toContain("'quietHoursEnabled'");
        expect(app).toMatch(/elQuietEnabled\.checked = s\.quietHoursEnabled/);
    });
});

describe('B. Güvenlik politikası ayarları arayüzden erişilebilir', () => {
    it('üç kontrol de mevcut', () => {
        expect(hasControl('setting-force-close-apps', 'checkbox')).toBe(true);
        expect(hasControl('setting-remote-approval', 'checkbox')).toBe(true);
        expect(hasControl('setting-protected-apps', 'text')).toBe(true);
    });

    it('her biri sunucuya yazılır', () => {
        // Onay kutuları `bindLocalPref` üzerinden yazılır (serverKey = ayar adı,
        // içinde `persistSingleSetting` çağrılır).
        expect(app).toMatch(/bindLocalPref\(elForceCloseApps, 'pp-force-close-apps', null, 'forceCloseApps'\)/);
        expect(app).toMatch(/bindLocalPref\(elRemoteApproval, 'pp-remote-approval', null, 'remoteApprovalRequired'\)/);
        // Liste alanı doğrudan yazılır.
        expect(app).toMatch(/persistSingleSetting\('protectedApps'/);
    });

    it('her biri arka uçta gerçekten okunur', () => {
        const taskManager = read('src/main/services/TaskManager.js');
        const engine = read('src/main/services/SafetyPolicyEngine.js');
        expect(taskManager).toMatch(/settings\.forceCloseApps/);
        expect(taskManager).toMatch(/settings\.remoteApprovalRequired/);
        expect(engine).toMatch(/settings\.protectedApps/);
    });

    it('korunan uygulama listesi arka uçla aynı varsayılana sıfırlanabilir', () => {
        expect(app).toContain("getElementById('btn-protected-apps-reset')");
        expect(app).toContain('DEFAULT_PROTECTED_APPS');
        // Boş liste kazara silme sayılır → varsayılana döner (arka uçla aynı sözleşme).
        expect(app).toMatch(/list\.length > 0 \? list : DEFAULT_PROTECTED_APPS\.slice\(\)/);
    });
});

describe('C. Enerji/istatistik ayarları arayüzden erişilebilir', () => {
    it('üç kontrol de mevcut', () => {
        expect(hasControl('setting-stats-enabled', 'checkbox')).toBe(true);
        expect(hasControl('setting-assumed-off-hours', 'number')).toBe(true);
        expect(hasControl('setting-boot-guard-seconds', 'select')).toBe(true);
    });

    it('her biri arka uçta gerçekten okunur', () => {
        const energy = read('src/main/services/EnergyEstimateService.js');
        const safety = read('src/main/services/SafetyPolicyEngine.js');
        expect(energy).toMatch(/if \(!settings\.statsEnabled\)/);
        expect(energy).toMatch(/settings\.assumedOffHours/);
        expect(safety).toMatch(/s\.bootGuardSeconds/);
    });

    it('istatistikler kapalıyken görünüm eski sayıları göstermez', () => {
        // `stats.enabled === false` dalı tüm KPI alanlarını temizler.
        expect(app).toMatch(/statsDisabledNote/);
        expect(app).toMatch(/renderDailyStatsChart\(\[\]\)/);
    });
});

describe('D. `priceEffectiveFrom` ölü veri değil', () => {
    const energy = read('src/main/services/EnergyEstimateService.js');

    it('tarife yaşı hesaplanır ve eskime işaretlenir', () => {
        expect(energy).toMatch(/priceAgeMonths/);
        expect(energy).toMatch(/priceStale/);
        expect(energy).toMatch(/settings\.priceEffectiveFrom/);
    });

    it('fiyat kaydedilirken geçerlilik ayı yazılır', () => {
        const occurrences = (app.match(/patch\.priceEffectiveFrom = /g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(2); // enerji kartı + sihirbaz
        expect(app).toMatch(/priceEffectiveFrom = null/); // temizlemede sıfırlanır
    });

    it('eskimiş tarife arayüzde gösterilir', () => {
        expect(app).toContain("t('statPriceStale'");
        expect(app).toMatch(/stats\.profile\.priceStale === true/);
    });
});

describe('E. mTLS istemci doğrulaması tamamlanabilir', () => {
    it('CA dosyası alanı arayüzde var', () => {
        expect(hasControl('api-ca-file', 'text')).toBe(true);
    });

    it('kaydetme yüküne dahil edilir', () => {
        expect(app).toMatch(/localApiCaFile: caFile/);
    });

    it('arka uç CA yolunu TLS materyali olarak okur', () => {
        const tls = read('src/main/security/TlsConfig.js');
        expect(tls).toMatch(/ca: readMaterial\(settings\.localApiCaPem, settings\.localApiCaFile\)/);
    });
});

describe('G. Form alanları erişilebilir biçimde etiketlidir', () => {
    // Denetim ikinci turda 13 alanın ekran okuyucu adı olmadığını buldu:
    // kullanıcı yalnızca placeholder'a bakabiliyordu, bu da WCAG 3.3.2 ihlali.
    const inputs = [];
    const inputRe = /<input\b[^>]*>/g;
    let m;
    while ((m = inputRe.exec(html))) {
        const tag = m[0];
        const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
        if (!id) continue;
        const type = (tag.match(/\btype="([^"]+)"/) || [])[1] || 'text';
        if (!['text', 'number', 'time', 'password', 'search', 'email', 'url', 'tel'].includes(type)) continue;
        inputs.push({ id, type, index: m.index, tag });
    }

    /** İçinde bulunduğu `<label>...</label>` bloğunu arar (örtük etiketleme). */
    function insideLabel(idx) {
        let pos = idx;
        while (pos > 0) {
            const open = html.lastIndexOf('<label', pos);
            if (open === -1) return false;
            const openEnd = html.indexOf('>', open);
            const close = html.indexOf('</label>', openEnd);
            if (close === -1) return false;
            if (openEnd < idx && close > idx) return true;
            pos = open - 1;
        }
        return false;
    }

    it('her metin/sayı/parola alanının bir adı vardır', () => {
        const unlabelled = inputs.filter((i) => {
            const hasAria = /\baria-label(?:ledby)?=|\btitle=/.test(i.tag);
            const hasFor = new RegExp('<label[^>]*\\bfor="' + i.id + '"').test(html);
            return !hasAria && !hasFor && !insideLabel(i.index);
        }).map((i) => i.id);
        expect(unlabelled, `etiketlenmemiş alanlar: ${unlabelled.join(', ')}`).toEqual([]);
    });

    it('denetimde bulunan 13 alan hâlâ etiketlidir', () => {
        // Regresyon listesi: bu alanların etiketi sessizce kaldırılmamalı.
        const audited = [
            'pin-input', 'sf-extra', 'sf-template-name', 'wh-name', 'wh-url',
            'wh-secret', 'wh-user', 'wol-device-name', 'wol-mac', 'wol-ip',
            'wz-watt', 'wz-bill', 'pin-modal-input'
        ];
        for (const id of audited) {
            const hasAria = new RegExp(`id="${id}"[^>]*aria-label`).test(html);
            const hasFor = new RegExp(`<label[^>]*\\bfor="${id}"`).test(html);
            expect(hasAria || hasFor, `${id} etiketsiz`).toBe(true);
        }
    });

    it('yeni eklenen aria etiketleri çeviri kataloğunda karşılık bulur', () => {
        const keys = ['pinInputAriaLabel', 'sfTemplateNameAriaLabel', 'webhookNameAriaLabel',
            'webhookUrlAriaLabel', 'webhookAuthAriaLabel', 'webhookSecretAriaLabel',
            'webhookUserAriaLabel', 'wolNameAriaLabel', 'wolMacAriaLabel', 'wolBroadcastAriaLabel'];
        const tr = JSON.parse(read('src/renderer/locales/tr.json'));
        const en = JSON.parse(read('src/renderer/locales/en.json'));
        for (const key of keys) {
            expect(html, `${key} bağlantısı`).toContain(`data-i18n-aria-label="${key}"`);
            expect(typeof tr[key], `tr.${key}`).toBe('string');
            expect(typeof en[key], `en.${key}`).toBe('string');
        }
    });
});

describe('F. Genel ulaşılabilirlik sözleşmesi', () => {
    it('her yeni ayarın hem kontrolü hem kalıcı yazıcısı vardır', () => {
        const pairs = [
            ['setting-quiet-enabled', 'quietHoursEnabled'],
            ['setting-force-close-apps', 'forceCloseApps'],
            ['setting-remote-approval', 'remoteApprovalRequired'],
            ['setting-stats-enabled', 'statsEnabled'],
            ['setting-assumed-off-hours', 'assumedOffHours'],
            ['setting-boot-guard-seconds', 'bootGuardSeconds']
        ];
        for (const [controlId, serverKey] of pairs) {
            expect(html, `${controlId} kontrolü`).toContain(`id="${controlId}"`);
            expect(app, `${serverKey} yazıcısı`).toContain(`'${serverKey}'`);
        }
    });
});
