'use strict';

/**
 * integrationDomainRoutes.js
 *
 * Modular Local REST API routes for integrations, cloud backup/sync, offline AI/RAG,
 * diagnostics, and updates so 100% of Power Pilot works headlessly via CLI/MCP/REST.
 */

const { validateWol, validateWebhooks } = require('../../ipc/validate');
const { normalizeAiInput } = require('../../ai/input');
const WebhookService = require('../WebhookService');
const { UpsMonitor } = require('../UpsMonitor');
const { searchDocs } = require('../DocsKnowledgeBase');

const UPS_HOST_RE = /^[A-Za-z0-9.:\[\]_-]{1,128}$/;
const UPS_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ALLOWED_CLOUD_PROVIDERS = new Set(['onedrive', 'gdrive', 'googledrive', 'dropbox', 'icloud', 'default']);

function handleWolAndWebhooks(svc, method, path, body, res) {
    if (method === 'GET' && path === '/api/v1/wol/devices') {
        if (typeof svc.storage.getDeviceProfiles !== 'function') return svc.unavailable(res, 'WoL storage');
        const devices = (svc.storage.getDeviceProfiles() || []).filter((p) => p && typeof p.macAddress === 'string');
        return svc.sendJson(res, 200, { devices });
    }

    if (method === 'PUT' && path === '/api/v1/wol/devices') {
        if (typeof svc.storage.saveDeviceProfiles !== 'function') return svc.unavailable(res, 'WoL storage');
        const incoming = Array.isArray(body) ? body : (body && Array.isArray(body.devices) ? body.devices : null);
        if (!incoming || incoming.length > 32) {
            return svc.sendJson(res, 400, { success: false, code: 'INVALID_BODY', error: 'devices must be an array (max 32).' });
        }
        const cleaned = [];
        for (const dev of incoming) {
            if (!dev || typeof dev !== 'object') {
                return svc.sendJson(res, 400, { success: false, code: 'INVALID_BODY', error: 'Invalid device entry.' });
            }
            const macAddress = String(dev.macAddress || '').trim().toUpperCase().replace(/-/g, ':');
            const broadcastIp = dev.broadcastIp ? String(dev.broadcastIp).trim() : undefined;
            const port = dev.port !== undefined && dev.port !== '' ? Number(dev.port) : 9;
            const check = validateWol({ macAddress, ...(broadcastIp ? { broadcastIp } : {}), port });
            if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
            cleaned.push({
                id: typeof dev.id === 'string' && dev.id ? dev.id.slice(0, 64) : `wol_${Date.now()}_${cleaned.length}`,
                name: String(dev.name || macAddress).trim().slice(0, 60),
                macAddress,
                broadcastIp: broadcastIp || '',
                port
            });
        }
        svc.storage.saveDeviceProfiles(cleaned);
        return svc.sendJson(res, 200, { success: true, devices: cleaned });
    }

    if (method === 'POST' && path === '/api/v1/wol/send') {
        if (!svc.deps.devices || typeof svc.deps.devices.sendWakeOnLan !== 'function') {
            return svc.unavailable(res, 'Wake-on-LAN service');
        }
        let macAddress = body && body.macAddress;
        let broadcastIp = body && body.broadcastIp;
        let port = body && body.port !== undefined ? Number(body.port) : undefined;

        if (!macAddress && body && (body.deviceId || body.name) && typeof svc.storage.getDeviceProfiles === 'function') {
            const list = svc.storage.getDeviceProfiles() || [];
            const found = list.find((d) => d && (d.id === body.deviceId || (body.name && String(d.name).toLowerCase() === String(body.name).toLowerCase())));
            if (!found) return svc.sendJson(res, 404, { success: false, code: 'DEVICE_NOT_FOUND', error: 'Saved WoL device not found.' });
            macAddress = found.macAddress;
            broadcastIp = broadcastIp || found.broadcastIp || undefined;
            port = port !== undefined ? port : (found.port || 9);
        }
        const check = validateWol({ macAddress, ...(broadcastIp ? { broadcastIp } : {}), ...(port !== undefined ? { port } : {}) });
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });

        Promise.resolve(svc.deps.devices.sendWakeOnLan(macAddress, broadcastIp || undefined, port || 9))
            .then((result) => svc.sendJson(res, 200, { success: true, result }))
            .catch((err) => svc.sendJson(res, 500, { success: false, code: 'WOL_FAILED', error: (err && err.message) || 'Wake-on-LAN failed.' }));
        return true;
    }

    if (method === 'GET' && path === '/api/v1/webhooks') {
        if (typeof svc.storage.getWebhooks !== 'function') return svc.unavailable(res, 'Webhook storage');
        return svc.sendJson(res, 200, { webhooks: WebhookService.redactForUi(svc.storage.getWebhooks() || []) });
    }

    if (method === 'PUT' && path === '/api/v1/webhooks') {
        if (typeof svc.storage.saveWebhooks !== 'function') return svc.unavailable(res, 'Webhook storage');
        const list = Array.isArray(body) ? body : (body && Array.isArray(body.webhooks) ? body.webhooks : null);
        const check = validateWebhooks(list);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        const existing = typeof svc.storage.getWebhooks === 'function' ? (svc.storage.getWebhooks() || []) : [];
        const merged = WebhookService.mergeSecrets(list, existing);
        const hasSecret = merged.some((hook) => WebhookService.secretFields()
            .some((field) => typeof hook[field] === 'string' && hook[field].length > 0));
        const store = svc.deps && svc.deps.secretStore;
        if (hasSecret && !store) {
            return svc.sendJson(res, 503, { success: false, code: 'SECRET_BACKEND_UNAVAILABLE', error: 'DPAPI/safeStorage unavailable; webhook secrets cannot be stored in plaintext.' });
        }
        const persist = async () => {
            if (store && typeof store.syncWebhooks === 'function') {
                if (hasSecret && typeof store.isAsyncEncryptionAvailable === 'function' && !(await store.isAsyncEncryptionAvailable())) {
                    return svc.sendJson(res, 503, { success: false, code: 'SECRET_BACKEND_UNAVAILABLE', error: 'DPAPI/safeStorage unavailable; webhook secrets cannot be stored in plaintext.' });
                }
                await store.syncWebhooks(merged);
            }
            svc.storage.saveWebhooks(merged);
            if (store && svc.storage.data && typeof store.hydrateData === 'function') {
                await store.hydrateData(svc.storage.data);
            }
            if (svc.deps.audit) {
                svc.deps.audit.append({ actor: 'api', action: 'webhooks_updated', target: 'webhooks', detail: `count=${merged.length}; secrets=${hasSecret ? 'present' : 'none'}` });
            }
            return svc.sendJson(res, 200, { success: true, webhooks: WebhookService.redactForUi(merged) });
        };
        if (store) {
            persist().catch((err) => svc.sendJson(res, (err && err.code === 'SECRET_BACKEND_UNAVAILABLE') ? 503 : 500, { success: false, code: (err && err.code) || 'WEBHOOKS_APPLY_FAILED', error: err && err.message }));
            return true;
        }
        svc.storage.saveWebhooks(merged);
        if (svc.deps.audit) {
            svc.deps.audit.append({ actor: 'api', action: 'webhooks_updated', target: 'webhooks', detail: `count=${merged.length}; secrets=none` });
        }
        return svc.sendJson(res, 200, { success: true, webhooks: WebhookService.redactForUi(merged) });
    }

    if (method === 'POST' && path === '/api/v1/webhooks/test') {
        if (!svc.deps.webhooks || typeof svc.deps.webhooks.sendPayload !== 'function') {
            return svc.unavailable(res, 'Webhook service');
        }
        const check = validateWebhooks([body]);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        const existing = typeof svc.storage.getWebhooks === 'function' ? (svc.storage.getWebhooks() || []) : [];
        const merged = WebhookService.mergeSecrets([body], existing)[0] || body;
        const sample = svc.deps.webhooks.buildPayload('task_created', {
            id: 'test', name: 'API Webhook Test', source: 'local_api', status: 'testing', action: 'lock'
        });
        const t0 = Date.now();
        Promise.resolve(svc.deps.webhooks.sendPayload(merged, sample))
            .then((r) => {
                const elapsedMs = Date.now() - t0;
                if (r && r.ok) return svc.sendJson(res, 200, { success: true, status: r.status || 200, elapsedMs });
                return svc.sendJson(res, 502, { success: false, status: (r && r.status) || 0, code: (r && r.code) || 'WEBHOOK_FAILED', elapsedMs, error: (r && (r.reason || r.code)) || 'Webhook delivery failed' });
            })
            .catch((err) => svc.sendJson(res, 502, { success: false, code: 'WEBHOOK_FAILED', error: (err && err.message) || 'Webhook test failed' }));
        return true;
    }

    if (method === 'POST' && path === '/api/v1/ups/test') {
        const s = svc.storage.getSettings();
        const host = (body && typeof body.host === 'string' && body.host.trim()) ? body.host.trim() : (s.upsHost || '127.0.0.1');
        const ups = (body && typeof body.ups === 'string' && body.ups.trim()) ? body.ups.trim() : (s.upsName || 'ups');
        if (!UPS_HOST_RE.test(host)) return svc.sendJson(res, 400, { ok: false, code: 'INVALID_HOST', error: 'Invalid UPS host.' });
        if (!UPS_NAME_RE.test(ups)) return svc.sendJson(res, 400, { ok: false, code: 'INVALID_UPS_NAME', error: 'Invalid UPS name.' });
        const monitor = new UpsMonitor({ host, ups, cacheTtlMs: 0 });
        monitor.query()
            .then((result) => svc.sendJson(res, 200, { ok: Boolean(result && result.reachable === true), ...result, host, ups }))
            .catch((err) => svc.sendJson(res, 502, { ok: false, reachable: false, code: (err && err.code) || 'UPS_ERROR', error: err && err.message }))
            .finally(() => { try { monitor.close(); } catch (_) { /* yut */ } });
        return true;
    }

    return null;
}

function handleCloudSyncRoutes(svc, method, path, body, res) {
    if (!path.startsWith('/api/v1/cloud/')) return null;
    const cloud = svc.deps.cloudSync;
    if (!cloud) return svc.unavailable(res, 'Cloud sync service');

    if (method === 'GET' && path === '/api/v1/cloud/status') {
        return svc.sendJson(res, 200, { cloud: cloud.getStatus() });
    }
    if (method === 'POST' && path === '/api/v1/cloud/connect') {
        const r = cloud.connect();
        return svc.sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && path === '/api/v1/cloud/disconnect') {
        return svc.sendJson(res, 200, cloud.disconnect());
    }
    if (method === 'POST' && path === '/api/v1/cloud/sync') {
        const force = Boolean(body && body.force === true);
        const r = cloud.syncNow({ force });
        return svc.sendJson(res, r && r.ok ? 200 : (r && r.skipped ? 409 : 400), r);
    }
    if (method === 'POST' && path === '/api/v1/cloud/restore') {
        const connect = Boolean(body && body.connect === true);
        const r = cloud.restoreFromBackup({ connect });
        if (r && r.ok && svc.taskManager && typeof svc.taskManager.reloadFromStorage === 'function') {
            try { svc.taskManager.reloadFromStorage(); } catch (_) { /* best-effort */ }
        }
        return svc.sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && path === '/api/v1/cloud/provider') {
        const providerId = body && typeof body.providerId === 'string' ? body.providerId.trim().toLowerCase() : '';
        if (!ALLOWED_CLOUD_PROVIDERS.has(providerId)) {
            return svc.sendJson(res, 400, { ok: false, code: 'INVALID_PROVIDER', error: 'Unsupported cloud provider.' });
        }
        const r = cloud.useDetectedProvider(providerId);
        return svc.sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'PATCH' && path === '/api/v1/cloud/autosync') {
        if (!body || typeof body.enabled !== 'boolean') {
            return svc.sendJson(res, 400, { ok: false, code: 'INVALID_BODY', error: 'enabled boolean is required.' });
        }
        return svc.sendJson(res, 200, cloud.setAutoSync(body.enabled));
    }
    return null;
}

function handleAiDocsDiagnosticsUpdates(svc, method, path, body, res, ctx) {
    const { query, role } = ctx;
    const settings = svc.storage.getSettings();
    const lang = (query && query.get('lang')) || (body && body.lang) || (settings && settings.language) || 'en';

    if (method === 'GET' && path === '/api/v1/docs/search') {
        const q = String((query && query.get('q')) || '').trim().slice(0, 300);
        if (!q) return svc.sendJson(res, 400, { ok: false, code: 'MISSING_QUERY', error: 'Query parameter q is required.' });
        const topK = Math.min(10, Math.max(1, Number(query.get('topK')) || 6));
        const results = searchDocs(q, { lang, topK, minScore: 0.35 });
        return svc.sendJson(res, 200, { query: q, lang, results });
    }

    if (method === 'POST' && path === '/api/v1/ai/parse') {
        if (!svc.deps.orchestrator || typeof svc.deps.orchestrator.runCommand !== 'function') {
            return svc.unavailable(res, 'AI parser');
        }
        const input = normalizeAiInput(body && body.text, { allowEmpty: false });
        if (!input.ok) return svc.sendJson(res, 400, { ok: false, code: input.code, error: 'text is required (1..4000 chars).' });
        if (svc.taskManager && svc.taskManager.pausedAll) {
            return svc.sendJson(res, 409, { ok: false, code: 'PAUSED', error: 'Automation is paused.' });
        }
        Promise.resolve(svc.deps.orchestrator.runCommand(input.text))
            .then((parsed) => {
                const proposal = parsed && (parsed.proposal || parsed.task);
                if (body && body.execute === true && parsed && parsed.ok && proposal) {
                    const act = proposal.action;
                    if ((act === 'shutdown' || act === 'restart') && role !== 'admin') {
                        return svc.sendJson(res, 403, { ok: false, code: 'FORBIDDEN', error: `Admin role required to execute ${act}.`, parsed });
                    }
                    const created = svc.taskManager.createTask({ ...proposal, source: 'local_api' });
                    return svc.sendJson(res, 201, { ok: true, parsed, executed: true, task: created.toJSON ? created.toJSON() : created });
                }
                return svc.sendJson(res, 200, { ok: Boolean(parsed && parsed.ok), parsed });
            })
            .catch((err) => svc.sendJson(res, 500, { ok: false, code: 'AI_ERROR', error: err && err.message }));
        return true;
    }

    if (method === 'POST' && path === '/api/v1/ai/assist') {
        if (!svc.deps.orchestrator || typeof svc.deps.orchestrator.runAssistant !== 'function') {
            return svc.unavailable(res, 'AI assistant');
        }
        const input = normalizeAiInput(body && body.text, { allowEmpty: false });
        if (!input.ok) return svc.sendJson(res, 400, { ok: false, code: input.code, error: 'text is required.' });
        const hist = svc.deps.history && typeof svc.deps.history.getHistory === 'function' ? svc.deps.history.getHistory() : [];
        const stats = svc.deps.energy && typeof svc.deps.energy.getStatistics === 'function' ? svc.deps.energy.getStatistics() : {};
        const lastBlocked = hist.find((h) => h && h.resultCode === 'blocked_by_policy');
        const lastBlockedReason = lastBlocked ? `${lastBlocked.taskName}: ${lastBlocked.detail || ''}`.slice(0, 4000) : '';
        Promise.resolve(svc.deps.orchestrator.runAssistant(input.text, {
            language: lang,
            intentHint: (body && body.intentHint) || null,
            energyStats: stats,
            historyList: hist,
            lastBlockedReason
        }))
            .then((result) => svc.sendJson(res, 200, { ok: true, result }))
            .catch((err) => svc.sendJson(res, 500, { ok: false, code: 'AI_ERROR', error: err && err.message }));
        return true;
    }

    if (method === 'POST' && path === '/api/v1/ai/diagnose') {
        if (!svc.deps.orchestrator || typeof svc.deps.orchestrator.runDiagnose !== 'function') {
            return svc.unavailable(res, 'AI diagnostics');
        }
        let detail = '';
        if (body && body.reason !== undefined && body.reason !== null) {
            const input = normalizeAiInput(body.reason);
            if (!input.ok) return svc.sendJson(res, 400, { ok: false, code: input.code, error: 'Invalid reason.' });
            detail = input.text;
        }
        if (!detail && svc.deps.history && typeof svc.deps.history.getHistory === 'function') {
            const lastBlocked = (svc.deps.history.getHistory() || []).find((h) => h && h.resultCode === 'blocked_by_policy');
            detail = lastBlocked ? `${lastBlocked.taskName}: ${lastBlocked.detail || ''}`.slice(0, 4000) : '';
        }
        Promise.resolve(svc.deps.orchestrator.runDiagnose(detail, { language: lang }))
            .then((diagnosis) => svc.sendJson(res, 200, { ok: true, diagnosis }))
            .catch(() => svc.sendJson(res, 500, { ok: false, code: 'AI_DIAGNOSE_FAILED', error: 'Diagnosis failed.' }));
        return true;
    }

    if (method === 'GET' && path === '/api/v1/diagnostics') {
        if (!svc.deps.diagnostics || typeof svc.deps.diagnostics.getDiagnosticsSnapshot !== 'function') {
            return svc.unavailable(res, 'Diagnostics service');
        }
        return svc.sendJson(res, 200, { diagnostics: svc.deps.diagnostics.getDiagnosticsSnapshot() });
    }

    if (method === 'DELETE' && path === '/api/v1/diagnostics') {
        if (!svc.deps.diagnostics || typeof svc.deps.diagnostics.clearLogs !== 'function') {
            return svc.unavailable(res, 'Diagnostics service');
        }
        svc.deps.diagnostics.clearLogs();
        return svc.sendJson(res, 200, { success: true });
    }

    if (method === 'POST' && path === '/api/v1/diagnostics/bundle') {
        if (!svc.deps.diagnostics || typeof svc.deps.diagnostics.createSupportBundle !== 'function') {
            return svc.unavailable(res, 'Diagnostics service');
        }
        Promise.resolve(svc.deps.diagnostics.createSupportBundle())
            .then((bundle) => svc.sendJson(res, 201, { success: true, bundle }))
            .catch((err) => svc.sendJson(res, 500, { success: false, code: 'BUNDLE_FAILED', error: err && err.message }));
        return true;
    }

    if (method === 'GET' && path === '/api/v1/updates/status') {
        if (!svc.deps.updates || typeof svc.deps.updates.getState !== 'function') {
            return svc.unavailable(res, 'Update service');
        }
        return svc.sendJson(res, 200, { ok: true, state: svc.deps.updates.getState() });
    }

    if (method === 'POST' && path === '/api/v1/updates/check') {
        if (!svc.deps.updates || typeof svc.deps.updates.checkForUpdates !== 'function') {
            return svc.unavailable(res, 'Update service');
        }
        Promise.resolve(svc.deps.updates.checkForUpdates())
            .then((r) => svc.sendJson(res, r && r.ok ? 200 : 502, r))
            .catch((err) => svc.sendJson(res, 500, { ok: false, code: 'CHECK_FAILED', error: err && err.message }));
        return true;
    }

    return null;
}

function routeIntegrationDomain(svc, method, path, body, res, ctx) {
    const ww = handleWolAndWebhooks(svc, method, path, body, res);
    if (ww !== null) return ww;
    const cl = handleCloudSyncRoutes(svc, method, path, body, res);
    if (cl !== null) return cl;
    return handleAiDocsDiagnosticsUpdates(svc, method, path, body, res, ctx);
}

module.exports = {
    routeIntegrationDomain
};
