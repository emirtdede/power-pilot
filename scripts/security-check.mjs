#!/usr/bin/env node
/**
 * security-check.mjs - WP-00.T5
 * Yasaklı desen taraması. Test ve dokümantasyon hariç tutulur.
 * Kural eklemek için RULES dizisine girin; istisna için ALLOW listesine
 * dosya + kural kimliği + gerekçe yazın. Sessiz istisna yoktur.
 *
 * Çıkış kodları: 0 = temiz, 1 = ihlal var.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['src', 'scripts'];
const SCAN_FILES = ['main.js', 'preload.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', '.git', 'vendor']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.json', '.ps1', '.svg']);

const RULES = [
    // `rx.exec(` / `this.exec(` gibi DI sarmalayıcıları değil, yalnızca
    // doğrudan kabuk exec çağrısını yakala.
    { id: 'SHELL_EXEC', re: /(?<![.\w$])exec\s*\(/, message: 'Kabuk exec() yasak; execFile(args) kullanın.' },
    { id: 'SHELL_TRUE', re: /shell\s*:\s*true/, message: 'shell:true yasak; execFile argüman dizisi kullanın.' },
    { id: 'INNER_HTML', re: /\.(inner|outer)HTML\s*=/, message: 'innerHTML/outerHTML ataması yasak; DOM API kullanın.' },
    { id: 'INSERT_ADJ_HTML', re: /insertAdjacentHTML/, message: 'insertAdjacentHTML yasak; DOM API kullanın.' },
    { id: 'UNSAFE_INLINE', re: /unsafe-inline/, message: "CSP 'unsafe-inline' yasak." },
    { id: 'NODE_INTEGRATION', re: /nodeIntegration\s*:\s*true/, message: 'nodeIntegration:true yasak.' },
    // Yalnızca gerçek URL sabitlerini yakala; `'http://'` şema kontrolü istisnadır.
    // `http://schemas.*` bir XML **ad alanı** tanımlayıcısıdır (ağ isteği
    // değildir); Task Scheduler/manifest XML'lerinde zorunludur.
    { id: 'PLAIN_HTTP_CLIENT', re: /(['"`])http:\/\/(?!127\.0\.0\.1|localhost|\[::1\]|x\b|\$\{|schemas\.|www\.w3\.org\/)(?!\1)/, message: 'Düz HTTP istemci URL yasak; HTTPS kullanın.' },
    { id: 'PLAINTEXT_SECRET', re: /(localApiKeyPem|consoleAgentKey|webhookSecret|auditHmacKey|backupAesKey)\s*[:=]\s*(['"`])[^'"`]{8,}\2/i, message: 'Düz metin sır sabiti yasak.' },
    { id: 'VM_RUN', re: /vm\.runIn(Context|NewContext|ThisContext)/, message: 'vm.runIn* yasak; JSON modülü kullanın.' },
    { id: 'EVAL', re: /\beval\s*\(/, message: 'eval() yasak.' },
    { id: 'NO_EM_DASH', re: /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/, message: 'Uzun çizgi (en/em-dash vb.) kullanımı kalıcı olarak yasaktır; "-" kullanın.' }
];

// Bilinçli, geçici istisnalar (dosya:kural → gerekçe + bağlı WP).
// Her istisna kapatılacak WP ile ilişkilidir; WP tamamlanınca silinir.
const ALLOW = new Map();

async function walk(dir, out = []) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch (_) {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            await walk(join(dir, entry.name), out);
        } else if (entry.isFile() && TEXT_EXT.has(extname(entry.name))) {
            out.push(join(dir, entry.name));
        }
    }
    return out;
}

async function collect() {
    const files = [];
    for (const d of SCAN_DIRS) {
        const abs = join(ROOT, d);
        try { await stat(abs); } catch (_) { continue; }
        files.push(...await walk(abs));
    }
    for (const f of SCAN_FILES) {
        const abs = join(ROOT, f);
        try { await stat(abs); files.push(abs); } catch (_) { /* yok */ }
    }
    // test ve docs zaten taranmıyor; yine de savunma amaçlı filtre.
    return files.filter((f) => !/[\\/](tests?|docs?|coverage|dist)[\\/]/.test(f));
}

const files = await collect();
const violations = [];
const SKIP_FILES = new Set(['scripts/security-check.mjs']);
for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (SKIP_FILES.has(rel)) continue;
    const text = await readFile(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const rule of RULES) {
        lines.forEach((line, i) => {
            if (!rule.re.test(line)) return;
            if (ALLOW.has(`${rel}:${rule.id}`)) return;
            violations.push({ file: rel, line: i + 1, rule: rule.id, message: rule.message, snippet: line.trim().slice(0, 160) });
        });
    }
}

if (violations.length === 0) {
    console.log(`[security-check] temiz (${files.length} dosya tarandı)`);
    process.exit(0);
}

console.error(`[security-check] ${violations.length} ihlal:`);
for (const v of violations) {
    console.error(`${v.file}:${v.line} [${v.rule}] ${v.message}`);
    console.error(`    ${v.snippet}`);
}
process.exit(1);
