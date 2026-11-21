/**
 * src/shared/localApiConnection.js — P0-4 (tek gerçek: API bağlantı sözleşmesi)
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
const http = require('http');
const https = require('https');

const CANONICAL_KEY = 'POWERPILOT_API_KEY';
const CANONICAL_HOST = 'POWERPILOT_API_HOST';
const CANONICAL_PORT = 'POWERPILOT_API_PORT';
const CANONICAL_TLS = 'POWERPILOT_API_TLS';
const CANONICAL_CA = 'POWERPILOT_API_CA';

const LEGACY = {
    [CANONICAL_KEY]: 'POWER_PILOT_API_KEY',
    [CANONICAL_HOST]: 'POWER_PILOT_API_HOST',
    [CANONICAL_PORT]: 'POWER_PILOT_API_PORT',
    [CANONICAL_TLS]: 'POWER_PILOT_API_TLS',
    [CANONICAL_CA]: 'POWER_PILOT_API_CA'
};

const DEFAULT_PORT = 18456;

/** Kanonik ad → eski (alt çizgili) ad fallback'i ile ortam değişkeni okur. */
function readEnv(env, name) {
    const source = env || process.env;
    const primary = source[name];
    if (primary !== undefined && primary !== '') return primary;
    const legacy = LEGACY[name];
    if (legacy && source[legacy] !== undefined && source[legacy] !== '') return source[legacy];
    return undefined;
}

/**
 * Ortamdan bağlantı bilgisini çözer.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{apiKey:string, host:string, port:number, tls:boolean, caFile:string|null}}
 */
function resolveConnection(env) {
    const rawPort = readEnv(env, CANONICAL_PORT);
    const parsedPort = Number(rawPort);
    const tlsRaw = String(readEnv(env, CANONICAL_TLS) || '').toLowerCase();
    const caFile = readEnv(env, CANONICAL_CA) || null;
    return {
        apiKey: String(readEnv(env, CANONICAL_KEY) || ''),
        host: String(readEnv(env, CANONICAL_HOST) || '127.0.0.1'),
        port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT,
        tls: tlsRaw === '1' || tlsRaw === 'true' || tlsRaw === 'yes',
        caFile
    };
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
    DEFAULT_PORT,
    readEnv,
    resolveConnection,
    transportFor,
    requestJson
};
