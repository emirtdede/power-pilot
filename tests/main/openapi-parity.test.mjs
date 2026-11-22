/**
 * openapi-parity.test.mjs - WBS-5.3 / TS-5.3 + Full Headless Control Parity
 * docs/openapi/power-pilot-local-api.yaml <-> LocalApiService.route() birebirligi.
 * Sapma olursa test kirmizi verir (dokuman-kod drift'i CI'da yakalanir).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import LocalApiService from '../../src/main/services/LocalApiService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const YAML_PATH = path.join(here, '..', '..', 'docs', 'openapi', 'power-pilot-local-api.yaml');

function parseYamlPaths(text) {
    const routes = [];
    let current = null;
    let inPaths = false;
    for (const line of text.split(/\r?\n/)) {
        if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
        if (/^[a-z]+:\s*$/.test(line) && !line.startsWith(' ')) { inPaths = false; continue; }
        if (!inPaths) continue;
        const pm = line.match(/^  (\/\S+):\s*$/);
        if (pm) { current = pm[1]; continue; }
        const mm = line.match(/^    (get|post|put|patch|delete):\s*$/);
        if (mm && current) routes.push({ method: mm[1].toUpperCase(), path: current });
    }
    return routes;
}

function makeService() {
    const storage = {
        getSettings: () => ({ localApiKeyHash: 'abc', localApiEnabled: true, localApiPort: 18456, localApiKeyRole: 'admin' }),
        updateSettings: vi.fn(() => true),
        getTemplates: () => [],
        saveTemplates: vi.fn(),
        getDeviceProfiles: () => [],
        saveDeviceProfiles: vi.fn(),
        getWebhooks: () => [],
        saveWebhooks: vi.fn(),
        getExemptions: () => [],
        saveExemptions: vi.fn(),
        getMaintenanceWindows: () => [],
        saveMaintenanceWindows: vi.fn()
    };
    const taskManager = {
        getActiveTasks: () => [],
        pausedAll: false,
        tasks: [],
        createTask: vi.fn((data) => ({ id: 'task_api_1', toJSON: () => ({ id: 'task_api_1', ...data }) })),
        cancelTask: vi.fn(() => ({ ok: true })),
        pauseTask: vi.fn(() => ({ ok: true })),
        resumeTask: vi.fn(() => ({ ok: true })),
        snoozeTask: vi.fn(() => ({ ok: true, minutes: 10 })),
        runTaskNow: vi.fn(() => true),
        removeTask: vi.fn(() => ({ ok: true })),
        removeTerminalTasks: vi.fn(() => ({ ok: true, removed: 0 })),
        togglePauseAll: vi.fn(() => true)
    };
    return new LocalApiService(storage, taskManager, { execute: vi.fn(async () => ({ success: true })) });
}

function fakeRes() {
    return {
        statusCode: null, body: null,
        writeHead(code) { this.statusCode = code; },
        end(payload) { try { this.body = JSON.parse(payload); } catch { this.body = payload; } }
    };
}

function sampleBody(docPath) {
    if (docPath === '/tasks/timer') return { action: 'shutdown', durationMs: 60000 };
    if (docPath === '/tasks') return { action: 'sleep', trigger: { type: 'duration', durationMs: 60000 } };
    if (docPath === '/settings') return { theme: 'dark' };
    if (docPath === '/settings/security') return { autonomyMode: 'classic' };
    if (docPath === '/cloud/autosync') return { enabled: true };
    if (docPath === '/cloud/provider') return { providerId: 'onedrive' };
    if (docPath === '/cloud/folder') return { dirPath: 'C:\\Temp\\PowerPilotBackup' };
    if (docPath === '/ai/dismiss-suggestion') return { topic: 'night_sleep' };
    if (docPath === '/updates/install-on-quit') return { enabled: true };
    if (docPath === '/import/settings') return { settings: { theme: 'dark' } };
    if (docPath === '/import/templates') return { schema: 1, templates: [] };
    if (docPath === '/security/cancel-pin') return { pin: '1234' };
    return {};
}

describe('OpenAPI <-> kod paritesi (TS-5.3 + Full Headless)', () => {
    it('yaml tam arayuzsuz kontrol rotalarinin tamamini icerir (93 rota)', () => {
        const routes = parseYamlPaths(fs.readFileSync(YAML_PATH, 'utf8'));
        const keys = routes.map((r) => `${r.method} ${r.path}`).sort();
        expect(keys).toEqual([
            'GET /status',
            'GET /tasks',
            'POST /tasks',
            'POST /tasks/timer',
            'POST /tasks/clear-finished',
            'POST /tasks/pause-all',
            'DELETE /tasks/{id}',
            'POST /tasks/{id}/cancel',
            'POST /tasks/{id}/pause',
            'POST /tasks/{id}/resume',
            'POST /tasks/{id}/snooze',
            'POST /tasks/{id}/run-now',
            'GET /warning',
            'POST /warning/confirm',
            'POST /warning/snooze',
            'POST /warning/cancel',
            'POST /power/hibernate',
            'POST /power/lock',
            'POST /power/restart',
            'POST /power/shutdown',
            'POST /power/signout',
            'POST /power/sleep',
            'GET /templates',
            'POST /templates',
            'POST /templates/restore-defaults',
            'DELETE /templates/{id}',
            'POST /templates/{id}/reset',
            'POST /templates/{id}/run',
            'GET /settings',
            'PATCH /settings',
            'PATCH /settings/security',
            'GET /security/status',
            'GET /security/cancel-pin',
            'PUT /security/cancel-pin',
            'DELETE /security/cancel-pin',
            'POST /security/rotate-key',
            'GET /export/settings',
            'POST /import/settings',
            'GET /export/templates',
            'POST /import/templates',
            'GET /history',
            'DELETE /history',
            'GET /statistics',
            'GET /health',
            'POST /device/estimate',
            'POST /console/sync',
            'GET /wol/devices',
            'PUT /wol/devices',
            'POST /wol/send',
            'GET /webhooks',
            'PUT /webhooks',
            'POST /webhooks/test',
            'POST /ups/test',
            'GET /cloud/status',
            'POST /cloud/connect',
            'POST /cloud/disconnect',
            'POST /cloud/sync',
            'POST /cloud/restore',
            'POST /cloud/provider',
            'PATCH /cloud/autosync',
            'PUT /cloud/folder',
            'POST /cloud/folder/reset',
            'POST /cloud/dismiss-recovery',
            'GET /ai/status',
            'POST /ai/model/download',
            'POST /ai/model/load',
            'POST /ai/model/unload',
            'POST /ai/parse',
            'POST /ai/assist',
            'POST /ai/diagnose',
            'GET /ai/energy',
            'GET /ai/suggest',
            'POST /ai/dismiss-suggestion',
            'GET /docs/search',
            'GET /diagnostics',
            'DELETE /diagnostics',
            'POST /diagnostics/bundle',
            'GET /updates/status',
            'POST /updates/check',
            'POST /updates/download',
            'PATCH /updates/install-on-quit',
            'POST /updates/install',
            'GET /inventory',
            'POST /orders',
            'GET /orders/pending',
            'GET /exemptions',
            'POST /exemptions',
            'DELETE /exemptions/{id}',
            'GET /maintenance-windows',
            'POST /maintenance-windows',
            'DELETE /maintenance-windows/{id}',
            'GET /audit',
            'GET /audit/verify'
        ].sort());
    });

    it('yaml daki her rota kodda 404 donmez (tum uclar isKnownRoute + handler ile kapli)', () => {
        const svc = makeService();
        const routes = parseYamlPaths(fs.readFileSync(YAML_PATH, 'utf8'));
        expect(routes.length).toBe(93);
        for (const r of routes) {
            const concrete = r.path.replace('{id}', 'user_tpl_1');
            expect(LocalApiService.isKnownRoute(`/api/v1${concrete}`), `isKnownRoute false: ${concrete}`).toBe(true);
            const res = fakeRes();
            svc.route(r.method, `/api/v1${concrete}`, sampleBody(r.path), res, { role: 'admin' });
            // Not: /tasks/user_tpl_1/run-now veya /templates/user_tpl_1/run gibi kayit arayan uclar
            // kayit olmadiginda 404 TASK_NOT_FOUND / TEMPLATE_NOT_FOUND donebilir; "Endpoint not found" olmamali!
            expect(res.body && res.body.error, `${r.method} ${r.path}`).not.toBe('Endpoint not found');
        }
    });

    it('6 guc eyleminin tamami yaml da belgeli', () => {
        const text = fs.readFileSync(YAML_PATH, 'utf8');
        for (const action of ['lock', 'signout', 'restart', 'sleep', 'hibernate', 'shutdown']) {
            expect(text).toContain(`/power/${action}:`);
        }
    });
});
