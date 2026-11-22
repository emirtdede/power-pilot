#!/usr/bin/env node
/**
 * sbom.mjs - WP-15.T8
 * CycloneDX 1.5 SBOM + yayın manifesti (SHA-256 + Ed25519 imza).
 *
 * Kullanım:
 *   node scripts/sbom.mjs
 *   PP_SBOM_SIGNING_KEY="D:\keys\release-ed25519.pem" node scripts/sbom.mjs --require-signature
 *
 * Çıktı:
 *   dist/sbom.cdx.json
 *   dist/release-manifest.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const LOCK = path.join(ROOT, 'package-lock.json');
const requireSignature = process.argv.includes('--require-signature');
const keyPath = process.env.PP_SBOM_SIGNING_KEY || '';

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function integrityToHash(integrity) {
    if (typeof integrity !== 'string') return null;
    const match = /^(sha1|sha256|sha512)-([A-Za-z0-9+/=]+)$/.exec(integrity);
    if (!match) return null;
    const alg = match[1].toUpperCase().replace('SHA', 'SHA-');
    const content = Buffer.from(match[2], 'base64').toString('hex');
    return { alg, content };
}

function purlFor(name, version) {
    if (!name || !version) return null;
    if (name.startsWith('@')) {
        const [scope, pkg] = name.split('/');
        return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}@${encodeURIComponent(version)}`;
    }
    return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function listArtifacts(dir, version) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (/\.(exe|msi|appx|msix|zip|blockmap)$/i.test(entry.name)) {
                const rel = path.relative(DIST, full).replace(/\\/g, '/');
                // Eski sürüm artefaktları manifeste sızmasın; yalnızca bu
                // sürümün kurulum dosyaları ve unpacked çıktısı imzalanır.
                const currentVersion = rel.startsWith('win-unpacked/') || entry.name.includes(` ${version}`);
                if (!currentVersion) continue;
                const stat = fs.statSync(full);
                out.push({
                    path: path.relative(ROOT, full).replace(/\\/g, '/'),
                    size: stat.size,
                    sha256: sha256File(full)
                });
            }
        }
    };
    walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
const lockSha256 = sha256File(LOCK);
const components = [];

for (const [rel, entry] of Object.entries(lock.packages || {})) {
    if (!rel || !rel.startsWith('node_modules/') || !entry || !entry.version) continue;
    const name = entry.name || rel.slice('node_modules/'.length).replace(/^node_modules\//, '');
    if (entry.dev === true && process.env.PP_SBOM_INCLUDE_DEV !== '1') continue;
    const component = {
        type: 'library',
        'bom-ref': `npm:${name}@${entry.version}`,
        name,
        version: entry.version,
        purl: purlFor(name, entry.version)
    };
    if (entry.license) component.licenses = [{ license: { id: entry.license } }];
    const hash = integrityToHash(entry.integrity);
    if (hash) component.hashes = [hash];
    components.push(component);
}

components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const rootRef = `pkg:npm/${pkg.name}@${pkg.version}`;
const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
        timestamp: new Date().toISOString(),
        tools: [{ vendor: 'Power Pilot', name: 'sbom.mjs', version: pkg.version }],
        component: {
            type: 'application',
            'bom-ref': rootRef,
            name: pkg.name,
            version: pkg.version
        },
        properties: [
            { name: 'powerpilot:lockfile:sha256', value: lockSha256 },
            { name: 'powerpilot:node', value: process.version },
            { name: 'powerpilot:platform', value: process.platform }
        ]
    },
    components,
    dependencies: [{ ref: rootRef, dependsOn: components.map((component) => component['bom-ref']) }]
};

fs.mkdirSync(DIST, { recursive: true });
const bomPath = path.join(DIST, 'sbom.cdx.json');
fs.writeFileSync(bomPath, `${JSON.stringify(bom, null, 2)}\n`, 'utf8');
const bomSha256 = sha256File(bomPath);

const artifacts = listArtifacts(DIST, pkg.version).filter((artifact) => {
    const base = path.basename(artifact.path);
    return base !== 'sbom.cdx.json' && base !== 'release-manifest.json';
});
const manifest = {
    schema: 'powerpilot-release-manifest/v1',
    product: pkg.name,
    version: pkg.version,
    generatedAt: new Date().toISOString(),
    lockfile: { path: 'package-lock.json', sha256: lockSha256 },
    sbom: { path: 'dist/sbom.cdx.json', sha256: bomSha256, componentCount: components.length },
    artifacts,
    signature: null
};

const signable = { ...manifest };
delete signable.signature;
const payload = Buffer.from(JSON.stringify(signable), 'utf8');

if (keyPath) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
    manifest.signature = {
        algorithm: 'ed25519',
        keyId: process.env.PP_SBOM_KEY_ID || 'release',
        value: crypto.sign(null, payload, privateKey).toString('base64')
    };
} else if (requireSignature) {
    console.error('[sbom] PP_SBOM_SIGNING_KEY zorunlu (--require-signature).');
    process.exit(1);
} else {
    console.warn('[sbom] UYARI: PP_SBOM_SIGNING_KEY yok; manifest imzasız üretildi.');
}

const manifestPath = path.join(DIST, 'release-manifest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`[sbom] ${components.length} bileşen, ${artifacts.length} artefakt; ${path.relative(ROOT, bomPath)} + ${path.relative(ROOT, manifestPath)}`);
