#!/usr/bin/env node
'use strict';

/**
 * scripts/build-setup.mjs
 *
 * Builds Power Pilot's single-file frameless 640x420 monochrome Setup & Uninstaller:
 *  1. Generates 73-language zero-leak UI bundle (scripts/generate-setup-i18n.mjs)
 *  2. Packs Electron app into dist/win-unpacked (unless --skip-pack)
 *  3. Compiles Rust native setup stub & packer into dist/setup-target
 *  4. Authenticode-signs the standalone stub (when WIN_CERT_SUBJECT is set)
 *  5. Compresses dist/win-unpacked + signed stub into dist/Power Pilot Setup <ver>.exe
 *  6. Authenticode-signs the final Setup.exe (when WIN_CERT_SUBJECT is set)
 *  7. Writes dist/latest.yml (SHA-512 + size) for electron-updater compatibility
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version || '1.0.0';
const DIST_DIR = path.join(ROOT, 'dist');
const UNPACKED_DIR = path.join(DIST_DIR, 'win-unpacked');
const CARGO_TARGET_DIR = path.join(DIST_DIR, 'setup-target');
const RELEASE_DIR = path.join(CARGO_TARGET_DIR, 'release');
const STUB_EXE = path.join(RELEASE_DIR, 'powerpilot-setup.exe');
const PACKER_EXE = path.join(RELEASE_DIR, 'pp-pack.exe');
const SETUP_NAME = `Power Pilot Setup ${VERSION}.exe`;
const SETUP_OUT = path.join(DIST_DIR, SETUP_NAME);

function run(cmd, args, extraEnv = {}) {
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR, ...extraEnv }
  });
}

function findSignTool() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin')
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter((d) => /^10\./.test(d)).sort().reverse();
    for (const v of versions) {
      const p = path.join(base, v, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function signIfConfigured(exePath) {
  const subject = process.env.WIN_CERT_SUBJECT;
  const sha1 = process.env.WIN_CERT_SHA1;
  if (!subject && !sha1) return;
  const signtool = findSignTool();
  if (!signtool) {
    console.warn('[build-setup] signtool.exe not found; skipping Authenticode signing.');
    return;
  }
  const tsUrl = process.env.WIN_TIMESTAMP_URL || 'https://timestamp.digicert.com';
  const args = ['sign', '/fd', 'sha256', '/tr', tsUrl, '/td', 'sha256'];
  if (sha1) args.push('/sha1', sha1);
  else args.push('/n', subject);
  args.push(exePath);
  console.log(`[build-setup] Signing ${path.basename(exePath)}...`);
  run(signtool, args);
}

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('base64');
}

function writeLatestYml(setupPath) {
  const stat = fs.statSync(setupPath);
  const sha512 = sha512Base64(setupPath);
  const ymlFile = path.join(DIST_DIR, 'latest.yml');
  const releaseFileName = `Power.Pilot.Setup.${VERSION}.exe`;
  const content = [
    `version: ${VERSION}`,
    'files:',
    `  - url: ${releaseFileName}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${releaseFileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    ''
  ].join('\n');
  fs.writeFileSync(ymlFile, content, 'utf8');
  console.log(`[build-setup] Wrote ${path.relative(ROOT, ymlFile)} (size=${stat.size})`);
}

function main() {
  const skipPack = process.argv.includes('--skip-pack');

  console.log('[build-setup] 1/5 Generating 73-language setup UI bundle...');
  run(process.execPath, [path.join(ROOT, 'scripts', 'generate-setup-i18n.mjs')]);

  if (!skipPack) {
    console.log('[build-setup] 2/5 Packing Electron app (dist/win-unpacked)...');
    run(process.execPath, [path.join(ROOT, 'scripts', 'build-renderer.mjs')]);
    run(process.execPath, [
      path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'),
      '--dir',
      '--config',
      'electron-builder.config.cjs',
      '--publish',
      'never'
    ]);
  } else {
    console.log('[build-setup] 2/5 Skipping Electron pack (--skip-pack).');
  }

  if (!fs.existsSync(path.join(UNPACKED_DIR, 'Power Pilot.exe'))) {
    throw new Error(`Missing unpacked app at ${UNPACKED_DIR}. Run npm run pack first.`);
  }

  console.log('[build-setup] 3/5 Building native frameless Rust setup stub & packer...');
  run('cargo', ['build', '--release', '--manifest-path', path.join(ROOT, 'installer', 'Cargo.toml')]);

  if (!fs.existsSync(STUB_EXE) || !fs.existsSync(PACKER_EXE)) {
    throw new Error('Rust release binaries missing after cargo build.');
  }

  // Sign standalone stub BEFORE packing so embedded uninstall.exe retains a valid signature
  signIfConfigured(STUB_EXE);

  console.log(`[build-setup] 4/5 Packing single-file ${SETUP_NAME}...`);
  run(PACKER_EXE, [STUB_EXE, UNPACKED_DIR, SETUP_OUT, VERSION]);

  signIfConfigured(SETUP_OUT);

  console.log('[build-setup] 5/5 Writing dist/latest.yml metadata...');
  writeLatestYml(SETUP_OUT);

  const sizeMb = (fs.statSync(SETUP_OUT).size / 1048576).toFixed(1);
  console.log(`[build-setup] DONE - ${path.relative(ROOT, SETUP_OUT)} (${sizeMb} MB)`);
}

main();
