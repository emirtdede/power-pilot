/**
 * fixtures.mjs - WP-00.T3
 * Deterministik test verisi fabrikaları: görev, emir, muafiyet, bakım
 * penceresi, eski JSON verisi, TLS materyali ve sahte schtasks.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seq = 0;
function nextId(prefix) {
    seq += 1;
    return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export function tempDir(prefix = 'pp-fixture-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeTask(overrides = {}) {
    return {
        id: nextId('task'),
        name: 'Test görevi',
        action: 'sleep',
        status: 'pending',
        source: 'user_interface',
        createdAt: new Date('2026-10-22T00:00:00.000Z').toISOString(),
        ...overrides
    };
}

export function makeOrder(overrides = {}) {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    return {
        orderId: nextId('order'),
        issuer: 'console-test',
        target: { agentId: 'agent-test' },
        action: 'lock',
        issuedAt: now,
        expiresAt: now + 5 * 60 * 1000,
        nonce: crypto.randomBytes(16).toString('base64url'),
        ...overrides
    };
}

export function makeExemption(overrides = {}) {
    return {
        id: nextId('exemption'),
        deviceId: 'agent-test',
        policyId: null,
        from: '2026-10-22T00:00:00.000Z',
        to: '2026-10-23T00:00:00.000Z',
        reason: 'Test muafiyeti',
        approvedBy: 'tester',
        createdAt: '2026-10-22T00:00:00.000Z',
        ...overrides
    };
}

export function makeMaintenanceWindow(overrides = {}) {
    return {
        id: nextId('window'),
        name: 'Test penceresi',
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '23:59',
        ...overrides
    };
}

/** Eski (v0/v1) JSON veri dosyası - migrasyon testleri için. */
export function makeLegacyData(version = 0, overrides = {}) {
    return {
        version,
        tasks: [{ id: 'legacy-task', name: 'Eski görev', action: 'lock', status: 'pending' }],
        history: [],
        settings: { theme: 'light', localApiEnabled: false },
        webhooks: [],
        ...overrides
    };
}

export function writeLegacyData(dir, version = 0, overrides = {}) {
    const file = path.join(dir, 'powerpilot_data.json');
    fs.writeFileSync(file, JSON.stringify(makeLegacyData(version, overrides), null, 2), 'utf8');
    return file;
}

/** Ed25519 anahtar çifti (imzalı emir testleri). */
export function makeKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' })
    };
}

/** Self-signed TLS materyali (WP-02 testleri). */
export async function makeTlsMaterial() {
    const { default: selfsigned } = await import('selfsigned');
    const pems = selfsigned.generate(
        [{ name: 'commonName', value: '127.0.0.1' }],
        {
            days: 1,
            keySize: 2048,
            algorithm: 'sha256',
            extensions: [
                { name: 'basicConstraints', cA: true },
                {
                    name: 'subjectAltName',
                    altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }]
                }
            ]
        }
    );
    return {
        cert: pems.cert,
        key: pems.private,
        ca: pems.cert,
        pfx: null
    };
}

/**
 * Sahte schtasks yürütücüsü: gerçek OS çağrısı yapmaz, argümanları kaydeder.
 * @returns {{calls:Array, execFile:Function, failWith:(Error|null)=>void}}
 */
export function fakeSchtasks() {
    const calls = [];
    const state = { error: null };
    return {
        calls,
        failWith(err) { state.error = err; },
        execFile(file, args, options, cb) {
            calls.push({ file, args: Array.isArray(args) ? [...args] : args, options });
            const done = typeof options === 'function' ? options : cb;
            if (state.error) return done(state.error, '', state.error.message);
            return done(null, 'SUCCESS: The scheduled task was created.', '');
        }
    };
}

export default {
    tempDir,
    makeTask,
    makeOrder,
    makeExemption,
    makeMaintenanceWindow,
    makeLegacyData,
    writeLegacyData,
    makeKeypair,
    makeTlsMaterial,
    fakeSchtasks
};
