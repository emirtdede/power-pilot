import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    UpdateService,
    compareSemver,
    parseLatestYml,
    sanitizeReleaseNotes,
    classifyErrorCode,
    RELEASE_PAGE_URL,
    STATIC_LATEST_YML_URL
} = require('../../src/main/services/UpdateService');
const { validateSettings } = require('../../src/main/ipc/validate');

class FakeAutoUpdater extends EventEmitter {
    constructor() {
        super();
        this.autoDownload = true;
        this.autoInstallOnAppQuit = true;
        this.allowPrerelease = true;
        this.allowDowngrade = true;
        this.feed = null;
        this.quitAndInstallCalls = [];
        this.checkMock = vi.fn();
        this.downloadMock = vi.fn();
    }
    setFeedURL(cfg) { this.feed = cfg; }
    async checkForUpdates() { return this.checkMock(); }
    async downloadUpdate() { return this.downloadMock(); }
    quitAndInstall(isSilent, isForceRunAfter) {
        this.quitAndInstallCalls.push({ isSilent, isForceRunAfter });
    }
}

describe('UpdateService - Yardimci Fonksiyonlar', () => {
    it('compareSemver surum karsilastirmasini dogru yapar', () => {
        expect(compareSemver('1.0.1', '1.0.0')).toBe(1);
        expect(compareSemver('v1.2.0', '1.1.9')).toBe(1);
        expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
        expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    });

    it('parseLatestYml statik latest.yml dosyasini SHA-512 ve surum notlariyla cozer', () => {
        const yml = [
            'version: 1.2.0',
            'path: Power Pilot Setup 1.2.0.exe',
            'sha512: ABCDEF123456==',
            "releaseDate: '2026-12-01T10:00:00.000Z'",
            'releaseNotes: |',
            '  <p>Yeni ozellikler:</p>',
            '  <ul><li>Delta guncelleme</li><li>OneDrive esitleme</li></ul>'
        ].join('\n');
        const parsed = parseLatestYml(yml);
        expect(parsed).toBeTruthy();
        expect(parsed.version).toBe('1.2.0');
        expect(parsed.sha512).toBe('ABCDEF123456==');
        expect(parsed.releaseNotes).toContain('Yeni ozellikler:');
        expect(parsed.releaseNotes).toContain('- Delta guncelleme');
        expect(parsed.releaseNotes).not.toContain('<p>');
        expect(parsed.releaseNotes).not.toContain('<li>');
    });

    it('sanitizeReleaseNotes HTML etiketlerini ve uzun cizgileri temizler', () => {
        const out = sanitizeReleaseNotes([{ version: '1.1.0', note: '<b>Hizli</b><br/>Test' }]);
        expect(out).toBe('v1.1.0: Hizli\nTest');
    });

    it('validateSettings autoCheckUpdates boolean ayarini kabul eder', () => {
        expect(validateSettings({ autoCheckUpdates: false }).ok).toBe(true);
        expect(validateSettings({ autoCheckUpdates: true }).ok).toBe(true);
        expect(validateSettings({ autoCheckUpdates: 'yes' }).ok).toBe(false);
    });
});

describe('UpdateService - 3 Kanal Ayrimi (Store / Portable / Direct NSIS)', () => {
    it('Microsoft Store (MSIX) modunda tamamen kapalidir; hicbir ag istegi atmaz ve electron-updater yuklemez', async () => {
        const fetchSpy = vi.fn();
        const loaderSpy = vi.fn();
        const svc = new UpdateService({
            currentVersion: '1.0.0',
            isStore: true,
            isPortable: false,
            isPackaged: true,
            fetchText: fetchSpy,
            loadAutoUpdater: loaderSpy
        });
        expect(svc.getState().mode).toBe('store');
        expect(svc.getState().status).toBe('store-managed');
        expect(svc.getState().canAutoInstall).toBe(false);

        const checkRes = await svc.checkForUpdates();
        expect(checkRes.ok).toBe(false);
        expect(checkRes.code).toBe('STORE_MANAGED');

        const dlRes = await svc.downloadUpdate();
        expect(dlRes.ok).toBe(false);
        expect(dlRes.code).toBe('STORE_MANAGED');

        const installRes = svc.installNow();
        expect(installRes.ok).toBe(false);
        expect(installRes.code).toBe('STORE_MANAGED');

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(loaderSpy).not.toHaveBeenCalled();
    });

    it('Portable modda yalnizca statik latest.yml denetler; Setup .exe indirmez veya kurmaz', async () => {
        const loaderSpy = vi.fn();
        const fetchSpy = vi.fn().mockResolvedValue(
            'version: 1.3.0\nreleaseDate: 2026-12-10T00:00:00Z\nreleaseNotes: |\n  - Portable surum hazir\n'
        );
        const svc = new UpdateService({
            currentVersion: '1.0.0',
            isStore: false,
            isPortable: true,
            isPackaged: true,
            fetchText: fetchSpy,
            loadAutoUpdater: loaderSpy
        });
        expect(svc.getState().mode).toBe('portable');
        expect(svc.getState().canAutoInstall).toBe(false);

        const res = await svc.checkForUpdates();
        expect(res.ok).toBe(true);
        expect(fetchSpy).toHaveBeenCalledWith(STATIC_LATEST_YML_URL);
        expect(res.state.status).toBe('available');
        expect(res.state.availableVersion).toBe('1.3.0');
        expect(res.state.releaseUrl).toBe(RELEASE_PAGE_URL);
        expect(res.state.releaseNotes).toContain('Portable surum hazir');

        // Portable asla Setup .exe indirip kuramaz!
        const dl = await svc.downloadUpdate();
        expect(dl.ok).toBe(false);
        expect(dl.code).toBe('PORTABLE_MANUAL_ONLY');
        const inst = svc.installNow();
        expect(inst.ok).toBe(false);
        expect(inst.code).toBe('PORTABLE_MANUAL_ONLY');
        expect(loaderSpy).not.toHaveBeenCalled();
    });

    it('Direct NSIS modda electron-updater (statik github latest.yml + delta/SHA-512), Cikista Guncelle ve Yeniden Baslat akisini yonetir', async () => {
        const fakeUpdater = new FakeAutoUpdater();
        const states = [];
        let quitHookCalled = false;

        fakeUpdater.checkMock.mockImplementation(async () => {
            const info = {
                version: '1.1.0',
                releaseDate: '2026-12-15T12:00:00Z',
                releaseNotes: '<p>SHA-512 ve delta guncelleme</p>'
            };
            fakeUpdater.emit('update-available', info);
            return { updateInfo: info };
        });
        fakeUpdater.downloadMock.mockImplementation(async () => {
            fakeUpdater.emit('download-progress', { percent: 45.2, transferred: 4500, total: 10000, bytesPerSecond: 1000 });
            fakeUpdater.emit('update-downloaded', { version: '1.1.0' });
        });

        const svc = new UpdateService({
            currentVersion: '1.0.0',
            isStore: false,
            isPortable: false,
            isPackaged: true,
            loadAutoUpdater: () => fakeUpdater,
            onStateChange: (st) => states.push(st),
            onBeforeQuitAndInstall: () => { quitHookCalled = true; }
        });

        expect(svc.getState().mode).toBe('nsis');
        expect(svc.getState().canAutoInstall).toBe(true);

        // 1. Check
        const chk = await svc.checkForUpdates();
        expect(chk.ok).toBe(true);
        expect(fakeUpdater.autoDownload).toBe(false);
        expect(fakeUpdater.autoInstallOnAppQuit).toBe(false);
        expect(fakeUpdater.feed).toMatchObject({ provider: 'github', owner: 'emirtdede', repo: 'power-pilot' });
        expect(chk.state.status).toBe('available');
        expect(chk.state.availableVersion).toBe('1.1.0');
        expect(chk.state.releaseNotes).toBe('SHA-512 ve delta guncelleme');

        // 2. Download (delta + progress)
        const dl = await svc.downloadUpdate();
        expect(dl.ok).toBe(true);
        expect(dl.state.status).toBe('downloaded');
        expect(states.some((s) => s.status === 'downloading' && s.progress && s.progress.percent === 45)).toBe(true);

        // 3. Cikista Guncelle (installOnQuit)
        const later = svc.setInstallOnQuit(true);
        expect(later.ok).toBe(true);
        expect(fakeUpdater.autoInstallOnAppQuit).toBe(true);
        expect(later.state.installOnQuit).toBe(true);

        // 4. Yeniden Baslat ve Guncelle (quitAndInstall)
        const now = svc.installNow();
        expect(now.ok).toBe(true);
        expect(quitHookCalled).toBe(true);
        expect(fakeUpdater.quitAndInstallCalls).toEqual([{ isSilent: false, isForceRunAfter: true }]);
    });

    it('ag/offline veya SHA-512 imza hatalarini guvenli hata kodlarina cevirir', async () => {
        const fakeUpdater = new FakeAutoUpdater();
        fakeUpdater.checkMock.mockRejectedValue(new Error('sha512 checksum mismatch'));
        const svc = new UpdateService({
            currentVersion: '1.0.0',
            isStore: false,
            isPortable: false,
            isPackaged: true,
            loadAutoUpdater: () => fakeUpdater
        });
        const res = await svc.checkForUpdates();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('SIGNATURE_OR_HASH_ERROR');
        expect(res.state.status).toBe('error');
    });

    it('classifyErrorCode, statik latest.yml 404/guncel dallari ve unpackaged/hatali durum gecislerini eksiksiz kapsar', async () => {
        expect(classifyErrorCode({ code: 'RATE_LIMITED' })).toBe('RATE_LIMITED');
        expect(classifyErrorCode({ message: 'HTTP 429 rate limit' })).toBe('RATE_LIMITED');
        expect(classifyErrorCode({ code: 'NO_RELEASE_METADATA' })).toBe('NO_RELEASE_METADATA');
        expect(classifyErrorCode({ message: 'ENOTFOUND github.com' })).toBe('OFFLINE_OR_NETWORK');
        expect(classifyErrorCode({ message: 'unknown failure' })).toBe('CHECK_FAILED');

        // Static latest.yml returns 404 -> treated as up-to-date
        const svc404 = new UpdateService({
            currentVersion: '1.0.0',
            isPortable: true,
            isPackaged: true,
            fetchText: vi.fn().mockRejectedValue(Object.assign(new Error('404'), { code: 'NO_RELEASE_METADATA' }))
        });
        const r404 = await svc404.checkForUpdates();
        expect(r404.ok).toBe(true);
        expect(r404.state.status).toBe('up-to-date');

        // Static latest.yml same version -> up-to-date
        const svcSame = new UpdateService({
            currentVersion: '1.0.0',
            isPortable: true,
            isPackaged: true,
            fetchText: vi.fn().mockResolvedValue('version: 1.0.0\n')
        });
        const rSame = await svcSame.checkForUpdates();
        expect(rSame.ok).toBe(true);
        expect(rSame.state.status).toBe('up-to-date');
        expect(svcSame.setInstallOnQuit(true).code).toBe('PORTABLE_MANUAL_ONLY');

        // Unpackaged dev mode guards
        const svcDev = new UpdateService({
            currentVersion: '1.0.0',
            isStore: false,
            isPortable: false,
            isPackaged: false,
            fetchText: vi.fn().mockResolvedValue('')
        });
        expect((await svcDev.checkForUpdates()).state.status).toBe('up-to-date');
        expect((await svcDev.downloadUpdate()).code).toBe('UNPACKAGED_DEV');
        expect(svcDev.installNow().code).toBe('NOT_DOWNLOADED');
    });
});
