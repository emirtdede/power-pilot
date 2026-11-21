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
