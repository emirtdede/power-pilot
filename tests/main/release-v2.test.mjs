/**
 * release-v2.test.mjs — Plan v2.0 tamamlayıcı regresyon kapısı.
 *
 * Kapsam: executionClaims takma adı, süreç örnekleme bütçesi, uyarı erteleme,
 * TLS/mTLS çapraz doğrulaması, şema v2 LAN uyarısı, prototip kirlenmesi,
 * APPX publisher kapısı ve release yapılandırması.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import TaskManager from '../../src/main/services/TaskManager.js';
import WarningManager from '../../src/main/services/WarningManager.js';
import MetricCollector from '../../src/main/services/monitors/MetricCollector.js';
import StorageService from '../../src/main/services/StorageService.js';
import LocalApiService from '../../src/main/services/LocalApiService.js';
import { validateSettings, validateSecuritySettings } from '../../src/main/ipc/validate.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');
const { normalizePublisher } = require('../../scripts/build-appx.js');

const live = [];
const tempDirs = [];

afterEach(() => {
    for (const obj of live.splice(0)) {
        if (obj && obj.loopInterval) clearInterval(obj.loopInterval);
        if (obj && typeof obj.stopSampling === 'function') obj.stopSampling();
    }
    for (const d of tempDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { }
    }
});

function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-v2-'));
    tempDirs.push(dir);
    return dir;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(fn, timeoutMs = 2000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return false;
}

function makeTaskManager({ power, warning = null } = {}) {
    const storage = { getTasks: () => [], saveTask: vi.fn(), deleteTask: vi.fn(), getSettings: () => ({}) };
    const history = { record: vi.fn(), getHistory: () => [], clear: () => { } };
    const webhook = { triggerEvent: vi.fn() };
    const safety = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const tm = new TaskManager(storage, warning, safety, history, webhook, null, null, power);
    live.push(tm);
    return tm;
}

describe('WP-02 executionClaims sözleşmesi', () => {
    it('executionClaims aynı Map’tir ve claim durumu kopyalanmaz', () => {
        const tm = makeTaskManager({ power: { execute: vi.fn(async () => ({ success: true })) } });
        expect(tm.executionClaims).toBe(tm.claims);
        const task = tm.createTask({ name: 'x', action: 'lock', trigger: { type: 'duration', durationMs: 1000 } });
        const claim = tm.claimTask(task.id, 'test');
        expect(claim.ok).toBe(true);
        expect(tm.getClaimState(task.id).token).toBe(claim.token);
        tm.releaseTask(task.id, claim.token);
        expect(tm.getClaimState(task.id)).toBeNull();
    });

    it('process_running koşulu yokken süreç tüketicisi yoktur', () => {
        const tm = makeTaskManager({ power: { execute: vi.fn() } });
        tm.createTask({
            name: 'zaman', action: 'lock', trigger: { type: 'duration', durationMs: 1000 },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage', thresholdPercent: 10 }] }
        });
        expect(tm.hasProcessConditions()).toBe(false);
        tm.createTask({
            name: 'süreç', action: 'lock', trigger: { type: 'duration', durationMs: 1000 },
            conditionGroup: { operator: 'AND', conditions: [{ type: 'process_running', processName: 'chrome.exe' }] }
        });
        expect(tm.hasProcessConditions()).toBe(true);
    });

    it('uyarı açıkken erteleme görevi yeniden zamanlar', async () => {
        const power = { execute: vi.fn(async () => ({ success: true })) };
        const history = { record: vi.fn(), getHistory: () => [], clear: () => { } };
        const warning = new WarningManager(history);
        const tm = makeTaskManager({ power, warning });
        const task = tm.createTask({
            name: 'uyarı', action: 'shutdown',
            warningConfig: { enabled: true, durationSeconds: 30 },
            trigger: { type: 'duration', durationMs: 1000 }
        });

        const running = tm.executeTask(task);
        expect(await waitFor(() => warning.getActiveState()?.taskId === task.id)).toBe(true);
        const before = Date.now();
        const result = tm.snoozeTask(task.id, 7);
        await running;

        expect(result).toMatchObject({ ok: true, code: 'SNOOZED_ACTIVE', minutes: 7 });
        // P1-6 (üçüncü tur): erteleme artık gerçek ve GÖRÜNÜR bir durumdur.
        // Eskiden `snoozed` durumu hiç atanmadığı için görev "scheduled"
        // görünüyordu; artık listede "Ertelendi" olarak görünür.
        expect(task.status).toBe('snoozed');
        expect(task.trigger.targetTime).toBeGreaterThanOrEqual(before + 7 * 60000 - 1000);
        expect(warning.getActiveState()).toBeNull();
        expect(power.execute).not.toHaveBeenCalled();
    });
});

describe('WP-16 süreç örnekleme bütçesi', () => {
    it('tüketici yoksa veya aralık dolmadıysa örneklemez', async () => {
        let now = 1_000;
        let calls = 0;
        const mc = new MetricCollector({
            sampleIntervalMs: 60 * 60 * 1000,
            processSampleIntervalMs: 5000,
            needsProcessList: () => false,
            processProvider: async () => { calls += 1; return [{ name: 'chrome' }]; },
            now: () => now
        });
        live.push(mc);
        expect(mc.shouldSampleProcesses()).toBe(false);

        const enabled = new MetricCollector({
            sampleIntervalMs: 60 * 60 * 1000,
            processSampleIntervalMs: 5000,
            needsProcessList: () => true,
            processProvider: async () => { calls += 1; return [{ name: 'chrome' }]; },
            now: () => now
        });
        live.push(enabled);
        expect(enabled.shouldSampleProcesses()).toBe(true);
        await enabled.sampleProcesses();
        expect(calls).toBe(1);
        expect(enabled.shouldSampleProcesses()).toBe(false);

        now += 5001;
        expect(enabled.shouldSampleProcesses()).toBe(true);
        await enabled.sampleProcesses();
        expect(calls).toBe(2);
    });
});

describe('WP-10 ayar çapraz doğrulaması', () => {
    it('mTLS ve sıkı TLS, TLS olmadan reddedilir', () => {
        expect(validateSecuritySettings({ localApiRequireClientCert: true }, {}).code)
            .toBe('MTLS_REQUIRES_TLS');
        expect(validateSecuritySettings({ localApiTlsStrict: true }, {}).code)
            .toBe('TLS_STRICT_REQUIRES_TLS');
        expect(validateSecuritySettings({ localApiTlsEnabled: true, localApiRequireClientCert: true }, {}).ok)
            .toBe(true);
    });

    it('IPv4-mapped IPv6 yinelenen kayıt sayılır', () => {
        expect(validateSettings({ lanAllowedIps: ['10.0.0.1', '::ffff:10.0.0.1'] }, {}).code)
            .toBe('INVALID_SETTING');
        expect(validateSettings({ lanAllowedIps: ['::ffff:10.0.0.0/120'] }, {}).ok).toBe(true);
    });

    it('priceEffectiveFrom null veya YYYY-MM kabul eder', () => {
        expect(validateSettings({ priceEffectiveFrom: null }, {}).ok).toBe(true);
        expect(validateSettings({ priceEffectiveFrom: '2026-04' }, {}).ok).toBe(true);
        expect(validateSettings({ priceEffectiveFrom: '2026-13' }, {}).code).toBe('INVALID_SETTING');
    });
});

describe('WP-09 şema v2 dayanıklılığı', () => {
    it('LAN allowlist boşsa mod kapanır ve gerekçe görünür', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify({
            version: 1,
            settings: { lanModeEnabled: true, lanAllowedIps: ['eski-host.local'] }
        }), 'utf8');
        const s = new StorageService(dir);
        expect(s.getSchemaVersion()).toBe(3);
        expect(s.getSettings().lanModeEnabled).toBe(false);
        expect(s.getSettings().lanModeWarning).toMatch(/kapatıldı/i);
        s.close();
    });

    it('prototip kirlenmesi anahtarları yok sayılır', () => {
        const dir = tempDir();
        const s = new StorageService(dir);
        const evil = JSON.parse('{"__proto__":{"polluted":true},"theme":"light"}');
        s.updateSettings(evil);
        expect(s.getSettings().theme).toBe('light');
        expect(s.getSettings().polluted).toBeUndefined();
        expect({}.polluted).toBeUndefined();
        s.close();
    });
});

describe('WP-17/WP-18 gözlemlenebilirlik ve APPX kapısı', () => {
    it('güvenlik durumu ACL/rate-limit sayaçlarını taşır', () => {
        const svc = new LocalApiService(
            { getSettings: () => ({}) },
            { createTask: vi.fn(), getActiveTasks: () => [], pausedAll: false },
            {},
            {}
        );
        svc.diagnostics.aclDenied = 2;
        expect(svc.getSecurityStatus().diagnostics).toMatchObject({
            aclDenied: 2,
            rateLimitKeys: 0
        });
    });

    it('publisher normalizasyonu sıralı ve boşluk toleranslıdır', () => {
        expect(normalizePublisher('CN=B, O=A')).toBe('CN=B,O=A');
        expect(normalizePublisher(' O=A ,  CN=B ')).toBe('CN=B,O=A');
    });

    it('package.json NSIS-only ve APPX publisher env kapısındadır', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.version).toBe('1.0.0');
        expect(pkg.build.win.target).toEqual(['nsis']);
        expect(pkg.build.appx.publisher).toBe('${env.APPX_PUBLISHER}');
        expect(pkg.build.appx.languages).toHaveLength(17);
        expect(pkg.scripts['dist:appx']).toContain('build-appx.js');
        expect(pkg.build.asarUnpack.some((p) => String(p).includes('ps-list'))).toBe(true);
        expect(pkg.build.nsis.oneClick).toBe(false);
        expect(pkg.build.nsis.allowToChangeInstallationDirectory).toBe(true);
    });
});

describe('WP-13/WP-15 renderer sözleşmesi', () => {
    const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
    const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    it('Arapça RTL, aktif durum geri yüklemesi ve köprü uçları vardır', () => {
        expect(appJs).toContain('PPLocale.isRtl');
        expect(appJs).toContain("isRtl ? 'rtl' : 'ltr'");
        expect(appJs).toContain('getActiveState');
        expect(preload).toContain("ipcRenderer.invoke('get-active-state')");
        expect(preload).toContain("ipcRenderer.invoke('get-app-version')");
        expect(main).toContain("ipcHandle('get-active-state'");
    });

    it('SingletonLock elle silinmez', () => {
        expect(main).not.toMatch(/unlinkSync\(lockFile\)/);
    });

    it('CANCEL_TOO_LATE IPC yanıtı başarı gibi sunulmaz', () => {
        // C-01: iptal gövdesi src/main/ipc/warningActions.js'e taşındı.
        const warningActions = fs.readFileSync(path.join(ROOT, 'src/main/ipc/warningActions.js'), 'utf8');
        expect(warningActions).toMatch(/r\.code === 'CANCEL_TOO_LATE'[\s\S]{0,220}success: false/);
        expect(main).toMatch(/activeResult\.code === 'CANCEL_TOO_LATE'[\s\S]{0,220}success: false/);
    });
});

describe('WP-12 sürüm hattı dondurma', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();

    it('Electron, electron-builder, Vitest ve Playwright tam pinlidir', () => {
        // Sürümler Dependabot ile güncellenebilir; kapı belirli bir sürümü
        // değil, aralık işareti içermeyen tam pinleri doğrular.
        for (const name of ['electron', 'electron-builder', 'vitest', '@vitest/coverage-v8', '@playwright/test']) {
            expect(pkg.devDependencies[name], `${name} tam sürümle pinlenmeli`).toMatch(/^\d+\.\d+\.\d+$/);
        }
    });

    it('Node sürümü .nvmrc + engines ile hizalıdır', () => {
        expect(nvmrc).toBe('24.18.1');
        expect(pkg.engines.node).toBe('>=24.18.1');
    });

    it('ps-list ve ipaddr.js üretim bağımlılığı olarak pinlidir', () => {
        expect(pkg.dependencies['ps-list']).toBe('9.0.0');
        expect(pkg.dependencies['ipaddr.js']).toBe('2.5.0');
    });
});
