'use strict';

/**
 * src/agent/bootstrap.js
 *
 * Zero-GUI bootstrapper for Power Pilot headless, CLI, and MCP workflows.
 * Solves the chicken-and-egg problem where Local API was disabled by default
 * and required opening the desktop GUI at least once to generate an API key.
 *
 * Can be invoked from:
 *  - `Power Pilot.exe --init-headless [--user-data-dir=<dir>] [--port=18456] [--role=admin]`
 *  - `powerpilot init [--user-data-dir=<dir>] [--port=18456] [--role=admin]`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const StorageService = require('../main/services/StorageService');
const Acl = require('../main/security/Acl');
const { CLI_PROFILE_FILENAME, DEFAULT_PORT } = require('../shared/localApiConnection');

const VALID_ROLES = new Set(['viewer', 'operator', 'admin']);

function resolveDefaultUserDataDir(env = process.env) {
    const appData = env && env.APPDATA ? env.APPDATA : path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'powerpilot');
}

function writePrivateProfile(dir, payload, { applyAcl = true } = {}) {
    const profilePath = path.join(dir, CLI_PROFILE_FILENAME);
    const tmpPath = `${profilePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, profilePath);
    if (applyAcl) {
        try { Acl.ensurePrivateFile(profilePath, { apply: true, efs: false }); } catch (_) { /* best-effort */ }
    }
    return profilePath;
}

/**
 * Bootstraps Local API settings and API key directly in SQLite storage without any GUI.
 *
 * @param {object} [options]
 * @param {string|null} [options.userDataPath]
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {'viewer'|'operator'|'admin'} [options.role]
 * @param {boolean} [options.enableApi]
 * @param {boolean} [options.rotateKey]
 * @param {boolean} [options.saveProfile]
 * @param {boolean} [options.applyAcl]
 * @param {string|null} [options.mcpEntryPath]
 */
function initHeadlessConfig({
    userDataPath = null,
    port = DEFAULT_PORT,
    host = '127.0.0.1',
    role = 'admin',
    enableApi = true,
    rotateKey = false,
    saveProfile = true,
    applyAcl = true,
    mcpEntryPath = null
} = {}) {
    const safePort = Number.isInteger(Number(port)) && Number(port) >= 1 && Number(port) <= 65535
        ? Number(port)
        : DEFAULT_PORT;
    const safeRole = VALID_ROLES.has(role) ? role : 'admin';
    const dir = path.resolve(userDataPath || resolveDefaultUserDataDir());
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const storage = new StorageService(dir);
    try {
        const current = storage.getSettings() || {};
        const patch = {
            localApiEnabled: enableApi !== false,
            localApiPort: safePort,
            localApiKeyRole: safeRole
        };

        let rawKey = null;
        let apiKeyMasked = current.localApiKeyMasked || null;
        const needNewKey = rotateKey === true || !current.localApiKeyHash;
        if (needNewKey) {
            rawKey = `pp_key_${crypto.randomBytes(24).toString('hex')}`;
            const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
            apiKeyMasked = `${rawKey.slice(0, 10)}...${rawKey.slice(-4)}`;
            patch.localApiKeyHash = hash;
            patch.localApiKeyMasked = apiKeyMasked;
            patch.localApiKeyCreatedAt = Date.now();
        }

        const saved = storage.updateSettings(patch);
        if (saved === false) {
            throw Object.assign(new Error('Failed to persist headless API configuration.'), { code: 'SETTINGS_PERSIST_FAILED' });
        }

        let profilePath = null;
        if (saveProfile !== false && rawKey) {
            profilePath = writePrivateProfile(dir, {
                version: 1,
                host,
                port: safePort,
                tls: current.localApiTlsEnabled === true,
                caFile: current.localApiCaFile || null,
                role: safeRole,
                apiKey: rawKey,
                updatedAt: new Date().toISOString()
            }, { applyAcl });
        } else if (saveProfile !== false) {
            // Preserve existing key in profile if present while syncing updated port/host/role
            const existingPath = path.join(dir, CLI_PROFILE_FILENAME);
            if (fs.existsSync(existingPath)) {
                try {
                    const prev = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
                    if (prev && typeof prev.apiKey === 'string' && prev.apiKey) {
                        profilePath = writePrivateProfile(dir, {
                            ...prev,
                            host,
                            port: safePort,
                            role: safeRole,
                            updatedAt: new Date().toISOString()
                        }, { applyAcl });
                    }
                } catch (_) { /* ignore malformed previous file */ }
            }
        }

        const resolvedMcp = mcpEntryPath || path.resolve(__dirname, '..', 'mcp', 'server.js');
        const packagedMcpShim = process.resourcesPath
            ? path.join(process.resourcesPath, 'bin', 'powerpilot-mcp.cmd')
            : null;
        const useShim = Boolean(!mcpEntryPath && packagedMcpShim && fs.existsSync(packagedMcpShim));
        const mcpConfig = {
            mcpServers: {
                'power-pilot': {
                    command: useShim ? packagedMcpShim : 'node',
                    args: useShim ? [] : [resolvedMcp],
                    env: {
                        POWERPILOT_API_HOST: host,
                        POWERPILOT_API_PORT: String(safePort),
                        POWERPILOT_API_KEY: rawKey || '<EXISTING_API_KEY>'
                    }
                }
            }
        };

        return {
            ok: true,
            userDataDir: dir,
            host,
            port: safePort,
            role: safeRole,
            localApiEnabled: patch.localApiEnabled,
            keyGenerated: Boolean(rawKey),
            apiKey: rawKey,
            apiKeyMasked,
            profilePath,
            mcpConfig
        };
    } finally {
        storage.close();
    }
}

module.exports = {
    initHeadlessConfig,
    resolveDefaultUserDataDir,
    writePrivateProfile,
    VALID_ROLES
};
