/**
 * WebhookService.js - WP-12
 * SSRF-korumalı, HTTPS-only, HMAC imzalı webhook teslimatı.
 * Ağ hatası/5xx/429 için en fazla 3 deneme; yönlendirme izlenmez.
 */

const https = require('https');
const crypto = require('crypto');
const os = require('os');
const log = require('../logger');
const { SsrfGuard, validateUrl } = require('../security/SsrfGuard');

const APP_VERSION = (() => {
    try { return require('../../../package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; }
})();

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_BASE_MS = [2000, 8000, 30000];
const MAX_RESPONSE_BYTES = 64 * 1024;

function isRetryableStatus (status) {
    return status === 429 || (status >= 500 && status <= 599);
}

class WebhookService {
    constructor (storageService, options = {}) {
        this.storage = storageService;
        this.guard = new SsrfGuard({ lookupFn: options.lookupFn });
        this.httpsRequest = options.httpsRequest || https.request;
        this.setTimeoutFn = options.setTimeoutFn || setTimeout;
        this.clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        this.nowFn = options.nowFn || Date.now;
        this.jitterFn = options.jitterFn || Math.random;
        this.maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
        // O-11: eşzamanlı webhook teslimatı sınırlıdır (bağlantı patlaması yok).
        this.maxConcurrent = options.maxConcurrent || 5;
        this._activeDeliveries = 0;
        this._deliveryQueue = [];
    }

    _enqueue (task) {
        this._deliveryQueue.push(task);
        this._drainQueue();
    }

    _drainQueue () {
        while (this._activeDeliveries < this.maxConcurrent && this._deliveryQueue.length > 0) {
            const task = this._deliveryQueue.shift();
            this._activeDeliveries += 1;
            Promise.resolve()
                .then(task)
                .catch((err) => log.warn('[WebhookService] teslimat beklenmeyen hata:', err && err.message))
                .finally(() => {
                    this._activeDeliveries -= 1;
                    this._drainQueue();
                });
        }
    }

    /**
     * @param {string} eventType
     * @param {object} taskOrData
     */
    triggerEvent (eventType, taskOrData = {}) {
        const webhooks = this.storage ? this.storage.getWebhooks() : [];
        const activeWebhooks = webhooks.filter((w) => w.enabled && (w.events || []).includes(eventType));
        if (activeWebhooks.length === 0) return;

        const payload = this.buildPayload(eventType, taskOrData);
        activeWebhooks.forEach((hook) => {
            this._enqueue(() => this.sendPayload(hook, payload));
        });
    }

    buildPayload (eventType, data) {
        const settings = this.storage ? this.storage.getSettings() : {};
        const eventId = `evt_${crypto.randomUUID()}`;
        // WP-12.T6: yalnızca tanımlı alanlar; secret/anahtar asla payload'a girmez.
        return {
            eventId,
            event: eventType,
            occurredAt: new Date(this.nowFn()).toISOString(),
            deviceId: settings.agentId || os.hostname(),
            deviceName: os.hostname(),
            appVersion: APP_VERSION,
            data: data && data.id ? {
                taskId: data.id,
                name: data.name,
                source: data.source,
                status: data.status,
                action: data.action
            } : null
        };
    }

    static retryDelay (attempt, jitter = 0) {
        const base = RETRY_BASE_MS[Math.max(0, attempt - 1)] || RETRY_BASE_MS[RETRY_BASE_MS.length - 1];
        return base + Math.floor(Math.max(0, Math.min(1, jitter)) * 250);
    }

    /**
     * @returns {Promise<{ok:boolean,code?:string,status?:number}>}
     */
    async sendPayload (hook, payload, attempt = 1) {
        if (!hook || !hook.url) return { ok: false, code: 'INVALID_URL' };
        const urlInfo = validateUrl(hook.url);
        if (!urlInfo.ok) {
            log.error(`[WebhookService] URL reddedildi (${urlInfo.reason || urlInfo.code}): ${String(hook.url).slice(0, 120)}`);
            return { ok: false, code: urlInfo.code, reason: urlInfo.reason };
        }

        const resolved = await this.guard.resolvePublicAddress(urlInfo.hostname);
        if (!resolved.ok) {
            log.error(`[WebhookService] SSRF denetimi reddetti (${resolved.reason || resolved.code}): ${urlInfo.hostname}`);
            return { ok: false, code: resolved.code, reason: resolved.reason };
        }

        return this.deliver(hook, payload, attempt, urlInfo, resolved);
    }

    deliver (hook, payload, attempt, urlInfo, resolved) {
        return new Promise((resolve) => {
            let settled = false;
            let req = null;
            let hardTimer = null;

            const finish = (result, retryable) => {
                if (settled) return;
                settled = true;
                if (hardTimer) {
                    this.clearTimeoutFn(hardTimer);
                    hardTimer = null;
                }
                if (retryable && attempt < this.maxAttempts) {
                    const delay = WebhookService.retryDelay(attempt, this.jitterFn());
                    this.setTimeoutFn(() => {
                        // O-11: retry reddederse dış Promise sonsuza kadar pending kalmasın.
                        this.sendPayload(hook, payload, attempt + 1).then(
                            (result) => resolve(result),
                            (err) => resolve({ ok: false, code: 'RETRY_FAILED', error: err && err.message })
                        );
                    }, delay);
                    return;
                }
                resolve(result);
            };

            const body = JSON.stringify(payload);
            const timestamp = Math.floor(this.nowFn() / 1000).toString();
            const headers = {
                'Content-Type': 'application/json',
                'User-Agent': 'PowerPilot-Webhook/2.0',
                'Content-Length': Buffer.byteLength(body),
                'Idempotency-Key': String(payload.eventId || `${Date.now()}`),
                Host: urlInfo.hostHeader,
                'X-PowerPilot-Timestamp': timestamp
            };
            if (hook.hmacSecret) {
                const digest = crypto.createHmac('sha256', hook.hmacSecret)
                    .update(`${timestamp}.${body}`)
                    .digest('hex');
                headers['X-PowerPilot-Signature'] = `sha256=${digest}`;
            }
            if (hook.bearerToken) {
                headers.Authorization = `Bearer ${hook.bearerToken}`;
            } else if (hook.basicAuthUser && hook.basicAuthPass) {
                const auth = Buffer.from(`${hook.basicAuthUser}:${hook.basicAuthPass}`).toString('base64');
                headers.Authorization = `Basic ${auth}`;
            }
            // Kullanıcı başlıkları güvenlik başlıklarını EZEMEZ.
            if (hook.customHeaders && typeof hook.customHeaders === 'object') {
                for (const [name, value] of Object.entries(hook.customHeaders)) {
                    if (typeof name !== 'string' || typeof value !== 'string') continue;
                    if (/^(host|content-length|content-type|authorization|idempotency-key|x-powerpilot-(timestamp|signature))$/i.test(name)) continue;
                    headers[name] = value;
                }
            }

            const options = {
                hostname: resolved.address,
                family: resolved.family,
                port: urlInfo.port,
                path: urlInfo.path,
                method: 'POST',
                headers,
                timeout: REQUEST_TIMEOUT_MS,
                servername: urlInfo.hostname,
                lookup: SsrfGuard.pinnedLookup(resolved.address, resolved.family),
                rejectUnauthorized: true,
                agent: false
            };

            hardTimer = this.setTimeoutFn(() => {
                if (settled) return;
                if (req) req.destroy();
                log.warn(`[WebhookService] Zaman aşımı: ${urlInfo.hostname}`);
                finish({ ok: false, code: 'WEBHOOK_TIMEOUT' }, true);
            }, REQUEST_TIMEOUT_MS);

            try {
                req = this.httpsRequest(options, (res) => {
                    const status = res.statusCode || 0;
                    let received = 0;
                    res.on('data', (chunk) => {
                        received += chunk.length;
                        if (received > MAX_RESPONSE_BYTES) res.destroy();
                    });
                    res.on('end', () => {
                        if (status >= 200 && status < 300) {
                            log.info(`[WebhookService] ${payload.event} → ${hook.name || urlInfo.hostname} (${status})`);
                            finish({ ok: true, status }, false);
                        } else {
                            log.warn(`[WebhookService] ${hook.name || urlInfo.hostname} HTTP ${status}`);
                            finish({ ok: false, status, code: `HTTP_${status}` }, isRetryableStatus(status));
                        }
                    });
                    res.on('error', () => finish({ ok: false, code: 'NETWORK_ERROR' }, true));
                });
            } catch (_) {
                finish({ ok: false, code: 'NETWORK_ERROR' }, true);
                return;
            }

            req.on('error', (err) => {
                log.warn(`[WebhookService] ağ hatası: ${urlInfo.hostname} (${err && err.message})`);
                finish({ ok: false, code: 'NETWORK_ERROR' }, true);
            });
            req.on('timeout', () => {
                if (req) req.destroy();
                finish({ ok: false, code: 'WEBHOOK_TIMEOUT' }, true);
            });
            req.end(body);
        });
    }

    // WBS-5.2: Gizli alan adları (UI'ya asla plain-text dönmez).
    static secretFields () {
        return ['bearerToken', 'basicAuthPass', 'hmacSecret'];
    }

    static redactForUi (list) {
        return (list || []).map((hook) => {
            const copy = { ...hook };
            let hasSecret = false;
            for (const field of WebhookService.secretFields()) {
                if (copy[field]) {
                    hasSecret = true;
                    delete copy[field];
                }
            }
            copy.hasSecret = hasSecret;
            return copy;
        });
    }

    static mergeSecrets (incoming, existing) {
        const byUrl = new Map((existing || []).map((h) => [h.url, h]));
        return (incoming || []).map((hook) => {
            const merged = { ...hook };
            const prev = byUrl.get(hook.url);
            if (!prev) return merged;
            for (const field of WebhookService.secretFields()) {
                if ((merged[field] === undefined || merged[field] === '') && prev[field]) {
                    merged[field] = prev[field];
                }
            }
            delete merged.hasSecret;
            return merged;
        });
    }
}

module.exports = WebhookService;
