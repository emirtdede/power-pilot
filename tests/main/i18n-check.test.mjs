/**
 * i18n-check.test.mjs - WP-14.T4
 * locales:check kalite kapısı: eksik anahtar exit 1, duplicate ve placeholder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkLocales, duplicateKeys } from '../../scripts/check-i18n.js';

const sourceDir = path.resolve(__dirname, '../../src/renderer/locales');
const dirs = [];

function copyLocales() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-locales-'));
    dirs.push(dir);
    for (const name of fs.readdirSync(sourceDir)) {
        if (name.endsWith('.json') && name !== 'manifest.json') {
            fs.copyFileSync(path.join(sourceDir, name), path.join(dir, name));
        }
    }
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('locales:check (T-I18N-04)', () => {
    it('mevcut sözlükler temiz', () => {
        const result = checkLocales({ dir: sourceDir, serverDir: null });
        expect(result.errors).toEqual([]);
        expect(result.languages).toBe(17);
        expect(result.keys).toBeGreaterThan(500);
    });

    it('eksik anahtar hata üretir', () => {
        const dir = copyLocales();
        const file = path.join(dir, 'de.json');
        const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete dict.trayShow;
        fs.writeFileSync(file, JSON.stringify(dict, null, 2));
        const result = checkLocales({ dir, serverDir: null });
        expect(result.errors.some((e) => e.includes('de: eksik'))).toBe(true);
    });

    it('placeholder farkı hata üretir', () => {
        const dir = copyLocales();
        const file = path.join(dir, 'fr.json');
        const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
        dict.balloonMeasured = 'Mesure {watt}W {extra}';
        fs.writeFileSync(file, JSON.stringify(dict, null, 2));
        const result = checkLocales({ dir, serverDir: null });
        expect(result.errors.some((e) => e.includes('fr.balloonMeasured'))).toBe(true);
    });

    it('duplicate JSON anahtarını yakalar', () => {
        expect(duplicateKeys('{\n  "a": "1",\n  "a": "2"\n}')).toEqual(['a']);
    });
});

/**
 * Regresyon: dedektör 86 anahtarı yanlışlıkla "kullanılmayan" bildiriyordu
 * (gerçek ölü sayısı 0). Naif düzeltme tehlikelidir: her şeyi "kullanılıyor"
 * sayan bir dedektör sessizce hiçbir şey yakalamaz. Bu testler iki yönü de
 * kilitler - yanlış pozitif yok VE yanlış negatif yok.
 */
describe('locales:check - kullanılmayan anahtar dedektörü', () => {
    it('gerçekten ölü anahtarı hâlâ yakalar (yanlış negatif yok)', () => {
        const dir = copyLocales();
        for (const name of fs.readdirSync(dir)) {
            if (!name.endsWith('.json')) continue;
            const file = path.join(dir, name);
            const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
            dict.__qaTotallyUnusedKey__ = 'x';
            fs.writeFileSync(file, JSON.stringify(dict, null, 2));
        }
        const result = checkLocales({ dir, serverDir: null });
        expect(result.errors).toEqual([]);
        expect(result.unused).toContain('__qaTotallyUnusedKey__');
        expect(result.unused.length).toBe(1);
    });

    it('harita değeri / nesne özelliği / translate() kullanımları tanınır', () => {
        const result = checkLocales({ dir: sourceDir, serverDir: null });
        // Her biri farklı bir kullanım biçimini temsil eder:
        //  - aiBusy              → harita değeri      (main.js:106)
        //  - timeFormatDays      → nesne özelliği     (app.js:775)
        //  - aiNegatedIntent     → this.translate()   (AiService.js:227)
        //  - energySourceDefault → harita değeri      (app.js:3493)
        //  - event_task_created  → dinamik önek       (app.js:2386)
        for (const key of ['aiBusy', 'timeFormatDays', 'aiNegatedIntent', 'energySourceDefault', 'event_task_created']) {
            expect(result.unused, `${key} kullanılıyor olarak tanınmalı`).not.toContain(key);
        }
    });

    it('dinamik önek genişletmesi tüm event_* anahtarlarını kapsar', () => {
        const result = checkLocales({ dir: sourceDir, serverDir: null });
        const events = result.unused.filter((k) => k.startsWith('event_'));
        expect(events).toEqual([]);
    });

    it('test dosyalarındaki anmalar "kullanım" sayılmaz', () => {
        // i18n-coverage.test.mjs bu anahtarları açıkça listeler; buna rağmen
        // üretim kodunda geçmiyorlarsa ölü sayılmalıdırlar.
        const result = checkLocales({ dir: sourceDir, serverDir: null });
        expect(result.unused).not.toContain('statusDraft'); // app.js'te gerçekten var
    });
});

/**
 * `t()` çağrısı ile dize şablonunun parametre sözleşmesi.
 *
 * GERÇEK BOŞLUK (denetimde ölçüldü): `checkLocales` yalnızca DİLLER ARASI
 * `{placeholder}` eşitliğini doğrular. Hiçbir kapı, çağrının dizeye
 * sağladığı parametrelerin gerçekten o yer tutucularla eşleştiğini
 * denetlemiyordu. Bu yüzden:
 *
 *   - dize yeni bir `{count}` yer tutucusu kazanır ama çağrı onu geçmezse
 *     kullanıcı arayüzde ham `{count}` görür;
 *   - çağrı bir parametre geçer ama dizede o yer tutucu yoksa değer sessizce
 *     düşer (plasebo: veri var, görünmüyor).
 *
 * İkisi de "sessiz no-op" sınıfıdır. Bu test iki yönü de kilitler.
 *
 * NOT: Kısa yol nesne değişmezleri (`{ count }`) `key:` biçiminde değildir;
 * ilk taramada bunlar yanlış pozitif üretti, bu yüzden hem `key: değer` hem
 * de kısa yol biçimi ayrı ayrı toplanır.
 */
describe('t() parametre sözleşmesi', () => {
    const dict = JSON.parse(fs.readFileSync(path.join(sourceDir, 'tr.json'), 'utf8'));
    const jsFiles = ['src/renderer/app.js', 'src/renderer/mini.js', 'main.js'];
    const root = path.resolve(sourceDir, '../../..');

    const placeholdersOf = (value) => [...String(value ?? '').matchAll(/\{([A-Za-z0-9_]+)\}/g)]
        .map((m) => m[1]).sort();

    function scanCalls() {
        const findings = [];
        for (const rel of jsFiles) {
            const file = path.join(root, rel);
            if (!fs.existsSync(file)) continue;
            const text = fs.readFileSync(file, 'utf8');
            // t('anahtar', { ... }) — süslü parantez gövdesi iç içe olmayacak kadar basit.
            for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*,\s*\{([^{}]*)\}\s*\)/g)) {
                const key = m[1];
                const body = m[2];
                const supplied = new Set();
                // `key: değer`
                for (const x of body.matchAll(/(?:^|,)\s*([A-Za-z0-9_]+)\s*:/g)) supplied.add(x[1]);
                // kısa yol `{ count }` / `{ count, time }`
                for (const x of body.matchAll(/(?:^|,)\s*([A-Za-z0-9_]+)\s*(?=,|$)/g)) supplied.add(x[1]);
                const need = placeholdersOf(dict[key]);
                if (need.length === 0 && supplied.size === 0) continue;
                const missing = need.filter((n) => !supplied.has(n));
                const extra = [...supplied].filter((s) => !need.includes(s));
                if (missing.length || extra.length) {
                    findings.push({ rel, key, need, supplied: [...supplied], missing, extra });
                }
            }
        }
        return findings;
    }

    it('her t() çağrısı, dizesinin istediği yer tutucuları sağlar', () => {
        const findings = scanCalls();
        const message = findings
            .map((f) => `${f.rel} ${f.key}: eksik{${f.missing}} fazla{${f.extra}}`)
            .join('\n');
        expect(findings, message).toEqual([]);
    });

    it('tarama gerçekten çağrı buluyor (boş küme üzerinde geçmiyor)', () => {
        // Bir tarama hiç eşleşme bulamazsa "sorun yok" sonucu yanıltıcıdır.
        const root2 = path.resolve(sourceDir, '../../..');
        const app = fs.readFileSync(path.join(root2, 'src/renderer/app.js'), 'utf8');
        const calls = [...app.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*,\s*\{/g)];
        expect(calls.length).toBeGreaterThan(5);
    });

    it('yer tutucusu olan bir dizeye parametresiz çağrı yapılmaz', () => {
        // t('key') biçimi (nesne geçmeyen çağrı) yer tutucu bekleyen bir
        // dizeye giderse ham `{placeholder}` görünür.
        const root2 = path.resolve(sourceDir, '../../..');
        const bad = [];
        for (const rel of jsFiles) {
            const file = path.join(root2, rel);
            if (!fs.existsSync(file)) continue;
            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) {
                const key = m[1];
                if (placeholdersOf(dict[key]).length > 0) bad.push(`${rel} ${key}`);
            }
        }
        expect(bad, `parametresiz çağrı: ${bad.join(', ')}`).toEqual([]);
    });
});
