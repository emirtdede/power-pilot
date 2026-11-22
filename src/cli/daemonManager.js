'use strict';

/**
 * src/cli/daemonManager.js
 *
 * Background headless daemon lifecycle manager (`powerpilot daemon start|stop|status`).
 * Tracks PID in `<userDataDir>/headless-daemon.pid` and verifies live Local API readiness.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveDefaultUserDataDir } = require('../agent/bootstrap');
const { resolveConnection, requestJson, CLI_PROFILE_FILENAME } = require('../shared/localApiConnection');

const PID_FILENAME = 'headless-daemon.pid';

function pidFilePath(userDataDir) {
    return path.join(path.resolve(userDataDir || resolveDefaultUserDataDir()), PID_FILENAME);
}

function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return Boolean(err && err.code === 'EPERM');
    }
}

function readPidMeta(userDataDir) {
    const file = pidFilePath(userDataDir);
    if (!fs.existsSync(file)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && Number.isInteger(parsed.pid)) return parsed;
    } catch (_) { /* ignore */ }
    return null;
}

function writePidMeta(userDataDir, meta) {
    const dir = path.resolve(userDataDir || resolveDefaultUserDataDir());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFilePath(dir), JSON.stringify(meta, null, 2) + '\n', 'utf8');
}

function removePidMeta(userDataDir) {
    try { fs.unlinkSync(pidFilePath(userDataDir)); } catch (_) { /* ignore */ }
}

function resolveSpawnSpec({ userDataDir, port, enableApi }) {
    const isElectron = Boolean(process.versions && process.versions.electron);
    const args = [];
    if (isElectron) {
        // Inside packaged Electron or electron dev runtime
        const isPackagedExe = !/electron(?:\.exe)?$/i.test(path.basename(process.execPath));
        if (!isPackagedExe) {
            args.push(path.resolve(__dirname, '..', '..'));
        }
        args.push('--headless', `--user-data-dir=${userDataDir}`);
        if (enableApi) args.push('--enable-api');
        if (port) args.push(`--port=${port}`);
        return { command: process.execPath, args };
    }
    const headlessEntry = path.resolve(__dirname, '..', 'agent', 'headless.js');
    args.push(headlessEntry, userDataDir);
    return { command: process.execPath, args };
}

async function pingApi(userDataDir, env = process.env) {
    const profilePath = path.join(userDataDir, CLI_PROFILE_FILENAME);
    const conn = resolveConnection(env, { allowProfileFile: true, profilePath });
    if (!conn.apiKey) return { reachable: false, reason: 'NO_API_KEY', conn };
    try {
        const res = await requestJson(conn, 'GET', '/status', null, { timeoutMs: 2500 });
        return { reachable: res.status === 200, status: res.status, body: res.body, conn };
    } catch (err) {
        return { reachable: false, reason: (err && err.code) || err.message, conn };
    }
}

async function daemonStatus({ userDataDir = null, env = process.env } = {}) {
    const dir = path.resolve(userDataDir || resolveDefaultUserDataDir(env));
    const meta = readPidMeta(dir);
    const alive = meta ? isProcessAlive(meta.pid) : false;
    if (meta && !alive) removePidMeta(dir);
    const api = await pingApi(dir, env);
    return {
        ok: true,
        running: alive || api.reachable,
        pid: alive ? meta.pid : null,
        dir,
        apiReachable: api.reachable,
        port: api.conn ? api.conn.port : null,
        status: api.body || null
    };
}

async function startDaemon({ userDataDir = null, port = null, enableApi = false, waitMs = 12000, env = process.env } = {}) {
    const dir = path.resolve(userDataDir || resolveDefaultUserDataDir(env));
    const existing = await daemonStatus({ userDataDir: dir, env });
    if (existing.running && existing.apiReachable) {
        return { ok: true, alreadyRunning: true, ...existing };
    }

    const spec = resolveSpawnSpec({ userDataDir: dir, port, enableApi });
    const child = spawn(spec.command, spec.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...env }
    });
    child.unref();

    writePidMeta(dir, {
        pid: child.pid,
        dir,
        startedAt: new Date().toISOString()
    });

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(child.pid)) {
            removePidMeta(dir);
            return { ok: false, code: 'DAEMON_EXITED', error: 'Headless daemon exited before Local API became ready.', dir };
        }
        const ping = await pingApi(dir, env);
        if (ping.reachable) {
            return {
                ok: true,
                started: true,
                pid: child.pid,
                dir,
                host: ping.conn.host,
                port: ping.conn.port,
                status: ping.body
            };
        }
        await new Promise((r) => setTimeout(r, 250));
    }

    return {
        ok: isProcessAlive(child.pid),
        started: true,
        pid: child.pid,
        dir,
        apiReachable: false,
        note: 'Daemon started; run `powerpilot init` if Local API is not yet enabled.'
    };
}

async function stopDaemon({ userDataDir = null, env = process.env } = {}) {
    const dir = path.resolve(userDataDir || resolveDefaultUserDataDir(env));
    const meta = readPidMeta(dir);
    if (!meta || !isProcessAlive(meta.pid)) {
        removePidMeta(dir);
        return { ok: true, stopped: false, message: 'No tracked headless daemon is running.', dir };
    }
    try {
        process.kill(meta.pid, 'SIGTERM');
    } catch (_) {
        try { process.kill(meta.pid); } catch (__) { /* yut */ }
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(meta.pid)) {
        await new Promise((r) => setTimeout(r, 150));
    }
    if (isProcessAlive(meta.pid)) {
        try { process.kill(meta.pid, 'SIGKILL'); } catch (_) { /* yut */ }
    }
    removePidMeta(dir);
    return { ok: true, stopped: true, pid: meta.pid, dir };
}

module.exports = {
    PID_FILENAME,
    pidFilePath,
    isProcessAlive,
    daemonStatus,
    startDaemon,
    stopDaemon
};
