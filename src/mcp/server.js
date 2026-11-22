#!/usr/bin/env node
'use strict';

/**
 * src/mcp/server.js
 *
 * Built-in Model Context Protocol (MCP) JSON-RPC 2.0 server for Power Pilot.
 * Runs over stdio (supports both newline-delimited JSON-RPC and Content-Length
 * LSP-style framing) and bridges AI coding/desktop agents (Claude Desktop,
 * Cursor, Antigravity, Windsurf, Cline) to the full-parity Power Pilot Local REST API.
 */

const { resolveConnection, requestJson } = require('../shared/localApiConnection');
const { TOOLS, RESOURCES, RESOURCE_PATHS, executeToolCall } = require('./tools');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = Object.freeze({
    name: 'powerpilot-mcp',
    version: '1.0.0',
    publisher: 'Vellium',
    homepage: 'https://vellium.dev'
});

function defaultApiRequester(options = {}) {
    // P0-4: tek sozlesme - env degiskenleri oncelikli; yoksa `powerpilot init` profili okunur.
    const conn = resolveConnection(process.env, { allowProfileFile: true });
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
            const apiPath = RESOURCE_PATHS[uri] || null;
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

    const drain = async () => {
        for (;;) {
            buffer = buffer.replace(/^\s+/, '');
            if (!buffer) return;

            const headerMatch = /^Content-Length:\s*(\d+)\s*\r?\n/i.exec(buffer);
            if (headerMatch) {
                const len = Number(headerMatch[1]);
                const headerEnd = buffer.indexOf('\r\n\r\n');
                if (headerEnd === -1) {
                    if (buffer.length > 65536) buffer = '';
                    return;
                }
                const bodyStart = headerEnd + 4;
                if (buffer.length - bodyStart < len) return;
                const bodyText = buffer.slice(bodyStart, bodyStart + len);
                buffer = buffer.slice(bodyStart + len);
                let parsed;
                try { parsed = JSON.parse(bodyText); } catch (_) { continue; }
                const res = await handleRpcRequest(parsed, options);
                writeResponse(res);
                continue;
            }

            const nl = buffer.indexOf('\n');
            if (nl === -1) {
                if (buffer.length > 1048576) buffer = '';
                return;
            }
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || line.startsWith('Content-Length:')) continue;
            let parsed;
            try { parsed = JSON.parse(line); } catch (_) { continue; }
            const res = await handleRpcRequest(parsed, options);
            writeResponse(res);
        }
    };

    stdin.setEncoding('utf8');
    let chain = Promise.resolve();
    stdin.on('data', (chunk) => {
        buffer += chunk;
        chain = chain.then(drain).catch(() => { /* tek istek hatasi akisi durdurmaz */ });
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
    RESOURCE_PATHS,
    handleRpcRequest,
    startStdioServer
};
