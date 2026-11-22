/**
 * src/shared/localApiConnection.js - P0-4 (tek gerçek: API bağlantı sözleşmesi)
 *
 * CLI ve MCP aynı yerel API'ye bağlanır; ikisi de BURADAN okur. Daha önce
 * UI/connectionAgent/DocsKnowledgeBase `POWER_PILOT_API_*` (alt çizgili)
 * üretirken CLI/MCP `POWERPILOT_API_*` (bitişik) okuyordu → kopyala-yapıştır
 * yapan her kullanıcı 401 alıyordu.
 *
 * Kural: bitişik ad kanonik; alt çizgili ad geriye-uyum için fallback.
 * TLS: `*_API_TLS=1` ise https kullanılır (sertifika doğrulaması
 * `*_API_CA` ile özelleştirilebilir; self-signed için CA yolu verin).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const CANONICAL_KEY = 'POWERPILOT_API_KEY';
const CANONICAL_HOST = 'POWERPILOT_API_HOST';
const CANONICAL_PORT = 'POWERPILOT_API_PORT';
const CANONICAL_TLS = 'POWERPILOT_API_TLS';
const CANONICAL_CA = 'POWERPILOT_API_CA';
const CANONICAL_PROFILE = 'POWERPILOT_CONFIG';
const CLI_PROFILE_FILENAME = 'cli-connection.json';

const LEGACY = {
    [CANONICAL_KEY]: 'POWER_PILOT_API_KEY',
    [CANONICAL_HOST]: 'POWER_PILOT_API_HOST',
    [CANONICAL_PORT]: 'POWER_PILOT_API_PORT',
    [CANONICAL_TLS]: 'POWER_PILOT_API_TLS',
    [CANONICAL_CA]: 'POWER_PILOT_API_CA',
    [CANONICAL_PROFILE]: 'POWER_PILOT_CONFIG'
};

const DEFAULT_PORT = 18456;

/** Kanonik ad -> eski (alt çizgili) ad fallback'i ile ortam değişkeni okur. */
function readEnv(env, name) {
    const source = env || process.env;
    const primary = source[name];
    if (primary !== undefined && primary !== '') return primary;
    const legacy = LEGACY[name];
    if (legacy && source[legacy] !== undefined && source[legacy] !== '') return source[legacy];
    return undefined;
}

/** Varsayilan kullanici CLI/MCP baglanti profil yolu (%APPDATA%/powerpilot/cli-connection.json). */
function defaultProfilePaths(env = process.env) {
    const list = [];
    const custom = readEnv(env, CANONICAL_PROFILE);
    if (custom) list.push(path.resolve(custom));
    const appData = env && env.APPDATA ? env.APPDATA : path.join(os.homedir(), 'AppData', 'Roaming');
    list.push(path.join(appData, 'powerpilot', CLI_PROFILE_FILENAME));
    const programData = env && (env.ProgramData || env.ALLUSERSPROFILE);
    if (programData) {
        list.push(path.join(programData, 'PowerPilot', 'Agent', CLI_PROFILE_FILENAME));
    }
    return list;
}

/** Diskteki cli-connection.json profilini guvenli sekilde okur; yoksa null doner. */
function readProfileFile(env = process.env, profilePath = null) {
    const candidates = profilePath ? [path.resolve(profilePath)] : defaultProfilePaths(env);
    for (const filePath of candidates) {
        try {
            if (!fs.existsSync(filePath)) continue;
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            return {
                profilePath: filePath,
                apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
                host: typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host.trim() : null,
                port: Number.isInteger(Number(parsed.port)) ? Number(parsed.port) : null,
                tls: parsed.tls === true,
                caFile: typeof parsed.caFile === 'string' && parsed.caFile.trim() ? parsed.caFile.trim() : null
            };
        } catch (_) {
            // Bozuk veya okunamayan profil atlanir; sonraki aday denenir.
        }
    }
    return null;
}

/**
 * Ortamdan baglanti bilgisini cozer.
 * Ortam degiskenleri HER ZAMAN onceliklidir. `allowProfileFile: true` verilirse
 * eksik alanlar `cli-connection.json` (zero-GUI `powerpilot init`) profilinden tamamlanir.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{allowProfileFile?: boolean, profilePath?: string|null}} [options]
 * @returns {{apiKey:string, host:string, port:number, tls:boolean, caFile:string|null, profilePath?:string|null}}
 */
function resolveConnection(env, options = {}) {
    const allowProfile = options && options.allowProfileFile === true && readEnv(env, 'POWERPILOT_NO_PROFILE') !== '1';
    const profile = allowProfile ? readProfileFile(env, options.profilePath || null) : null;

    const envKey = readEnv(env, CANONICAL_KEY);
    const envHost = readEnv(env, CANONICAL_HOST);
    const envPort = readEnv(env, CANONICAL_PORT);
    const envTls = readEnv(env, CANONICAL_TLS);
    const envCa = readEnv(env, CANONICAL_CA);

    const rawPort = envPort !== undefined ? envPort : (profile && profile.port ? profile.port : undefined);
    const parsedPort = Number(rawPort);
    const tlsRaw = envTls !== undefined ? String(envTls).toLowerCase() : null;
    const tls = tlsRaw !== null
        ? (tlsRaw === '1' || tlsRaw === 'true' || tlsRaw === 'yes')
        : Boolean(profile && profile.tls === true);
    const caFile = envCa || (profile && profile.caFile) || null;
    const out = {
        apiKey: String(envKey !== undefined ? envKey : (profile && profile.apiKey) || ''),
        host: String(envHost !== undefined ? envHost : (profile && profile.host) || '127.0.0.1'),
        port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT,
        tls,
        caFile
    };
    if (profile && profile.profilePath) {
        out.profilePath = profile.profilePath;
    }
    return out;
}

/** TLS seçimine göre transport modülü + istek seçenekleri. */
function transportFor(conn) {
    if (!conn.tls) return { mod: http, extra: {} };
    const extra = {};
    if (conn.caFile) {
        try {
            extra.ca = fs.readFileSync(conn.caFile);
        } catch (err) {
            throw new Error(`CA sertifikası okunamadı (${conn.caFile}): ${err.message}`);
        }
    }
    return { mod: https, extra };
}

/**
 * Ortak JSON istek yardımcısı (CLI + MCP).
 * @returns {Promise<{status:number, body:any}>}
 */
function requestJson(conn, method, apiPath, body = null, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        let transport;
        try {
            transport = transportFor(conn);
        } catch (err) {
            return reject(err);
        }
        const payload = body ? JSON.stringify(body) : '';
        const req = transport.mod.request({
            hostname: conn.host,
            port: conn.port,
            path: `/api/v1${apiPath}`,
            method,
            timeout: timeoutMs,
            headers: {
                'X-API-Key': conn.apiKey,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            ...transport.extra
        }, (res) => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => {
                let parsed = raw;
                try { parsed = JSON.parse(raw); } catch (_) { /* düz metin yanıt */ }
                resolve({ status: res.statusCode || 500, body: parsed });
            });
        });
        req.on('timeout', () => {
            req.destroy(Object.assign(new Error(`İstek zaman aşımı (${timeoutMs} ms)`), { code: 'ETIMEDOUT' }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

module.exports = {
    CANONICAL_KEY,
    CANONICAL_HOST,
    CANONICAL_PORT,
    CANONICAL_TLS,
    CANONICAL_CA,
    CANONICAL_PROFILE,
    CLI_PROFILE_FILENAME,
    DEFAULT_PORT,
    readEnv,
    defaultProfilePaths,
    readProfileFile,
    resolveConnection,
    transportFor,
    requestJson
};
