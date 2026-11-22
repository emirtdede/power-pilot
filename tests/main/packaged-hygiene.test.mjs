/**
 * packaged-hygiene.test.mjs - yayın artefaktı temizliği sözleşmesi.
 *
 * Neden: `app.asar` içinde `playwright.config.js`, `vitest.config.js`,
 * `tailwind.config.js`, `electron-builder*.cjs` ve `.nvmrc` dosyaları
 * son kullanıcıya gidiyordu. Hiçbiri çalışma zamanında `require` edilmiyor
 * (kanıt: src/ ve main.js içinde 0 referans), dolayısıyla paket dışına
 * alınabilirler. Test/build yapılandırmasının kullanıcının diskine gitmesi
 * hem gereksiz hem de iç yapıyı ifşa eder.
 *
 * Bu test `package.json` `build.files` listesini doğrular: yeni bir
 * geliştirici dosyası eklendiğinde burada unutulmasın diye.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const files = pkg.build.files;

const DEV_ONLY = [
    'playwright.config.js',
    'vitest.config.js',
    'tailwind.config.js',
    'electron-builder.config.cjs',
    'electron-builder.store.cjs',
    '.nvmrc'
];

describe('paket hijyeni - geliştirici dosyaları yayına girmez', () => {
    it('her geliştirici yapılandırması files listesinden hariç tutulur', () => {
        const missing = DEV_ONLY.filter((f) => !files.includes(`!${f}`));
        expect(missing, `build.files içinde hariç tutulmayan: ${missing.join(', ')}`).toEqual([]);
    });

    it('test/doküman/scratch dizinleri hariç tutulur', () => {
        for (const dir of ['tests', 'docs', 'scratch', 'spikes', 'coverage']) {
            expect(files, `${dir}/ paketten çıkarılmalı`).toContain(`!${dir}/**`);
        }
    });

    it('kaynak haritaları ve loglar pakete girmez', () => {
        expect(files).toContain('!**/*.map');
        expect(files).toContain('!**/*.log');
    });

    it('hariç tutulan dosyalar gerçekten çalışma zamanında kullanılmıyor', () => {
        // Kanıt: src/ ve main.js hiçbirini require etmiyor.
        const sources = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (['node_modules', 'locales', 'vendor'].includes(e.name)) continue;
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full);
                else if (/\.js$/.test(e.name)) sources.push(full);
            }
        };
        walk(path.join(root, 'src'));
        sources.push(path.join(root, 'main.js'), path.join(root, 'preload.js'));

        const corpus = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
        for (const f of DEV_ONLY) {
            const stem = f.replace(/\.(js|cjs|mjs)$/, '');
            expect(corpus.includes(stem), `${stem} çalışma zamanında referans ediliyor`).toBe(false);
        }
    });
});
