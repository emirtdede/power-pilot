#!/usr/bin/env electron
/**
 * migrate-secrets.mjs - WP-04.T2
 * Düz metin sırları (settings + webhook) DPAPI ile şifreleyip ayrı
 * `secrets.v1.json` dosyasına taşır; eski sır içeren yedekleri siler.
 *
 * Çalıştırma (Electron gerekir; Node'da safeStorage yoktur):
 *   npx electron scripts/migrate-secrets.mjs --user-data-dir="<veri dizini>"
 *
 * Çıkış kodları: 0 = başarılı, 1 = hata, 2 = backend yok ama sır var.
 */
import { app, safeStorage } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const StorageService = require('../src/main/services/StorageService');
const { SecretStore } = require('../src/main/security/SecretStore');
const { AuditLog } = require('../src/main/services/AuditLog');

function argValue(name) {
    const prefix = `--${name}=`;
    for (let i = 0; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
        if (a.startsWith(prefix)) return a.slice(prefix.length);
    }
    return null;
}

const override = argValue('user-data-dir');
if (override) {
    const resolved = path.resolve(override);
    fs.mkdirSync(resolved, { recursive: true });
    app.setPath('userData', resolved);
}

function finish(code, message) {
    // eslint-disable-next-line no-console
    console.log(message);
    app.exit(code);
}

app.whenReady().then(async () => {
    const dir = app.getPath('userData');
    const store = new SecretStore({
        filePath: path.join(dir, 'secrets.v1.json'),
        safeStorage,
        applyAcl: true
    });
    const storage = new StorageService(dir);
    storage.setSecretStore(store);

    const plaintext = SecretStore.findPlaintextSecrets(storage.data);
    const available = await store.isAsyncEncryptionAvailable();
    if (!available) {
        if (plaintext.length > 0 || store.listNames().length > 0) {
            return finish(2, `HATA: safeStorage/DPAPI kullanılamıyor; ${plaintext.length} düz metin sır korunamaz.`);
        }
        return finish(0, 'Sır yok; migrasyon gerekmiyor.');
    }

    try {
        const result = await store.migrateFromData(storage.data);
        await store.hydrateData(storage.data);
        storage.save();
        const removed = SecretStore.purgeSecretBackups(storage.backupDir);
        const audit = new AuditLog(storage);
        audit.append({
            actor: 'system',
            action: 'secrets_migrated',
            target: null,
            detail: `script=1; migrated=${result.migrated.length}; already=${result.alreadyEncrypted.length}; backups_removed=${removed.length}`
        });
        return finish(0, `Tamam: ${result.migrated.length} sır şifrelendi, ${result.alreadyEncrypted.length} zaten şifreliydi, ${removed.length} eski yedek silindi.`);
    } catch (err) {
        return finish(1, `HATA: ${(err && err.message) || 'bilinmeyen hata'} (${(err && err.code) || 'NO_CODE'})`);
    }
}).catch((err) => {
    finish(1, `HATA: ${(err && err.message) || 'bilinmeyen hata'}`);
});
