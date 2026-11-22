/**
 * Bozuk veri kurtarma - "program bozuk, hiçbir şey yapamıyorum" senaryosu.
 *
 * Bulgu (P1): bozuk `powerpilot.db` veya bozuk eski `powerpilot_data.json`
 * durumunda uygulama açılıyor ama HİÇBİR görev oluşturulamıyordu
 * ("Task could not be created") ve kullanıcıya çıkış yolu gösterilmiyordu.
 * Kullanıcı için bu "program bozuk" demekti; tek çıkış veri klasörünü elle
 * silmekti.
 *
 * Düzeltme: bozuk dosya SİLİNMEZ, `quarantine/` altına taşınır; uygulama
 * temiz depoyla açılır ve kullanılabilir olur. Eski JSON yolu zaten
 * `backups/powerpilot_data_corrupted_*.json` yedeği alır.
 *
 * Ölçüm (öncesi - scratch/probe-corrupt-data.cjs):
 *   bozuk DB   → görev oluşturma false, karantina yok
 *   bozuk JSON → uygulama kullanılamaz, yedek yok
 * Ölçüm (sonrası): 9/9 PASS - görev oluşturma true, karantina + yedek mevcut.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const StorageRecovery = require('../../src/main/services/StorageRecovery');

let dir;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-recovery-'));
});

afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* kilit */ }
});

describe('StorageRecovery.quarantineDatabase', () => {
    it('bozuk DB dosyasını SİLMEZ, karantinaya taşır', () => {
        const dbPath = path.join(dir, 'powerpilot.db');
        fs.writeFileSync(dbPath, 'BU BOZUK BIR SQLITE DEGIL');

        const out = StorageRecovery.quarantineDatabase(dbPath);

        expect(out.quarantined).toBeTruthy();
        expect(fs.existsSync(dbPath), 'kaynak yol boşaltılmalı').toBe(false);
        expect(fs.existsSync(out.quarantined), 'karantina dosyası var').toBe(true);
        expect(path.dirname(out.quarantined)).toBe(path.join(dir, 'quarantine'));
        // İçerik korunmuş olmalı (veri kurtarma umudu).
        expect(fs.readFileSync(out.quarantined, 'utf8')).toContain('BOZUK');
    });

    it('WAL/SHM artıklarını temizler', () => {
        const dbPath = path.join(dir, 'powerpilot.db');
        fs.writeFileSync(dbPath, 'bozuk');
        fs.writeFileSync(`${dbPath}-wal`, 'wal');
        fs.writeFileSync(`${dbPath}-shm`, 'shm');

        const out = StorageRecovery.quarantineDatabase(dbPath);

        expect(out.removedSidecars.length).toBe(2);
        expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
        expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    });

    it('dosya yoksa hata fırlatmaz, null döner', () => {
        const out = StorageRecovery.quarantineDatabase(path.join(dir, 'yok.db'));
        expect(out.quarantined).toBeNull();
    });

    it('art arda karantina adı çakışmaz', () => {
        const dbPath = path.join(dir, 'powerpilot.db');
        fs.writeFileSync(dbPath, 'birinci');
        const a = StorageRecovery.quarantineDatabase(dbPath);
        fs.writeFileSync(dbPath, 'ikinci');
        const b = StorageRecovery.quarantineDatabase(dbPath);

        expect(a.quarantined).not.toBe(b.quarantined);
        expect(fs.existsSync(a.quarantined) && fs.existsSync(b.quarantined)).toBe(true);
        expect(fs.readFileSync(b.quarantined, 'utf8')).toContain('ikinci');
    });

    it('geçersiz dbPath reddedilir', () => {
        expect(() => StorageRecovery.quarantineDatabase('')).toThrow();
        expect(() => StorageRecovery.quarantineDatabase(null)).toThrow();
    });
});

describe('StorageRecovery.listBackups', () => {
    it('yalnızca .db.enc yedeklerini yeniden eskiye sıralar', () => {
        const backupDir = path.join(dir, 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const mk = (name, mtimeMs) => {
            const p = path.join(backupDir, name);
            fs.writeFileSync(p, 'x');
            fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
            return p;
        };
        mk('powerpilot_2026-01-01.db.enc', 1000);
        mk('powerpilot_2026-01-02.db.enc', 2000);
        fs.writeFileSync(path.join(backupDir, 'baska.json'), 'x');

        const list = StorageRecovery.listBackups(backupDir);

        expect(list.length).toBe(2);
        expect(list[0].name).toBe('powerpilot_2026-01-02.db.enc');
        expect(list[1].name).toBe('powerpilot_2026-01-01.db.enc');
    });

    it('dizin yoksa boş dizi döner', () => {
        expect(StorageRecovery.listBackups(path.join(dir, 'yok'))).toEqual([]);
    });
});

describe('StorageService - kurtarma yolu bağlı', () => {
    const svc = fs.readFileSync(
        path.join(here, '../../src/main/services/StorageService.js'),
        'utf8'
    );

    it('quick_check başarısızlığında kurtarma çağrılır (bakım modu değil)', () => {
        expect(svc).toMatch(/if \(check !== 'ok'\) \{[\s\S]*?recoverCorruptDatabase\(check\)/);
    });

    it('new Db açılış hatası da kurtarma yoluna gider', () => {
        // Bozuk dosya quickCheck'ten önce hata verir; yakalanmazsa kullanıcı kilitlenir.
        expect(svc).toMatch(/catch \(err\) \{[\s\S]*?recoverCorruptDatabase\(err && err\.code \? err\.code : 'DB_OPEN_FAILED'\)/);
    });

    it('T-STO-03 sözleşmesi korunur: bozuk eski JSON kaynağı DEĞİŞTİRİLMEZ', () => {
        // Bilinçli karar: eski JSON kullanıcı verisidir; taşınmaz, silinmez.
        // Kilitlenme yerine bakım modunda "veri klasörünü aç" çıkışı sunulur.
        expect(svc).not.toMatch(/LEGACY_JSON_CORRUPT/);
        expect(svc).toMatch(/enterMaintenance\(result\.error/);
    });

    it('bakım modunda kullanıcıya çıkış yolu sunulur (veri klasörünü aç)', () => {
        const htmlSrc = fs.readFileSync(path.join(here, '../../src/index.html'), 'utf8');
        const appSrc = fs.readFileSync(path.join(here, '../../src/renderer/app.js'), 'utf8');
        expect(htmlSrc).toContain('id="btn-storage-open-folder"');
        expect(appSrc).toMatch(/btn-storage-open-folder[\s\S]{0,400}openDataFolder/);
        // Gerekçe dinamik (ipucu + durum) → dil değişiminde yeniden çizilir.
        expect(appSrc).toMatch(/renderStorageWarning\(\)/);
    });

    it('kurtarma bildirimi yolu tek tıkla açar (düğme gerçek IPC çağırır)', () => {
        const htmlSrc = fs.readFileSync(path.join(here, '../../src/index.html'), 'utf8');
        const appSrc = fs.readFileSync(path.join(here, '../../src/renderer/app.js'), 'utf8');
        expect(htmlSrc).toContain('id="btn-storage-recovered-folder"');
        expect(appSrc).toMatch(/btn-storage-recovered-folder[\s\S]{0,420}openDataFolder/);
        // Düğme etiketi çeviri anahtarından gelir; ikon dekoratif.
        expect(htmlSrc).toMatch(/btn-storage-recovered-folder[\s\S]{0,700}data-i18n="openDataFolder"/);
    });

    it('kurtarma bildirimi kapatılabilir ve kapatma yeniden çizimde korunur', () => {
        const htmlSrc = fs.readFileSync(path.join(here, '../../src/index.html'), 'utf8');
        const appSrc = fs.readFileSync(path.join(here, '../../src/renderer/app.js'), 'utf8');
        expect(htmlSrc).toContain('id="btn-storage-recovered-close"');
        // Erişilebilir ad mevcut sözlükten (yeni anahtar eklemeye gerek yok).
        expect(htmlSrc).toMatch(/btn-storage-recovered-close[\s\S]{0,400}data-i18n-aria-label="modalClose"/);
        expect(appSrc).toMatch(/storageRecoveryDismissed\s*=\s*true/);
        // Çizici kapalı durumu dikkate alır: dil değişimi bildirimi geri getirmez.
        expect(appSrc).toMatch(/if \(!rec \|\| storageRecoveryDismissed\)/);
    });

    it('karantina başarısız olursa sessiz veri kaybı yok → bakım modu', () => {
        expect(svc).toMatch(/Karantina başarısız; bakım modu:/);
    });

    it('kurtarma nedeni kullanıcıya raporlanabilir (recoveredFrom)', () => {
        expect(svc).toMatch(/this\.recoveredFrom = \{/);
        expect(svc).toMatch(/quarantinePath/);
    });
});
