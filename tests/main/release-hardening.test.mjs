/**
 * release-hardening.test.mjs - v1.0.1 P0/P1 regresyon kapısı.
 *
 * Kapsam: IP/CIDR ACL, atomik icra, uyarı-iptal, süreç fail-closed,
 * ps-list/powerMonitor, model pinleri, makbuz idempotency, şema v2,
 * ayar çapraz doğrulaması ve uzaktan kapatma koruması.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

import TaskManager from '../../src/main/services/TaskManager.js';
import WarningManager from '../../src/main/services/WarningManager.js';
import SmartFinishEngine from '../../src/main/services/SmartFinishEngine.js';
import MetricCollector from '../../src/main/services/monitors/MetricCollector.js';
import { canonicalProcessName } from '../../src/main/services/processNames.js';
import { ModelManager } from '../../src/main/services/ModelManager.js';
import { OrderQueue } from '../../src/main/services/OrderQueue.js';
import { ConsoleClient } from '../../src/main/services/ConsoleClient.js';
import StorageService from '../../src/main/services/StorageService.js';
import LocalApiService from '../../src/main/services/LocalApiService.js';
import ipAcl from '../../src/main/services/net/ipAcl.js';
import { validateSettings, validateSecuritySettings } from '../../src/main/ipc/validate.js';

const live = [];
const tempDirs = [];
const servers = [];

afterEach(() => {
    for (const obj of live.splice(0)) {
        if (obj && obj.loopInterval) clearInterval(obj.loopInterval);
        if (obj && typeof obj.stopSampling === 'function') obj.stopSampling();
    }
    for (const s of servers.splice(0)) {
        try { s.close(); } catch (_) { }
    }
    for (const d of tempDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { }
    }
});

function tempDir(prefix = 'pp-hardening-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function makeTaskManager({ power, warning = null, settings = {} } = {}) {
    const storage = {
        getTasks: () => [],
        saveTask: vi.fn(), deleteTask: vi.fn(),
        getSettings: () => Object.assign({}, settings)
    };
    const history = { record: vi.fn(), getHistory: () => [], clear: () => { } };
    const webhook = { triggerEvent: vi.fn() };
    const safety = { evaluate: vi.fn(async () => ({ allowed: true })) };
    const tm = new TaskManager(storage, warning, safety, history, webhook, null, null, power);
    live.push(tm);
    return { tm, storage, history, webhook, safety };
}

function scheduledTask(tm, overrides = {}) {
    return tm.createTask(Object.assign({
        name: 'Hardening görevi',
        action: 'shutdown',
        trigger: { type: 'duration', durationMs: 1000 }
    }, overrides));
}

function startHttpServer(handler) {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function serverUrl(server) {
    return `http://127.0.0.1:${server.address().port}/model`;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('WP-01 IP/CIDR ACL', () => {
    it('loopback her zaman açıktır; IPv4-mapped IPv6 normalize edilir', () => {
        expect(ipAcl.isAllowed('127.0.0.1', [])).toBe(true);
        expect(ipAcl.isAllowed('::1', [])).toBe(true);
        expect(ipAcl.isAllowed('::ffff:192.168.1.10', ['192.168.1.0/24'])).toBe(true);
        expect(ipAcl.normalizeAddress('::ffff:10.0.0.5').toString()).toBe('10.0.0.5');
    });

    it('boş allowlist loopback dışını reddeder (fail-closed)', () => {
        expect(ipAcl.isAllowed('192.168.1.10', [])).toBe(false);
        expect(ipAcl.isAllowed('10.0.0.5', null)).toBe(false);
    });

    it('CIDR ve zone ID desteklenir; hostname reddedilir', () => {
        expect(ipAcl.isAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
        expect(ipAcl.isAllowed('10.1.2.3', ['10.0.0.0/8', 'localhost'])).toBe(true);
        expect(ipAcl.isAllowed('10.1.2.3', ['localhost'])).toBe(false);
        expect(ipAcl.normalizeAddress('fe80::1%eth0').toString()).toBe('fe80::1');
        // Zone ID prefix'i yutmamalı; /64 korunur.
        expect(ipAcl.isAllowed('fe80::2', ['fe80::1%eth0/64'])).toBe(true);
        expect(ipAcl.parseRule('fe80::1%eth0/64')).toMatchObject({ kind: 'cidr', prefix: 64 });
    });

    it('IPv4-mapped /96’dan geniş blok fail-open olmaz', () => {
        expect(ipAcl.parseRule('::ffff:0:0/80')).toBeNull();
        expect(ipAcl.isAllowed('10.1.2.3', ['::ffff:0:0/80'])).toBe(false);
        expect(validateSettings({ lanAllowedIps: ['::ffff:0:0/80'] }, {}).code)
            .toBe('INVALID_SETTING');
        expect(validateSettings({ lanAllowedIps: ['fe80::1%eth0/64'] }, {}).ok).toBe(true);
    });
});

describe('WP-02/WP-03 atomik icra ve uyarı iptali', () => {
    it('aynı görev iki kez tetiklenirse yalnızca bir kez çalışır', async () => {
        const power = { execute: vi.fn(async () => ({ success: true })) };
        const { tm } = makeTaskManager({ power });
        const task = scheduledTask(tm);
        task.trigger.targetTime = Date.now() - 1;

        expect(tm.runTaskNow(task.id)).toBe(true);
        expect(tm.runTaskNow(task.id)).toBe(false);
        await waitFor(() => power.execute.mock.calls.length === 1);
        await flush();

        expect(power.execute).toHaveBeenCalledTimes(1);
        expect(tm.claims.size).toBe(0);
    });

    it('uyarı açıkken iptal görevi CANCELLED yapar ve güç çağrılmaz', async () => {
        const power = { execute: vi.fn(async () => ({ success: true })) };
        const history = { record: vi.fn(), getHistory: () => [], clear: () => { } };
        const warning = new WarningManager(history);
        const { tm } = makeTaskManager({ power, warning });
        const task = scheduledTask(tm, {
            warningConfig: { enabled: true, durationSeconds: 30 }
        });

        const running = tm.executeTask(task);
        expect(await waitFor(() => warning.getActiveState()?.taskId === task.id)).toBe(true);
        const result = tm.cancelTask(task.id);
        await running;

        expect(result.code).toBe('CANCELLED');
        expect(task.status).toBe('cancelled');
        expect(warning.getActiveState()).toBeNull();
        expect(power.execute).not.toHaveBeenCalled();
    });

    it('OS komutu başladıktan sonra iptal CANCEL_TOO_LATE döner', async () => {
        let resolvePower;
        const power = {
            execute: vi.fn(() => new Promise((resolve) => { resolvePower = resolve; }))
        };
        const { tm } = makeTaskManager({ power });
        const task = scheduledTask(tm);

        const running = tm.executeTask(task);
        expect(await waitFor(() => power.execute.mock.calls.length === 1)).toBe(true);

        const result = tm.cancelTask(task.id);
        expect(result.ok).toBe(true);
        expect(result.code).toBe('CANCEL_TOO_LATE');

        resolvePower({ success: true });
        await running;
        expect(task.status).toBe('completed');
        expect(task.lastResult.note).toBe('CANCEL_TOO_LATE');
    });
});

describe('WP-04/WP-05 süreç ve idle', () => {
    it('boş processName ve stale liste fail-closed', () => {
        const engine = new SmartFinishEngine({ getMetrics: () => ({}) });
        const base = { type: 'process_running', triggerOnClose: true, processName: 'chrome.exe' };

        expect(engine.evaluateSingleCondition({ ...base, processName: '' }, {
            processListStale: false,
            runningProcesses: ['chrome']
        }).satisfied).toBe(false);

        expect(engine.evaluateSingleCondition(base, {
            processListStale: true,
            runningProcesses: []
        }).satisfied).toBe(false);
    });

    it('chrome ve chrome.exe kanonik olarak eşittir', () => {
        expect(canonicalProcessName('Chrome.EXE')).toBe('chrome');
        expect(canonicalProcessName('C:\\Program Files\\Google\\Chrome\\chrome.exe')).toBe('chrome');
        const engine = new SmartFinishEngine({ getMetrics: () => ({}) });
        const result = engine.evaluateSingleCondition(
            { type: 'process_running', triggerOnClose: false, processName: 'chrome.exe' },
            { processListStale: false, runningProcesses: ['chrome'] }
        );
        expect(result.satisfied).toBe(true);
    });

    it('MetricCollector sağlayıcıları kullanır; hata stale yapar', async () => {
        const mc = new MetricCollector({
            sampleIntervalMs: 60 * 60 * 1000,
            processProvider: async () => [{ name: 'Chrome.exe' }, { name: 'notepad.exe' }],
            idleProvider: () => 321
        });
        live.push(mc);
        await mc.sampleProcesses();
        await mc.sampleIdle();
        expect(mc.getMetrics().runningProcesses).toEqual(expect.arrayContaining(['chrome', 'notepad']));
        expect(mc.getMetrics().processListStale).toBe(false);
        expect(mc.getMetrics().userIdleSeconds).toBe(321);
        mc.stopSampling();

        const bad = new MetricCollector({
            sampleIntervalMs: 60 * 60 * 1000,
            processProvider: async () => { throw new Error('ps-list yok'); }
        });
        live.push(bad);
        await bad.sampleProcesses();
        expect(bad.getMetrics().processListStale).toBe(true);
        bad.stopSampling();

        const noIdle = new MetricCollector({
            sampleIntervalMs: 60 * 60 * 1000,
            processProvider: async () => ['explorer']
        });
        live.push(noIdle);
        await noIdle.sampleIdle();
        expect(noIdle.getMetrics().userIdleSeconds).toBe(0);
        noIdle.stopSampling();
    });
});

describe('WP-06 model bütünlüğü', () => {
    it('boyut + SHA-256 doğrulanınca indirme başarılıdır', async () => {
        const data = Buffer.from('power-pilot-model-data');
        const server = await startHttpServer((req, res) => {
            res.writeHead(200, { 'Content-Length': data.length });
            res.end(data);
        });
        const dir = tempDir();
        const mm = new ModelManager({
            modelDir: dir,
            url: serverUrl(server),
            modelId: 'custom',
            expectedBytes: data.length,
            expectedSha256: sha256(data)
        });
        const result = await mm.download();
        expect(result.success).toBe(true);
        expect(await mm.verify()).toBe(true);
        expect(mm.status().manifest.sha256).toBe(sha256(data));
    });

    it('SHA-256 uyuşmazlığında dosya çalıştırılabilir hale gelmez', async () => {
        const data = Buffer.from('bozuk-model');
        const server = await startHttpServer((req, res) => {
            res.writeHead(200, { 'Content-Length': data.length });
            res.end(data);
        });
        const dir = tempDir();
        const mm = new ModelManager({
            modelDir: dir,
            url: serverUrl(server),
            modelId: 'custom',
            expectedBytes: data.length,
            expectedSha256: '0'.repeat(64)
        });
        const result = await mm.download();
        expect(result.success).toBe(false);
        expect(mm.status().present).toBe(false);
        expect(fs.existsSync(mm.modelPath())).toBe(false);
    });

    it('sunucu Range’i yok sayarsa baştan yazar', async () => {
        const data = Buffer.from('0123456789abcdef');
        const server = await startHttpServer((req, res) => {
            res.writeHead(200, { 'Content-Length': data.length });
            res.end(data);
        });
        const dir = tempDir();
        const mm = new ModelManager({
            modelDir: dir,
            url: serverUrl(server),
            modelId: 'custom',
            expectedBytes: data.length,
            expectedSha256: sha256(data)
        });
        fs.writeFileSync(mm.partPath(), data.subarray(0, 4));
        const result = await mm.download();
        expect(result.success).toBe(true);
        expect(fs.readFileSync(mm.modelPath()).toString()).toBe(data.toString());
    });

    it('416 + tam .part dosyasını finalize eder', async () => {
        const data = Buffer.from('tam-part-dosyasi');
        const server = await startHttpServer((req, res) => {
            res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
            res.end();
        });
        const dir = tempDir();
        const mm = new ModelManager({
            modelDir: dir,
            url: serverUrl(server),
            modelId: 'custom',
            expectedBytes: data.length,
            expectedSha256: sha256(data)
        });
        fs.writeFileSync(mm.partPath(), data);
        const result = await mm.download();
        expect(result.success).toBe(true);
        expect(fs.existsSync(mm.modelPath())).toBe(true);
    });
});

describe('WP-07 makbuz idempotency', () => {
    it('peek işaretlemez; başarılı gönderim tek kez işaretler', () => {
        const q = new OrderQueue(null);
        const { record } = q.enqueue({ order: { nonce: 'n1', action: 'lock' }, signature: 's' });
        q.ack(record.key, { code: 'success', message: 'ok' });

        const first = q.peekUnsentReceipts();
        expect(first).toHaveLength(1);
        expect(q.peekUnsentReceipts()).toHaveLength(1);
        expect(q.markReceiptsSent(first)).toBe(1);
        expect(q.peekUnsentReceipts()).toEqual([]);
    });

    it('gönderim hatası makbuzu kuyrukta tutar', () => {
        const q = new OrderQueue(null);
        const { record } = q.enqueue({ order: { nonce: 'n2', action: 'shutdown' }, signature: 's' });
        q.ack(record.key, { code: 'success' });
        const receipts = q.peekUnsentReceipts();
        q.markReceiptsFailed(receipts, 'HTTP 500');
        expect(q.peekUnsentReceipts()).toHaveLength(1);
        expect(q.load()[0].receiptAttempts).toBe(1);
    });

    it('204 boş gövde makbuzu gönderilmiş sayar', async () => {
        const queue = new OrderQueue(null);
        const { record } = queue.enqueue({ order: { nonce: 'n3', action: 'lock' }, signature: 's' });
        queue.ack(record.key, { code: 'success' });
        const storage = {
            getSettings: () => ({
                consoleUrl: 'https://srv',
                consolePublicKeyPem: 'x',
                consoleAgentKey: 'agent-key'
            })
        };
        const client = new ConsoleClient({
            storage,
            inventoryService: { collect: async () => ({ agentId: 'a1' }) },
            orderQueue: queue,
            fetchFn: async () => ({ ok: true, status: 204, json: async () => { throw new Error('boş'); } })
        });
        const result = await client.sync();
        expect(result.ok).toBe(true);
        expect(queue.peekUnsentReceipts()).toEqual([]);
    });
});

describe('WP-09/WP-10 ayarlar ve şema', () => {
    it('LAN için allowlist, TLS için sertifika zorunludur', () => {
        expect(validateSecuritySettings({ lanModeEnabled: true }, { lanAllowedIps: [] }).code)
            .toBe('LAN_ALLOWLIST_REQUIRED');
        expect(validateSecuritySettings({
            lanModeEnabled: true,
            localApiTlsEnabled: true
        }, { lanAllowedIps: ['192.168.1.0/24'] }).code).toBe('TLS_MATERIAL_REQUIRED');
        expect(validateSettings({
            lanAllowedIps: ['telefon.local']
        }, {}).code).toBe('INVALID_SETTING');
        expect(validateSettings({
            lanAllowedIps: ['10.0.0.1', '10.0.0.1']
        }, {}).code).toBe('INVALID_SETTING');
        expect(validateSettings({
            lanAllowedIps: ['10.0.0.0/8', '::ffff:192.168.1.0/120']
        }, {}).ok).toBe(true);
    });

    it('şema v1→v2 hostnameleri filtreler ve güvenli varsayılan ekler', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify({
            version: 1,
            settings: {
                lanModeEnabled: true,
                lanAllowedIps: ['hostname.local', '192.168.1.0/24', '10.0.0.5']
            }
        }), 'utf8');
        const s = new StorageService(dir);
        expect(s.data.version).toBe(3);
        expect(s.getSettings().lanAllowedIps).toEqual(['192.168.1.0/24', '10.0.0.5']);
        expect(s.getSettings().lanModeEnabled).toBe(true);
        expect(s.getSettings().blockRemoteShutdownWhenActive).toBe(true);
        s.close();
    });

    it('yalnızca hostname kaldıysa LAN modu kapanır (kilitlenme yok)', () => {
        const dir = tempDir();
        fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'powerpilot_data.json'), JSON.stringify({
            version: 1,
            settings: { lanModeEnabled: true, lanAllowedIps: ['sadece-hostname.local'] }
        }), 'utf8');
        const s = new StorageService(dir);
        expect(s.getSettings().lanAllowedIps).toEqual([]);
        expect(s.getSettings().lanModeEnabled).toBe(false);
        s.close();
    });
});

describe('WP-08 uzaktan kapatma koruması', () => {
    it('kullanıcı aktifken shutdown/restart engellenir; idle>=60 serbest', () => {
        const svc = new LocalApiService(
            { getSettings: () => ({}) },
            { createTask: vi.fn() },
            {},
            { powerMonitor: { getSystemIdleTime: () => 10 } }
        );
        expect(svc.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: true }, 'shutdown')).toBe(true);
        expect(svc.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: true }, 'restart')).toBe(true);
        // O-05: lock/signout/sleep/hibernate da kullanıcı aktifken engellenir.
        expect(svc.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: true }, 'lock')).toBe(true);
        expect(svc.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: false }, 'shutdown')).toBe(false);

        const idle = new LocalApiService(
            { getSettings: () => ({}) },
            { createTask: vi.fn() },
            {},
            { powerMonitor: { getSystemIdleTime: () => 120 } }
        );
        expect(idle.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: true }, 'shutdown')).toBe(false);
    });

    it('sağlayıcı yoksa fail-closed davranır', () => {
        const svc = new LocalApiService(
            { getSettings: () => ({}) },
            { createTask: vi.fn() },
            {},
            {}
        );
        expect(svc.isRemoteShutdownBlocked({ blockRemoteShutdownWhenActive: true }, 'shutdown')).toBe(true);
    });
});
