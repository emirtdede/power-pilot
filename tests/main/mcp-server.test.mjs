/**
 * mcp-server.test.mjs - Built-in MCP Server JSON-RPC 2.0 unit tests
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    MCP_PROTOCOL_VERSION,
    SERVER_INFO,
    TOOLS,
    RESOURCES,
    handleRpcRequest
} = require('../../src/mcp/server.js');

describe('Power Pilot MCP Server (JSON-RPC 2.0)', () => {
    it('initialize protokol sürümünü ve sunucu bilgisini döner', async () => {
        const res = await handleRpcRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {}
        });
        expect(res).toEqual({
            jsonrpc: '2.0',
            id: 1,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: {
                    tools: { listChanged: false },
                    resources: { subscribe: false, listChanged: false }
                },
                serverInfo: SERVER_INFO
            }
        });
        expect(SERVER_INFO.version).toBe('1.0.0');
        expect(SERVER_INFO.publisher).toBe('Vellium');
    });

    it('tools/list tam arayuzsuz kontrol araclarini (62 tool) listeler', async () => {
        const res = await handleRpcRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list'
        });
        expect(res.result.tools).toHaveLength(TOOLS.length);
        expect(TOOLS.length).toBeGreaterThanOrEqual(62);
        const names = res.result.tools.map((t) => t.name);
        for (const expected of [
            'powerpilot_status', 'powerpilot_schedule_timer', 'powerpilot_create_task',
            'powerpilot_cancel_timer', 'powerpilot_pause_task', 'powerpilot_resume_task',
            'powerpilot_snooze_task', 'powerpilot_pause_all', 'powerpilot_list_tasks',
            'powerpilot_warning_status', 'powerpilot_warning_action',
            'powerpilot_power_action', 'powerpilot_list_templates', 'powerpilot_run_template',
            'powerpilot_reset_template', 'powerpilot_restore_templates',
            'powerpilot_get_settings', 'powerpilot_update_settings', 'powerpilot_update_security_settings',
            'powerpilot_cancel_pin', 'powerpilot_rotate_api_key',
            'powerpilot_export_data', 'powerpilot_import_data',
            'powerpilot_get_history', 'powerpilot_get_statistics', 'powerpilot_get_health',
            'powerpilot_device_estimate', 'powerpilot_console_sync',
            'powerpilot_wol_send', 'powerpilot_webhooks_list', 'powerpilot_ups_test',
            'powerpilot_cloud_status', 'powerpilot_cloud_action', 'powerpilot_cloud_folder',
            'powerpilot_ai_status', 'powerpilot_ai_model', 'powerpilot_ai_insights',
            'powerpilot_ai_parse', 'powerpilot_ai_assist', 'powerpilot_ai_diagnose', 'powerpilot_docs_search',
            'powerpilot_diagnostics', 'powerpilot_updates', 'powerpilot_updates_manage',
            'powerpilot_audit_log', 'powerpilot_audit_verify', 'powerpilot_submit_order',
            'powerpilot_manage_exemptions', 'powerpilot_manage_maintenance_windows'
        ]) {
            expect(names).toContain(expected);
        }
        expect(RESOURCES).toHaveLength(11);
    });

    it('tools/call powerpilot_schedule_timer dakikayı ms olarak yerel API’ye iletir', async () => {
        const requestApi = vi.fn(async (method, path, body) => ({
            status: 201,
            body: { ok: true, method, path, body }
        }));
        const res = await handleRpcRequest({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
                name: 'powerpilot_schedule_timer',
                arguments: { action: 'shutdown', minutes: 30, name: 'Gece Kapat' }
            }
        }, { requestApi });

        expect(requestApi).toHaveBeenCalledWith('POST', '/tasks/timer', {
            action: 'shutdown',
            durationMs: 1800000,
            name: 'Gece Kapat'
        });
        expect(res.result.isError).toBe(false);
    });

    it('resources/list ve resources/read durum kaynağını döner', async () => {
        const requestApi = vi.fn(async () => ({
            status: 200,
            body: { version: '1.0.0', activeTasks: 0 }
        }));
        const listRes = await handleRpcRequest({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
        expect(listRes.result.resources).toHaveLength(RESOURCES.length);

        const readRes = await handleRpcRequest({
            jsonrpc: '2.0',
            id: 5,
            method: 'resources/read',
            params: { uri: 'powerpilot://status' }
        }, { requestApi });
        expect(readRes.result.contents[0].uri).toBe('powerpilot://status');
        expect(JSON.parse(readRes.result.contents[0].text)).toEqual({ version: '1.0.0', activeTasks: 0 });
    });

    it('bilinmeyen metot -32601 döner ve bildirimler (id yok) null döner', async () => {
        const notif = await handleRpcRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(notif).toBeNull();

        const unknown = await handleRpcRequest({ jsonrpc: '2.0', id: 9, method: 'unknown/method' });
        expect(unknown.error.code).toBe(-32601);
    });
});
