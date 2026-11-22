/**
 * storage.test.mjs - StorageService v3 (SQLite / WP-11)
 * Varsayılanlar, roundtrip, bozuk-JSON bakım modu, v0/v1 migrasyonu,
 * 500 geçmiş tavanı, boot dedupe ve yarım migrasyon temizliği.
 * Gerçek fs kullanılır; her test kendi temp dizininde çalışır.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import StorageService from '../../src/main/services/StorageService.js';

let dirs = [];
let services = [];

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-test-'));
    dirs.push(dir);
    return dir;
}

function open(dir) {
    const s = new StorageService(dir);
    services.push(s);
    return s;
}

afterEach(() => {
    for (const s of services.splice(0)) {
        try { s.close(); } catch (_) { /* yut */ }
    }
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('StorageService v3', () => {
    it('ilk açılışta powerpilot.db oluşturur, JSON yazmaz', () => {
        const dir = freshDir();
        const s = open(dir);
        expect(s.maintenanceMode).toBe(false);
        expect(s.getSettings().theme).toBe('dark');
        expect(s.getSettings().localApiPort).toBe(18456);
        expect(s.getTasks()).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'powerpilot_data.json'))).toBe(false);
        expect(s.getMeta('schema_version')).toBe('3');
        expect(s.data.version).toBe(3);
    });

    it('ayar + görev roundtrip (yeniden yükleme diskten okur)', () => {
        const dir = freshDir();
        const s1 = open(dir);
        s1.updateSettings({ theme: 'light', deviceWattage: 65 });
        s1.saveTasks([{ id: 't1', name: 'X' }]);
        const s2 = open(dir);
        expect(s2.getSettings().theme).toBe('light');
        expect(s2.getSettings().deviceWattage).toBe(65);
        expect(s2.getTasks()).toHaveLength(1);
        expect(s2.getTasks()[0].name).toBe('X');
    });

    it('bozuk JSON bakım moduna alır, kaynağı DEĞİŞTİRMEZ, yedek alır (T-STO-03)', () => {
        const dir = freshDir();
        const jsonPath = path.join(dir, 'powerpilot_data.json');
        const raw = '{bozuk json!!!';
        fs.writeFileSync(jsonPath, raw, 'utf8');
        const s = open(dir);
        expect(s.maintenanceMode).toBe(true);
        expect(s.maintenanceReason).toMatch(/parse/i);
        expect(s.getTasks()).toEqual([]);
        expect(fs.readFileSync(jsonPath, 'utf8')).toBe(raw);
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(false);
        const backups = fs.readdirSync(path.join(dir, 'backups'));
        expect(backups.some((f) => f.includes('corrupted'))).toBe(true);
        // bakım modunda yazma reddedilir
        expect(s.save()).toBe(false);
    });

    it('sürüm 0 verisi v3 SQLite\'a migrate edilir; kaynak sırsız .migrated olur', () => {
        const dir = freshDir();
        const jsonPath = path.join(dir, 'powerpilot_data.json');
        fs.writeFileSync(jsonPath, JSON.stringify({
            version: 0,
            tasks: [{ id: 'eski' }],
            history: [{ id: 'h1', action: 'shutdown' }],
            settings: { theme: 'light', consoleAgentKey: 'duz-anahtar', localApiKeyPem: 'PEM' },
            webhooks: [{ url: 'https://x/y', bearerToken: 'gizli' }]
        }), 'utf8');
        const s = open(dir);
        expect(s.maintenanceMode).toBe(false);
        expect(s.data.version).toBe(3);
        expect(s.getTasks()).toHaveLength(1);
        expect(s.getHistory()).toHaveLength(1);
        expect(s.getSettings().theme).toBe('light');
        expect(fs.existsSync(path.join(dir, 'powerpilot.db'))).toBe(true);
        expect(fs.existsSync(jsonPath)).toBe(false);
        const migrated = JSON.parse(fs.readFileSync(`${jsonPath}.migrated`, 'utf8'));
        expect(migrated.settings.consoleAgentKey).toBeNull();
        expect(migrated.settings.localApiKeyPem).toBeNull();
        expect(migrated.webhooks[0].bearerToken).toBeUndefined();
        expect(s.getMeta('migrated_from')).toBe('json-v2');
        const backups = fs.readdirSync(path.join(dir, 'backups'));
        expect(backups.some((f) => f.includes('pre_v3'))).toBe(true);
    });

    it('geçmiş 500 kayıtla sınırlanır', () => {
        const s = open(freshDir());
        for (let i = 0; i < 505; i++) s.addHistoryRecord({ id: `h${i}` });
        expect(s.getHistory()).toHaveLength(500);
        expect(s.getHistory()[0].id).toBe('h504');
    }, 30000);

    it('addTask günceller, removeTask siler', () => {
        const s = open(freshDir());
        s.addTask({ id: 'a', name: 'v1' });
        s.addTask({ id: 'a', name: 'v2' });
        expect(s.getTasks()).toHaveLength(1);
        expect(s.getTasks()[0].name).toBe('v2');
        s.removeTask('a');
        expect(s.getTasks()).toHaveLength(0);
    });

    it('webhook roundtrip', () => {
        const dir = freshDir();
        const s = open(dir);
        s.saveWebhooks([{ id: 'w1', url: 'https://x/y', enabled: true }]);
        expect(s.getWebhooks()).toHaveLength(1);
        const s2 = open(dir);
        expect(s2.getWebhooks()[0].url).toBe('https://x/y');
    });

    it('yeni profilde watt/fiyat null + unset başlar (WBS-E1)', () => {
        const s = open(freshDir());
        expect(s.getSettings().deviceWattage).toBeNull();
        expect(s.getSettings().electricityCostPerKwh).toBeNull();
        expect(s.getSettings().wattSource).toBe('unset');
        expect(s.getSettings().priceSource).toBe('unset');
    });

    it('birebir eski varsayılan çifti korunur + legacy işaretlenir (WBS-E1)', () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify({
            version: 1,
            settings: { deviceWattage: 150, electricityCostPerKwh: 2.5 }
        }), 'utf8');
        const s = open(dir);
        expect(s.getSettings().deviceWattage).toBe(150);
        expect(s.getSettings().electricityCostPerKwh).toBe(2.5);
        expect(s.getSettings().wattSource).toBe('legacy');
        expect(s.getSettings().priceSource).toBe('legacy');
    });

    it('kullanıcı değeri manual sayılır, sıfırlanmaz', () => {
        const dir = freshDir();
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify({
            version: 1,
            settings: { deviceWattage: 200, electricityCostPerKwh: 3.24 }
        }), 'utf8');
        const s = open(dir);
        expect(s.getSettings().deviceWattage).toBe(200);
        expect(s.getSettings().wattSource).toBe('manual');
        expect(s.getSettings().priceSource).toBe('manual');
    });

    it('template roundtrip (WBS-6.4)', () => {
        const dir = freshDir();
        const s = open(dir);
        expect(s.getTemplates()).toEqual([]);
        s.saveTemplates([{ id: 'user_tpl_1', name: 'Benimki' }]);
        expect(s.getTemplates()).toHaveLength(1);
        const s2 = open(dir);
        expect(s2.getTemplates()[0].id).toBe('user_tpl_1');
    });

    it('yarım kalmış migrasyon geçici dosyaları açılışta temizlenir (K7)', () => {
        const dir = freshDir();
        const staleDb = path.join(dir, 'powerpilot.db.migrating-999-dead');
        const staleJson = path.join(dir, '.powerpilot_data.json.99999.tmp');
        fs.writeFileSync(staleDb, 'yarım');
        fs.writeFileSync(staleJson, 'yarım');
        const s = open(dir);
        expect(fs.existsSync(staleDb)).toBe(false);
        expect(fs.existsSync(staleJson)).toBe(false);
        expect(s.getSettings().theme).toBe('dark');
    });

    it('boot kayıtları dakika anahtarıyla tekilleşir (T-STO-06)', () => {
        const s = open(freshDir());
        const base = Date.parse('2026-10-20T10:00:00.000Z');
        expect(s.appendBoot(new Date(base).toISOString())).toBe(true);
        expect(s.appendBoot(new Date(base + 20_000).toISOString())).toBe(true);
        expect(s.getBootHistory()).toHaveLength(1);
        expect(s.appendBoot(new Date(base + 60_000).toISOString())).toBe(true);
        expect(s.getBootHistory()).toHaveLength(2);
    });
});
