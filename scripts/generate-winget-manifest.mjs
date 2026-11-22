#!/usr/bin/env node
/**
 * scripts/generate-winget-manifest.mjs
 *
 * Microsoft Windows Package Manager (winget-pkgs) v1.6.0 cok dosyalı
 * manifest setini (version, installer, en-US, tr-TR) deterministik olarak uretir.
 * dist/Power Pilot Setup <version>.exe mevcutsa gercek SHA-256 ozetini hesaplar.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '1.0.0';
const packageId = 'Vellium.PowerPilot';
const manifestVersion = '1.6.0';
const setupFileName = `Power Pilot Setup ${version}.exe`;
const releaseAssetName = `Power.Pilot.Setup.${version}.exe`;
const installerUrl = `https://github.com/emirtdede/power-pilot/releases/download/v${version}/${releaseAssetName}`;
const setupPath = path.join(ROOT, 'dist', setupFileName);

function computeSha256(filePath) {
    if (!fs.existsSync(filePath)) return '0'.repeat(64);
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex').toUpperCase();
}

const sha256 = computeSha256(setupPath);
const outDir = path.join(ROOT, 'packaging', 'winget', 'manifests', 'v', 'Vellium', 'PowerPilot', version);
fs.mkdirSync(outDir, { recursive: true });

const versionYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.${manifestVersion}.schema.json
PackageIdentifier: ${packageId}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${manifestVersion}
`;

const installerYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.${manifestVersion}.schema.json
PackageIdentifier: ${packageId}
PackageVersion: ${version}
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.19041.0
InstallerType: exe
Scope: user
InstallModes:
  - interactive
  - silent
  - silentWithProgress
InstallerSwitches:
  Silent: /S
  SilentWithProgress: /P
UpgradeBehavior: install
Commands:
  - powerpilot
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${installerUrl}
    InstallerSha256: ${sha256}
ManifestType: installer
ManifestVersion: ${manifestVersion}
`;

const localeEnYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.${manifestVersion}.schema.json
PackageIdentifier: ${packageId}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Vellium Teknoloji Anonim Sirketi
PublisherUrl: https://vellium.dev
PublisherSupportUrl: https://vellium.dev/en/legal/support
PrivacyUrl: https://vellium.dev/en/legal/privacy
Author: Vellium
PackageName: Power Pilot
PackageUrl: https://github.com/emirtdede/power-pilot
License: Proprietary
LicenseUrl: https://github.com/emirtdede/power-pilot/blob/main/LICENSE
Copyright: Copyright (c) 2026 Vellium Teknoloji Anonim Sirketi
ShortDescription: Smart, local-first Windows power management and task automation.
Description: >-
  Power Pilot automates Windows shutdown, restart, sleep, hibernate, lock, and
  Smart Finish conditions completely offline with local SQLite storage, OneDrive
  folder sync, 73 languages, custom color themes, and accessibility controls.
Moniker: powerpilot
Tags:
  - power-management
  - shutdown
  - timer
  - automation
  - sleep
  - hibernate
  - windows
  - offline
ReleaseNotesUrl: https://github.com/emirtdede/power-pilot/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: ${manifestVersion}
`;

const localeTrYaml = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.locale.${manifestVersion}.schema.json
PackageIdentifier: ${packageId}
PackageVersion: ${version}
PackageLocale: tr-TR
Publisher: Vellium Teknoloji Anonim Sirketi
PublisherUrl: https://vellium.dev
PublisherSupportUrl: https://vellium.dev/tr/legal/support
PrivacyUrl: https://vellium.dev/tr/legal/privacy
Author: Vellium
PackageName: Power Pilot
PackageUrl: https://github.com/emirtdede/power-pilot
License: Proprietary
ShortDescription: Windows icin akilli, yerel oncelikli guc yonetimi ve gorev otomasyonu.
Description: >-
  Power Pilot; kapatma, yeniden baslatma, uyku, hazirda bekletme, kilitleme ve
  Akilli Tamamlanma (Smart Finish) kosullarini yerel SQLite deposu, sunucusuz
  OneDrive esitlemesi, 73 dil ve ozel tema destegiyle tamamen cevrimdisi yonetir.
Tags:
  - guc-yonetimi
  - kapatma
  - zamanlayici
  - otomasyon
  - uyku
  - windows
ManifestType: locale
ManifestVersion: ${manifestVersion}
`;

fs.writeFileSync(path.join(outDir, `${packageId}.yaml`), versionYaml, 'utf8');
fs.writeFileSync(path.join(outDir, `${packageId}.installer.yaml`), installerYaml, 'utf8');
fs.writeFileSync(path.join(outDir, `${packageId}.locale.en-US.yaml`), localeEnYaml, 'utf8');
fs.writeFileSync(path.join(outDir, `${packageId}.locale.tr-TR.yaml`), localeTrYaml, 'utf8');

console.log(`[winget] OK - ${packageId} v${version} manifestleri uretildi (${path.relative(ROOT, outDir)}, sha256=${sha256.slice(0, 12)}...).`);
