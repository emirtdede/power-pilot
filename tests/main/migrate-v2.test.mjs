/**
 * migrate-v2.test.mjs - v2 JSON → v3 SQLite migrasyonu
 * Gerçek dosyalar GEÇİCİ dizinde; hedef DB gerçek SQLite. Uygulama verisi yok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    migrateV2,
    sanitizeLegacyData,
    expectedCounts,
    cleanStaleTemps,
    validateMigratedTarget,
    stableStringify,
    contentChecksum,
    fileSha256,
    LEGACY_FILE
} from '../../src/main/storage/MigrateV2.js';
import { Db } from '../../src/main/storage/Database.js';

let dir;
const safeRm = (t) => { try { fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ } };

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-migrate-')); });
afterEach(() => safeRm(dir));

/** Şemayı hedef DB'ye yazan minimal writer (StorageService._writeAll yerine). */
function writeAll(db, data) {
    db.prepare('INSERT OR REPLACE INTO settings(key, json, updated_at) VALUES (?, ?, ?)').run('theme', JSON.stringify(data.settings && data.settings.theme), new Date().toISOString());
    for (const t of data.tasks || []) {
        db.prepare('INSERT OR REPLACE INTO tasks(id, status, action, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
            .run(t.id, t.status || null, t.action || null, t.createdAt || null, t.updatedAt || null, JSON.stringify(t));
    }
    for (const h of data.history || []) {
        db.prepare('INSERT OR REPLACE INTO history(id, timestamp, result_code, action, data) VALUES (?, ?, ?, ?, ?)')
            .run(h.id, h.timestamp || null, h.resultCode || null, h.action || null, JSON.stringify(h));
    }
    for (const b of data.bootHistory || []) {
        db.prepare('INSERT OR REPLACE INTO boot_history(boot_key, boot_at, recorded_at) VALUES (?, ?, ?)')
            .run(Math.floor(new Date(b).getTime() / 60000), b, new Date().toISOString());
    }
    const collections = [
        ['templates', data.templates],
        ['webhooks', data.webhooks],
        ['exemptions', data.exemptions],
        ['maintenance_windows', data.maintenanceWindows],
        ['device_profiles', data.deviceProfiles]
    ];
    for (const [table, list] of collections) {
        (list || []).forEach((item, i) => {
            db.prepare(`INSERT OR REPLACE INTO ${table}(row_id, id, updated_at, data) VALUES (?, ?, ?, ?)`)
                .run(String((item && item.id) || `${table}_${i}`), (item && item.id) || null, new Date().toISOString(), JSON.stringify(item));
        });
    }
    for (const [i, o] of (data.orders || []).entries()) {
        db.prepare('INSERT OR REPLACE INTO orders(key, nonce, state, expires_at, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(String((o && o.key) || `order_${i}`), null, 'pending', null, new Date().toISOString(), new Date().toISOString(), JSON.stringify(o));
    }
    for (const rec of data.auditLog || []) {
        db.prepare('INSERT OR REPLACE INTO audit_log(seq, ts, actor, action, target, detail, prev_hmac, record_hmac, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(rec.seq || 1, rec.ts || new Date().toISOString(), rec.actor || 'system', rec.action || 'x', rec.target || null, rec.detail || null, 'GENESIS', rec.hash || '', new Date().toISOString());
    }
}

const legacyData = () => ({
    version: 2,
    createdAt: new Date().toISOString(),
    tasks: [{ id: 't1', name: 'g', action: 'shutdown', status: 'scheduled' }],
    history: [{ id: 'h1', timestamp: new Date().toISOString() }],
    settings: { theme: 'dark', consoleAgentKey: 'GİZLİ', localApiKeyPem: 'PEM' },
    webhooks: [{ url: 'https://a/h', hmacSecret: 's' }],
    bootHistory: [new Date().toISOString()],
    templates: [], deviceProfiles: [], auditLog: []
});

function writeLegacy(data = legacyData()) {
    const file = path.join(dir, LEGACY_FILE);
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
}

describe('MigrateV2 - saf yardımcılar', () => {
    it('stableStringify deterministik', () => {
        expect(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
        expect(stableStringify(null)).toBe('null');
        expect(stableStringify([])).toBe('[]');
    });

    it('sanitizeLegacyData sırları temizler, iş verisini korur', () => {
        const clean = sanitizeLegacyData(legacyData());
        expect(clean.settings.consoleAgentKey).toBeNull();
        expect(clean.settings.localApiKeyPem).toBeNull();
        expect(clean.settings.theme).toBe('dark');
        expect(clean.webhooks[0].hmacSecret).toBeUndefined();
        expect(clean.tasks).toHaveLength(1);
        expect(sanitizeLegacyData(null)).toBeNull();
    });

    it('expectedCounts koleksiyonları sayar, bozuk boot ISO atlanır', () => {
        const counts = expectedCounts({
            tasks: [{ id: 'a' }, {}],
            history: [{}, {}],
            templates: [],
            webhooks: [{}],
            exemptions: [],
            maintenanceWindows: [],
            deviceProfiles: [],
            orders: [],
            auditLog: [],
            bootHistory: [new Date().toISOString(), 'bozuk', new Date().toISOString()]
        });
        expect(counts.tasks).toBe(1);
        expect(counts.history).toBe(2);
        expect(counts.webhooks).toBe(1);
        expect(counts.bootHistory).toBe(1);
        expect(expectedCounts(null).tasks).toBe(0);
    });

    it('cleanStaleTemps yarım kalan geçici dosyaları siler', () => {
        const target = path.join(dir, 'powerpilot.db');
        const staleA = `${target}.migrating-123-abcd`;
        const staleB = path.join(dir, `.${path.basename(target)}.migrating-999`);
        fs.writeFileSync(staleA, 'x');
        fs.writeFileSync(staleB, 'y');
        fs.writeFileSync(path.join(dir, 'kalsin.txt'), 'z');
        expect(cleanStaleTemps(target)).toBe(2);
        expect(fs.existsSync(staleA)).toBe(false);
        expect(fs.existsSync(staleB)).toBe(false);
        expect(fs.existsSync(path.join(dir, 'kalsin.txt'))).toBe(true);
        expect(cleanStaleTemps(path.join(dir, 'olmayan', 'db'))).toBe(0);
    });

    it('contentChecksum deterministik (sıra bağımsız)', () => {
        expect(contentChecksum({ a: 1, b: 2 })).toBe(contentChecksum({ b: 2, a: 1 }));
        expect(contentChecksum({ a: 1 })).not.toBe(contentChecksum({ a: 2 }));
    });

    it('bozuk hedef DB okunamaz olarak reddedilir', () => {
        const target = path.join(dir, 'bad.db');
        fs.writeFileSync(target, 'bozuk');
        // Doğrulama migrateV2 içinde çalışır: hedef sağlamsızsa bakım modu döner.
        fs.writeFileSync(path.join(dir, LEGACY_FILE), JSON.stringify(legacyData()));
        const out = migrateV2({ userDataPath: dir, writeAll, dbPath: target });
        expect(out.status).toBe('maintenance');
        expect(String(out.code || '')).toMatch(/^MIGRATION_TARGET_/);
    });
});

describe('MigrateV2 - migrateV2', () => {
    it('yazıcı yoksa StorageError', () => {
        expect(() => migrateV2({ userDataPath: dir })).toThrow();
    });

    it('kaynak yoksa no-source', () => {
        expect(migrateV2({ userDataPath: dir, writeAll })).toEqual({ status: 'no-source' });
    });

    it('bozuk JSON: yedek alınır, üzerine yazılmaz, bakım modu', () => {
        const file = path.join(dir, LEGACY_FILE);
        fs.writeFileSync(file, '{bozuk');
        const out = migrateV2({ userDataPath: dir, writeAll });
        expect(out.status).toBe('maintenance');
        expect(out.error).toMatch(/JSON parse/);
        expect(fs.readFileSync(file, 'utf8')).toBe('{bozuk');
        expect(fs.existsSync(out.backupPath)).toBe(true);
    });

    it('dizi kökü de bakım moduna alır', () => {
        fs.writeFileSync(path.join(dir, LEGACY_FILE), '[]');
        expect(migrateV2({ userDataPath: dir, writeAll }).status).toBe('maintenance');
    });

    it('başarılı migrasyon: DB + .migrated + yedek + kaynak silinir', () => {
        const file = writeLegacy();
        const out = migrateV2({ userDataPath: dir, writeAll, normalize: (d) => ({ ...d, version: 3 }) });
        expect(out.status).toBe('migrated');
        expect(out.counts.tasks).toBe(1);
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(true);
        expect(fs.existsSync(`${file}.migrated`)).toBe(true);
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(out.backupPath)).toBe(true);

        const migrated = fs.readFileSync(`${file}.migrated`, 'utf8');
        expect(migrated).not.toContain('GİZLİ');
        expect(migrated).not.toContain('PEM');

        const db = new Db(path.join(dir, 'powerpilot.db'));
        try {
            expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(1);
            expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value).toBe('3');
            expect(db.prepare("SELECT value FROM meta WHERE key = 'migrated_from'").get().value).toBe('json-v2');
        } finally { db.close(); }
    });

    it('hedef zaten bu kaynaktan sağlam üretilmişse korunur (yarım kalan rename)', () => {
        const file = writeLegacy();
        const first = migrateV2({ userDataPath: dir, writeAll });
        expect(first.status).toBe('migrated');

        // Kaynağı yeniden oluştur (rename yapılamadı senaryosu) ve tekrar çalıştır.
        const raw = JSON.parse(fs.readFileSync(first.backupPath, 'utf8'));
        fs.writeFileSync(file, JSON.stringify(raw));
        const second = migrateV2({ userDataPath: dir, writeAll });
        expect(second.status).toBe('migrated');
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(true);
    });

    it('hedef farklı kaynaktan ise bakım modu (üzerine yazmaz)', () => {
        const file = writeLegacy();
        fs.writeFileSync(path.join(dir, 'powerpilot.db'), '');
        const other = new Db(path.join(dir, 'powerpilot.db'));
        try {
            other.sql(Db.schemaSql());
            other.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '3');
        } finally { other.close(); }
        const out = migrateV2({ userDataPath: dir, writeAll });
        expect(out.status).toBe('maintenance');
        expect(out.code).toBe('MIGRATION_TARGET_SOURCE');
        expect(fs.existsSync(file)).toBe(true);
    });

    it('sayım uyuşmazlığı MIGRATION_COUNT_MISMATCH üretir ve hedef yazılmaz', () => {
        writeLegacy();
        const out = migrateV2({ userDataPath: dir, writeAll: () => { /* hiçbir şey yazma */ } });
        expect(out.status).toBe('maintenance');
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(false);
    });

    it('okuma hatası maintenance (kaynak dizin olarak açılamaz)', () => {
        fs.mkdirSync(path.join(dir, LEGACY_FILE));
        const out = migrateV2({ userDataPath: dir, writeAll });
        expect(out.status).toBe('maintenance');
        expect(out.error).toMatch(/Kaynak okunamadı/);
    });
});
