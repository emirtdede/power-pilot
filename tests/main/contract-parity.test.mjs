/**
 * contract-parity.test.mjs - P1-6 (üçüncü tur) sözleşme paritesi kapısı
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
     * döngüsünde belgeleniyor ve 17 dilde çevirileri vardı - ama HİÇBİR kod
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

    /**
     * P1-6 (dördüncü tur): MOTORUN OKUDUĞU HER ALAN KURUCUDAN YAZILABİLMELİ.
     *
     * `thresholdIops` motor tarafından okunuyor ve SMART_FINISH.md'de
     * belgeleniyordu, ama arayüz yalnızca `thresholdKbps` üretiyordu: motorun
     * IOPS yolu kullanıcı için ulaşılamazdı. Aynı sınıf kusur (motor var,
     * kapı yok). Bu kapı, motorun koşul nesnesinden okuduğu her alanın
     * renderer formunda karşılığı olduğunu doğrular.
     *
     * İstisna: `maxDepth`/`maxEntries` kullanıcı yeteneği değil, tarama
     * performans sınırlarıdır; motorda güvenli varsayılanları vardır ve
     * SMART_FINISH.md'de kullanıcıya sunulmazlar.
     */
    it('motorun okuduğu her koşul alanı formdan yazılabilir', () => {
        const engine = read('src/main/services/SmartFinishEngine.js');
        const app = read('src/renderer/app.js');

        const INTERNAL_DEFAULTS = new Set(['maxDepth', 'maxEntries', 'type']);
        const fields = new Set();
        for (const m of engine.matchAll(/\b(?:cond|condition|c)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) fields.add(m[1]);

        const missing = [...fields]
            .filter((f) => !INTERNAL_DEFAULTS.has(f))
            .filter((f) => !new RegExp(`\\b${f}\\b`).test(app));

        expect(missing, `formdan yazılamayan koşul alanı: ${missing.join(', ')}`).toEqual([]);
    });

    it('doğrulayıcı motorun okuduğu eşik alanlarını doğrular', () => {
        const validate = read('src/main/ipc/validate.js');
        // Doğrulanmayan bir alan sessizce "asla karşılanmaz"a dönüşebilir.
        for (const field of ['thresholdKbps', 'thresholdIops', 'maxDepth', 'maxEntries', 'idleSeconds', 'stableSeconds']) {
            expect(validate, `doğrulanmayan alan: ${field}`).toContain(field);
        }
    });

    it('disk birimi seçicisi bağlıdır (ölü kontrol değil)', () => {
        const app = read('src/renderer/app.js');
        expect(html, '#sf-disk-unit seçicisi yok').toContain('id="sf-disk-unit"');
        expect(html).toContain('id="sf-disk-unit-row"');
        // Görünürlük tür değişiminde ayarlanmalı.
        expect(app, 'görünürlük bağlanmamış').toMatch(/sf-disk-unit-row/);
        // Okuma yolu IOPS dalını üretmeli.
        expect(app).toMatch(/thresholdIops/);
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
     * destekliyor, doğrulayıcı kabul ediyor, çeviri hazır - kapı yok. Aynı
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

/**
 * E. IPC kanal paritesi.
 *
 * Ölçülen durum: main.js 86 `ipcHandle` + 9 `ipcOn` kaydeder, preload.js 86
 * `invoke` + 9 `send` yapar - birebir simetrik. Bu simetrinin KORUNMASI
 * gerekir: preload'da çağrılan ama karşılığı olmayan bir kanal, çağrı anında
 * sessizce reddedilen (veya hiç yanıt vermeyen) bir buton demektir; tersi ise
 * ulaşılamayan bir yetenektir.
 *
 * Simetri TEK BAŞINA yeterli değildir: `update-mini-timer` bir zamanlar iki
 * tarafta da tanımlıydı ama işleyicisi boş bir no-op'tu ve hiçbir çağıranı
 * yoktu. Bu yüzden no-op yüzeyi ayrıca yasaklanır (aşağıdaki son test).
 *
 * `window-minimize` gibi kanallar preload'da `ipcRenderer.send` ile gider;
 * bu yüzden invoke ve send birlikte değerlendirilir.
 */
describe('E. IPC kanal paritesi', () => {
    const grab = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

    const registeredChannels = () => new Set([
        ...grab(read('main.js'), /ipcHandle\(\s*'([^']+)'/g),
        ...grab(read('main.js'), /ipcOn\(\s*'([^']+)'/g)
    ]);

    const preloadChannels = () => new Set([
        ...grab(read('preload.js'), /ipcRenderer\.invoke\(\s*'([^']+)'/g),
        ...grab(read('preload.js'), /ipcRenderer\.send\(\s*'([^']+)'/g)
    ]);

    it('preload her çağrısı için kayıtlı bir handler bulur', () => {
        const registered = registeredChannels();
        const missing = [...preloadChannels()].filter((c) => !registered.has(c));
        expect(missing, `preload çağırıyor, handler yok: ${missing.join(', ')}`).toEqual([]);
    });

    it('her kayıtlı handler preload üzerinden erişilebilir (ulaşılamaz yetenek yok)', () => {
        const consumed = preloadChannels();
        const orphan = [...registeredChannels()].filter((c) => !consumed.has(c));
        expect(orphan, `handler var, preload sunmuyor: ${orphan.join(', ')}`).toEqual([]);
    });

    it('IPC kanal tabanı korunur (kazara silme yok)', () => {
        const count = registeredChannels().size;
        // Kanal sayısı düşerse bir yetenek kaldırılmış demektir. Taban,
        // kazara silmeyi yakalar; yeni yetenek eklemek serbesttir.
        // (Ölçülen: 95 - 86 handle + 9 on.)
        expect(count, 'IPC kanal sayısı beklenenden az').toBeGreaterThanOrEqual(95);
    });

    it('hiçbir IPC işleyicisi boş no-op değil (sessiz yüzey yok)', () => {
        // Denetim kusuru (altıncı tur): `ipcOn('update-mini-timer', () => {})`
        // işleyicisi hiçbir şey yapmıyordu ve çağıranı da yoktu. Simetri
        // kapısı bunu göremez çünkü kanal iki tarafta da tanımlıydı.
        const main = read('main.js');
        const bodies = [
            ...main.matchAll(/ipcOn\(\s*'([^']+)'\s*,\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*(\/\*[\s\S]*?\*\/)?\s*\}\s*\)/g)
        ].map((m) => m[1]);
        expect(bodies, `boş no-op işleyici: ${bodies.join(', ')}`).toEqual([]);
    });
});

/**
 * F. Olay paritesi (main → renderer).
 *
 * Ölçülen durum: main 8 kanal gönderir (`timer-tick`, `warning-*`,
 * `task-executed|failed`, ...), preload 12 kanal dinler. Fazlalık YOKTUR;
 * `task-executed|failed` bir ternary ile, `warning-*` ise `forwardWarning`
 * yardımcısıyla gönderilir. Bu kapı, dinlenen ama hiç gönderilmeyen bir kanalı
 * (sonsuza dek boş bekleyen dinleyici) yakalar.
 */
describe('F. Olay paritesi', () => {
    const grab = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

    /**
     * main.js'in gönderdiği kanallar.
     *
     * Satır bazlı çıkarım şart: `.send(` çağrısının ilk argümanı bir ternary
     * olabilir (`payload.success ? 'task-executed' : 'task-failed'`). Satır
     * sınırını aşan bir regex, başka bir `? ... : ...` ifadesine kayar ve
     * olmayan bir kanal uydurur - bu kapının ilk sürümü tam olarak bunu yaptı
     * (`wakeMode === 'skip' ? 'skip' : 'run'` satırını yakaladı).
     */
    const mainSentChannels = () => {
        const out = new Set();
        for (const line of read('main.js').split('\n')) {
            const idx = line.indexOf('.send(');
            if (idx < 0) continue;
            for (const m of line.slice(idx).matchAll(/'([a-z][a-z0-9-]+)'/g)) out.add(m[1]);
        }
        // `forwardWarning('x')` yardımcısı `channel` değişkeniyle gönderir;
        // gerçek kanal adları çağrı yerlerinde sabittir.
        for (const c of grab(read('main.js'), /forwardWarning\(\s*'([^']+)'\s*\)/g)) out.add(c);
        return out;
    };

    /**
     * preload'un dinlediği kanallar.
     *
     * Doğrudan `ipcRenderer.on('x')` çağrıları yetmez: `onWarningEnded`
     * üç kanalı bir dizi üzerinden abone eder
     * (`const channels = [...]; channels.forEach((c) => ipcRenderer.on(c, h))`).
     * Dizi tabanlı abonelikleri de sayarız; yoksa var olan bir kanal
     * "hiç gönderilmiyor" sanılır.
     */
    const preloadSubscriptions = () => {
        const preload = read('preload.js');
        const out = new Set(grab(preload, /ipcRenderer\.on\(\s*'([^']+)'/g));
        for (const m of preload.matchAll(/const\s+(\w+)\s*=\s*\[([^\]]*)\];/g)) {
            const [name, body] = [m[1], m[2]];
            // Dizi, ipcRenderer.on'a aktarılıyor mu?
            const piped = new RegExp(`\\b${name}\\b[^\\n]*ipcRenderer\\.on|ipcRenderer\\.on\\([^)]*\\b${name}\\b`).test(preload);
            if (!piped) continue;
            for (const c of body.matchAll(/'([a-z][a-z0-9-]+)'/g)) out.add(c[1]);
        }
        return out;
    };

    it('preload yalnızca gerçekten gönderilen kanalları dinler', () => {
        const sent = mainSentChannels();
        const orphan = [...preloadSubscriptions()].filter((c) => !sent.has(c));
        expect(orphan, `dinleniyor ama hiç gönderilmiyor: ${orphan.join(', ')}`).toEqual([]);
    });

    it('main hiçbir kanalı preload sunmadan göndermez', () => {
        const sent = mainSentChannels();
        const subs = preloadSubscriptions();
        const unhandled = [...sent].filter((c) => !subs.has(c));
        expect(unhandled, `gönderiliyor ama preload dinlemiyor: ${unhandled.join(', ')}`).toEqual([]);
    });

    it('dizi tabanlı abonelik gerçekten bağlı (regresyon)', () => {
        // Bu test kırılırsa `onWarningEnded` sessizce hiçbir kanal dinlemiyor
        // olabilir; yukarıdaki parite testleri bunu tek başına yakalayamaz.
        const preload = read('preload.js');
        for (const ch of ['warning-cancelled', 'warning-snoozed', 'warning-finished']) {
            expect(preload, `abone olunmayan kanal: ${ch}`).toContain(`'${ch}'`);
        }
        expect(preload).toMatch(/onWarningEnded/);
    });
});
