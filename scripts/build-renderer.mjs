#!/usr/bin/env node
/**
 * build-renderer.mjs - WP-14.T2
 * Tailwind CSS'i build zamanında üretir (runtime `vendor/tailwind.js` yok).
 * Çıktı deterministik ve minified'dir; release-check bu dosyanın varlığını arar.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
const args = [
    cli,
    '-c', path.join(root, 'tailwind.config.js'),
    '-i', path.join(root, 'src', 'renderer', 'tailwind.input.css'),
    '-o', path.join(root, 'src', 'renderer', 'tailwind.css'),
    '--minify'
];

const res = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
if (res.error) {
    console.error('[build:renderer] Tailwind çalıştırılamadı:', res.error.message);
    process.exit(1);
}
if (res.status !== 0) process.exit(res.status || 1);
console.log('[build:renderer] src/renderer/tailwind.css üretildi.');
