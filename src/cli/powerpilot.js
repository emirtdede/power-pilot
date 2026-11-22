#!/usr/bin/env node
'use strict';

/**
 * src/cli/powerpilot.js
 *
 * Full-parity CLI entrypoint for Power Pilot.
 * Supports:
 *  - Zero-GUI local bootstrap (`powerpilot init`)
 *  - Embedded headless daemon (`powerpilot daemon`)
 *  - Embedded MCP stdio server (`powerpilot mcp`)
 *  - All Local REST API commands (auto-reads cli-connection.json when env vars unset)
 */

const {
    parseArgs,
    buildRequest,
    validate,
    usageText,
    renderResponse
} = require('./commands');
const { resolveConnection, requestJson } = require('../shared/localApiConnection');

function parseLocalFlags(args) {
    const out = {};
    for (let i = 0; i < args.length; i++) {
        const tok = args[i];
        if (!tok.startsWith('--')) continue;
        const eq = tok.indexOf('=');
        const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
        if (eq !== -1) {
            out[key] = tok.slice(eq + 1);
        } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
            out[key] = args[i + 1];
            i += 1;
        } else {
            out[key] = true;
        }
    }
    return out;
}

async function runCli(rawArgs, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
    const args = Array.isArray(rawArgs) ? rawArgs : [];
    const cmd = args[0];

    if (cmd === 'mcp') {
        const { startStdioServer } = require('../mcp/server');
        startStdioServer();
        return 0;
    }

    if (cmd === 'init') {
        const f = parseLocalFlags(args.slice(1));
        if (f.help) {
            stdout('Kullanim: powerpilot init [--port 18456] [--role admin|operator|viewer] [--user-data-dir <dir>] [--rotate] [--no-save-profile] [--json]');
            return 0;
        }
        const { initHeadlessConfig } = require('../agent/bootstrap');
        const res = initHeadlessConfig({
            userDataPath: typeof f['user-data-dir'] === 'string' ? f['user-data-dir'] : null,
            port: f.port ? Number(f.port) : undefined,
            host: typeof f.host === 'string' ? f.host : '127.0.0.1',
            role: typeof f.role === 'string' ? f.role : 'admin',
            enableApi: true,
            rotateKey: f.rotate === true,
            saveProfile: f['no-save-profile'] !== true
        });
        stdout(JSON.stringify(res, null, 2));
        return 0;
    }

    if (cmd === 'daemon') {
        const sub = args[1];
        if (sub === '--help' || sub === '-h') {
            stdout('Kullanim: powerpilot daemon [start|stop|status|--foreground] [--user-data-dir <dir>] [--port 18456] [--enable-api] [--json]');
            return 0;
        }
        if (sub === 'start' || sub === 'stop' || sub === 'status') {
            const f = parseLocalFlags(args.slice(2));
            const { startDaemon, stopDaemon, daemonStatus } = require('./daemonManager');
            const opts = {
                userDataDir: typeof f['user-data-dir'] === 'string' ? f['user-data-dir'] : null,
                port: f.port ? Number(f.port) : null,
                enableApi: f['enable-api'] === true,
                env
            };
            const res = sub === 'start'
                ? await startDaemon(opts)
                : (sub === 'stop' ? await stopDaemon(opts) : await daemonStatus(opts));
            if (f.json) {
                stdout(JSON.stringify(res, null, 2));
            } else if (sub === 'status') {
                stdout([
                    `Power Pilot Daemon: ${res.running ? 'RUNNING' : 'STOPPED'}`,
                    `  PID           : ${res.pid || '-'}`,
                    `  API Reachable : ${res.apiReachable ? 'YES' : 'no'}${res.port ? ` (port ${res.port})` : ''}`,
                    `  Data Dir      : ${res.dir}`
                ].join('\n'));
            } else if (sub === 'start') {
                if (!res.ok) {
                    stderr(`Hata: ${res.error || 'Daemon baslatilamadi.'}`);
                } else {
                    stdout(res.alreadyRunning
                        ? `Power Pilot daemon already running (PID ${res.pid || '?'}, port ${res.port || '?'}).`
                        : `Power Pilot daemon started (PID ${res.pid}, ${res.host || '127.0.0.1'}:${res.port || '?'}).`);
                }
            } else {
                stdout(res.stopped
                    ? `Power Pilot daemon stopped (PID ${res.pid}).`
                    : (res.message || 'No tracked headless daemon is running.'));
            }
            return res.ok ? 0 : 1;
        }
        const f = parseLocalFlags(args.slice(1));
        const { bootAgent } = require('../agent/headless');
        const handle = await bootAgent({
            userDataPath: typeof f['user-data-dir'] === 'string' ? f['user-data-dir'] : null,
            autoEnableApi: f['enable-api'] === true,
            apiPort: f.port ? Number(f.port) : null
        });
        stdout(JSON.stringify({ ok: true, mode: 'headless-daemon', dir: handle.dir, security: handle.api.getSecurityStatus() }, null, 2));
        const shutdown = async () => {
            try { await handle.stop(); } catch (_) { /* yut */ }
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        return null; // keeps daemon process alive
    }

    const parsed = parseArgs(args);
    if (parsed.flags.help) {
        stdout(usageText());
        return 0;
    }
    if (parsed.errors.length > 0) {
        for (const err of parsed.errors) stderr(`Hata: ${err}`);
        stderr('');
        stderr(usageText());
        return 2;
    }
    const check = validate(parsed);
    if (!check.ok) {
        stderr(`Hata: ${check.error}`);
        stderr('');
        stderr(usageText());
        return 2;
    }

    const connection = resolveConnection(env, { allowProfileFile: true });
    if (!connection.apiKey) {
        stderr('Hata: POWERPILOT_API_KEY tanimli degil ve cli-connection.json bulunamadi.');
        stderr('Cozum: `powerpilot init` calistirin veya POWERPILOT_API_KEY ortam degiskenini atayin.');
        return 2;
    }

    const request = buildRequest(parsed);
    try {
        const res = await requestJson(connection, request.method, request.path, request.body).catch((err) => {
            if (err && err.code === 'ECONNREFUSED') {
                throw new Error(
                    `Power Pilot yerel API'sine baglanilamadi (${connection.host}:${connection.port}). ` +
                    'Uygulama veya `powerpilot daemon` calisiyor mu?'
                );
            }
            throw err instanceof Error ? err : new Error(`API baglanti hatasi: ${err && err.message}`);
        });
        const output = renderResponse(request, res, parsed.flags);
        if (res.status >= 400) {
            stderr(output);
            return 1;
        }
        stdout(output);
        return 0;
    } catch (err) {
        stderr(err.message);
        return 1;
    }
}

if (require.main === module) {
    runCli(process.argv.slice(2)).then((code) => {
        if (typeof code === 'number' && code !== 0) process.exitCode = code;
    });
}

module.exports = { runCli, parseLocalFlags };
