#!/usr/bin/env node
/**
 * build-appx.js - WP-18/TS-18: APPX üretim kapısı.
 *
 * Kural (Plan v2.0): Varsayılan dağıtım NSIS-only'dir. APPX yalnızca
 *  1. APPX_PUBLISHER ortam değişkeni verilmişse,
 *  2. kod imzalama materyali (CSC_LINK veya mağaza sertifikası) varsa,
 *  3. sertifika Subject'i APPX_PUBLISHER ile eşleşiyorsa
 * üretilir. Aksi halde komut açık hata ile durur; yanlış publisher'lı paket
 * mağazaya gönderilemez.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function fail(message) {
    console.error(`[build-appx] REDDEDİLDİ: ${message}`);
    process.exit(1);
}

function normalizePublisher(value) {
    return String(value || '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .sort()
        .join(',');
}

/**
 * Windows sertifika deposunda Subject'i publisher ile eşleşen sertifika arar.
 * Sertifika yoksa null döner (APPX üretimi reddedilir).
 */
function findPublisherCertificate(publisher) {
    if (process.platform !== 'win32') return null;
    const script = [
        "$ErrorActionPreference='SilentlyContinue';",
        'Get-ChildItem Cert:\\CurrentUser\\My, Cert:\\LocalMachine\\My |',
        'Where-Object { $_.HasPrivateKey } |',
        'Select-Object -ExpandProperty Subject'
    ].join(' ');
    const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 20000
    });
    if (res.status !== 0 || !res.stdout) return null;
    const wanted = normalizePublisher(publisher);
    for (const line of res.stdout.split(/\r?\n/)) {
        if (normalizePublisher(line) === wanted) return line.trim();
    }
    return null;
}

/**
 * İmzalama için sertifika Subject'ini çözer.
 *
 * package.json'daki `certificateSubjectName` `${env.WIN_CERT_SUBJECT}` okuyor;
 * eski betik yalnızca `WINDOWS_CERT_SUBJECT` arıyordu. İki adı tek noktada
 * birleştirmek bu sınıf hataların (sertifika doğruyken build'in
 * "Cannot find certificate" ile düşmesi) önüne geçer.
 *
 * @param {Record<string,string|undefined>} env
 * @param {string} [publisher]
 * @returns {{ subject: string|null, source: 'env'|'store'|null }}
 */
function resolveSigningSubject(env = {}, publisher) {
    const direct = env.WINDOWS_CERT_SUBJECT || env.WIN_CERT_SUBJECT || null;
    if (direct) return { subject: String(direct).trim(), source: 'env' };
    if (publisher) {
        const found = findPublisherCertificate(publisher);
        if (found) return { subject: found, source: 'store' };
    }
    return { subject: null, source: null };
}

function main() {
    const publisher = process.env.APPX_PUBLISHER;
    if (!publisher || !String(publisher).trim()) {
        fail('APPX_PUBLISHER tanımlı değil. Varsayılan dağıtım NSIS-only; APPX için publisher zorunlu.');
    }
    // package.json `certificateSubjectName` değeri `${env.WIN_CERT_SUBJECT}`
    // okuyor; eski sürüm yalnızca WINDOWS_CERT_SUBJECT doğruluyordu, bu yüzden
    // sertifika doğru olsa bile electron-builder "Cannot find certificate
    // ${env.WIN_CERT_SUBJECT}" ile düşüyordu. İki adı tek kaynağa bağla.
    const hasSigningMaterial = !!(process.env.CSC_LINK || process.env.WINDOWS_CERT_SUBJECT || process.env.WIN_CERT_SUBJECT);
    if (!hasSigningMaterial) {
        fail('Kod imzalama materyali yok (CSC_LINK veya WINDOWS_CERT_SUBJECT). İmzasız APPX yayınlanamaz.');
    }
    const { subject: certSubject } = resolveSigningSubject(process.env, publisher);
    if (!certSubject) {
        fail(`Publisher ile eşleşen özel anahtarlı sertifika bulunamadı: ${publisher}`);
    }
    if (normalizePublisher(certSubject) !== normalizePublisher(publisher)) {
        fail(`Sertifika Subject publisher ile eşleşmiyor.\n  Publisher: ${publisher}\n  Sertifika: ${certSubject}`);
    }

    console.log(`[build-appx] Publisher doğrulandı: ${publisher}`);
    console.log('[build-appx] electron-builder --win appx başlatılıyor...');
    // Kök neden: paket `package.json`'daki `build` alanını okuyordu; orada
    // imza Subject'i `${env.WIN_CERT_SUBJECT}` olarak **ham** duruyor ve
    // electron-builder bu sürümde genişletmiyordu (bu yüzden sertifika
    // doğruyken bile "Cannot find certificate ${env.WIN_CERT_SUBJECT}").
    // `electron-builder.config.cjs` ortamdan çözüp `certificateSubjectName`
    // alanına yazıyor; bu yüzden onu her zaman `--config` ile geç.
    const configFile = process.argv.includes('--store')
        ? 'electron-builder.store.cjs'
        : 'electron-builder.config.cjs';
    // Node 20+ (CVE-2024-27980 sertleştirmesi) `.cmd` dosyalarını kabuk
    // olmadan spawn etmeyi reddediyor (`spawnSync npx.cmd EINVAL`). npx.cmd
    // yerine electron-builder CLI'sını mevcut Node ile doğrudan çalıştırıyoruz;
    // böylece kabuk enjeksiyonu da devre dışı kalıyor.
    const builderCli = require.resolve('electron-builder/cli.js', { paths: [ROOT] });
    execFileSync(
        process.execPath,
        [builderCli, '--win', 'appx', '--config', configFile],
        {
            cwd: ROOT,
            stdio: 'inherit',
            // electron-builder'ın okuduğu adı burada garanti et.
            env: { ...process.env, WIN_CERT_SUBJECT: certSubject }
        }
    );
}

if (require.main === module) main();

module.exports = { normalizePublisher, findPublisherCertificate, resolveSigningSubject };
