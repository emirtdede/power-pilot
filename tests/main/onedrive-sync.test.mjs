/**
 * onedrive-sync.test.mjs - Sunucusuz Microsoft OneDrive bulut yedekleme,
 * atomik yazma + Windows kilit korumasi, 15 gunluk surum rotasyonu, bozuk dosya
 * kurtarma zinciri, bos yerel veri korumasi, format sonrasi kurtarma ve kapanis flush.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const StorageService = require('../../src/main/services/StorageService');
const {
    OneDriveSyncService,
    detectOneDriveRoot,
    validateDirectoryPath,
    atomicWriteFile,
    SYNC_FILE,
    PREVIOUS_FILE,
    DAILY_PREFIX,
    MAX_DAILY_BACKUPS
} = require('../../src/main/services/OneDriveSyncService');

const tmpDirs = [];
function freshDir(prefix = 'pp-od-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* yut */ }
    }
});

describe('1. OneDrive klasor algilama, guvenlik ve baglanti/kesme dongusu', () => {
    it('Windows ortam degiskenlerini OneDriveConsumer -> OneDrive -> OneDriveCommercial -> ~/OneDrive sirasiyla algilar', () => {
        const consumer = freshDir('pp-od-consumer-');
        const generic = freshDir('pp-od-generic-');
        const commercial = freshDir('pp-od-commercial-');
        const fakeHome = freshDir('pp-od-home-');
        const homeOd = path.join(fakeHome, 'OneDrive');
        fs.mkdirSync(homeOd, { recursive: true });

        expect(detectOneDriveRoot(
            { OneDriveConsumer: consumer, OneDrive: generic, OneDriveCommercial: commercial },
            fakeHome
        )).toEqual({ found: true, rootDir: path.resolve(consumer), source: 'OneDriveConsumer' });

        expect(detectOneDriveRoot(
            { OneDrive: generic, OneDriveCommercial: commercial },
            fakeHome
        )).toEqual({ found: true, rootDir: path.resolve(generic), source: 'OneDrive' });

        expect(detectOneDriveRoot(
            { OneDriveCommercial: commercial },
            fakeHome
        )).toEqual({ found: true, rootDir: path.resolve(commercial), source: 'OneDriveCommercial' });

        expect(detectOneDriveRoot({}, fakeHome))
            .toEqual({ found: true, rootDir: path.resolve(homeOd), source: 'homedir' });

        const emptyHome = freshDir('pp-od-emptyhome-');
        expect(detectOneDriveRoot({}, emptyHome))
            .toEqual({ found: false, rootDir: null, source: 'local-fallback' });
    });

    it('OneDrive yoksa userData altinda guvenli yerel yedek klasorune duser ve ozel klasor secimini destekler', () => {
        const ud = freshDir('pp-od-ud-');
        const emptyHome = freshDir('pp-od-no-od-');
        const customDir = freshDir('pp-od-custom-');
        const storage = new StorageService(ud);
        try {
            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: {},
                homedir: emptyHome
            });
            const st = svc.getStatus();
            expect(st.isOneDriveDetected).toBe(false);
            expect(st.isFallback).toBe(true);
            expect(st.syncDir).toBe(path.join(ud, 'onedrive-backup'));

            // Path traversal ve goreli yollar reddedilir.
            expect(validateDirectoryPath('../evil').ok).toBe(false);
            expect(validateDirectoryPath('C:\\Temp\\..\\Windows').ok).toBe(false);
            expect(validateDirectoryPath('relative/dir').ok).toBe(false);
            expect(svc.setCustomDirectory('../evil').ok).toBe(false);

            // Gecerli ozel klasor kabul edilir ve geri sifirlanabilir.
            const setRes = svc.setCustomDirectory(customDir);
            expect(setRes.ok).toBe(true);
            expect(setRes.status.isCustomDir).toBe(true);
            expect(setRes.status.syncDir).toBe(path.resolve(customDir));

            const resetRes = svc.setCustomDirectory(null);
            expect(resetRes.ok).toBe(true);
            expect(resetRes.status.isCustomDir).toBe(false);
        } finally {
            storage.close();
        }
    });

    it('baglan -> esitle -> kes dongusu sirasinda sirlari bulut JSON dosyasina yazmaz', () => {
        const ud = freshDir('pp-od-cycle-ud-');
        const odRoot = freshDir('pp-od-cycle-root-');
        const storage = new StorageService(ud);
        try {
            storage.updateSettings({
                themeId: 'purple',
                uiZoom: 125,
                cancelPinHash: 'secret-argon2-hash',
                localApiKeyPem: 'PRIVATE-KEY-NEVER-CLOUD'
            });
            storage.saveTask({ id: 't1', name: 'Nightly Sleep', action: 'sleep', status: 'scheduled' });
            storage.saveWebhooks([{ id: 'w1', url: 'https://example.com/hook', secret: 'super-secret-token' }]);

            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDriveConsumer: odRoot },
                homedir: odRoot
            });

            const conn = svc.connect();
            expect(conn.ok).toBe(true);
            expect(conn.action).toBe('synced');
            expect(conn.status.connected).toBe(true);
            expect(conn.status.syncDir).toBe(path.join(odRoot, 'PowerPilot'));

            const raw = fs.readFileSync(path.join(odRoot, 'PowerPilot', SYNC_FILE), 'utf8');
            const parsed = JSON.parse(raw);
            expect(parsed.app).toBe('Power Pilot');
            expect(parsed.provider).toBe('OneDrive');
            expect(typeof parsed.exportedAt).toBe('string');
            expect(parsed.data.settings.themeId).toBe('purple');
            expect(parsed.data.settings.uiZoom).toBe(125);
            expect(parsed.data.settings.cancelPinHash).toBeUndefined();
            expect(parsed.data.settings.localApiKeyPem).toBeUndefined();
            expect(parsed.data.webhooks[0].secret).toBeUndefined();
            expect(parsed.data.tasks).toHaveLength(1);

            const disc = svc.disconnect();
            expect(disc.ok).toBe(true);
            expect(disc.status.connected).toBe(false);
            // Baglanti kesilince yedek dosyasi silinmez.
            expect(fs.existsSync(path.join(odRoot, 'PowerPilot', SYNC_FILE))).toBe(true);
        } finally {
            storage.close();
        }
    });
});

describe('2. Atomik yazma, Windows EBUSY/EPERM kilit korumasi, previous.json ve 15 gunluk rotasyon', () => {
    it('renameSync EBUSY/EPERM verdiginde copyFileSync yedegine duser ve .tmp-<pid> dosyasini temizler', () => {
        const dir = freshDir('pp-od-lock-');
        const target = path.join(dir, SYNC_FILE);
        const tmpExpected = `${target}.tmp-4242`;

        let renameAttempts = 0;
        let copyUsed = false;
        const lockedFs = {
            mkdirSync: (...a) => fs.mkdirSync(...a),
            writeFileSync: (...a) => fs.writeFileSync(...a),
            renameSync: () => {
                renameAttempts += 1;
                const err = new Error('resource busy');
                err.code = 'EBUSY';
                throw err;
            },
            copyFileSync: (src, dst) => {
                copyUsed = true;
                return fs.copyFileSync(src, dst);
            },
            existsSync: (...a) => fs.existsSync(...a),
            unlinkSync: (...a) => fs.unlinkSync(...a)
        };

        const res = atomicWriteFile(target, '{"ok":true}', lockedFs, 4242);
        expect(res.method).toBe('copy-fallback');
        expect(res.lockCode).toBe('EBUSY');
        expect(renameAttempts).toBe(1);
        expect(copyUsed).toBe(true);
        expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true}');
        expect(fs.existsSync(tmpExpected)).toBe(false);
    });

    it('her yazim oncesinde previous.json saklar ve yalnizca en guncel 15 gunluk yedegi tutar', () => {
        const ud = freshDir('pp-od-rot-ud-');
        const odRoot = freshDir('pp-od-rot-root-');
        const storage = new StorageService(ud);
        try {
            let currentDate = new Date('2026-01-01T10:00:00.000Z');
            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDrive: odRoot },
                homedir: odRoot,
                nowFn: () => new Date(currentDate.getTime())
            });

            // 18 farkli gun boyunca yazim simule et -> en yeni 15 gun kalmali.
            for (let day = 1; day <= 18; day++) {
                currentDate = new Date(Date.UTC(2026, 0, day, 12, 0, 0));
                storage.updateSettings({ defaultMinutes: 10 + day });
                const res = svc.syncNow({ force: true });
                expect(res.ok).toBe(true);
            }

            const syncDir = path.join(odRoot, 'PowerPilot');
            const daily = svc.listDailyBackups(syncDir);
            expect(daily).toHaveLength(MAX_DAILY_BACKUPS);
            expect(daily[0]).toBe(`${DAILY_PREFIX}2026-01-18.json`);
            expect(daily[daily.length - 1]).toBe(`${DAILY_PREFIX}2026-01-04.json`);
            // 1, 2 ve 3 Ocak otomatik temizlenmis olmali.
            expect(fs.existsSync(path.join(syncDir, `${DAILY_PREFIX}2026-01-01.json`))).toBe(false);
            expect(fs.existsSync(path.join(syncDir, `${DAILY_PREFIX}2026-01-03.json`))).toBe(false);

            // previous.json bir onceki (17. gun) gecerli ana dosyayi tasimali.
            const prevParsed = JSON.parse(fs.readFileSync(path.join(syncDir, PREVIOUS_FILE), 'utf8'));
            const currParsed = JSON.parse(fs.readFileSync(path.join(syncDir, SYNC_FILE), 'utf8'));
            expect(currParsed.data.settings.defaultMinutes).toBe(28);
            expect(prevParsed.data.settings.defaultMinutes).toBe(27);
        } finally {
            storage.close();
        }
    });
});

describe('3. Bozuk dosya kurtarma zinciri (sync.json -> previous.json -> gunluk yedek)', () => {
    it('sync.json bozuksa previous.json dosyasina, o da bozuksa en yeni gunluk yedege sessizce duser', () => {
        const ud = freshDir('pp-od-corrupt-ud-');
        const odRoot = freshDir('pp-od-corrupt-root-');
        const storage = new StorageService(ud);
        try {
            let day = 1;
            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDrive: odRoot },
                homedir: odRoot,
                nowFn: () => new Date(Date.UTC(2026, 2, day, 12, 0, 0))
            });

            storage.updateSettings({ themeId: 'emerald', uiZoom: 110 });
            svc.syncNow({ force: true });

            day = 2;
            storage.updateSettings({ themeId: 'indigo', uiZoom: 125 });
            svc.syncNow({ force: true });

            const syncDir = path.join(odRoot, 'PowerPilot');
            // 1) Ana sync.json yari yazilmis / bozuk JSON olsun -> previous.json (emerald) okunmali.
            fs.writeFileSync(path.join(syncDir, SYNC_FILE), '{"app":"Power Pilot","broken":', 'utf8');
            const fallbackPrev = svc.readLatestValidBackup(syncDir);
            expect(fallbackPrev.ok).toBe(true);
            expect(fallbackPrev.sourceFile).toBe(PREVIOUS_FILE);
            expect(fallbackPrev.recoveredFromFallback).toBe(true);
            expect(fallbackPrev.snapshot.data.settings.themeId).toBe('emerald');

            // 2) previous.json da bozuk olsun -> en yeni gunluk yedek (2026-03-02, indigo) okunmali.
            fs.writeFileSync(path.join(syncDir, PREVIOUS_FILE), 'NOT_JSON!!!', 'utf8');
            const fallbackDaily = svc.readLatestValidBackup(syncDir);
            expect(fallbackDaily.ok).toBe(true);
            expect(fallbackDaily.sourceFile).toBe(`${DAILY_PREFIX}2026-03-02.json`);
            expect(fallbackDaily.recoveredFromFallback).toBe(true);
            expect(fallbackDaily.snapshot.data.settings.themeId).toBe('indigo');
        } finally {
            storage.close();
        }
    });
});

describe('4. Veri kaybi onleme, format sonrasi geri yukleme, debounce ve kapanis flush', () => {
    it('bos yerel durum dolu OneDrive yedegini ASLA ezmez; format sonrasi kurtarma tetiklenir ve atomik geri yuklenir', () => {
        const oldUd = freshDir('pp-od-old-ud-');
        const newUd = freshDir('pp-od-fresh-ud-');
        const odRoot = freshDir('pp-od-format-root-');

        // Eski PC: dolu veri + OneDrive yedegi olustur.
        const oldStorage = new StorageService(oldUd);
        try {
            oldStorage.updateSettings({
                themeId: 'cyan',
                customThemeColor: '#06b6d4',
                uiZoom: 125,
                onboardingCompleted: true,
                deviceWattage: 180
            });
            oldStorage.saveTask({ id: 'task-render', name: 'Render Bitince Kapat', action: 'shutdown', status: 'scheduled' });
            oldStorage.saveTemplates([{ id: 'tpl-custom', name: 'Gece Modu', action: 'sleep' }]);
            oldStorage.saveDeviceProfiles([{ id: 'dev-1', name: 'Office PC', mac: 'AA:BB:CC:DD:EE:FF' }]);
            oldStorage.addHistoryRecord({ id: 'h-1', action: 'sleep', resultCode: 'executed', timestamp: '2026-03-10T20:00:00.000Z' });

            const oldSvc = new OneDriveSyncService({
                storageService: oldStorage,
                userDataDir: oldUd,
                env: { OneDriveConsumer: odRoot },
                homedir: odRoot
            });
            expect(oldSvc.connect().ok).toBe(true);
        } finally {
            oldStorage.close();
        }

        // Format sonrasi yeni temiz PC: yerel DB bos/varsayilan (yalnizca kurulum dili atanmis olsa bile).
        const newStorage = new StorageService(newUd);
        try {
            newStorage.updateSettings({ language: 'tr' });
            const newSvc = new OneDriveSyncService({
                storageService: newStorage,
                userDataDir: newUd,
                env: { OneDriveConsumer: odRoot },
                homedir: odRoot
            });

            // Format sonrasi kurtarma penceresi tetiklenmeli.
            const status = newSvc.getStatus();
            expect(status.isLocalEmpty).toBe(true);
            expect(status.hasRemoteBackup).toBe(true);
            expect(status.shouldPromptRecovery).toBe(true);

            // Bos yerel durum uzerine yazma korumasi (force=false).
            const blocked = newSvc.syncNow({ force: false });
            expect(blocked.ok).toBe(false);
            expect(blocked.skipped).toBe(true);
            expect(blocked.code).toBe('EMPTY_LOCAL_PROTECTED');

            // "OneDrive Bagla" bos yerelde once geri yukleme yapar (ezmez!).
            const connected = newSvc.connect();
            expect(connected.ok).toBe(true);
            expect(connected.action).toBe('restored');
            expect(newStorage.getSettings().themeId).toBe('cyan');
            expect(newStorage.getSettings().uiZoom).toBe(125);
            expect(newStorage.getSettings().deviceWattage).toBe(180);
            expect(newStorage.getSettings().oneDriveConnected).toBe(true);
            expect(newStorage.getTasks()).toHaveLength(1);
            expect(newStorage.getTemplates()).toHaveLength(1);
            expect(newStorage.getDeviceProfiles()).toHaveLength(1);
            expect(newStorage.getHistory()).toHaveLength(1);
        } finally {
            newStorage.close();
        }
    });

    it('Yeni Baslangic Yap (dismissRecovery) mevcut OneDrive yedegine dokunmadan temiz baslatir', () => {
        const odRoot = freshDir('pp-od-dismiss-root-');
        const syncDir = path.join(odRoot, 'PowerPilot');
        fs.mkdirSync(syncDir, { recursive: true });
        const remoteSnap = {
            app: 'Power Pilot',
            version: '1.0.0',
            schemaVersion: 1,
            provider: 'OneDrive',
            exportedAt: '2026-03-10T12:00:00.000Z',
            data: { settings: { themeId: 'red', onboardingCompleted: true }, tasks: [{ id: 't9', action: 'lock' }] }
        };
        fs.writeFileSync(path.join(syncDir, SYNC_FILE), JSON.stringify(remoteSnap), 'utf8');

        const ud = freshDir('pp-od-dismiss-ud-');
        const storage = new StorageService(ud);
        try {
            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDrive: odRoot },
                homedir: odRoot
            });
            expect(svc.getStatus().shouldPromptRecovery).toBe(true);
            svc.dismissRecovery();
            expect(svc.getStatus().shouldPromptRecovery).toBe(false);
            // Yedek dosyasi bozulmadan yerinde duruyor.
            const stillThere = JSON.parse(fs.readFileSync(path.join(syncDir, SYNC_FILE), 'utf8'));
            expect(stillThere.data.tasks[0].id).toBe('t9');
        } finally {
            storage.close();
        }
    });

    it('debounce + kapanis flush() bekleyen son degisikligi aninda esitler ve hatalari yutar', async () => {
        const ud = freshDir('pp-od-debounce-ud-');
        const odRoot = freshDir('pp-od-debounce-root-');
        const storage = new StorageService(ud);
        try {
            const svc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDrive: odRoot },
                homedir: odRoot,
                debounceMs: 250
            });
            storage.setChangeListener((r) => svc.scheduleAutoSync(r));
            storage.updateSettings({ themeId: 'blue' });
            expect(svc.connect().ok).toBe(true);

            // Hizli art arda degisiklik -> hemen yazilmaz, flush() ile kapanista kesin yazilir.
            storage.updateSettings({ defaultMinutes: 45 });
            storage.updateSettings({ defaultMinutes: 90 });
            const flushed = svc.flush();
            expect(flushed.ok).toBe(true);
            expect(flushed.flushed).toBe(true);

            const written = JSON.parse(fs.readFileSync(path.join(odRoot, 'PowerPilot', SYNC_FILE), 'utf8'));
            expect(written.data.settings.defaultMinutes).toBe(90);

            // Arka plan hatasi kullanici islemini bloklamaz.
            const brokenSvc = new OneDriveSyncService({
                storageService: storage,
                userDataDir: ud,
                env: { OneDrive: odRoot },
                homedir: odRoot,
                debounceMs: 10,
                fs: {
                    ...fs,
                    mkdirSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
                }
            });
            expect(() => brokenSvc.scheduleAutoSync('settings')).not.toThrow();
            const res = brokenSvc.flush();
            expect(res.ok).toBe(false);
            expect(res.code).toBe('ENOSPC');
        } finally {
            storage.close();
        }
    });
});
