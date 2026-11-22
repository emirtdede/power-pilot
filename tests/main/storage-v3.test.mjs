/**
 * storage-v3.test.mjs - WP-11.T12
 * T-STO-01..06: delta yazma, v2 fixture migrasyonu, bozuk JSON,
 * yarım migrasyon, geri dönüş ve boot dedupe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import StorageService from '../../src/main/services/StorageService.js';
import { migrateV2 } from '../../src/main/storage/MigrateV2.js';
import { Db } from '../../src/main/storage/Database.js';

const dirs = [];
const services = [];

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-v3-'));
    dirs.push(dir);
    return dir;
}
function open(dir) {
    const s = new StorageService(dir);
    services.push(s);
    return s;
}
function writeLegacy(dir, data) {
    fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify(data), 'utf8');
}

afterEach(() => {
    for (const s of services.splice(0)) {
        try { s.close(); } catch (_) { /* yut */ }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('StorageService v3 - WP-11', () => {
    it('T-STO-01: 1000 görevden biri güncellenince yalnızca o satır yazılır', () => {
        const s = open(freshDir());
        const tasks = Array.from({ length: 1000 }, (_, i) => ({ id: `t${i}`, name: `gorev-${i}` }));
        expect(s.saveTasks(tasks)).toBe(true);
        const before = new Map(s.db.prepare('SELECT id, updated_at FROM tasks').all().map((r) => [r.id, r.updated_at]));
        const next = tasks.map((t) => (t.id === 't500' ? { ...t, name: 'guncel' } : t));
        expect(s.saveTasks(next)).toBe(true);
        const changed = s.db.prepare('SELECT id, updated_at FROM tasks').all()
            .filter((r) => r.updated_at !== before.get(r.id));
        expect(changed).toHaveLength(1);
        expect(changed[0].id).toBe('t500');
        expect(s.getTasks().find((t) => t.id === 't500').name).toBe('guncel');
    });

    it('T-STO-02: v2 fixture tüm koleksiyonları ve ayarları korur', () => {
        const dir = freshDir();
        writeLegacy(dir, {
            version: 2,
            tasks: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B' }],
            history: [{ id: 'h1', action: 'shutdown', timestamp: '2026-10-01T00:00:00.000Z' }],
            templates: [{ id: 'tpl1' }],
            webhooks: [{ id: 'w1', url: 'https://example.test/h' }],
            exemptions: [{ id: 'e1', deviceId: 'pc1', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
            maintenanceWindows: [{ id: 'm1', days: [1], start: '23:00', end: '02:00' }],
            deviceProfiles: [{ id: 'd1', host: 'pc1' }],
            orders: [{ key: 'o1', order: { nonce: 'n1' }, status: 'pending' }],
            auditLog: [{ seq: 1, ts: '2026-10-01T00:00:00.000Z', actor: 'system', action: 'test', target: null, detail: '' }],
            bootHistory: ['2026-10-01T00:00:00.000Z', '2026-10-01T00:00:30.000Z', '2026-10-02T00:00:00.000Z'],
            settings: { theme: 'light', deviceWattage: 75, lanModeEnabled: false }
        });
        const s = open(dir);
        expect(s.maintenanceMode).toBe(false);
        expect(s.getTasks()).toHaveLength(2);
        expect(s.getHistory()).toHaveLength(1);
        expect(s.getTemplates()).toHaveLength(1);
        expect(s.getWebhooks()).toHaveLength(1);
        expect(s.getExemptions()).toHaveLength(1);
        expect(s.getMaintenanceWindows()).toHaveLength(1);
        expect(s.getDeviceProfiles()).toHaveLength(1);
        expect(s.getOrders()).toHaveLength(1);
        expect(s.getAuditLog()).toHaveLength(1);
        // Aynı dakikadaki iki boot tekilleşir.
        expect(s.getBootHistory()).toHaveLength(2);
        expect(s.getSettings().deviceWattage).toBe(75);
        expect(s.getSettings().theme).toBe('light');
        expect(s.db.quickCheck()).toBe('ok');
        expect(s.getMeta('schema_version')).toBe('3');
    });

    it('T-STO-03: bozuk JSON → bakım modu, kaynak korunur, yedek yazılır', () => {
        const dir = freshDir();
        const source = path.join(dir, 'powerpilot_data.json');
        fs.writeFileSync(source, '{"bozuk":', 'utf8');
        const s = open(dir);
        expect(s.maintenanceMode).toBe(true);
        expect(fs.readFileSync(source, 'utf8')).toBe('{"bozuk":');
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(false);
        const backups = fs.readdirSync(path.join(dir, 'backups'));
        expect(backups.some((b) => b.startsWith('powerpilot_data_corrupted_'))).toBe(true);
        expect(s.save()).toBe(false);
    });

    it('T-STO-04: yarım migrasyon artığı temizlenir, JSON korunur ve ikinci deneme başarılı olur', () => {
        const dir = freshDir();
        writeLegacy(dir, { version: 2, tasks: [{ id: 't1' }], settings: {} });
        fs.writeFileSync(path.join(dir, 'powerpilot.db.migrating-999-dead'), 'yarim-db');
        fs.writeFileSync(path.join(dir, '.powerpilot_data.json.999.tmp'), 'yarim-json');
        const s = open(dir);
        expect(s.maintenanceMode).toBe(false);
        expect(s.getTasks()).toHaveLength(1);
        expect(fs.existsSync(path.join(dir, 'powerpilot.db.migrating-999-dead'))).toBe(false);
        expect(fs.existsSync(path.join(dir, '.powerpilot_data.json.999.tmp'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json.migrated'))).toBe(true);
    });

    it('T-STO-05: migrasyon sonrası .migrated geri konunca veri okunur (eski ikili senaryosu)', () => {
        const dir = freshDir();
        writeLegacy(dir, {
            version: 2,
            tasks: [{ id: 't1', name: 'kritik' }],
            history: [{ id: 'h1', action: 'shutdown', timestamp: '2026-10-01T00:00:00.000Z' }],
            settings: { theme: 'light' }
        });
        const s1 = open(dir);
        expect(s1.getTasks()).toHaveLength(1);
        s1.close();
        // Eski ikiliye dönüş: DB'yi kaldır, .migrated'ı JSON yap.
        fs.rmSync(path.join(dir, 'powerpilot.db'), { force: true });
        for (const suffix of ['-wal', '-shm']) {
            fs.rmSync(path.join(dir, `powerpilot.db${suffix}`), { force: true });
        }
        fs.copyFileSync(path.join(dir, 'powerpilot_data.json.migrated'), path.join(dir, 'powerpilot_data.json'));
        const s2 = open(dir);
        expect(s2.getTasks()).toHaveLength(1);
        expect(s2.getTasks()[0].name).toBe('kritik');
        expect(s2.getHistory()).toHaveLength(1);
        expect(s2.getSettings().theme).toBe('light');
    });

    it('T-STO-06: aynı boot 100 kez → 1 kayıt; 365 gün sınırı', () => {
        const s = open(freshDir());
        const boot = '2026-10-20T10:00:00.000Z';
        for (let i = 0; i < 100; i += 1) {
            expect(s.appendBoot(new Date(Date.parse(boot) + i * 100).toISOString())).toBe(true);
        }
        expect(s.getBootHistory()).toHaveLength(1);
        const old = new Date(Date.now() - 400 * 86400000).toISOString();
        s.appendBoot(old);
        expect(s.getBootHistory()).toHaveLength(1);
        expect(s.db.prepare('SELECT COUNT(*) AS n FROM boot_history').get().n).toBe(1);
    });
});

/**
 * Y-10: hedef DB zaten varsa yalnızca bu kaynağa ait ve sağlam olduğu
 * doğrulandıktan sonra korunur. Doğrulanamayan hedef yüzünden kaynak JSON
 * silinmez / `.migrated` işaretlenmez.
 */
function writeLegacyData(dir, data) {
    fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify(data), 'utf8');
}

function runMigration(dir) {
    return migrateV2({
        userDataPath: dir,
        writeAll: (db, data) => {
            for (const task of Array.isArray(data.tasks) ? data.tasks : []) {
                if (!task || !task.id) continue;
                db.prepare('INSERT INTO tasks(id, status, action, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)')
                    .run(task.id, task.status || null, task.action || null, task.createdAt || null,
                        new Date().toISOString(), JSON.stringify(task));
            }
        }
    });
}

function migrationTemps(dir) {
    return fs.readdirSync(dir).filter((name) => name.includes('.migrating-'));
}

describe('StorageService v3 - Y-10 hedef DB doğrulaması', () => {
    it('aynı kaynaktan üretilmiş sağlam hedef korunur, kaynak temizlenir', () => {
        const dir = freshDir();
        const data = { version: 2, tasks: [{ id: 't1', name: 'A' }] };
        writeLegacyData(dir, data);
        expect(runMigration(dir).status).toBe('migrated');

        // JSON işaretlenemedi senaryosu: aynı kaynak yeniden konur.
        writeLegacyData(dir, data);
        const second = runMigration(dir);
        expect(second.status).toBe('migrated');
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json.migrated'))).toBe(true);
        expect(migrationTemps(dir)).toHaveLength(0);

        const db = new Db(path.join(dir, 'powerpilot.db'), { fileMustExist: true });
        try {
            expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(1);
        } finally {
            db.close();
        }
    });

    it('hedef farklı kaynaktan üretilmişse maintenance; kaynak ve hedef korunur', () => {
        const dir = freshDir();
        writeLegacyData(dir, { version: 2, tasks: [{ id: 't1', name: 'A' }] });
        expect(runMigration(dir).status).toBe('migrated');

        const secondData = { version: 2, tasks: [{ id: 't2', name: 'B' }] };
        writeLegacyData(dir, secondData);
        const res = runMigration(dir);
        expect(res.status).toBe('maintenance');
        expect(res.code).toBe('MIGRATION_TARGET_SOURCE');
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'powerpilot_data.json'), 'utf8'))).toEqual(secondData);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json.migrated'))).toBe(true);
        expect(migrationTemps(dir)).toHaveLength(0);

        const db = new Db(path.join(dir, 'powerpilot.db'), { fileMustExist: true });
        try {
            expect(db.prepare('SELECT id FROM tasks').all().map((r) => r.id)).toEqual(['t1']);
        } finally {
            db.close();
        }
    });

    it('hedefte migrasyon kaydı eksikse maintenance; kaynak korunur', () => {
        const dir = freshDir();
        const data = { version: 2, tasks: [{ id: 't1', name: 'A' }] };
        writeLegacyData(dir, data);
        expect(runMigration(dir).status).toBe('migrated');

        const db = new Db(path.join(dir, 'powerpilot.db'), { fileMustExist: true });
        try {
            db.prepare('DELETE FROM migrations WHERE id = ?').run('v2-json-to-v3');
        } finally {
            db.close();
        }

        writeLegacyData(dir, data);
        const res = runMigration(dir);
        expect(res.status).toBe('maintenance');
        expect(res.code).toBe('MIGRATION_TARGET_INCOMPLETE');
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(true);
        expect(migrationTemps(dir)).toHaveLength(0);
    });

    it('bozuk/okunamayan hedef maintenance döner; kaynak JSON silinmez', () => {
        const dir = freshDir();
        writeLegacyData(dir, { version: 2, tasks: [{ id: 't1' }] });
        const target = path.join(dir, 'powerpilot.db');
        fs.writeFileSync(target, 'bozuk-sqlite-verisi');

        const res = runMigration(dir);
        expect(res.status).toBe('maintenance');
        expect(res.code).toMatch(/^MIGRATION_TARGET_/);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json.migrated'))).toBe(false);
        expect(fs.readFileSync(target, 'utf8')).toBe('bozuk-sqlite-verisi');
        expect(migrationTemps(dir)).toHaveLength(0);
    });

    it('hedef şema sürümü uyuşmazsa maintenance', () => {
        const dir = freshDir();
        writeLegacyData(dir, { version: 2, tasks: [{ id: 't1' }] });
        const target = path.join(dir, 'powerpilot.db');
        const db = new Db(target);
        try {
            db.sql(Db.schemaSql());
            db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '2');
        } finally {
            db.close();
        }

        const res = runMigration(dir);
        expect(res.status).toBe('maintenance');
        expect(res.code).toBe('MIGRATION_TARGET_SCHEMA');
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(true);
    });
});
