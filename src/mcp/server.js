#!/usr/bin/env node
'use strict';

/**
 * src/mcp/server.js
 *
 * Built-in Model Context Protocol (MCP) JSON-RPC 2.0 server for Power Pilot.
 * Runs over stdio (supports both newline-delimited JSON-RPC and Content-Length
 * LSP-style framing) and bridges AI coding/desktop agents (Claude Desktop,
 * Cursor, Antigravity, Windsurf, Cline) to the local Power Pilot REST API.
 */

const { POWER_ACTIONS } = require('../cli/commands');
const { resolveConnection, requestJson } = require('../shared/localApiConnection');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = Object.freeze({
    name: 'powerpilot-mcp',
    version: '1.0.0',
    publisher: 'Vellium',
    homepage: 'https://vellium.dev'
});

const TOOLS = Object.freeze([
    {
        name: 'powerpilot_status',
        description: 'Get Power Pilot daemon status, version, active countdown timer, and security posture.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_schedule_timer',
        description: 'Schedule a countdown power action (shutdown, restart, sleep, hibernate, lock, signout).',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: POWER_ACTIONS,
                    description: 'Power action to execute when the timer expires.'
                },
                minutes: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 34560,
                    description: 'Countdown duration in minutes (1 to 34560).'
                },
                durationMs: {
                    type: 'integer',
                    minimum: 1000,
                    maximum: 2073600000,
                    description: 'Optional exact duration in milliseconds (overrides minutes).'
                },
                name: {
                    type: 'string',
                    maxLength: 120,
                    description: 'Optional human-readable task name.'
                }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_cancel_timer',
        description: 'Cancel a scheduled or active Power Pilot task by its taskId.',
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'Task ID to cancel (e.g., task_...).'
                }
            },
            required: ['id'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_list_tasks',
        description: 'List active and scheduled automation tasks.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 200 },
                offset: { type: 'integer', minimum: 0 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_power_action',
        description: 'Trigger an immediate safety-checked power action through the task pipeline.',
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: POWER_ACTIONS,
                    description: 'Power action to execute.'
                }
            },
            required: ['action'],
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_audit_verify',
        description: 'Verify the integrity of the local HMAC-SHA256 tamper-evident audit log chain.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_inventory',
        description: 'Retrieve local device hardware/OS inventory and power capabilities.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    },
    {
        name: 'powerpilot_pending_orders',
        description: 'List pending signed enterprise console orders.',
        inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
        }
    }
]);

const RESOURCES = Object.freeze([
    {
        uri: 'powerpilot://status',
        name: 'Power Pilot Status',
        description: 'Live status of the running Power Pilot desktop service.',
        mimeType: 'application/json'
    },
    {
        uri: 'powerpilot://tasks',
        name: 'Power Pilot Scheduled Tasks',
        description: 'Active and scheduled power automation tasks.',
        mimeType: 'application/json'
    }
]);

function defaultApiRequester(options = {}) {
    // P0-4: tek sözleşme — CLI/MCP/UI aynı env adlarını okur; TLS destekli.
    const conn = resolveConnection(process.env);
    if (options.apiKey !== undefined) conn.apiKey = options.apiKey;
    if (options.host !== undefined) conn.host = options.host;
    if (options.port !== undefined) conn.port = Number(options.port) || conn.port;
    if (options.tls !== undefined) conn.tls = options.tls === true;
    if (options.caFile !== undefined) conn.caFile = options.caFile;

    return function requestApi(method, apiPath, body = null) {
        return requestJson(conn, method, apiPath, body).catch((err) => {
            throw new Error(`Power Pilot Local API unreachable (${conn.host}:${conn.port}): ${err.message}`);
        });
    };
}

async function executeToolCall(name, args = {}, requestApi) {
    switch (name) {
        case 'powerpilot_status':
            return requestApi('GET', '/status');
        case 'powerpilot_schedule_timer': {
            const action = args.action || 'shutdown';
            if (!POWER_ACTIONS.includes(action)) {
                throw new Error(`Invalid action: ${action}`);
            }
            const durationMs = args.durationMs !== undefined
                ? Number(args.durationMs)
                : Number(args.minutes || 45) * 60000;
            if (!Number.isInteger(durationMs) || durationMs <= 0) {
                throw new Error('durationMs or minutes must be a positive integer');
            }
            const body = { action, durationMs };
            if (typeof args.name === 'string' && args.name.trim()) body.name = args.name.trim();
            return requestApi('POST', '/tasks/timer', body);
        }
        case 'powerpilot_cancel_timer': {
            if (!args.id || typeof args.id !== 'string') {
                throw new Error('id is required');
            }
            return requestApi('POST', `/tasks/${encodeURIComponent(args.id)}/cancel`);
        }
        case 'powerpilot_list_tasks': {
            const qs = new URLSearchParams();
            if (args.limit !== undefined) qs.set('limit', String(args.limit));
            if (args.offset !== undefined) qs.set('offset', String(args.offset));
            const suffix = qs.toString() ? `?${qs.toString()}` : '';
            return requestApi('GET', `/tasks${suffix}`);
        }
        case 'powerpilot_power_action': {
            const action = args.action;
            if (!POWER_ACTIONS.includes(action)) {
                throw new Error(`Invalid action: ${action}`);
            }
            return requestApi('POST', `/power/${action}`);
        }
        case 'powerpilot_audit_verify':
            return requestApi('GET', '/audit/verify');
        case 'powerpilot_inventory':
            return requestApi('GET', '/inventory');
        case 'powerpilot_pending_orders':
            return requestApi('GET', '/orders/pending');
        default:
            return null;
    }
}

async function handleRpcRequest(msg, options = {}) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return {
            jsonrpc: '2.0',
            id: msg && msg.id !== undefined ? msg.id : null,
            error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' }
        };
    }

    const requestApi = options.requestApi || defaultApiRequester(options);
    const { id, method, params } = msg;

    // Notifications have no id and produce no response
    if (id === undefined) {
        return null;
    }

    try {
        if (method === 'initialize') {
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: {
                        tools: { listChanged: false },
                        resources: { subscribe: false, listChanged: false }
                    },
                    serverInfo: SERVER_INFO
                }
            };
        }

        if (method === 'ping') {
            return { jsonrpc: '2.0', id, result: {} };
        }

        if (method === 'tools/list') {
            return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
        }

        if (method === 'tools/call') {
            const toolName = params && params.name;
            const toolArgs = (params && params.arguments) || {};
            const toolDef = TOOLS.find((t) => t.name === toolName);
            if (!toolDef) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `Unknown tool: ${String(toolName)}` }
                };
            }
            try {
                const apiRes = await executeToolCall(toolName, toolArgs, requestApi);
                const isError = !apiRes || apiRes.status >= 400;
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        isError,
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(apiRes ? apiRes.body : { error: 'Empty response' }, null, 2)
                            }
                        ]
                    }
                };
            } catch (err) {
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        isError: true,
                        content: [{ type: 'text', text: err.message }]
                    }
                };
            }
        }

        if (method === 'resources/list') {
            return { jsonrpc: '2.0', id, result: { resources: RESOURCES } };
        }

        if (method === 'resources/read') {
            const uri = params && params.uri;
            const apiPath = uri === 'powerpilot://status'
                ? '/status'
                : uri === 'powerpilot://tasks'
                    ? '/tasks'
                    : null;
            if (!apiPath) {
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `Unknown resource URI: ${String(uri)}` }
                };
            }
            const apiRes = await requestApi('GET', apiPath);
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    contents: [
                        {
                            uri,
                            mimeType: 'application/json',
                            text: JSON.stringify(apiRes.body, null, 2)
                        }
                    ]
                }
            };
        }

        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${String(method)}` }
        };
    } catch (err) {
        return {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err.message || 'Internal MCP error' }
        };
    }
}

function startStdioServer(options = {}) {
    const stdin = options.stdin || process.stdin;
    const stdout = options.stdout || process.stdout;
    let buffer = '';

    const writeResponse = (res) => {
        if (!res) return;
        stdout.write(`${JSON.stringify(res)}\n`);
    };

    // P0-4: gerçek çerçeveleme. İki biçim birlikte desteklenir:
    //  1) Content-Length: <n>\r\n\r\n<gövde>   (LSP / MCP stdio standardı)
    //  2) satır-sonlu JSON (tek satır bir JSON-RPC nesnesi)
    // Eski kod yalnızca `\n` bölüyordu; Content-Length'li istekte gövde hiç
    // tamamlanmadığı için sunucu SONSUZA KADAR kilitleniyordu.
    const drain = async () => {
        for (;;) {
            // Baştaki boş satırları at.
            buffer = buffer.replace(/^\s+/, '');
            if (!buffer) return;

            const headerMatch = /^Content-Length:\s*(\d+)\s*\r?\n/i.exec(buffer);
            if (headerMatch) {
                const len = Number(headerMatch[1]);
                const headerEnd = buffer.indexOf('\r\n\r\n');
                const sepLen = 4;
                if (headerEnd === -1) {
                    // Başlık henüz tamamlanmadı; daha fazla veri bekle.
                    if (buffer.length > 65536) buffer = ''; // bozuk başlık: sıfırla
                    return;
                }
                const bodyStart = headerEnd + sepLen;
                if (buffer.length - bodyStart < len) return; // gövde eksik: bekle
                const bodyText = buffer.slice(bodyStart, bodyStart + len);
                buffer = buffer.slice(bodyStart + len);
                let parsed;
                try {
                    parsed = JSON.parse(bodyText);
                } catch (_) {
                    continue; // bozuk çerçeve: atla, kilitlenme yok
                }
                const res = await handleRpcRequest(parsed, options);
                writeResponse(res);
                continue;
            }

            // Satır-sonlu biçim.
            const nl = buffer.indexOf('\n');
            if (nl === -1) {
                if (buffer.length > 1048576) buffer = ''; // taşma koruması
                return; // satır tamamlanmadı: bekle
            }
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || line.startsWith('Content-Length:')) continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            } catch (_) {
                continue;
            }
            const res = await handleRpcRequest(parsed, options);
            writeResponse(res);
            // Satır-sonlu yanıt da Content-Length ile istenmiş olabilir;
            // standart istemciler satır-sonlu yanıtı da kabul eder.
        }
    };

    stdin.setEncoding('utf8');
    let chain = Promise.resolve();
    stdin.on('data', (chunk) => {
        buffer += chunk;
        // Sıralı işleme: paralel async handleRpcRequest yanıtları karışmasın.
        chain = chain.then(drain).catch(() => { /* tek istek hatası akışı durdurmaz */ });
    });
    stdin.on('end', () => {
        chain = chain.then(drain).catch(() => {});
    });
}

if (require.main === module) {
    startStdioServer();
}

module.exports = {
    MCP_PROTOCOL_VERSION,
    SERVER_INFO,
    TOOLS,
    RESOURCES,
    handleRpcRequest,
    startStdioServer
};
