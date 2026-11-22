/**
 * no-em-dash.test.mjs - Tum Unicode uzun cizgi karakterlerinin (U+2012..U+2015,
 * U+2E3A, U+2E3B, U+FE58, U+FF0D) proje genelinde kalici olarak yasaklanmasi.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'test-results', 'playwright-report', 'blob-report']);
const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.nsh', '.ps1', '.md', '.yml', '.yaml', '.txt', '.svg']);
const LONG_DASH_RE = /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(path.join(dir, entry.name), out);
        } else if (entry.isFile() && TEXT_EXTS.has(path.extname(entry.name).toLowerCase())) {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

describe('Kalici uzun cizgi yasagi (en-dash / em-dash / yatay cizgi)', () => {
    it('projedeki hicbir kaynak, ceviri, test, SVG veya dokumantasyon dosyasinda uzun cizgi bulunmaz', () => {
        const files = walk(ROOT);
        const offenders = [];
        for (const file of files) {
            const text = fs.readFileSync(file, 'utf8');
            if (LONG_DASH_RE.test(text)) {
                offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
            }
        }
        expect(offenders, `Uzun cizgi tespit edilen dosyalar: ${offenders.join(', ')}`).toEqual([]);
    });
});
