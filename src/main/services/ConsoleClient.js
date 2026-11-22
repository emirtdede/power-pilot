/**
 * ConsoleClient.js - FAZ B (ajan tarafı).
 * Ajan KENDİSİ konsola bağlanır (outbound HTTPS): güvenlik duvarı/NAT dostu.
 * sync(): envanter topla → heartbeat POST → gelen emirleri imzayla doğrula →
 * kuyruğa al → makbuzları bildir. İmzasız emir kuyruğa GİRMEZ (denetimde red yazılır).
 *
 * WP-02.T3: yalnızca https:// kabul edilir, CA doğrulanır, 30 sn timeout,
 * yönlendirme izlenmez; sertifika hatası kullanıcıya açık hata olarak döner.
 * WP-03.T6: sync() tek-uçuşludur; eşzamanlı çağrılar aynı Promise'i paylaşır.
 */

const https = require('https');
const { URL } = require('url');
const { SignedOrderService } = require('./SignedOrderService');
const TlsConfig = require('../security/TlsConfig');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isTlsError(err) {
    const code = String((err && err.code) || '');
    return /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_|DEPTH_|ALT_NAME|HOSTNAME_MISMATCH/.test(code);
}

class ConsoleClient {
    /**
     * @param {object} opts
     * @param {Function} [opts.fetchFn] test/legacy adaptörü (https URL kontrolü yine uygulanır)
     * @param {Function} [opts.requestFn] düşük seviye taşıma adaptörü
     */
    constructor({ storage = null, inventoryService = null, orderQueue = null, auditLog = null, fetchFn = null, requestFn = null } = {}) {
        this.storage = storage;
        this.inventory = inventoryService;
        this.queue = orderQueue;
        this.audit = auditLog;
        this._inflight = null;
        this.fetch = fetchFn || null;
        if (requestFn) this.request = requestFn;
        else if (fetchFn) this.request = this.fetchTransport(fetchFn);
        else this.request = this.httpsTransport.bind(this);
    }

    settings() {
        if (this.storage && typeof this.storage.getSettings === 'function') {
            return this.storage.getSettings();
        }
        return {};
    }

    isConfigured() {
        const s = this.settings();
        return !!(s.consoleUrl && s.consolePublicKeyPem && s.consoleAgentKey);
    }

    /**
     * Test/legacy fetch adaptörü - fetch semantiğiyle aynı yanıtı döner.
     */
    fetchTransport(fetchFn) {
        return async (url, opts) => {
            const res = await fetchFn(url, { ...opts, redirect: 'manual' });
            return res;
        };
    }

    /**
     * Üretim taşıması: https.request + doğrulanmış CA + sabit timeout.
     * Yönlendirme izlenmez; 3xx yanıtı olduğu gibi döner.
     */
    httpsTransport(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            let u;
            try {
                u = new URL(urlStr);
            } catch (err) {
                return reject(Object.assign(new Error('Konsol URL geçersiz.'), { code: 'INVALID_URL' }));
            }
            if (u.protocol !== 'https:') {
                return reject(Object.assign(new Error('Konsol TLS gerektirir (https://).'), { code: 'TLS_REQUIRED' }));
            }
            const tlsOptions = TlsConfig.buildClientOptions(this.settings());
            const req = https.request({
                hostname: u.hostname,
                port: u.port || 443,
                path: `${u.pathname}${u.search}`,
                method,
                headers,
                timeout: REQUEST_TIMEOUT_MS,
                ...tlsOptions
            }, (res) => {
                const chunks = [];
                let size = 0;
                let aborted = false;
                res.on('data', (chunk) => {
                    if (aborted) return;
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        aborted = true;
                        try { req.destroy(Object.assign(new Error('Konsol yanıtı çok büyük.'), { code: 'RESPONSE_TOO_LARGE' })); } catch (_) {}
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (aborted) return;
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        headers: res.headers,
                        text,
                        json: async () => JSON.parse(text)
                    });
                });
            });
            req.on('timeout', () => {
                req.destroy(Object.assign(new Error('Konsol isteği zaman aşımı (30 sn).'), { code: 'TIMEOUT' }));
            });
            req.on('error', reject);
            if (body) req.write(body);
            req.end();
        });
    }

    /**
     * WP-03.T6 / M-08: aynı anda gelen sync() çağrıları aynı Promise'i döner.
     */
    sync() {
        if (this._inflight) return this._inflight;
        this._inflight = this._syncOnce().finally(() => { this._inflight = null; });
        return this._inflight;
    }

    async _syncOnce() {
        if (!this.isConfigured()) {
            return { ok: false, code: 'NOT_CONFIGURED', error: 'Konsol URL/anahtar tanımsız.' };
        }
        const s = this.settings();
        const base = String(s.consoleUrl).replace(/\/+$/, '');
        // T-TLS-03: düz HTTP URL'de istek hiç gitmez.
        if (!/^https:\/\//i.test(base)) {
            return { ok: false, code: 'TLS_REQUIRED', error: 'Konsol URL https:// olmalı; düz HTTP kabul edilmez.' };
        }
        let inv = null;
        try {
            inv = this.inventory ? await this.inventory.collect() : null;
        } catch (err) {
            return { ok: false, code: 'INVENTORY_FAILED', error: (err && err.message) || 'Envanter alınamadı.' };
        }
        // Denetim: önceki turda icra edilenlerin makbuzları bu heartbeat'e eklenir.
        // Konsol makbuzu denetime işler; döngü böylece uçtan-uca kapanır.
        let receipts = [];
        try {
            if (this.queue && typeof this.queue.peekUnsentReceipts === 'function') {
                receipts = this.queue.peekUnsentReceipts();
            } else if (this.queue && typeof this.queue.takeUnsentReceipts === 'function') {
                receipts = this.queue.takeUnsentReceipts();
            }
        } catch (_) {
            receipts = [];
        }
        let res;
        try {
            res = await this.request(`${base}/api/v1/heartbeat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': s.consoleAgentKey },
                body: JSON.stringify({ agentId: inv && inv.agentId, inventory: inv, receipts })
            });
        } catch (err) {
            try {
                if (this.queue && typeof this.queue.markReceiptsFailed === 'function') {
                    this.queue.markReceiptsFailed(receipts, (err && err.message) || 'Konsola erişilemedi.');
                }
            } catch (_) { /* makbuz işaretleme senkronu engellemez */ }
            if (isTlsError(err)) {
                return {
                    ok: false,
                    code: 'TLS_CERTIFICATE_ERROR',
                    error: `Konsol sertifikası doğrulanamadı: ${(err && err.message) || 'bilinmeyen TLS hatası'}`
                };
            }
            if (err && err.code === 'TLS_REQUIRED') {
                return { ok: false, code: 'TLS_REQUIRED', error: err.message };
            }
            return { ok: false, code: 'CONSOLE_UNREACHABLE', error: (err && err.message) || 'Konsola erişilemedi.' };
        }
        if (!res || !res.ok) {
            const status = res && res.status;
            try {
                if (this.queue && typeof this.queue.markReceiptsFailed === 'function') {
                    this.queue.markReceiptsFailed(receipts, `HTTP ${status}`);
                }
            } catch (_) { /* yut */ }
            if (status === 401 || status === 403) {
                return { ok: false, code: 'CONSOLE_UNAUTHORIZED', error: 'Ajan anahtarı reddedildi (consoleAgentKey).' };
            }
            if (status >= 300 && status < 400) {
                return { ok: false, code: 'CONSOLE_REDIRECT', error: `Konsol yönlendirmesi reddedildi (HTTP ${status}).` };
            }
            return { ok: false, code: 'CONSOLE_ERROR', error: `Konsol yanıtı: ${status}` };
        }

        // WP-07: 2xx = teslim edildi. 204/boş gövde JSON değildir; makbuz yine
        // gönderilmiş sayılır ve tekrar gönderilmez.
        try {
            if (this.queue && typeof this.queue.markReceiptsSent === 'function') {
                this.queue.markReceiptsSent(receipts);
            }
        } catch (_) { /* yut */ }

        let payload = {};
        if (res.status !== 204) {
            try {
                payload = await res.json();
            } catch (_) {
                return { ok: false, code: 'BAD_RESPONSE', error: 'Konsol yanıtı JSON değil.' };
            }
        }
        // Denetim (kill-switch): konsol bayrağı yerelde kalıcılaşır; icra hattı durur,
        // heartbeat sürer (konsol yeniden açabilir).
        const wantDisabled = payload.disabled === true;
        let disabled = !!s.agentDisabled;
        if (wantDisabled !== !!s.agentDisabled) {
            try {
                if (!this.storage || typeof this.storage.updateSettings !== 'function') {
                    throw Object.assign(new Error('Ayar deposu yok.'), { code: 'SETTINGS_UNAVAILABLE' });
                }
                if (this.storage.updateSettings({ agentDisabled: wantDisabled }) === false) {
                    throw Object.assign(new Error('Kill-switch kalıcılaştırılamadı.'), { code: 'SETTINGS_PERSIST_FAILED' });
                }
                disabled = wantDisabled;
                if (this.audit) {
                    this.audit.append({ actor: 'console', action: wantDisabled ? 'agent_disabled' : 'agent_enabled', detail: '' });
                }
            } catch (err) {
                // Y-04: bayrak yazılamıyorsa icra hattı ASLA açılmaz (fail-closed).
                return {
                    ok: false,
                    code: 'KILL_SWITCH_PERSIST_FAILED',
                    disabled: true,
                    error: (err && err.message) || 'Kill-switch kalıcılaştırılamadı.'
                };
            }
        }
        if (disabled) {
            return { ok: true, accepted: 0, rejected: 0, details: [], disabled: true, serverTime: payload.serverTime || null };
        }
        const verifier = new SignedOrderService({
            publicKeyPem: s.consolePublicKeyPem,
            keyId: s.consoleKeyId || 'default',
            agentId: (inv && inv.agentId) || s.agentId || null,
            storage: this.storage
        });
        const orders = Array.isArray(payload.orders) ? payload.orders : [];
        let accepted = 0;
        let rejected = 0;
        const details = [];
        for (const signed of orders) {
            const v = verifier.verify(signed);
            if (!v.ok) {
                rejected++;
                details.push({ ok: false, code: v.code });
                if (this.audit) this.audit.append({ actor: 'console', action: 'order_rejected', detail: v.code || 'red' });
                continue;
            }
            try {
                const { duplicate } = this.queue.enqueue(signed);
                accepted++;
                if (this.audit) {
                    this.audit.append({
                        actor: 'console',
                        action: duplicate ? 'order_duplicate' : 'order_queued',
                        target: v.order && v.order.action,
                        detail: (v.order && v.order.nonce) || ''
                    });
                }
            } catch (err) {
                rejected++;
                details.push({ ok: false, code: (err && err.code) || 'QUEUE_FAILED' });
            }
        }
        return { ok: true, accepted, rejected, details, serverTime: payload.serverTime || null };
    }
}

module.exports = { ConsoleClient };
