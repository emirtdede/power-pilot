/**
 * storage-flush-migrate.test.mjs - StorageService satır yazımı ve migrasyon dalları
 * Geçici dizinde gerçek SQLite ile; OS yan etkisi yok.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import StorageService from '../../src/main/services/StorageService.js';

let dir;
let svc;

function safeRm(target) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* yut */ }
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-flush-'));
    svc = new StorageService(dir);
});
afterEach(() => {
    try { if (svc && svc.db) svc.close(); } catch (_) { /* yut */ }
    safeRm(dir);
});

describe('StorageService - save() tüm koleksiyonlar', () => {
    it('tüm tablolar tek yazımda doldurulur, ikinci yazım değişiklik üretmez', () => {
        svc.data.tasks = [{ id: 't1', status: 'scheduled', action: 'lock', createdAt: 'x' }];
        svc.data.history = [{ id: 'h1', timestamp: 'x', resultCode: 'success', action: 'lock' }];
        svc.data.templates = [{ id: 'tpl1' }];
        svc.data.webhooks = [{ id: 'wh1', url: 'https://a/h' }, { url: 'https://no-id/h' }];
        svc.data.exemptions = [{ id: 'ex1' }];
        svc.data.maintenanceWindows = [{ id: 'mw1' }];
        svc.data.deviceProfiles = [{ id: 'dp1' }];
        svc.data.orders = [{ key: 'o1', status: 'pending', order: { nonce: 'n1', expiresAt: Date.now() + 1000 } }, { order: { nonce: 'n2' } }];
        svc.data.seenNonces = [{ nonce: 'n1', exp: Date.now() + 1000 }, { nonce: 'bozuk' }];
        svc.data.inventory = { hostname: 'pc' };
        svc.data.bootHistory = [new Date().toISOString()];

        expect(svc.save()).toBe(true);
        expect(svc.save()).toBe(true);

        const count = (table) => svc.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
        expect(count('tasks')).toBe(1);
        expect(count('history')).toBe(1);
        expect(count('templates')).toBe(1);
        expect(count('webhooks')).toBe(2);
        expect(count('exemptions')).toBe(1);
        expect(count('maintenance_windows')).toBe(1);
        expect(count('device_profiles')).toBe(1);
        expect(count('orders')).toBe(2);
        expect(count('seen_nonces')).toBe(1);
        expect(count('inventory')).toBe(1);
        expect(count('boot_history')).toBe(1);
    });

    it('kayıt silme tablodan satırı kaldırır (snapshot diff)', () => {
        svc.data.templates = [{ id: 'a' }, { id: 'b' }];
        svc.save();
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM templates').get().c).toBe(2);
        svc.data.templates = [{ id: 'a' }];
        svc.save();
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM templates').get().c).toBe(1);

        svc.data.inventory = { a: 1 };
        svc.save();
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM inventory').get().c).toBe(1);
        svc.data.inventory = null;
        svc.save();
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM inventory').get().c).toBe(0);
    });

    it('id\'siz kayıtlar için sentetik anahtar kullanılır; null anahtar atlanır', () => {
        svc.data.history = [{ timestamp: 'x' }];
        svc.data.tasks = [null, { id: null }];
        expect(svc.save()).toBe(true);
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM history').get().c).toBe(1);
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c).toBe(0);
    });

    it('geçmiş 500 kayıtla sınırlanarak yazılır', () => {
        svc.data.history = Array.from({ length: 520 }, (_, i) => ({ id: `h${i}` }));
        svc.save();
        expect(svc.db.prepare('SELECT COUNT(*) AS c FROM history').get().c).toBe(500);
    });

    it('settings delete + undefined null\'a çevrilir', () => {
        svc.save();
        svc.data.settings = Object.assign({}, svc.data.settings, { extraKey: undefined, yeni: 1 });
        expect(svc.save()).toBe(true);
        const row = svc.db.prepare('SELECT json FROM settings WHERE key = ?').get('yeni');
        expect(JSON.parse(row.json)).toBe(1);
    });

    it('veritabanı kapalıyken save false döner', () => {
        svc.close();
        expect(svc.save()).toBe(false);
        expect(svc._persist(() => {})).toBe(false);
    });
});

describe('StorageService - migrasyon dalları', () => {
    it('v0 → v3 tüm koleksiyonlar ve varsayılanlar', () => {
        const out = svc.migrate({ version: 0, history: [{ id: 'h' }], webhooks: [{ url: 'https://a' }] }, 0);
        expect(out.version).toBe(3);
        expect(out.tasks).toEqual([]);
        expect(out.templates).toEqual([]);
        expect(out.deviceProfiles).toEqual([]);
        expect(out.settings.lanAllowedIps).toEqual([]);
    });

    it('v1 → v3 ayarlar korunur, lan listesi temizlenir', () => {
        const out = svc.migrate({ version: 1, settings: { deviceWattage: 150, lanAllowedIps: ['10.0.0.1', 'bad'] } }, 1);
        expect(out.version).toBe(3);
        expect(out.settings.deviceWattage).toBe(150);
        expect(out.settings.lanAllowedIps).toEqual(['10.0.0.1']);
    });

    it('v2 → v3 bakım pencereleri korunur, LAN güvenliğe çekilir', () => {
        const out = svc.migrate({
            version: 2,
            settings: { lanModeEnabled: true, lanAllowedIps: [] },
            maintenanceWindows: [{ id: 'w', days: [1], start: '01:00', end: '02:00' }]
        }, 2);
        expect(out.version).toBe(3);
        expect(out.maintenanceWindows).toHaveLength(1);
        svc.data.settings = out.settings;
        svc.normalizeSecuritySettings();
        expect(svc.data.settings.lanModeEnabled).toBe(false);
    });

    it('_markLegacyMigrated .migrated varsa yeniden yazmaz, JSON\'u siler', () => {
        fs.writeFileSync(svc.legacyPath, JSON.stringify({ settings: { consoleAgentKey: 'gizli' } }));
        fs.writeFileSync(`${svc.legacyPath}.migrated`, 'mevcut');
        svc._markLegacyMigrated();
        expect(fs.existsSync(svc.legacyPath)).toBe(false);
        expect(fs.readFileSync(`${svc.legacyPath}.migrated`, 'utf8')).toBe('mevcut');
    });

    it('_markLegacyMigrated bozuk JSON\'da sessiz kalır', () => {
        fs.writeFileSync(svc.legacyPath, '{bozuk');
        expect(() => svc._markLegacyMigrated()).not.toThrow();
        expect(fs.existsSync(svc.legacyPath)).toBe(true);
    });

    it('enterMaintenance hata ile çağrılabilir', () => {
        svc.enterMaintenance('sebep', new Error('kök'));
        expect(svc.maintenanceMode).toBe(true);
        expect(svc.maintenanceReason).toBe('sebep');
        expect(svc.maintenanceBackupPath).toBeNull();
    });

    it('normalizeLoaded bakım pencerelerini ve ayarları düzeltir', () => {
        svc.data.settings.localApiKeyRole = 'root';
        svc.data.settings.localApiTlsEnabled = 'yes';
        svc.data.maintenanceWindows = [{ id: 'w', name: 'w', days: [1], start: '01:00', end: '02:00' }, { id: 'bad' }];
        svc.normalizeLoaded();
        expect(svc.data.settings.localApiKeyRole).toBe('viewer');
        expect(svc.data.settings.localApiTlsEnabled).toBe(false);
        expect(Array.isArray(svc.data.maintenanceWindows)).toBe(true);
    });

    it('createBackup kopyalama hatasında null döner', () => {
        fs.mkdirSync(svc.legacyPath, { recursive: true }); // kopyalanamaz hedef
        expect(svc.createBackup('x')).toBeNull();
        fs.rmdirSync(svc.legacyPath);
    });
});
