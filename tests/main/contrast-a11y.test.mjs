/**
 * contrast-a11y.test.mjs - WCAG AA kontrast sözleşmesi (statik kapı).
 *
 * Ölçülen gerçek kusurlar (uygulama, hesaplanmış etkin arka plan üzerinden,
 * 10 görünümün tamamı taranarak):
 *
 *   açık tema:
 *     text-slate-400 (#94a3b8) beyaz üstünde ................ 2.56:1  (AA 4.5)
 *     text-slate-500 (#64748b) slate-100 üstünde ............ 4.34:1  (sınırda)
 *     text-amber-500 (#f59e0b) beyaz üstünde ................ 2.10:1
 *     text-red-500   (#ef4444) red-50 üstünde ............... 3.23:1
 *     text-primary   (#0067c2) bg-primary/20 üstünde ........ 4.19:1
 *
 *   koyu tema:
 *     text-primary   (#0067c2) koyu zeminlerde .............. 2.40-3.16:1
 *     dark:text-slate-500 (#64748b) slate-800 üstünde ....... 3.07:1
 *
 * Düzeltme (ölçüldü, iki temada da AA):
 *     text-slate-400        → text-slate-500 dark:text-slate-400   (4.76 / 5.71)
 *     text-slate-500        → text-slate-600 dark:text-slate-400   (6.4  / 5.71)
 *     text-amber-500        → text-amber-700 dark:text-amber-400
 *     text-red-500/600      → text-red-700   dark:text-red-400
 *     text-primary          → text-primary dark:text-primary-light (5.33+ koyu)
 *     bg-primary/20         → bg-primary/10
 *
 * Bu test o sözleşmeyi kilitler; yeni bir "yalnızca bir temada tanımlı"
 * soluk/kontrastsız sınıf eklenirse başarısız olur.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SOURCES = [
    'src/index.html',
    'src/renderer/app.js',
    'src/renderer/tasksView.js'
];

function readLines(rel) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readFileSync(abs, 'utf8').split(/\r?\n/);
}

function scan(predicate, label) {
    const offenders = [];
    for (const rel of SOURCES) {
        readLines(rel).forEach((line, i) => {
            if (predicate(line)) {
                offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 130)}`);
            }
        });
    }
    expect(offenders, `${label}:\n${offenders.join('\n')}`).toEqual([]);
}

describe('kontrast (WCAG AA) - açık ve koyu tema', () => {
    it('çıplak `text-slate-400` yok (açık tema 2.56:1)', () => {
        // dark:text-slate-400 serbest (koyu temada 5.71:1).
        scan(
            (line) => /(^|[\s"'`])text-slate-400(?=[\s"'`]|$)/.test(line),
            'Açık temada okunaksız metin'
        );
    });

    it('çıplak `text-slate-500` yok (açık temada 4.34:1 - sınırda)', () => {
        // text-slate-500 artık text-slate-600 dark:text-slate-400 olmalı.
        scan(
            (line) => /(^|[\s"'`])text-slate-500(?=[\s"'`]|$)/.test(line),
            'Sınırda kalan açık tema metni'
        );
    });

    it('koyu temada `dark:text-slate-500` yok (3.07:1)', () => {
        scan(
            (line) => /dark:text-slate-500/.test(line),
            'Koyu temada okunaksız metin'
        );
    });

    it('koyu temada `dark:text-slate-600` yok (slate-800 üzerinde yetersiz)', () => {
        scan(
            (line) => /dark:text-slate-600/.test(line),
            'Koyu temada yetersiz kontrast'
        );
    });

    it('`text-amber-500` çıplak kullanılmaz (beyaz üstünde 2.10:1)', () => {
        scan(
            (line) => /(^|[\s"'`:])text-amber-500(?=[\s"'`]|$)/.test(line)
                && !/dark:text-amber-400/.test(line),
            'Uyarı metni okunaksız'
        );
    });

    it('`text-red-500` çıplak kullanılmaz (red-50 üstünde 3.23:1)', () => {
        scan(
            (line) => /(^|[\s"'`:])text-red-500(?=[\s"'`]|$)/.test(line)
                && !/dark:text-red-400/.test(line),
            'Hata metni okunaksız'
        );
    });

    it('`text-primary` her zaman koyu tema eşi taşır (koyu zeminde 2.40:1)', () => {
        // #0067c2 koyu zeminde okunmuyor → dark:text-primary-light zorunlu.
        scan(
            (line) => /(^|[\s"'`])text-primary(?![-\w])/.test(line)
                && !/dark:text-primary-light/.test(line),
            'Koyu temada okunaksız primary metin'
        );
    });

    it('`bg-primary/20` kullanılmaz (primary metinle 4.19:1)', () => {
        scan(
            (line) => /bg-primary\/20/.test(line),
            'Yarı saydam primary zemin çok koyu'
        );
    });

    it('`text-green-500` çıplak kullanılmaz (beyaz üstünde 2.28:1)', () => {
        scan(
            (line) => /(^|[\s"'`:])text-green-500(?=[\s"'`]|$)/.test(line),
            'Yeşil metin okunaksız'
        );
    });

    it('`text-emerald-500` çıplak kullanılmaz', () => {
        scan(
            (line) => /(^|[\s"'`:])text-emerald-500(?=[\s"'`]|$)/.test(line),
            'Zümrüt metin okunaksız'
        );
    });

    it('primary-light token tailwind config içinde tanımlı', () => {
        const config = fs.readFileSync(path.join(root, 'tailwind.config.js'), 'utf8');
        expect(config, "'primary-light' rengi tanımlı olmalı").toContain("'primary-light'");
    });

    it('düzeltilen desen her iki temada da AA sağlıyor', () => {
        // text-slate-600 (açık ~6.4:1) + dark:text-slate-400 (koyu 5.71:1).
        const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
        expect(html).toContain('text-slate-600 dark:text-slate-400');
    });
});
