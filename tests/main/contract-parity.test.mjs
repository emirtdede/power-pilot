/**
 * contract-parity.test.mjs — P1-6 (üçüncü tur) sözleşme paritesi kapısı
 *
 * Denetim kusuru: `TaskManager` `task_cancel_too_late` webhook olayını
 * GERÇEKTEN üretiyordu (kullanıcı iptali OS komutu başladıktan sonra gelince),
 * ama olay `WEBHOOK_EVENTS` listesinde yoktu. `validateWebhooks` bilinmeyen
 * olayı reddettiği için hiçbir kullanıcı bu olaya abone olamıyordu: üretilen
 * ama dinlenemeyen bir olay. Sessiz no-op'un aynası.
 *
 * Bu kapı "üretilen küme ⊆ abone olunabilir küme" değişmezini kilitler.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function walk(dir, out = [], test = () => true) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return out;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist', 'release', 'out', 'coverage'].includes(e.name)) continue;
        const rel = path.join(dir, e.name).replace(/\\/g, '/');
        if (e.isDirectory()) walk(rel, out, test);
        else if (test(e.name)) out.push(rel);
    }
    return out;
}

const mainFiles = walk('src', [], (n) => /\.(js|mjs)$/.test(n)).filter((f) => !f.includes('/locales/'));
const html = read('src/index.html');

/** validate.js'teki WEBHOOK_EVENTS kümesi. */
function declaredWebhookEvents() {
    const m = read('src/main/ipc/validate.js').match(/WEBHOOK_EVENTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
}

/** Kodda gerçekten üretilen olaylar. */
function emittedWebhookEvents() {
    const out = new Set();
    for (const f of mainFiles) {
        for (const m of read(f).matchAll(/triggerEvent\(\s*'([a-z_]+)'/g)) out.add(m[1]);
    }
    return [...out];
}

/** Renderer'ın abone olunabilir olarak sunduğu liste. */
function rendererWebhookEvents() {
    const m = read('src/renderer/app.js').match(/const WEBHOOK_EVENTS\s*=\s*\[([\s\S]*?)\];/);
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : [];
}

describe('A. Webhook olay paritesi', () => {
    it('üretilen her olay abone olunabilir', () => {
        const declared = new Set(declaredWebhookEvents());
        const missing = emittedWebhookEvents().filter((e) => !declared.has(e));
        expect(missing, `üretiliyor ama abone olunamıyor: ${missing.join(', ')}`).toEqual([]);
    });

    it('abone olunabilir her olay gerçekten üretiliyor', () => {
        const emitted = new Set(emittedWebhookEvents());
        const dead = declaredWebhookEvents().filter((e) => !emitted.has(e));
        expect(dead, `abone olunabilir ama hiç üretilmiyor: ${dead.join(', ')}`).toEqual([]);
    });

    it('renderer listesi doğrulayıcı listesiyle birebir aynı', () => {
        expect(rendererWebhookEvents().sort()).toEqual(declaredWebhookEvents().sort());
    });

    it('her olayın 17 dilde etiketi var', () => {
        const langs = fs.readdirSync(path.join(root, 'src/renderer/locales'))
            .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
            .map((f) => ({ lang: f.replace('.json', ''), d: JSON.parse(read(`src/renderer/locales/${f}`)) }));

        const problems = [];
        for (const ev of declaredWebhookEvents()) {
            const key = `event_${ev}`;
            for (const { lang, d } of langs) {
                if (typeof d[key] !== 'string' || !d[key].trim()) problems.push(`${lang}:${key}`);
            }
        }
        expect(problems).toEqual([]);
    });
});

describe('B. Görev durumu paritesi', () => {
    const model = () => read('src/main/services/models/AutomationTask.js');
    const statuses = () => {
        const m = model().match(/TASK_STATUS\s*=\s*(?:Object\.freeze\(\s*)?\{([\s\S]*?)\}\s*\)?;/);
        return m ? [...m[1].matchAll(/[A-Z_]+\s*:\s*'([a-z_]+)'/g)].map((x) => x[1]) : [];
    };

    it('her durumun renderer etiketi var', () => {
        const app = read('src/renderer/app.js');
        const mapBlock = app.slice(app.indexOf('draft: '), app.indexOf('draft: ') + 1200);
        const missing = statuses().filter((s) => !new RegExp(`\\b${s}\\s*:`).test(mapBlock));
        expect(missing, `etiketsiz durum: ${missing.join(', ')}`).toEqual([]);
    });

    it('her durumun 17 dilde çevirisi var', () => {
        const app = read('src/renderer/app.js');
        const mapBlock = app.slice(app.indexOf('draft: '), app.indexOf('draft: ') + 1200);
        const keyOf = {};
        for (const m of mapBlock.matchAll(/\b([a-z_]+)\s*:\s*'([A-Za-z0-9_]+)'/g)) keyOf[m[1]] = m[2];

        const langs = fs.readdirSync(path.join(root, 'src/renderer/locales'))
            .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
            .map((f) => ({ lang: f.replace('.json', ''), d: JSON.parse(read(`src/renderer/locales/${f}`)) }));

        const problems = [];
        for (const s of statuses()) {
            const key = keyOf[s];
            if (!key) { problems.push(`(etiket anahtarı yok):${s}`); continue; }
            for (const { lang, d } of langs) {
                if (typeof d[key] !== 'string' || !d[key].trim()) problems.push(`${lang}:${key}`);
            }
        }
        expect(problems).toEqual([]);
    });

    /**
     * P1-6 (üçüncü tur): HAYALET DURUM KAPISI.
     *
     * Denetim kusuru: `waiting`, `snoozed` ve `disabled` TASK_STATUS içinde
     * ilan ediliyor, `docs/architecture/AUTOMATION_ENGINE.md` yaşam
     * döngüsünde belgeleniyor ve 17 dilde çevirileri vardı — ama HİÇBİR kod
     * yolu onları atamıyordu. Kullanıcı ertelediği görevi "Zamanlandı" olarak
     * görüyordu; görev duraklatmanın hiçbir yolu yoktu.
     *
     * Bu kapı, ilan edilen her durumun motorda GERÇEKTEN atandığını doğrular.
     */
    it('her ilan edilen durum motorda gerçekten atanır (hayalet durum yok)', () => {
        const manager = read('src/main/services/TaskManager.js')
            + read('src/main/services/models/AutomationTask.js');

        // Model varsayılanı + TaskManager atamaları.
        const missing = statuses().filter((s) => {
            const upper = s.toUpperCase();
            if (new RegExp(`TASK_STATUS\\.${upper}\\b`).test(manager)) return false;
            // Model varsayılanı: `data.status || TASK_STATUS.DRAFT`
            return !(s === 'draft');
        });
        expect(missing, `ilan edilmiş ama hiç atanmayan durum: ${missing.join(', ')}`).toEqual([]);
    });

    it('terminal olmayan durumlar sürdürülebilir/çalıştırılabilir kalır', () => {
        // `disabled` duraklatılmış görevdir; terminal sayılırsa "Bitenleri
        // temizle" onu sessizce siler.
        const manager = read('src/main/services/TaskManager.js');
        const block = manager.slice(manager.indexOf('static isTerminalStatus'));
        const body = block.slice(0, block.indexOf('}'));
        expect(body).not.toMatch(/TASK_STATUS\.DISABLED/);
        expect(body).not.toMatch(/TASK_STATUS\.SNOOZED/);
        expect(body).not.toMatch(/TASK_STATUS\.WAITING/);
    });
});

describe('C. Koşul tipi paritesi', () => {
    /**
     * P1-6 (üçüncü tur): `CONDITION_TYPE` içinde `file_exists`, `file_size` ve
     * `power_source` ilan ediliyordu; ama `SUPPORTED_CONDITION_TYPES`'ta
     * kayıtları, `SmartFinishEngine`'de okuyucuları, iki UI seçicisinde
     * seçenekleri ve dokümanda tanımları yoktu. Enum'da duran bu üç değer
     * "destekleniyor" izlenimi veriyordu.
     */
    const model = () => read('src/main/services/models/AutomationTask.js');

    const conditionEnum = () => {
        const m = model().match(/const CONDITION_TYPE\s*=\s*\{([\s\S]*?)\n\};/);
        return m ? [...m[1].matchAll(/([A-Z_]+)\s*:\s*'([a-z_]+)'/g)].map((x) => ({ key: x[1], val: x[2] })) : [];
    };

    /** key -> value (enum tanımından). */
    const conditionValueOf = (key) => {
        const hit = conditionEnum().find((c) => c.key === key);
        return hit ? hit.val : null;
    };

    const supportedConditions = () => {
        const m = model().match(/SUPPORTED_CONDITION_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
        return m ? [...m[1].matchAll(/CONDITION_TYPE\.([A-Z_]+)/g)].map((x) => x[1]) : [];
    };

    it('her ilan edilen koşul tipi desteklenen kümede yer alır', () => {
        const supported = new Set(supportedConditions());
        const missing = conditionEnum().filter((c) => !supported.has(c.key)).map((c) => c.val);
        expect(missing, `enum'da var ama desteklenmiyor: ${missing.join(', ')}`).toEqual([]);
    });

    it('desteklenen her koşul tipi UI seçicilerinde sunulur', () => {
        const html = read('src/index.html');
        const app = read('src/renderer/app.js');
        const missing = supportedConditions().filter((k) => {
            const v = conditionValueOf(k);
            if (!v) return true;
            // İki seçici: sf-condition-type ve tpl-edit-cond-type
            const inSelect = new RegExp(`<option[^>]*value="${v}"`).test(html);
            const inRenderer = app.includes(`'${v}'`);
            return !(inSelect && inRenderer);
        });
        expect(missing, `UI'da sunulmayan koşul tipi: ${missing.join(', ')}`).toEqual([]);
    });

    it('her desteklenen koşul tipinin SmartFinishEngine okuyucusu var', () => {
        const engine = read('src/main/services/SmartFinishEngine.js');
        const missing = supportedConditions().filter((k) => {
            const v = conditionValueOf(k);
            if (!v) return true;
            // case CONDITION_TYPE.X veya type === 'x'
            return !(new RegExp(`CONDITION_TYPE\\.${k}\\b`).test(engine) || engine.includes(`'${v}'`));
        });
        expect(missing, `okuyucusu olmayan koşul tipi: ${missing.join(', ')}`).toEqual([]);
    });
});

describe('D. Güç eylemi paritesi', () => {
    /**
     * P1-6 (üçüncü tur): `PowerService.POWER_ACTIONS` altı eylem tanımlar ve
     * hepsini uygular (`shutdown.exe /s|/r|/h|/l`, `LockWorkStation`,
     * `SetSuspendState`). `validate.js` altısını da kabul ediyor, 17 dilde
     * etiketleri var.
     *
     * Ama ana görev kurucusu (`#sf-action`) yalnızca dört seçenek sunuyordu:
     * `restart` ve `signout` ile görev oluşturmanın HİÇBİR yolu yoktu. Motor
     * destekliyor, doğrulayıcı kabul ediyor, çeviri hazır — kapı yok. Aynı
     * `directory_idle` sınıfı.
     */
    const powerActionValues = () => {
        const m = read('src/main/services/PowerService.js').match(/const POWER_ACTIONS\s*=\s*\{([\s\S]*?)\n\};/);
        return m ? [...m[1].matchAll(/([A-Z_]+)\s*:\s*'([a-z_]+)'/g)].map((x) => x[2]) : [];
    };

    /** Bir <select id="..."> içindeki <option value="..."> değerleri. */
    const optionValuesOf = (selectId) => {
        const idx = html.indexOf(`id="${selectId}"`);
        if (idx < 0) return [];
        const end = html.indexOf('</select>', idx);
        if (end < 0) return [];
        return [...html.slice(idx, end).matchAll(/<option[^>]*value="([a-z_]*)"/g)].map((x) => x[1]);
    };

    it('PowerService altı güç eylemi tanımlar (regresyon tabanı)', () => {
        expect(powerActionValues().sort()).toEqual(
            ['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout'].sort()
        );
    });

    it('ana görev kurucusu her güç eylemini sunar', () => {
        const offered = new Set(optionValuesOf('sf-action'));
        const missing = powerActionValues().filter((a) => !offered.has(a));
        expect(missing, `#sf-action sunmuyor: ${missing.join(', ')}`).toEqual([]);
    });

    it('zincir kurucusu her güç eylemini sunar', () => {
        const offered = new Set(optionValuesOf('sf-chain-action'));
        const missing = powerActionValues().filter((a) => !offered.has(a));
        expect(missing, `#sf-chain-action sunmuyor: ${missing.join(', ')}`).toEqual([]);
    });

    it('CLI komut oluşturucu her güç eylemini sunar', () => {
        const offered = new Set(optionValuesOf('cli-builder-action'));
        const missing = powerActionValues().filter((a) => !offered.has(a));
        expect(missing, `#cli-builder-action sunmuyor: ${missing.join(', ')}`).toEqual([]);
    });

    it('doğrulayıcı her güç eylemini kabul eder', () => {
        const validate = read('src/main/ipc/validate.js');
        // validate.js POWER_ACTIONS'ı doğrudan içe aktarıp Object.values ile
        // karşılaştırır; sabit listeyi elle yazmak bu pariteyi bozardı.
        expect(validate).toMatch(/POWER_ACTIONS/);
        expect(validate).toMatch(/Object\.values\(POWER_ACTIONS\)\.includes\(/);
    });

    it('her güç eyleminin renderer etiket anahtarı 17 dilde var', () => {
        const app = read('src/renderer/app.js');
        const block = app.slice(app.indexOf('function getActionString'), app.indexOf('function getActionString') + 700);
        const keyOf = {};
        for (const m of block.matchAll(/\b([a-z]+)\s*:\s*'([A-Za-z0-9_]+)'/g)) keyOf[m[1]] = m[2];

        const langs = fs.readdirSync(path.join(root, 'src/renderer/locales'))
            .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
            .map((f) => ({ lang: f.replace('.json', ''), d: JSON.parse(read(`src/renderer/locales/${f}`)) }));

        const problems = [];
        for (const action of powerActionValues()) {
            const key = keyOf[action];
            if (!key) { problems.push(`(etiket yok):${action}`); continue; }
            for (const { lang, d } of langs) {
                if (typeof d[key] !== 'string' || !d[key].trim()) problems.push(`${lang}:${key}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('seçicilerdeki her data-i18n anahtarı 17 dilde çözülür', () => {
        const langs = fs.readdirSync(path.join(root, 'src/renderer/locales'))
            .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
            .map((f) => ({ lang: f.replace('.json', ''), d: JSON.parse(read(`src/renderer/locales/${f}`)) }));

        const problems = [];
        for (const id of ['sf-action', 'sf-chain-action', 'cli-builder-action']) {
            const idx = html.indexOf(`id="${id}"`);
            if (idx < 0) continue;
            const body = html.slice(idx, html.indexOf('</select>', idx));
            for (const m of body.matchAll(/data-i18n="([A-Za-z0-9_]+)"/g)) {
                for (const { lang, d } of langs) {
                    if (typeof d[m[1]] !== 'string' || !d[m[1]].trim()) problems.push(`${id} ${lang}:${m[1]}`);
                }
            }
        }
        expect(problems).toEqual([]);
    });
});
