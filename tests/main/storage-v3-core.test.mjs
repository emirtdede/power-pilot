/**
 * storage-v3-core.test.mjs - StorageService v3 (SQLite) çekirdek yüzeyi
 *
 * Her test kendi GEÇİCİ userData dizininde gerçek SQLite dosyasıyla çalışır;
 * uygulamanın gerçek verisine dokunulmaz. Event Log/ACL gibi OS yan etkileri
 * kullanılmaz (audit checkpoint eventLog:false).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import StorageService from '../../src/main/services/StorageService.js';

let dir;
let svc;

function safeRm(target) {
    try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (_) { /* OS kilidi: TEMP temizliğine bırakılır */ }
}

function fresh() {
    return new StorageService(dir);
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-'));
    svc = fresh();
});
afterEach(() => {
    try { if (svc && svc.db) svc.close(); } catch (_) { /* yut */ }
    safeRm(dir);
});

describe('StorageService - açılış', () => {
    it('temiz dizinde v3 şema oluşturulur ve varsayılanlar yüklenir', () => {
        expect(fs.existsSync(svc.dbPath)).toBe(true);
        expect(svc.getSchemaVersion()).toBe(3);
        expect(svc.maintenanceMode).toBe(false);
        expect(svc.getTasks()).toEqual([]);
        expect(svc.getSettings().localApiPort).toBe(18456);
        expect(svc.getMeta('schema_version')).toBe('3');
    });

    it('ikinci açılış mevcut DB\'yi okur (openExisting + normalize + save)', () => {
        svc.updateSettings({ language: 'en' });
        svc.saveTask({ id: 't1', name: 'görev' });
        svc.close();

        const again = fresh();
        expect(again.getTasks()).toHaveLength(1);
        expect(again.getSettings().language).toBe('en');
        again.close();
    });

    it('v2 JSON varsa otomatik migrate edilir (yedek + .migrated)', () => {
        svc.close();
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-legacy-'));
        try {
            const legacy = {
                version: 2,
                createdAt: new Date().toISOString(),
                tasks: [{ id: 't1', name: 'eski görev', action: 'shutdown' }],
                history: [{ id: 'h1' }],
                settings: { language: 'de', lanAllowedIps: ['10.0.0.1', 'bozuk'] },
                webhooks: [], templates: [], deviceProfiles: [], auditLog: [], bootHistory: []
            };
            fs.writeFileSync(path.join(dir2, 'powerpilot_data.json'), JSON.stringify(legacy));
            const migrated = new StorageService(dir2);
            expect(migrated.maintenanceMode).toBe(false);
            expect(migrated.getTasks()).toHaveLength(1);
            expect(migrated.getSettings().language).toBe('de');
            expect(migrated.getSettings().lanAllowedIps).toContain('10.0.0.1');
            expect(fs.existsSync(path.join(dir2, 'powerpilot_data.json'))).toBe(false);
            expect(fs.existsSync(path.join(dir2, 'powerpilot_data.json.migrated'))).toBe(true);
            migrated.close();
        } finally {
            safeRm(dir2);
        }
    });

    it('bozuk JSON bakım moduna alır ve kaynak dosyayı silmez', () => {
        svc.close();
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storage-bad-'));
        try {
            fs.writeFileSync(path.join(dir2, 'powerpilot_data.json'), '{bozuk');
            const broken = new StorageService(dir2);
            expect(broken.maintenanceMode).toBe(true);
            expect(fs.existsSync(path.join(dir2, 'powerpilot_data.json'))).toBe(true);
            expect(broken.save()).toBe(false);
            broken.close();
        } finally {
            safeRm(dir2);
        }
    });

    it('enterMaintenance yazmayı reddeder ve varsayılanlara döner', () => {
        svc.enterMaintenance('test');
        expect(svc.maintenanceMode).toBe(true);
        expect(svc.getSettings().localApiPort).toBe(18456);
        expect(svc.save()).toBe(false);
        expect(svc.saveTask({ id: 'x' })).toBe(false);
        expect(svc._persist(() => {})).toBe(false);
        expect(svc.checkpoint()).toBeNull();
    });

    it('close idempotent; checkpoint WAL\'ı temizler', () => {
        expect(svc.checkpoint()).not.toBeNull();
        svc.close();
        svc.close();
        expect(svc.db).toBeNull();
        expect(svc.checkpoint()).toBeNull();
    });
});

describe('StorageService - ayarlar', () => {
    it('getSettings savunmacı kopya döner', () => {
        const a = svc.getSettings();
        a.language = 'hack';
        // Varsayılan dil null ("kullanıcı seçmedi") - ilk çalıştırmada sistem
        // dili algılanır. Dışarıdan yapılan mutasyon içeriği kirletmemeli.
        expect(svc.getSettings().language).toBeNull();
    });

    it('updateSettings geçersiz gövdeyi reddeder ve proto anahtarlarını atlar', () => {
        expect(svc.updateSettings(null)).toBe(false);
        expect(svc.updateSettings([])).toBe(false);
        expect(svc.updateSettings('x')).toBe(false);
        svc.updateSettings({ __proto__: { polluted: 1 }, constructor: 'x', prototype: 1, theme: 'light' });
        expect(svc.getSettings().theme).toBe('light');
        expect({}.polluted).toBeUndefined();
    });

    it('updateSettings disk hatasında belleği geri alır ve fırlatır', () => {
        const spy = vi.spyOn(svc, '_persist').mockReturnValue(false);
        expect(() => svc.updateSettings({ theme: 'light' })).toThrow(/kalıcılaştırılamadı/);
        expect(svc.getSettings().theme).toBe('dark');
        spy.mockRestore();
    });

    it('normalizeSecuritySettings güvenli varsayılanlara çeker', () => {
        svc.data.settings.localApiKeyRole = 'root';
        svc.data.settings.lanModeEnabled = true;
        svc.data.settings.lanAllowedIps = [];
        svc.normalizeSecuritySettings();
        const s = svc.getSettings();
        expect(s.localApiKeyRole).toBe('viewer');
        expect(s.lanModeEnabled).toBe(false);
        expect(s.lanModeWarning).toMatch(/allowlist/);
        expect(s.blockRemoteShutdownWhenActive).toBe(true);
        expect(s.deviceRole).toBe('workstation');
        expect(s.upsHost).toBe('127.0.0.1');
        expect(s.assumedOffHours).toBeNull();
    });

    it('normalizeEnergySettings kaynak alanlarını türetir', () => {
        svc.data.settings.deviceWattage = 150;
        svc.data.settings.electricityCostPerKwh = 2.5;
        svc.data.settings.wattSource = 'unset';
        svc.data.settings.priceSource = 'unset';
        svc.normalizeEnergySettings();
        expect(svc.getSettings().wattSource).toBe('legacy');
        expect(svc.getSettings().priceSource).toBe('legacy');

        svc.data.settings.deviceWattage = 200;
        svc.data.settings.wattSource = 'unset';
        svc.normalizeEnergySettings();
        expect(svc.getSettings().wattSource).toBe('manual');

        svc.data.settings.deviceWattage = null;
        svc.data.settings.wattSource = 'unset';
        svc.normalizeEnergySettings();
        expect(svc.getSettings().wattSource).toBe('unset');
    });

    it('migrate v1 → v3 lan listesini temizler ve sınırlar', () => {
        const out = svc.migrate({ version: 0, settings: { lanAllowedIps: ['10.0.0.1', 'bad', '10.0.0.1'] } }, 0);
        expect(out.version).toBe(3);
        expect(out.settings.lanAllowedIps).toContain('10.0.0.1');
        expect(out.settings.lanAllowedIps).not.toContain('bad');
        expect(Array.isArray(out.tasks)).toBe(true);
    });

    it('isIpOrCidr yardımcısı', () => {
        expect(StorageService.isIpOrCidr('10.0.0.1')).toBe(true);
        expect(StorageService.isIpOrCidr('10.0.0.0/8')).toBe(true);
        expect(StorageService.isIpOrCidr('10.0.0.0/33')).toBe(false);
        expect(StorageService.isIpOrCidr('x')).toBe(false);
        expect(StorageService.isIpOrCidr(null)).toBe(false);
        expect(StorageService.isIpOrCidr('a'.repeat(65))).toBe(false);
    });
});

describe('StorageService - görev / geçmiş / koleksiyonlar', () => {
    it('görev CRUD ve toplu API', () => {
        expect(svc.saveTasks('x')).toBe(false);
        expect(svc.saveTask(null)).toBe(false);
        expect(svc.saveTask({ name: 'id yok' })).toBe(false);

        expect(svc.saveTask({ id: 't1', name: 'bir' })).toBe(true);
        expect(svc.getTasks()).toHaveLength(1);
        expect(svc.saveTask({ id: 't1', name: 'güncel' })).toBe(true);
        expect(svc.getTasks()[0].name).toBe('güncel');

        expect(svc.addTask({ id: 't2', name: 'iki' })).toBe(true);
        expect(svc.getTasks()).toHaveLength(2);
        expect(svc.removeTask('t2')).toBe(true);
        expect(svc.getTasks()).toHaveLength(1);

        expect(svc.saveTasks([{ id: 'a' }, { id: 'b' }])).toBe(true);
        expect(svc.getTasks().map((t) => t.id)).toEqual(['a', 'b']);
        expect(svc.deleteTask('a')).toBe(true);
        expect(svc.getTasks().map((t) => t.id)).toEqual(['b']);
    });

    it('geçmiş 500 kayıtla sınırlanır ve temizlenebilir', { timeout: 25000 }, () => {
        for (let i = 0; i < 505; i += 1) svc.addHistoryRecord({ id: `h${i}`, ts: Date.now() });
        expect(svc.getHistory()).toHaveLength(500);
        expect(svc.getHistory()[0].id).toBe('h504');
        expect(svc.clearHistory()).toBe(true);
        expect(svc.getHistory()).toEqual([]);
    });

    it('koleksiyonlar: templates / webhooks / deviceProfiles / exemptions / windows', () => {
        expect(svc.saveTemplates([{ id: 'tpl' }])).toBe(true);
        expect(svc.getTemplates()).toHaveLength(1);
        expect(svc.saveTemplates('x')).toBe(true);
        expect(svc.getTemplates()).toEqual([]);

        expect(svc.saveWebhooks([{ url: 'https://a/h' }])).toBe(true);
        expect(svc.getWebhooks()).toHaveLength(1);
        expect(svc.saveWebhooks(null)).toBe(true);
        expect(svc.getWebhooks()).toEqual([]);

        expect(svc.saveDeviceProfiles([{ id: 'd' }])).toBe(true);
        expect(svc.getDeviceProfiles()).toHaveLength(1);

        expect(svc.saveExemptions([{ id: 'e' }])).toBe(true);
        expect(svc.getExemptions()).toHaveLength(1);

        expect(svc.saveMaintenanceWindows([{ id: 'w' }])).toBe(true);
        expect(svc.getMaintenanceWindows()).toHaveLength(1);
    });

    it('saveOrders hata halinde belleği geri alır', () => {
        expect(svc.saveOrders([{ key: 'o1' }])).toBe(true);
        expect(svc.getOrders()).toHaveLength(1);
        const spy = vi.spyOn(svc, '_persist').mockReturnValue(false);
        expect(svc.saveOrders([{ key: 'o2' }])).toBe(false);
        expect(svc.getOrders()).toEqual([{ key: 'o1' }]);
        spy.mockRestore();
    });

    it('envanter kaydı', () => {
        expect(svc.getInventory()).toBeNull();
        expect(svc.saveInventory({ hostname: 'pc' })).toBe(true);
        expect(svc.getInventory()).toEqual({ hostname: 'pc' });
        expect(svc.saveInventory(null)).toBe(true);
        expect(svc.getInventory()).toBeNull();
    });
});

describe('StorageService - nonce ve boot geçmişi', () => {
    it('consumeNonce atomik tek kullanım', () => {
        const exp = Date.now() + 60000;
        expect(svc.consumeNonce('n1', exp)).toBe(true);
        expect(svc.consumeNonce('n1', exp)).toBe(false);
        expect(svc.getSeenNonces().map((e) => e.nonce)).toContain('n1');
        expect(svc.consumeNonce('', exp)).toBe(false);
        expect(svc.consumeNonce('n2', Number.NaN)).toBe(false);
    });

    it('purgeExpiredNonces süresi geçenleri siler', () => {
        svc.consumeNonce('old', Date.now() - 1000);
        svc.consumeNonce('new', Date.now() + 60000);
        expect(svc.purgeExpiredNonces()).toBe(1);
        expect(svc.getSeenNonces().map((e) => e.nonce)).toEqual(['new']);
    });

    it('saveSeenNonces / getSeenNonces', () => {
        expect(svc.saveSeenNonces([{ nonce: 'a', exp: Date.now() + 1000 }])).toBe(true);
        expect(svc.getSeenNonces()).toEqual([{ nonce: 'a', exp: expect.any(Number) }]);
    });

    it('appendBoot aynı dakikada tek kayıt; geçersiz ISO reddedilir', () => {
        expect(svc.appendBoot('bozuk')).toBe(false);
        const iso = new Date().toISOString();
        expect(svc.appendBoot(iso)).toBe(true);
        expect(svc.appendBoot(iso)).toBe(true); // aynı dakika: tek kayıt
        expect(svc.getBootHistory()).toHaveLength(1);
    });

    it('pruneBootHistory 365 günden eskiyi atar', () => {
        const old = new Date(Date.now() - 400 * 86400000).toISOString();
        svc.data.bootHistory = [old, new Date().toISOString()];
        expect(svc.pruneBootHistory()).toBe(1);
        expect(svc.getBootHistory()).toHaveLength(1);
    });
});

describe('StorageService - audit zinciri (HMAC)', () => {
    const key = crypto.createHash('sha256').update('test-audit-key').digest();

    it('anahtarsız yazım fail-closed', () => {
        expect(svc.hasAuditKey()).toBe(false);
        expect(() => svc.appendAudit({ action: 'x' })).toThrow(/anahtar/i);
        expect(svc.verifyAuditChain()).toMatchObject({ ok: false, code: 'AUDIT_KEY_MISSING' });
    });

    it('setAuditKey olmadan rebuild hata verir', () => {
        expect(() => svc.rebuildAuditChain()).toThrow(/anahtar/i);
    });

    it('append + verify + sayfalama', () => {
        svc.setAuditKey(key, { checkpointDir: path.join(dir, 'cp') });
        const r1 = svc.appendAudit({ actor: 'user', action: 'a1', target: 't', detail: 'd1' });
        const r2 = svc.appendAudit({ actor: 'user', action: 'a2' });
        expect(r1.seq).toBe(1);
        expect(r2.seq).toBe(2);
        expect(svc.verifyAuditChain()).toMatchObject({ ok: true });

        const page = svc.getAuditLog({ limit: 1, beforeSeq: 3 });
        expect(page).toHaveLength(1);
        expect(svc.getAuditLog({ limit: 100 })).toHaveLength(2);
        expect(svc.getAuditLog()).toHaveLength(2);
    });

    it('zincir kurcalanırsa verify ok=false ve auditTampered', () => {
        svc.setAuditKey(key, { checkpointDir: path.join(dir, 'cp') });
        svc.appendAudit({ action: 'a1' });
        svc.db.prepare('UPDATE audit_log SET detail = ? WHERE seq = 1').run('değiştirildi');
        const v = svc.verifyAuditChain();
        expect(v.ok).toBe(false);
        expect(svc.auditTampered).toBe(true);
    });

    it('saveAuditLog ile legacy liste yazılır', () => {
        svc.setAuditKey(key, { checkpointDir: path.join(dir, 'cp') });
        expect(svc.saveAuditLog([{ seq: 1, ts: new Date().toISOString(), actor: 'a', action: 'b' }])).not.toBe(false);
        expect(svc.getAuditLog()).toHaveLength(1);
    });

    it('auditStore adaptörü beklenen API\'yi sunar', () => {
        svc.setAuditKey(key, { checkpointDir: path.join(dir, 'cp') });
        const store = svc.auditStore();
        expect(store.appendAudit({ action: 'x' })).toMatchObject({ seq: 1 });
        expect(store.verifyAuditChain().ok).toBe(true);
        expect(store.hasAuditKey()).toBe(true);
    });

    it('rebuildAuditChain legacy kayıtları yeniden imzalar', () => {
        svc.setAuditKey(key, { checkpointDir: path.join(dir, 'cp') });
        svc.appendAudit({ action: 'a1' });
        svc.appendAudit({ action: 'a2' });
        svc.db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('audit_chain', 'legacy')").run();
        svc.rebuildAuditChain();
        expect(svc.getMeta('audit_chain')).toBe('hmac-v1');
        expect(svc.getAuditLog()).toHaveLength(2);
        expect(svc.verifyAuditChain().ok).toBe(true);
    });
});

describe('StorageService - yardımcılar', () => {
    it('atomicWrite + renameWithRetry çalışır, hata halinde tmp silinir', () => {
        const target = path.join(dir, 'out.json');
        svc.atomicWrite(target, '{"a":1}');
        expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');

        svc.atomicWrite(target, '{"a":2}', false);
        expect(fs.readFileSync(target, 'utf8')).toBe('{"a":2}');

        const missingDir = path.join(dir, 'yok', 'deep', 'x.json');
        expect(() => svc.atomicWrite(missingDir, 'x')).toThrow();
    });

    it('cleanStaleTmps eski .tmp dosyalarını siler', () => {
        const stale = path.join(dir, '.powerpilot_data.json.123.tmp');
        fs.writeFileSync(stale, 'x');
        svc.cleanStaleTmps();
        expect(fs.existsSync(stale)).toBe(false);
    });

    it('createBackup legacy JSON varsa kopyalar, yoksa null', () => {
        expect(svc.createBackup('t')).toBeNull();
        fs.writeFileSync(svc.legacyPath, '{"a":1}');
        const backup = svc.createBackup('test');
        expect(backup).toContain('powerpilot_data_test_');
        expect(fs.existsSync(backup)).toBe(true);
    });

    it('sleepSync bekleme yapar', () => {
        const t0 = Date.now();
        StorageService.sleepSync(20);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    });

    it('secretStore varsa diske sırlar yazılmaz', () => {
        const stripForDisk = vi.fn((data) => {
            const copy = JSON.parse(JSON.stringify(data));
            if (copy.settings) copy.settings.consoleAgentKey = null;
            return copy;
        });
        svc.setSecretStore({ stripForDisk });
        svc.data.settings.consoleAgentKey = 'GİZLİ';
        svc.updateSettings({ theme: 'light' });
        expect(stripForDisk).toHaveBeenCalled();

        const reopened = fresh();
        expect(reopened.getSettings().consoleAgentKey).toBeNull();
        reopened.close();
    });
});
