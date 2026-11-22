import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSettings } = require('../../src/main/ipc/validate');
const JumpListService = require('../../src/main/services/JumpListService');
const {
    GlobalShortcutService,
    DEFAULT_GLOBAL_SHORTCUTS,
    normalizeGlobalAccelerator,
    isValidGlobalAccelerator
} = require('../../src/main/services/GlobalShortcutService');
const {
    OneDriveSyncService,
    detectCloudProviders
} = require('../../src/main/services/OneDriveSyncService');

function makeTempDir(prefix = 'pp-desktop-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createFakeStorage(overrides = {}) {
    const defaults = {
        theme: 'dark',
        themeId: 'obsidian',
        oneDriveConnected: false,
        oneDriveAutoSync: true,
        oneDriveCustomDir: null,
        oneDriveLastSyncAt: null,
        oneDriveRecoveryDismissed: false,
        globalShortcutsEnabled: false,
        globalShortcutToggleWindow: 'Ctrl+Alt+P',
        globalShortcutQuickStart: 'Ctrl+Alt+S',
        globalShortcutCancel: 'Ctrl+Alt+X'
    };
    const state = {
        settings: { ...defaults, ...overrides },
        tasks: [],
        history: [],
        templates: [],
        deviceProfiles: [],
        webhooks: [],
        exemptions: [],
        maintenanceWindows: []
    };
    return {
        maintenanceMode: false,
        getDefaultData: () => ({ settings: { ...defaults } }),
        getSettings: () => ({ ...state.settings }),
        updateSettings: (patch) => { state.settings = { ...state.settings, ...patch }; return true; },
        getTasks: () => state.tasks,
        getHistory: () => state.history,
        getTemplates: () => state.templates,
        getDeviceProfiles: () => state.deviceProfiles,
        getWebhooks: () => state.webhooks,
        getExemptions: () => state.exemptions,
        getMaintenanceWindows: () => state.maintenanceWindows
    };
}

describe('1. System Theme (light / dark / system)', () => {
    it('validateSettings accepts system, light, and dark themes and rejects invalid ones', () => {
        expect(validateSettings({ theme: 'system' }).ok).toBe(true);
        expect(validateSettings({ theme: 'light' }).ok).toBe(true);
        expect(validateSettings({ theme: 'dark' }).ok).toBe(true);
        expect(validateSettings({ theme: 'neon' }).ok).toBe(false);
    });

    it('theme-boot.js handles system mode via prefers-color-scheme before first paint', () => {
        const bootSrc = fs.readFileSync(path.resolve('src/renderer/theme-boot.js'), 'utf8');
        expect(bootSrc).toContain("mode === 'system'");
        expect(bootSrc).toContain('prefers-color-scheme: dark');
    });
});

describe('2. Windows Taskbar Jump List (JumpListService)', () => {
    it('builds 4 localized tasks with strict --jump-action arguments', () => {
        const tasks = JumpListService.buildUserTasks({
            exePath: 'C:\\Program Files\\Power Pilot\\Power Pilot.exe',
            iconPath: 'C:\\Program Files\\Power Pilot\\icon.ico',
            translate: (k) => `TR:${k}`
        });
        expect(tasks).toHaveLength(4);
        expect(tasks.map((t) => t.arguments)).toEqual([
            '--jump-action=sleep-30',
            '--jump-action=shutdown-60',
            '--jump-action=lock-15',
            '--jump-action=cancel-active'
        ]);
        expect(tasks[0].title).toBe('TR:jumpSleep30Title');
    });

    it('registers user tasks on win32 and skips gracefully on non-win32', () => {
        let received = null;
        const appRef = { setUserTasks: (list) => { received = list; } };
        const winRes = JumpListService.registerJumpList({
            appRef,
            exePath: 'C:\\PowerPilot.exe',
            iconPath: 'C:\\icon.ico',
            platform: 'win32'
        });
        expect(winRes.ok).toBe(true);
        expect(winRes.count).toBe(4);
        expect(received).toHaveLength(4);

        const linuxRes = JumpListService.registerJumpList({
            appRef,
            exePath: '/usr/bin/powerpilot',
            platform: 'linux'
        });
        expect(linuxRes.ok).toBe(false);
        expect(linuxRes.skipped).toBe(true);
    });

    it('parseJumpActionArgv accepts only whitelisted actions and rejects arbitrary flags', () => {
        expect(JumpListService.parseJumpActionArgv(['app.exe', '--jump-action=sleep-30'])).toBe('sleep-30');
        expect(JumpListService.parseJumpActionArgv(['app.exe', '--jump-action', 'cancel-active'])).toBe('cancel-active');
        expect(JumpListService.parseJumpActionArgv(['app.exe', '--jump-action=rm-rf'])).toBeNull();
        expect(JumpListService.parseJumpActionArgv(['app.exe', '--minimized'])).toBeNull();
    });
});

describe('3. Global Keyboard Shortcuts (GlobalShortcutService)', () => {
    it('validates and normalizes accelerators requiring at least one modifier', () => {
        expect(normalizeGlobalAccelerator('Ctrl+Alt+P')).toBe('Control+Alt+P');
        expect(normalizeGlobalAccelerator('Ctrl+Shift+F9')).toBe('Control+Shift+F9');
        expect(isValidGlobalAccelerator('Alt+Space')).toBe(true);
        expect(isValidGlobalAccelerator('P')).toBe(false);
        expect(isValidGlobalAccelerator('Ctrl+Ctrl+P')).toBe(false);
        expect(isValidGlobalAccelerator('Ctrl+InvalidKey!')).toBe(false);

        expect(validateSettings({
            globalShortcutsEnabled: true,
            globalShortcutToggleWindow: 'Ctrl+Alt+P',
            globalShortcutQuickStart: 'Ctrl+Alt+S',
            globalShortcutCancel: 'Ctrl+Alt+X'
        }).ok).toBe(true);
        expect(validateSettings({ globalShortcutToggleWindow: 'Escape' }).ok).toBe(false);
    });

    it('stays unregistered when disabled, reports OS conflicts, and unregisters cleanly', () => {
        const active = new Map();
        const fakeGs = {
            register: (acc, fn) => {
                if (acc === 'Control+Alt+S') return false; // simulate OS conflict
                active.set(acc, fn);
                return true;
            },
            unregister: (acc) => { active.delete(acc); }
        };
        const svc = new GlobalShortcutService({ globalShortcut: fakeGs });

        const off = svc.apply({ globalShortcutsEnabled: false }, {
            toggleWindow: () => {},
            quickStart: () => {},
            cancel: () => {}
        });
        expect(off.enabled).toBe(false);
        expect(active.size).toBe(0);

        let toggled = 0;
        const on = svc.apply({
            globalShortcutsEnabled: true,
            globalShortcutToggleWindow: DEFAULT_GLOBAL_SHORTCUTS.toggleWindow,
            globalShortcutQuickStart: DEFAULT_GLOBAL_SHORTCUTS.quickStart,
            globalShortcutCancel: DEFAULT_GLOBAL_SHORTCUTS.cancel
        }, {
            toggleWindow: () => { toggled += 1; },
            quickStart: () => {},
            cancel: () => {}
        });
        expect(on.enabled).toBe(true);
        expect(on.registered).toHaveLength(2);
        expect(on.failed).toHaveLength(1);
        expect(on.failed[0].reason).toBe('CONFLICT');

        active.get('Control+Alt+P')();
        expect(toggled).toBe(1);

        svc.unregisterAll();
        expect(active.size).toBe(0);
    });
});

describe('4. Multi-Cloud Folder Auto-Detection (OneDrive / Google Drive / Dropbox / iCloud)', () => {
    let tmpDir;
    beforeEach(() => { tmpDir = makeTempDir(); });
    afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });

    it('detects OneDrive, Google Drive, Dropbox (via info.json), and iCloud Drive and switches safely', () => {
        const od = path.join(tmpDir, 'OneDrive');
        const gd = path.join(tmpDir, 'GoogleDrive');
        const dbx = path.join(tmpDir, 'MyDropbox');
        const ic = path.join(tmpDir, 'iCloudDrive');
        const localAppData = path.join(tmpDir, 'LocalAppData');
        fs.mkdirSync(od, { recursive: true });
        fs.mkdirSync(gd, { recursive: true });
        fs.mkdirSync(dbx, { recursive: true });
        fs.mkdirSync(ic, { recursive: true });
        fs.mkdirSync(path.join(localAppData, 'Dropbox'), { recursive: true });
        fs.writeFileSync(
            path.join(localAppData, 'Dropbox', 'info.json'),
            JSON.stringify({ personal: { path: dbx } }),
            'utf8'
        );

        const env = {
            OneDriveConsumer: od,
            GOOGLE_DRIVE_DIR: gd,
            LOCALAPPDATA: localAppData,
            ICLOUD_DRIVE_DIR: ic
        };
        const providers = detectCloudProviders(env, tmpDir);
        expect(providers.map((p) => p.id)).toEqual(['onedrive', 'gdrive', 'dropbox', 'icloud']);

        const storage = createFakeStorage();
        const svc = new OneDriveSyncService({
            storageService: storage,
            userDataDir: path.join(tmpDir, 'userData'),
            env,
            homedir: tmpDir
        });
        const switched = svc.useDetectedProvider('dropbox');
        expect(switched.ok).toBe(true);
        expect(switched.status.activeProviderId).toBe('dropbox');
        expect(switched.status.syncDir).toBe(path.join(dbx, 'PowerPilot'));

        const bad = svc.useDetectedProvider('../evil');
        expect(bad.ok).toBe(false);
    });
});

describe('5. WinGet v1.6.0 Manifest Pack', () => {
    it('contains all 4 valid manifest files with real SHA-256 and zero em-dashes', () => {
        const base = path.resolve('packaging/winget/manifests/v/Vellium/PowerPilot/1.0.0');
        const files = [
            'Vellium.PowerPilot.yaml',
            'Vellium.PowerPilot.installer.yaml',
            'Vellium.PowerPilot.locale.en-US.yaml',
            'Vellium.PowerPilot.locale.tr-TR.yaml'
        ];
        for (const f of files) {
            const full = path.join(base, f);
            expect(fs.existsSync(full), `Missing manifest: ${f}`).toBe(true);
            const txt = fs.readFileSync(full, 'utf8');
            expect(txt).toContain('PackageIdentifier: Vellium.PowerPilot');
            expect(txt).toContain('ManifestVersion: 1.6.0');
            expect(txt.includes('\u2014')).toBe(false);
        }
        const installerTxt = fs.readFileSync(path.join(base, 'Vellium.PowerPilot.installer.yaml'), 'utf8');
        expect(installerTxt).toMatch(/InstallerSha256:\s+[A-F0-9]{64}/);
    });
});
