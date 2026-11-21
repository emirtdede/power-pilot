/**
 * ui-reference-integrity.test.mjs — üçüncü tur yapısal kapı
 *
 * Denetimin bu turunda bulunan iki gerçek kusur sınıfı:
 *   1. VAR OLMAYAN EKRANLAR. Kullanıcıya gösterilen metinler olmayan
 *      ekranlara yönlendiriyordu: "Ayarlar → Güvenlik", "Ayarlar → Gizlilik",
 *      "Ayarlar → Konsol", "Ayarlar → AI Paketi", "Settings → Safety"...
 *      Gerçekte korunan uygulamalar ve tam ekran koruması Ayarlar →
 *      Otomasyon'da, AI Paketi kartı Ayarlar → Enerji ve Yapay Zeka içinde,
 *      veri silme Ayarlar → Sıfırlama ve Gizlilik altında.
 *   2. AYNI EKRANIN İKİ ADI. Kenar çubuğu settings-sec-security'yi
 *      "Sıfırlama ve Gizlilik" diye listelerken sayfa başlığı menü grubunun
 *      adını ("Güvenlik ve Veri") gösteriyordu.
 *
 * Bu kapı, gelecekte bir ekranın yeniden adlandırılması hâlinde dokümanların
 * ve kullanıcıya dönük metinlerin sessizce yanlış bilgi vermesini engeller.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('src/index.html');
const app = read('src/renderer/app.js');

/** index.html'deki gezinti bağlantılarının hedef → i18n anahtarı eşlemesi. */
function navLabelKeys() {
    const lines = html.split('\n');
    const map = new Map();
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].match(/data-scroll-target="([^"]+)"/);
        if (!t) continue;
        for (let j = i; j < Math.min(lines.length, i + 8); j++) {
            const m = lines[j].match(/data-i18n="([^"]+)"/);
            if (m) {
                if (!map.has(t[1])) map.set(t[1], m[1]);
                break;
            }
        }
    }
    return map;
}

/** Bir bölümün ilk başlık (pp-section-bar-title) anahtarı. */
function sectionTitleKeys() {
    const lines = html.split('\n');
    const map = new Map();
    let section = null;
    for (const line of lines) {
        const s = line.match(/<section[^>]*id="([^"]+)"/);
        if (s) section = s[1];
        if (section && /pp-section-bar-title/.test(line)) {
            const m = line.match(/data-i18n="([^"]+)"/);
            if (m && !map.has(section)) map.set(section, m[1]);
        }
    }
    return map;
}

const LOCALES = fs
    .readdirSync(path.join(root, 'src/renderer/locales'))
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => ({ lang: f.replace('.json', ''), dict: JSON.parse(read(`src/renderer/locales/${f}`)) }));

describe('A. Kenar çubuğu etiketi ile sayfa başlığı aynı ekranı aynı adla anar', () => {
    // Birden çok kart düzeyinde başlık taşıyan bölümlerde ilk bar kart başlığıdır
    // (ör. Genel → "Hazır Kullanım Profilleri"), bu yüzden yalnızca tek barlı
    // bölümler karşılaştırılır: orada ilk başlık ekranın kendi adıdır.
    const nav = navLabelKeys();
    const title = sectionTitleKeys();

    it('settings-sec-security başlığı gezinti etiketiyle aynı anahtarı kullanır', () => {
        // Denetim kusuru: gezinti `settingsSecDanger`, başlık `settingsNavSecurity`.
        expect(nav.get('settings-sec-security')).toBe('settingsSecDanger');
        expect(title.get('settings-sec-security')).toBe('settingsSecDanger');
    });

    it('tek barlı bölümlerde başlık anahtarı gezinti anahtarıyla eşleşir', () => {
        const multiBar = new Set(['settings-sec-general', 'settings-sec-notifications']);
        const mismatches = [];
        for (const [target, navKey] of nav) {
            if (multiBar.has(target)) continue;
            const titleKey = title.get(target);
            if (!titleKey) continue; // entegrasyon alt sayfaları bar taşımaz
            if (titleKey !== navKey) mismatches.push(`${target}: ${navKey} != ${titleKey}`);
        }
        expect(mismatches).toEqual([]);
    });
});

describe('B. Kullanıcıya dönük ekran referansları gerçek etiketlere işaret eder', () => {
    // Gerçek gezinti/başlık etiketleri (tr + en) — referansın hedefi bunlardan biri olmalı.
    const labelKeys = new Set();
    for (const d of LOCALES) {
        // tüm dillerde ortak anahtar kümesi tr/en ile aynı olduğundan yalnızca
        // değer karşılaştırması için tr/en yeterli; ama tümünü toplamak zararsız.
        for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) {
            const v = d.dict[m[1]];
            if (typeof v === 'string') labelKeys.add(v.trim());
        }
    }
    // Ürünün kök ekran adları.
    for (const v of ['Ayarlar', 'Settings', 'Entegrasyonlar', 'Integrations']) labelKeys.add(v);

    /** Bir referans zincirindeki segmentler gerçek etiket mi? */
    function segmentKnown(seg) {
        const core = seg
            .replace(/^[“"'«]+|[”"'»]+$/g, '')
            .split(/\s+(?:bölüm|section|ekran|screen|kart|card|sekme|tab)\b/i)[0]
            .trim();
        if (!core) return true;
        for (const label of labelKeys) {
            if (label === core || label.startsWith(core) || core.startsWith(label)) return true;
        }
        return false;
    }

    // Kullanıcıya gösterilen metin kaynakları (dokümanlar hariç: onlar ayrıca taranır).
    const TEXT_SOURCES = [
        'src/main/services/agents/diagnoseAgent.js',
        'src/main/services/DocsKnowledgeBase.js',
        'src/renderer/locales/tr.json',
        'src/renderer/locales/en.json'
    ];

    // İşletim sistemi diyalogları ürünün ekranı değildir.
    const OS_ALLOW = /^(Apps|Uygulamalar|Uninstall|Kaldır|Startup|Başlangıç)$/;

    it('kodda ve yerelleştirmede var olmayan ekran adı kalmaz', () => {
        const problems = [];
        for (const file of TEXT_SOURCES) {
            const text = read(file);
            text.split('\n').forEach((line, i) => {
                for (const m of line.matchAll(/(Ayarlar|Settings)\s*(?:→|←|->|>)\s*([^\n'"`.;,)]{2,60})/g)) {
                    const segs = m[2]
                        .split(/\s*(?:→|←|->|>)\s*/)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    for (const seg of segs) {
                        const core = seg.replace(/^[“"'«]+|[”"'»]+$/g, '').split(/\s+(?:bölüm|section|ekran|screen|kart|card|sekme|tab)\b/i)[0].trim();
                        if (!core) continue;
                        if (OS_ALLOW.test(core)) continue;
                        if (!segmentKnown(seg)) problems.push(`${file}:${i + 1}: "${seg}"`);
                    }
                }
            });
        }
        expect(problems).toEqual([]);
    });

    it('AI Paketi bir üst ekran değil, Enerji ve Yapay Zeka içindeki karttır', () => {
        // Denetim kusuru: 17 dilde "Ayarlar → AI Paketi" yazıyordu; öyle bir ekran yok.
        for (const { lang, dict } of LOCALES) {
            const parent = dict.settingsSecEnergyAi;
            if (typeof parent !== 'string' || typeof dict.aiModelNotDownloaded !== 'string') continue;
            if (!dict.aiModelNotDownloaded.includes('AI')) continue;
            expect(dict.aiModelNotDownloaded, `${lang}: üst bölüm eksik`).toContain(parent);
        }
    });
});

describe('C. Her gerçek kontrol bağlıdır (ölü kontrol yok)', () => {
    /**
     * Bir kontrol "bağlı" sayılır eğer:
     *   1) id'si app.js'te birebir geçiyorsa,
     *   2) id'si bir şablon değişkeniyle üretiliyorsa (ör. `shortcut-${k}`),
     *   3) bir data-* seçicisi app.js'te varsa.
     * Etiket/başlık <p> elemanları kontrol değildir; aria-labelledby ile bağlanır.
     */
    function isBound(id, tag) {
        if (app.includes(id)) return true;
        const parts = id.split('-');
        for (let i = parts.length - 1; i >= 1; i--) {
            const prefix = parts.slice(0, i).join('-');
            if (app.includes(`${prefix}-\${`)) return true;
        }
        for (const a of tag.matchAll(/\b(data-[a-z0-9-]+)(?:="[^"]*")?/g)) {
            if (app.includes(`[${a[1]}`)) return true;
        }
        return false;
    }

    it('hiçbir input/select/textarea/button kablosuz kalmaz', () => {
        const unbound = [];
        for (const m of html.matchAll(/<(input|select|textarea|button)\b[^>]*>/g)) {
            const tag = m[0];
            const idm = tag.match(/\bid="([^"]+)"/);
            if (!idm) continue;
            if (!isBound(idm[1], tag)) unbound.push(idm[1]);
        }
        expect(unbound).toEqual([]);
    });
});

describe('D. Doküman bağlantıları çözümlenir (kırık bağlantı yok)', () => {
    // Denetim kusuru: `.github/CONTRIBUTING.md` indeksi `docs/README.md` diye
    // bağlıyordu; bu yol `.github/docs/README.md` olarak çözümlenip kırıktı.
    function walk(dir, out = []) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'release', 'out', 'coverage'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, out);
            else if (e.name.endsWith('.md')) out.push(p);
        }
        return out;
    }

    it('her göreli markdown bağlantısı var olan bir dosyaya işaret eder', () => {
        const files = [
            ...walk(path.join(root, 'docs')),
            ...walk(path.join(root, '.github')),
            path.join(root, 'README.md'),
            path.join(root, 'CHANGELOG.md'),
            path.join(root, 'CONTRIBUTING.md')
        ].filter((f) => fs.existsSync(f));

        const broken = [];
        for (const file of files) {
            const rel = file.replace(root, '').replace(/\\/g, '/').replace(/^\//, '');
            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
                const target = m[1];
                if (/^(https?:|mailto:|#)/.test(target)) continue;
                const clean = target.split('#')[0];
                if (!clean) continue;
                const resolved = clean.startsWith('/')
                    ? path.join(root, clean)
                    : path.resolve(path.dirname(file), clean);
                if (!fs.existsSync(resolved)) broken.push(`${rel} -> ${target}`);
            }
        }
        expect(broken).toEqual([]);
    });
});

describe('E. Dokümanlardaki sayısal iddialar koddan türetilir', () => {
    // Denetim kusuru: README "150 suite / 1.724 test / 18 E2E spec" ve mağaza
    // kontrol listesi "Sürüm 1.1.0" diyordu; gerçek değerler 158 / 1.812 / 26
    // ve 1.0.0. Elle bakılan sayılar kaçınılmaz olarak bayatlar.
    const pkg = JSON.parse(read('package.json'));

    function walk(dir, out = [], test = (name) => name.endsWith('.md')) {
        if (!fs.existsSync(dir)) return out;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', 'dist', 'release', 'out', 'coverage'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, out, test);
            else if (test(e.name)) out.push(p);
        }
        return out;
    }

    it('README birim test paketi sayısı gerçek dosya sayısıyla uyuşur', () => {
        const actual = walk(path.join(root, 'tests'), [], (n) => /\.test\.(mjs|js|ts)$/.test(n)).length;
        const readme = read('README.md');
        // README'de "N unit test suites" / "N suites" iddiası varsa doğru olmalı.
        for (const m of readme.matchAll(/(\d+)\s+(?:unit test )?suites?\b/gi)) {
            expect(Number(m[1]), `README suite iddiası (gerçek: ${actual})`).toBe(actual);
        }
        expect(readme).not.toMatch(/\(\s*\d[\d,]*\s+tests?\s*\)/i);
    });

    it('README E2E spec sayısı gerçek dosya sayısıyla uyuşur', () => {
        const actual = walk(path.join(root, 'tests/e2e'), [], (n) => /\.spec\.(js|mjs|ts)$/.test(n)).length;
        const readme = read('README.md');
        for (const m of readme.matchAll(/(\d+)\s+Electron E2E test specs?/gi)) {
            expect(Number(m[1]), `README E2E iddiası (gerçek: ${actual})`).toBe(actual);
        }
    });

    it('mağaza kontrol listesi gerçek sürümü anar', () => {
        const sc = read('docs/store/STORE_CHECKLIST.md');
        for (const m of sc.matchAll(/\*\*Sürüm:\*\*\s*`(\d+\.\d+\.\d+)`/g)) {
            expect(m[1], 'mağaza kontrol listesi sürümü').toBe(pkg.version);
        }
    });

    it('güncel dokümanlarda "N dil / N anahtar" iddiası doğru', () => {
        const tr = JSON.parse(read('src/renderer/locales/tr.json'));
        const keys = Object.keys(tr).length;
        const langs = fs.readdirSync(path.join(root, 'src/renderer/locales'))
            .filter((f) => f.endsWith('.json') && f !== 'manifest.json').length;

        // CHANGELOG tarihsel kayıttır: eski sayıları korumak zorundadır.
        const files = [...walk(path.join(root, 'docs')), path.join(root, 'README.md')];
        const problems = [];
        for (const file of files) {
            const rel = file.replace(root, '').replace(/\\/g, '/');
            fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
                for (const m of line.matchAll(/(\d+)\s*(?:dil|lang|locale)[^.\n]{0,30}?(\d{2,5})\s*(?:anahtar|key)/gi)) {
                    const l = Number(m[1]), k = Number(m[2]);
                    if (l !== langs || k !== keys) problems.push(`${rel}:${i + 1}: "${m[0].trim()}" (gerçek ${langs}/${keys})`);
                }
            });
        }
        expect(problems).toEqual([]);
    });
});
