/**
 * dom-integrity.test.mjs - P0-1 regresyon kapısı
 *
 * NEDEN: `src/index.html` bir düzenleme kazası sonucu `#view-assistant`
 * bloğunu ve `#view-stats` içine gömülü `#templates-grid` / `#view-history`
 * kopyalarını İKİ KEZ içeriyordu (35 çift DOM ID). Aynı kazada İstatistik
 * sayfasının 4 KPI kartı ve CSV/JSON dışa aktarma düğmeleri HTML'den
 * silinmişti; `app.js` hâlâ onları arıyordu.
 *
 * 150 birim + 26 E2E testi bunu yakalayamadı. Bu test iki şeyi kilitler:
 *   1) Bir HTML belgesinde hiçbir `id` iki kez geçemez (tarayıcı ilkini
 *      kullanır; ikinci blok ölü kalır → görünmez/bozuk UI).
 *   2) `app.js`'in `getElementById('x')` ile aradığı her ID HTML'de
 *      GERÇEKTEN bulunmalıdır (yoksa sessizce null → ölü buton).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INDEX = path.join(root, 'src/index.html');
const MINI = path.join(root, 'src/mini.html');
const APP = path.join(root, 'src/renderer/app.js');

function htmlFiles() {
    return [INDEX, MINI].filter((p) => fs.existsSync(p));
}

function idCounts(html) {
    const counts = new Map();
    for (const m of html.matchAll(/\sid\s*=\s*"([^"]+)"/g)) {
        const id = m[1];
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
}

describe('DOM bütünlüğü (P0-1)', () => {
    it('hiçbir HTML belgesinde yinelenen id yok', () => {
        const offenders = [];
        for (const file of htmlFiles()) {
            const counts = idCounts(fs.readFileSync(file, 'utf8'));
            for (const [id, n] of counts) {
                if (n > 1) offenders.push(`${path.basename(file)} → #${id} ×${n}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('birincil görünümler (view-*) tam olarak bir kez tanımlı', () => {
        const html = fs.readFileSync(INDEX, 'utf8');
        const views = [];
        for (const m of html.matchAll(/\sid\s*=\s*"(view-[a-z0-9-]+)"/g)) views.push(m[1]);
        const dupes = views.filter((v, i) => views.indexOf(v) !== i);
        expect(dupes).toEqual([]);
        expect(views.length).toBeGreaterThan(5);
    });

    it('app.js içindeki her getElementById ID\u2019si HTML\u2019de mevcut', () => {
        const html = fs.readFileSync(INDEX, 'utf8');
        const present = idCounts(html);
        const source = fs.readFileSync(APP, 'utf8');

        const wanted = new Set();
        for (const m of source.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) {
            wanted.add(m[1]);
        }
        // Dinamik olarak üretilen ID'ler (şablon değişkenleri) bu kapıya girmez.
        const missing = [...wanted].filter((id) => !present.has(id)).sort();
        expect(missing).toEqual([]);
    });

    it('istatistik KPI ve dışa aktarma kontrolleri HTML\u2019de var', () => {
        const html = fs.readFileSync(INDEX, 'utf8');
        const required = [
            'stat-hours', 'stat-kwh', 'stat-cost', 'stat-co2', 'stat-success-rate',
            'btn-stats-export-csv', 'btn-stats-export-json'
        ];
        const missing = required.filter((id) => !new RegExp(`\\sid\\s*=\\s*"${id}"`).test(html));
        expect(missing).toEqual([]);
    });
});

/**
 * Ölü işaretleme (dead markup) kapısı.
 *
 * GERÇEK KUSUR (denetimde bulundu): üç `pp-split-layout` kapsayıcısı
 * `data-scroll-container="overflow-y-auto"` niteliği taşıyordu. Hiçbir JS ve
 * hiçbir CSS bu niteliği okumuyordu; `git log -S` ile doğrulandı, v1.0.0'dan
 * beri ölü. Gerçek kaydırma davranışını `.pp-split-content-pane` ve
 * `.pp-split-sidebar` sınıfları sağlıyor.
 *
 * Bu, yasaklanan kusur sınıfının işaretleme biçimidir: yüzeyde "kaydırma
 * davranışı burada tanımlı" diyen bir açıklama var, arkasında davranış yok.
 * Bir geliştirici niteliğe güvenip CSS'i değiştirse hiçbir şey olmaz ve
 * nedeni görünmez olur.
 *
 * Kapı, HTML'deki her `data-*` kancasının JS, CSS veya testlerden en az
 * birinde geçmesini ister. Sınıf adları (`pp-data-col`) ve CSS'e özgü
 * kancalar bu aramada kendiliğinden eşleşir; hiçbir yerde geçmeyen nitelik
 * kalmaz.
 */
describe('ölü işaretleme yok', () => {
    function collectSources(dir, out = []) {
        if (!fs.existsSync(dir)) return out;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'release', 'out', 'coverage'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) collectSources(p, out);
            else if (/\.(js|mjs|cjs|css)$/.test(e.name)) out.push(p);
        }
        return out;
    }

    it('her data-* kancası en az bir kaynakta okunuyor', () => {
        const html = fs.readFileSync(INDEX, 'utf8');
        const sources = [
            ...collectSources(path.join(root, 'src')),
            ...collectSources(path.join(root, 'tests')),
            path.join(root, 'main.js'),
            path.join(root, 'preload.js')
        ]
            .filter((f) => fs.existsSync(f))
            .map((f) => fs.readFileSync(f, 'utf8'))
            .join('\n');

        const hooks = new Set();
        // DİKKAT: `\b` burada yetmez. `pp-data-col` gibi bir SINIF adının
        // içindeki `data-col` da sözcük sınırına uyar ve sahte kanca üretir.
        // Bu yüzden niteliğin gerçekten nitelik konumunda olması istenir:
        // önünde boşluk, tırnak veya etiket kapanışı.
        for (const m of html.matchAll(/(?:^|[\s"'])data-[a-z0-9-]+(?==|\s|>)/gm)) {
            hooks.add(m[0].trim().replace(/^["']/, ''));
        }

        // Tarama gerçekten kanca buluyor mu (boş küme üzerinde geçmesin).
        expect(hooks.size).toBeGreaterThan(10);

        const camel = (h) => h.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const dead = [...hooks].filter((h) => {
            const c = camel(h);
            return !(
                sources.includes(`[${h}`) ||
                sources.includes(`'${h}'`) ||
                sources.includes(`"${h}"`) ||
                sources.includes(`\`${h}\``) ||
                new RegExp(`dataset\\.${c}\\b`).test(sources) ||
                new RegExp(`getAttribute\\(\\s*['"]${h}['"]`).test(sources)
            );
        });
        expect(dead, `hiçbir kaynakta okunmayan data-* kancası: ${dead.join(', ')}`).toEqual([]);
    });
});
