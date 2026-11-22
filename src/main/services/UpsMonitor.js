/**
 * UpsMonitor.js - FAZ D + WP-12.T8
 * NUT-uyumlu UPS izleme. Tek TCP bağlantısı, `LIST VAR` yanıtı
 * `END LIST VAR` gelene kadar parse edilir; 5 sn timeout, 55 sn cache.
 * GPL lisanslı NUT kodundan bağımsız temiz-oda istemci.
 */

const net = require('net');

const DEFAULT_PORT = 3493;
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 55000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function parseVarLine(line, ups, name) {
    const m = String(line || '').match(/^VAR\s+(\S+)\s+(\S+)\s+"(.*)"\s*$/);
    if (!m || m[1] !== ups || m[2] !== name) return null;
    return m[3];
}

/** `BEGIN LIST VAR ... / VAR ... / END LIST VAR ...` bloğunu çözer. */
function parseListVars(text, ups) {
    const vars = new Map();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        const m = line.match(/^VAR\s+(\S+)\s+(\S+)\s+"(.*)"\s*$/);
        if (m && m[1] === ups) vars.set(m[2], m[3]);
    }
    return vars;
}

class UpsMonitor {
    constructor({
        host = '127.0.0.1',
        port = DEFAULT_PORT,
        ups = 'ups',
        username = null,
        password = null,
        netModule = null,
        timeoutMs = TIMEOUT_MS,
        cacheTtlMs = CACHE_TTL_MS,
        nowFn = Date.now
    } = {}) {
        // O-16: NUT komut satırına CR/LF veya boşluk enjeksiyonu reddedilir.
        if (typeof host !== 'string' || !/^[A-Za-z0-9.:\[\]_-]+$/.test(host)) {
            throw Object.assign(new Error('Geçersiz UPS host.'), { code: 'INVALID_UPS_HOST' });
        }
        if (typeof ups !== 'string' || !/^[A-Za-z0-9._-]+$/.test(ups)) {
            throw Object.assign(new Error('Geçersiz UPS adı.'), { code: 'INVALID_UPS_NAME' });
        }
        this.host = host;
        this.port = port;
        this.ups = ups;
        this.username = username;
        this.password = password;
        this.net = netModule || net;
        this.timeoutMs = timeoutMs;
        this.cacheTtlMs = cacheTtlMs;
        this.nowFn = nowFn;
        this.socket = null;
        this.connecting = null;
        this.inFlight = null;
        this.lastResult = null;
        this.lastCheckedAt = 0;
    }

    _connect() {
        if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
        if (this.connecting) return this.connecting;
        this.connecting = new Promise((resolve, reject) => {
            let settled = false;
            let timer = null;
            let sock = null;
            const fail = (err) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                this.connecting = null;
                reject(err instanceof Error ? err : new Error('UPS connect failed'));
            };
            try {
                sock = this.net.createConnection({ host: this.host, port: this.port }, () => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    this.socket = sock;
                    this.connecting = null;
                    resolve(sock);
                });
            } catch (err) {
                return fail(err);
            }
            sock.on('error', () => { /* istek dinleyicisi sonucu çözer */ });
            sock.on('close', () => {
                if (this.socket === sock) this.socket = null;
            });
            timer = setTimeout(() => {
                try { sock.destroy(); } catch (_) { /* yok say */ }
                fail(new Error('UPS connect timeout'));
            }, this.timeoutMs);
        });
        return this.connecting;
    }

    _disconnect() {
        const sock = this.socket;
        this.socket = null;
        if (sock) {
            try { sock.destroy(); } catch (_) { /* yok say */ }
        }
    }

    /** 55 sn cache; eşzamanlı çağrılar tek isteğe birleşir. */
    async query() {
        const now = this.nowFn();
        if (this.lastResult && (now - this.lastCheckedAt) < this.cacheTtlMs) {
            return { ...this.lastResult };
        }
        if (this.inFlight) return this.inFlight;
        this.inFlight = this._queryFresh().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    async _queryFresh() {
        let result;
        try {
            result = await this._listVars();
        } catch (_) {
            this._disconnect();
            result = { reachable: false };
        }
        this.lastResult = result;
        this.lastCheckedAt = this.nowFn();
        return { ...result };
    }

    async _listVars() {
        const sock = await this._connect();
        const text = await this._request(sock);
        const vars = parseListVars(text, this.ups);
        if (vars.size === 0) return { reachable: false };

        const chargeRaw = vars.has('battery.charge') ? vars.get('battery.charge') : null;
        const status = vars.get('ups.status') || '';
        const runtimeRaw = vars.has('battery.runtime') ? vars.get('battery.runtime') : null;
        const charge = chargeRaw === null ? null : Number(chargeRaw);
        return {
            reachable: true,
            charge: Number.isFinite(charge) ? charge : null,
            status,
            onBattery: /(^|\s)OB(\s|$)/.test(status),
            lowBattery: /(^|\s)LB(\s|$)/.test(status),
            runtimeSec: runtimeRaw === null || runtimeRaw === '' ? null : Number(runtimeRaw),
            model: vars.get('ups.model') || null,
            checkedAt: new Date(this.nowFn()).toISOString()
        };
    }

    _request(sock) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let buf = '';
            let bytes = 0;
            let timer = null;

            const cleanup = () => {
                if (timer) clearTimeout(timer);
                sock.removeListener('data', onData);
                sock.removeListener('error', onError);
                sock.removeListener('close', onClose);
            };
            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                if (err) reject(err);
                else resolve(value);
            };
            const onData = (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                    try { sock.destroy(); } catch (_) { /* yok say */ }
                    return finish(new Error('UPS response too large'));
                }
                buf += chunk.toString('utf8');
                if (/^ERR(?:\s|$)/m.test(buf)) {
                    return finish(new Error('UPS protocol error'));
                }
                if (/^END LIST VAR(?:\s|$)/m.test(buf)) {
                    finish(null, buf);
                }
            };
            const onError = (err) => finish(err instanceof Error ? err : new Error('UPS socket error'));
            const onClose = () => finish(new Error('UPS connection closed'));

            sock.on('data', onData);
            sock.on('error', onError);
            sock.on('close', onClose);

            timer = setTimeout(() => {
                try { sock.destroy(); } catch (_) { /* yok say */ }
                finish(new Error('UPS timeout'));
            }, this.timeoutMs);

            let cmd = '';
            if (this.username) cmd += `USERNAME ${this.username}\n`;
            if (this.password) cmd += `PASSWORD ${this.password}\n`;
            cmd += `LIST VAR ${this.ups}\n`;
            try {
                sock.write(cmd);
            } catch (err) {
                finish(err instanceof Error ? err : new Error('UPS write failed'));
            }
        });
    }

    close() {
        this._disconnect();
    }
}

module.exports = { UpsMonitor, DEFAULT_PORT, CACHE_TTL_MS, parseVarLine, parseListVars };
