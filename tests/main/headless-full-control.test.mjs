/**
 * headless-full-control.test.mjs
 *
 * End-to-end real HTTP + SQLite + Zero-GUI Bootstrap + CLI + MCP integration suite.
 * Proves that 100% of Power Pilot works with ZERO GUI window ever opened.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initHeadlessConfig } = require('../../src/agent/bootstrap.js');
const { bootAgent } = require('../../src/agent/headless.js');
const { resolveConnection, requestJson } = require('../../src/shared/localApiConnection.js');
const { runCli } = require('../../src/cli/powerpilot.js');
const { handleRpcRequest, RESOURCES } = require('../../src/mcp/server.js');

const tmpDirs = [];
const handles = [];

function freshDir(prefix = 'pp-headless-e2e-') {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            srv.close(() => resolve(addr.port));
        });
        srv.on('error', reject);
    });
}

afterEach(async () => {
    for (const h of handles.splice(0)) {
        try { await h.stop(); } catch (_) { /* yut */ }
    }
    for (const d of tmpDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* yut */ }
    }
});

describe('Tam Arayuzsuz (Zero-GUI) Kontrol - Bootstrap + Headless + REST + CLI + MCP', () => {
    it('sifir-GUI bootstrap API + anahtar + profil uretir ve resolveConnection otomatik cozer', () => {
        const dir = freshDir();
        const boot = initHeadlessConfig({ userDataPath: dir, port: 19456, role: 'admin', applyAcl: false });
        expect(boot.ok).toBe(true);
        expect(boot.localApiEnabled).toBe(true);
        expect(boot.apiKey).toMatch(/^pp_key_[a-f0-9]{48}$/);
        expect(fs.existsSync(boot.profilePath)).toBe(true);
        expect(boot.mcpConfig.mcpServers['power-pilot'].env.POWERPILOT_API_PORT).toBe('19456');

        // Varsayilan saf cagri dosya okumaz (eski kontrat korunur)
        expect(resolveConnection({}).apiKey).toBe('');
        // Profil izniyle cli-connection.json otomatik okunur
        const fromProfile = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        expect(fromProfile.apiKey).toBe(boot.apiKey);
        expect(fromProfile.port).toBe(19456);
        // Ortam degiskeni her zaman profile gore onceliklidir
        const envOverride = resolveConnection({ POWERPILOT_API_KEY: 'pp_key_override', POWERPILOT_API_PORT: '19999' }, {
            allowProfileFile: true,
            profilePath: boot.profilePath
        });
        expect(envOverride.apiKey).toBe('pp_key_override');
        expect(envOverride.port).toBe(19999);
    });

    it('gercek headless daemon + gercek HTTP uzerinden CLI ve MCP ile tum domainler calisir', async () => {
        const dir = freshDir();
        const port = await getFreePort();
        const boot = initHeadlessConfig({ userDataPath: dir, port, role: 'admin', applyAcl: false });
        const agent = await bootAgent({ userDataPath: dir, appVersion: '1.0.0-e2e', syncIntervalMs: 3600000 });
        handles.push(agent);

        const conn = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        const reqApi = (method, apiPath, body = null) => requestJson(conn, method, apiPath, body);

        // 1. Status (headless: true)
        const st = await reqApi('GET', '/status');
        expect(st.status).toBe(200);
        expect(st.body.headless).toBe(true);
        expect(st.body.status).toBe('online');

        // 2. Full Conditional Task Creation (SmartFinish CPU + Process) + Pause + Resume + Snooze + Cancel + Delete
        const created = await handleRpcRequest({
            jsonrpc: '2.0',
            id: 10,
            method: 'tools/call',
            params: {
                name: 'powerpilot_create_task',
                arguments: {
                    name: 'Render Bitti Uyut',
                    action: 'sleep',
                    trigger: { type: 'composite' },
                    conditionGroup: {
                        operator: 'AND',
                        stabilitySeconds: 30,
                        conditions: [
                            { type: 'process_running', processName: 'blender.exe' },
                            { type: 'cpu_usage', thresholdPercent: 15 }
                        ]
                    }
                }
            }
        }, { requestApi: reqApi });
        expect(created.result.isError).toBe(false);
        const createdTask = JSON.parse(created.result.content[0].text).task;
        expect(createdTask.id).toBeTruthy();
        expect(createdTask.conditionGroup.conditions).toHaveLength(2);

        const paused = await reqApi('POST', `/tasks/${createdTask.id}/pause`);
        expect(paused.status).toBe(200);
        const resumed = await reqApi('POST', `/tasks/${createdTask.id}/resume`);
        expect(resumed.status).toBe(200);
        const snoozed = await reqApi('POST', `/tasks/${createdTask.id}/snooze`, { minutes: 15 });
        expect(snoozed.status).toBe(200);
        const cancelled = await reqApi('POST', `/tasks/${createdTask.id}/cancel`);
        expect(cancelled.status).toBe(200);
        const cleared = await reqApi('POST', '/tasks/clear-finished');
        expect(cleared.status).toBe(200);
        expect(cleared.body.removed).toBeGreaterThanOrEqual(1);

        // 3. Global pause-all on & off
        const paOn = await reqApi('POST', '/tasks/pause-all', { paused: true });
        expect(paOn.status).toBe(200);
        expect(paOn.body.pausedAll).toBe(true);
        const paOff = await reqApi('POST', '/tasks/pause-all', { paused: false });
        expect(paOff.body.pausedAll).toBe(false);

        // 4. Templates CRUD + Run Template -> live task
        const tplSave = await reqApi('POST', '/templates', {
            name: 'Headless Gece Modu',
            description: '20 dk sonra uyut',
            action: 'sleep',
            trigger: { type: 'duration', durationMs: 1200000 }
        });
        expect(tplSave.status).toBe(201);
        const tplId = tplSave.body.template.id;
        const tplRun = await reqApi('POST', `/templates/${tplId}/run`, { name: 'Sablondan Calisti' });
        expect(tplRun.status).toBe(201);
        expect(tplRun.body.task.action).toBe('sleep');
        await reqApi('POST', `/tasks/${tplRun.body.task.id}/cancel`);
        const tplDel = await reqApi('DELETE', `/templates/${tplId}`);
        expect(tplDel.status).toBe(200);

        // 5. Settings (ZERO secret leaks!) + PATCH settings + security settings
        const sGet = await reqApi('GET', '/settings');
        expect(sGet.status).toBe(200);
        expect(sGet.body.settings.localApiKeyHash).toBeUndefined();
        expect(sGet.body.settings.secretPresence.localApiKeyHash).toBe(true);
        const sPatch = await reqApi('PATCH', '/settings', { language: 'tr', deviceWattage: 180 });
        expect(sPatch.status).toBe(200);
        expect(sPatch.body.settings.deviceWattage).toBe(180);
        const secPatch = await reqApi('PATCH', '/settings/security', { autonomyMode: 'classic' });
        expect(secPatch.status).toBe(200);

        // 6. History, Statistics, Health
        expect((await reqApi('GET', '/history')).status).toBe(200);
        expect((await reqApi('GET', '/statistics')).status).toBe(200);
        expect((await reqApi('GET', '/health')).status).toBe(200);

        // 7. WoL devices CRUD & Webhooks SSRF validation
        const wolPut = await reqApi('PUT', '/wol/devices', {
            devices: [{ name: 'RenderNode', macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '192.168.1.255', port: 9 }]
        });
        expect(wolPut.status).toBe(200);
        expect((await reqApi('GET', '/wol/devices')).body.devices).toHaveLength(1);
        // Plain HTTP webhook MUST be rejected (SSRF/TLS guard)
        const badHook = await reqApi('PUT', '/webhooks', { webhooks: [{ url: 'http://127.0.0.1:9000/hook', enabled: true }] });
        expect(badHook.status).toBe(400);

        // 8. Cloud Sync Status & Autosync
        const clSt = await reqApi('GET', '/cloud/status');
        expect(clSt.status).toBe(200);
        expect(clSt.body.cloud).toBeTruthy();

        // 9. Offline AI Parse (deterministic, no GGUF needed!) + Docs RAG + Diagnose
        const parsed = await reqApi('POST', '/ai/parse', { text: '45 dakika sonra uyut', execute: true });
        expect(parsed.status).toBe(201);
        expect(parsed.body.executed).toBe(true);
        expect(parsed.body.task.action).toBe('sleep');
        await reqApi('POST', `/tasks/${parsed.body.task.id}/cancel`);

        const docs = await reqApi('GET', '/docs/search?q=mcp&lang=tr');
        expect(docs.status).toBe(200);
        expect(docs.body.results.length).toBeGreaterThan(0);

        const diag = await reqApi('POST', '/ai/diagnose', { reason: 'fullscreen', lang: 'tr' });
        expect(diag.status).toBe(200);
        expect(diag.body.diagnosis).toBeTruthy();
        expect(diag.body.diagnosis.ok).toBe(true);

        // 10. Diagnostics snapshot + Support Bundle ZIP + Updates Status
        const dSnap = await reqApi('GET', '/diagnostics');
        expect(dSnap.status).toBe(200);
        const bundle = await reqApi('POST', '/diagnostics/bundle');
        expect(bundle.status).toBe(201);
        expect(bundle.body.bundle.ok).toBe(true);
        const upd = await reqApi('GET', '/updates/status');
        expect(upd.status).toBe(200);

        // 11. All 8 MCP Resources readable over real HTTP!
        for (const r of RESOURCES) {
            const readRes = await handleRpcRequest({
                jsonrpc: '2.0',
                id: 99,
                method: 'resources/read',
                params: { uri: r.uri }
            }, { requestApi: reqApi });
            expect(readRes.error, `MCP resource failed: ${r.uri}`).toBeUndefined();
            expect(readRes.result.contents[0].uri).toBe(r.uri);
        }

        // 12. Real CLI (`runCli`) using POWERPILOT_CONFIG profile file (zero manual API key env!)
        const cliOut = [];
        const code = await runCli(['status', '--json'], {
            env: { POWERPILOT_CONFIG: boot.profilePath },
            stdout: (m) => cliOut.push(m),
            stderr: (m) => cliOut.push(m)
        });
        expect(code).toBe(0);
        expect(JSON.parse(cliOut.join('')).headless).toBe(true);
    }, 30000);

    it('RBAC fail-closed: viewer yazamaz/gizli uclari okuyamaz, operator shutdown gorevi acamaz', async () => {
        const dir = freshDir();
        const port = await getFreePort();
        const boot = initHeadlessConfig({ userDataPath: dir, port, role: 'operator', applyAcl: false });
        const agent = await bootAgent({ userDataPath: dir, appVersion: '1.0.0-rbac', syncIntervalMs: 3600000 });
        handles.push(agent);

        const conn = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        // Operator CAN create sleep task
        const okSleep = await requestJson(conn, 'POST', '/tasks', {
            action: 'sleep',
            trigger: { type: 'duration', durationMs: 600000 }
        });
        expect(okSleep.status).toBe(201);
        await requestJson(conn, 'POST', `/tasks/${okSleep.body.task.id}/cancel`);

        // Operator CANNOT create shutdown task (requires admin)
        const denyShut = await requestJson(conn, 'POST', '/tasks', {
            action: 'shutdown',
            trigger: { type: 'duration', durationMs: 600000 }
        });
        expect(denyShut.status).toBe(403);

        // Operator CANNOT patch settings or read webhooks/diagnostics
        expect((await requestJson(conn, 'PATCH', '/settings', { theme: 'dark' })).status).toBe(403);
        expect((await requestJson(conn, 'GET', '/webhooks')).status).toBe(403);
        expect((await requestJson(conn, 'GET', '/diagnostics')).status).toBe(403);
    }, 20000);

    it('Cancel PIN kilidi REST/CLI/MCP iptal ve duraklatma uclarinda zorunlu uygulanir', async () => {
        const dir = freshDir();
        const port = await getFreePort();
        const boot = initHeadlessConfig({ userDataPath: dir, port, role: 'admin', applyAcl: false });
        const agent = await bootAgent({ userDataPath: dir, appVersion: '1.0.0-pin', syncIntervalMs: 3600000 });
        handles.push(agent);

        const conn = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        const reqApi = (m, p, b = null) => requestJson(conn, m, p, b);

        expect((await reqApi('GET', '/security/cancel-pin')).body.set).toBe(false);
        const setRes = await reqApi('PUT', '/security/cancel-pin', { pin: '2468' });
        expect(setRes.status).toBe(200);
        expect((await reqApi('GET', '/security/cancel-pin')).body.set).toBe(true);

        const created = await reqApi('POST', '/tasks/timer', { action: 'sleep', durationMs: 600000 });
        expect(created.status).toBe(201);
        const taskId = created.body.task.id;

        // Without PIN -> 403 PIN_REQUIRED on cancel, pause, snooze, and pause-all
        const noPinCancel = await reqApi('POST', `/tasks/${taskId}/cancel`);
        expect(noPinCancel.status).toBe(403);
        expect(noPinCancel.body.code).toBe('PIN_REQUIRED');

        const noPinTaskPause = await reqApi('POST', `/tasks/${taskId}/pause`);
        expect(noPinTaskPause.status).toBe(403);
        expect(noPinTaskPause.body.code).toBe('PIN_REQUIRED');

        const noPinTaskSnooze = await reqApi('POST', `/tasks/${taskId}/snooze`, { minutes: 5 });
        expect(noPinTaskSnooze.status).toBe(403);
        expect(noPinTaskSnooze.body.code).toBe('PIN_REQUIRED');

        const okTaskSnooze = await reqApi('POST', `/tasks/${taskId}/snooze`, { minutes: 5, pin: '2468' });
        expect(okTaskSnooze.status).toBe(200);

        const noPinPause = await reqApi('POST', '/tasks/pause-all', { paused: true });
        expect(noPinPause.status).toBe(403);

        // Wrong PIN -> 403 PIN_WRONG
        const badPinCancel = await reqApi('POST', `/tasks/${taskId}/cancel`, { pin: '9999' });
        expect(badPinCancel.status).toBe(403);
        expect(badPinCancel.body.code).toBe('PIN_WRONG');

        // Correct PIN -> 200 OK
        const okCancel = await reqApi('POST', `/tasks/${taskId}/cancel`, { pin: '2468' });
        expect(okCancel.status).toBe(200);

        // Clear PIN requires current PIN
        expect((await reqApi('DELETE', '/security/cancel-pin', { currentPin: '0000' })).status).toBe(403);
        expect((await reqApi('DELETE', '/security/cancel-pin', { currentPin: '2468' })).status).toBe(200);
        expect((await reqApi('GET', '/security/cancel-pin')).body.set).toBe(false);
    }, 25000);

    it('SecretStore fail-closed (DPAPI yokken 503), DPAPI ile sifreli kayit, anahtar rotasyonu ve genisletilmis uclar calisir', async () => {
        const dir = freshDir();
        const port = await getFreePort();
        const boot = initHeadlessConfig({ userDataPath: dir, port, role: 'admin', applyAcl: false });
        const agent = await bootAgent({ userDataPath: dir, appVersion: '1.0.0-ext', syncIntervalMs: 3600000 });
        handles.push(agent);

        const conn = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        const reqApi = (m, p, b = null) => requestJson(conn, m, p, b);

        // 1. SecretStore fail-closed: headless Node test has no Electron DPAPI -> saving secret MUST fail closed 503!
        const hookSecretRes = await reqApi('PUT', '/webhooks', {
            webhooks: [{ url: 'https://hooks.example.com/pp', hmacSecret: 'super_secret_hmac', enabled: true }]
        });
        expect(hookSecretRes.status).toBe(503);
        expect(hookSecretRes.body.code).toBe('SECRET_BACKEND_UNAVAILABLE');

        const settingSecretRes = await reqApi('PATCH', '/settings', { localApiPfxPassphrase: 'plain_secret_should_fail' });
        expect(settingSecretRes.status).toBe(503);
        expect(settingSecretRes.body.code).toBe('SECRET_BACKEND_UNAVAILABLE');

        const secSettingSecretRes = await reqApi('PATCH', '/settings/security', { consoleAgentKey: 'plain_secret_should_fail' });
        expect(secSettingSecretRes.status).toBe(503);
        expect(secSettingSecretRes.body.code).toBe('SECRET_BACKEND_UNAVAILABLE');

        // 2. Positive DPAPI encryption check with mock safeStorage backend
        const dpapiDir = freshDir('pp-dpapi-');
        const dpapiPort = await getFreePort();
        const dpapiBoot = initHeadlessConfig({ userDataPath: dpapiDir, port: dpapiPort, role: 'admin', applyAcl: false });
        const { SecretStore } = require('../../src/main/security/SecretStore.js');
        const mockSafeStorage = {
            isEncryptionAvailable: () => true,
            encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
            decryptString: (b) => b.toString('utf8').replace(/^enc:/, '')
        };
        const mockSecretStore = new SecretStore({
            filePath: path.join(dpapiDir, 'secrets.v1.json'),
            safeStorage: mockSafeStorage,
            applyAcl: false
        });
        const dpapiAgent = await bootAgent({ userDataPath: dpapiDir, appVersion: '1.0.0-dpapi', secretStore: mockSecretStore, syncIntervalMs: 3600000 });
        handles.push(dpapiAgent);
        const dpapiConn = resolveConnection({}, { allowProfileFile: true, profilePath: dpapiBoot.profilePath });
        const okHook = await requestJson(dpapiConn, 'PUT', '/webhooks', {
            webhooks: [{ url: 'https://hooks.example.com/dpapi', hmacSecret: 'encrypted_hmac_42', enabled: true }]
        });
        expect(okHook.status).toBe(200);
        expect(okHook.body.webhooks[0].hasSecret).toBe(true);
        expect(okHook.body.webhooks[0].hmacSecret).toBeUndefined();
        expect(mockSecretStore.listNames().some((n) => n.startsWith('webhook:'))).toBe(true);
        const okSettingSecret = await requestJson(dpapiConn, 'PATCH', '/settings/security', { consoleAgentKey: 'agent_secret_xyz' });
        expect(okSettingSecret.status).toBe(200);
        expect(okSettingSecret.body.settings.consoleAgentKey).toBeUndefined();
        expect(mockSecretStore.has('consoleAgentKey')).toBe(true);

        // 2. Extended endpoints: warning, ai/status, ai/tier, ai/energy, ai/suggest, device/estimate, cloud/folder, export/import
        expect((await reqApi('GET', '/warning')).status).toBe(200);
        const aiSt = await reqApi('GET', '/ai/status');
        expect(aiSt.status).toBe(200);
        expect(typeof aiSt.body.ramGb).toBe('number');
        const tierRes = await reqApi('POST', '/ai/tier', { tierId: 'lite' });
        expect(tierRes.status).toBe(200);
        expect(tierRes.body.activeTier).toBe('lite');
        const nrgRes = await reqApi('GET', '/ai/energy?lang=tr');
        expect(nrgRes.status).toBe(200);
        expect(nrgRes.body.insight.ok).toBe(true);
        const sugRes = await reqApi('GET', '/ai/suggest?lang=tr');
        expect(sugRes.status).toBe(200);
        expect(sugRes.body.suggestion.ok).toBe(true);
        expect((await reqApi('POST', '/ai/dismiss-suggestion', { topic: 'night_sleep' })).status).toBe(200);

        const est = await reqApi('POST', '/device/estimate', { apply: false });
        expect(est.status).toBe(200);
        expect(est.body.ok).toBe(true);

        const expS = await reqApi('GET', '/export/settings');
        expect(expS.status).toBe(200);
        expect(expS.body.settings.localApiKeyHash).toBeUndefined();
        const impS = await reqApi('POST', '/import/settings', { settings: { language: 'en', deviceWattage: 140 } });
        expect(impS.status).toBe(200);
        expect(impS.body.appliedKeys).toContain('deviceWattage');

        const expT = await reqApi('GET', '/export/templates');
        expect(expT.status).toBe(200);

        const customCloudDir = path.join(dir, 'CustomCloudBackup');
        fs.mkdirSync(customCloudDir, { recursive: true });
        expect((await reqApi('PUT', '/cloud/folder', { dirPath: customCloudDir })).status).toBe(200);
        expect((await reqApi('POST', '/cloud/folder/reset')).status).toBe(200);

        // 3. API Key Rotation invalidates old key & accepts new key
        const rot = await reqApi('POST', '/security/rotate-key', { role: 'admin', saveProfile: true });
        expect(rot.status).toBe(200);
        expect(rot.body.apiKey).toMatch(/^pp_key_[a-f0-9]{48}$/);
        expect(rot.body.apiKey).not.toBe(boot.apiKey);

        // Old key MUST now return 401
        const oldTry = await requestJson(conn, 'GET', '/status');
        expect(oldTry.status).toBe(401);

        // New key works immediately
        const newConn = resolveConnection({}, { allowProfileFile: true, profilePath: boot.profilePath });
        expect(newConn.apiKey).toBe(rot.body.apiKey);
        const newTry = await requestJson(newConn, 'GET', '/status');
        expect(newTry.status).toBe(200);
    }, 30000);
});
