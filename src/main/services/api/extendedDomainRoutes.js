'use strict';

/**
 * extendedDomainRoutes.js
 *
 * Completes 100% non-visual GUI parity over Local REST API:
 *  - Active Warning interaction (GET /warning, confirm, snooze, cancel)
 *  - Local AI Model lifecycle & insights (status, download, load, unload, energy, suggest, dismiss)
 *  - Hardware wattage profiling (POST /device/estimate)
 *  - Enterprise console manual sync (POST /console/sync)
 *  - Updates download, install-on-quit, install-now
 *  - Cloud custom folder, reset folder, dismiss recovery
 *  - Bulk JSON Export / Import (settings, templates)
 *  - Cancel PIN management (GET/PUT/DELETE /security/cancel-pin) & API Key rotation (POST /security/rotate-key)
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { validateCancelPin, validateSettings } = require('../../ipc/validate');
const { setCancelPinAction, clearCancelPinAction } = require('../../ipc/cancelPinActions');
const { cancelWarningAction, snoozeWarningAction, confirmWarningAction } = require('../../ipc/warningActions');
const Pin = require('../../security/Pin');
const TemplateTransfer = require('../TemplateTransfer');
const { DeviceProfiler } = require('../DeviceProfiler');
const { ModelManager, AI_TIERS, DEFAULT_AI_TIER } = require('../ModelManager');
const { AiBackend } = require('../AiBackend');
const { writePrivateProfile } = require('../../../agent/bootstrap');
const { sanitizeSettingsForApi } = require('./coreDomainRoutes');

function handleWarningRoutes(svc, method, pathStr, body, res) {
    if (!pathStr.startsWith('/api/v1/warning')) return null;
    const wm = svc.deps.warningManager || (svc.taskManager && svc.taskManager.warningManager);
    if (!wm) return svc.unavailable(res, 'Warning manager');

    if (method === 'GET' && pathStr === '/api/v1/warning') {
        const active = typeof wm.getActiveState === 'function' ? wm.getActiveState() : null;
        return svc.sendJson(res, 200, { active });
    }
    if (method === 'POST' && pathStr === '/api/v1/warning/confirm') {
        const r = confirmWarningAction({
            taskId: body && body.taskId,
            warningManager: wm,
            t: (k) => k
        });
        return svc.sendJson(res, r && r.success ? 200 : 409, r);
    }
    if (method === 'POST' && pathStr === '/api/v1/warning/cancel') {
        const pin = (body && body.pin) || undefined;
        cancelWarningAction({
            pin,
            requireCancelPin: (p) => svc.verifyCancelPin(p),
            taskManager: svc.taskManager,
            warningManager: wm,
            t: (k) => k
        })
            .then((r) => svc.sendJson(res, r && r.success ? 200 : (r && r.code && r.code.startsWith('PIN_') ? 403 : 409), r))
            .catch(() => svc.sendJson(res, 500, { success: false, code: 'WARNING_CANCEL_FAILED', error: 'Warning cancel failed.' }));
        return true;
    }
    if (method === 'POST' && pathStr === '/api/v1/warning/snooze') {
        snoozeWarningAction({
            payload: { minutes: body && body.minutes, pin: body && body.pin },
            requireCancelPin: (p) => svc.verifyCancelPin(p),
            taskManager: svc.taskManager,
            warningManager: wm,
            t: (k) => k
        })
            .then((r) => svc.sendJson(res, r && r.success ? 200 : (r && r.code && r.code.startsWith('PIN_') ? 403 : 409), r))
            .catch(() => svc.sendJson(res, 500, { success: false, code: 'WARNING_SNOOZE_FAILED', error: 'Warning snooze failed.' }));
        return true;
    }
    return null;
}

function handleAiModelAndInsights(svc, method, pathStr, body, res, ctx) {
    const settings = svc.storage.getSettings() || {};
    const lang = (ctx.query && ctx.query.get('lang')) || (body && body.lang) || settings.language || 'en';
    const activeTier = AI_TIERS[settings.aiTier] ? settings.aiTier : DEFAULT_AI_TIER;
    const modelsDir = (svc.deps.modelManager && svc.deps.modelManager.modelDir)
        || (svc.deps.userDataDir ? path.join(svc.deps.userDataDir, 'models') : null);

    if (method === 'GET' && pathStr === '/api/v1/ai/status') {
        if (!svc.deps.aiBackend) return svc.unavailable(res, 'AI backend');
        const totalGb = Math.round((os.totalmem() / 1073741824) * 10) / 10;
        const downloadState = svc._aiDownloadState || { state: 'idle', tierId: activeTier, file: null, received: 0, total: null, step: 0, steps: 2, error: null };
        const tiers = modelsDir ? ModelManager.getAllTiersStatus(modelsDir, { cacheTtlMs: 1000 }) : null;
        return svc.sendJson(res, 200, {
            ...svc.deps.aiBackend.getStatus(),
            activeTier,
            ...(tiers ? { tiers } : {}),
            model: svc.deps.modelManager ? svc.deps.modelManager.status() : null,
            stt: svc.deps.sttModelManager ? svc.deps.sttModelManager.status() : null,
            download: { ...downloadState },
            ramGb: totalGb,
            ramOk: os.totalmem() >= 4294967296
        });
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/tier') {
        const rawTier = body && (typeof body.tierId === 'string' ? body.tierId : (typeof body.tier === 'string' ? body.tier : ''));
        const tierId = rawTier.trim();
        if (!tierId || !AI_TIERS[tierId]) {
            return svc.sendJson(res, 400, { ok: false, code: 'INVALID_TIER', error: 'tierId must be lite, balanced, or powerful.' });
        }
        svc.storage.updateSettings({ aiTier: tierId });
        if (modelsDir) {
            const mgrs = ModelManager.createTierManagers(modelsDir, tierId);
            svc.deps.modelManager = mgrs.llm;
            svc.deps.sttModelManager = mgrs.stt;
            if (svc.deps.sttService && typeof svc.deps.sttService.setModelId === 'function') {
                Promise.resolve(svc.deps.sttService.setModelId(mgrs.tier.sttServiceKey)).catch(() => {});
            }
        }
        if (typeof svc.deps.onSettingsUpdated === 'function') {
            try { svc.deps.onSettingsUpdated({ aiTier: tierId }, svc.storage.getSettings()); } catch (_) {}
        }
        if (svc.deps.aiBackend && typeof svc.deps.aiBackend.switchTier === 'function') {
            Promise.resolve(svc.deps.aiBackend.switchTier(tierId, { autoLoad: body && body.autoLoad === true }))
                .then((status) => svc.sendJson(res, 200, { ok: true, activeTier: tierId, status }))
                .catch(() => svc.sendJson(res, 500, { ok: false, code: 'TIER_SWITCH_FAILED', error: 'Could not switch AI tier.' }));
            return true;
        }
        return svc.sendJson(res, 200, { ok: true, activeTier: tierId });
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/model/download') {
        if (!svc.deps.modelManager) return svc.unavailable(res, 'Model manager');
        if (svc._aiDownloadState && svc._aiDownloadState.state === 'running') {
            return svc.sendJson(res, 409, { started: false, code: 'ALREADY_DOWNLOADING', error: 'Model download already in progress.' });
        }
        const reqTier = body && typeof body.tierId === 'string' && AI_TIERS[body.tierId] ? body.tierId : activeTier;
        if (modelsDir && reqTier !== activeTier) {
            svc.storage.updateSettings({ aiTier: reqTier });
            const mgrs = ModelManager.createTierManagers(modelsDir, reqTier);
            svc.deps.modelManager = mgrs.llm;
            svc.deps.sttModelManager = mgrs.stt;
        }
        const sttMgr = svc.deps.sttModelManager || (modelsDir ? ModelManager.createTierManagers(modelsDir, reqTier).stt : null);
        if (!sttMgr) return svc.unavailable(res, 'STT Model manager');
        svc._aiDownloadState = { state: 'running', tierId: reqTier, file: null, received: 0, total: null, step: 0, steps: 2, error: null };
        const run = async () => {
            try {
                const out = await ModelManager.downloadBundle(svc.deps.modelManager, sttMgr, (ev) => {
                    svc._aiDownloadState = { state: 'running', tierId: reqTier, file: ev.file, received: ev.received, total: ev.total, step: ev.step, steps: ev.steps, error: null };
                });
                const cancelled = (out.llm && out.llm.code === 'CANCELLED') || (out.stt && out.stt.code === 'CANCELLED');
                if (cancelled) {
                    svc._aiDownloadState = { ...svc._aiDownloadState, state: 'paused', error: null };
                    return;
                }
                const failed = (!out.llm || !out.llm.success) ? out.llm : (out.stt && !out.stt.success ? out.stt : null);
                svc._aiDownloadState = failed
                    ? { state: 'error', tierId: reqTier, error: failed.error || failed.code || 'DOWNLOAD_FAILED' }
                    : { state: 'done', tierId: reqTier, error: null };
            } catch (err) {
                svc._aiDownloadState = { state: 'error', tierId: reqTier, error: (err && err.code) || 'DOWNLOAD_FAILED' };
            }
        };
        run();
        return svc.sendJson(res, 202, { started: true, tierId: reqTier, download: { ...svc._aiDownloadState } });
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/model/cancel') {
        const r1 = svc.deps.modelManager && typeof svc.deps.modelManager.cancel === 'function' ? svc.deps.modelManager.cancel() : { cancelled: false };
        const r2 = svc.deps.sttModelManager && typeof svc.deps.sttModelManager.cancel === 'function' ? svc.deps.sttModelManager.cancel() : { cancelled: false };
        if (svc._aiDownloadState && svc._aiDownloadState.state === 'running') {
            svc._aiDownloadState = { ...svc._aiDownloadState, state: 'paused', error: null };
        }
        return svc.sendJson(res, 200, { ok: true, cancelled: Boolean(r1.cancelled || r2.cancelled) });
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/model/delete') {
        if (!modelsDir) return svc.unavailable(res, 'Model directory');
        const targetTier = (body && typeof body.tierId === 'string' && AI_TIERS[body.tierId]) ? body.tierId : activeTier;
        const proceedDelete = async () => {
            if (svc.deps.aiBackend && typeof svc.deps.aiBackend.unload === 'function') {
                const targetFile = AiBackend.modelFileForTier(targetTier);
                if (!svc.deps.aiBackend.modelId || svc.deps.aiBackend.modelId === targetFile || targetTier === activeTier) {
                    await svc.deps.aiBackend.unload();
                }
            }
            if (svc.deps.sttService && typeof svc.deps.sttService.unload === 'function') {
                await svc.deps.sttService.unload();
            }
            const del = ModelManager.deleteTierBundle(targetTier, modelsDir);
            return svc.sendJson(res, del.ok ? 200 : 500, { ok: del.ok, tierId: targetTier, freedBytes: del.freedBytes, code: del.code });
        };
        proceedDelete().catch(() => svc.sendJson(res, 500, { ok: false, code: 'DELETE_FAILED', error: 'Model delete failed.' }));
        return true;
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/model/load') {
        if (!svc.deps.aiBackend || typeof svc.deps.aiBackend.loadModel !== 'function') return svc.unavailable(res, 'AI backend');
        Promise.resolve(svc.deps.aiBackend.loadModel(svc.deps.modelManager ? svc.deps.modelManager.file : undefined))
            .then((r) => svc.sendJson(res, r && r.loaded ? 200 : 409, r))
            .catch(() => svc.sendJson(res, 500, { loaded: false, code: 'LOAD_FAILED', error: 'Model load failed.' }));
        return true;
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/model/unload') {
        if (!svc.deps.aiBackend || typeof svc.deps.aiBackend.unload !== 'function') return svc.unavailable(res, 'AI backend');
        Promise.resolve(svc.deps.aiBackend.unload())
            .then(() => svc.sendJson(res, 200, { success: true, ...svc.deps.aiBackend.getStatus() }))
            .catch(() => svc.sendJson(res, 500, { success: false, code: 'UNLOAD_FAILED', error: 'Model unload failed.' }));
        return true;
    }

    if (method === 'GET' && pathStr === '/api/v1/ai/energy') {
        if (!svc.deps.orchestrator || !svc.deps.energy) return svc.unavailable(res, 'AI energy advisor');
        Promise.resolve(svc.deps.orchestrator.runEnergy(svc.deps.energy.getStatistics(), { language: lang }))
            .then((insight) => svc.sendJson(res, 200, { ok: true, insight }))
            .catch(() => svc.sendJson(res, 500, { ok: false, code: 'AI_ENERGY_FAILED', error: 'Energy insight failed.' }));
        return true;
    }

    if (method === 'GET' && pathStr === '/api/v1/ai/suggest') {
        if (!svc.deps.orchestrator || !svc.deps.history) return svc.unavailable(res, 'AI recommender');
        Promise.resolve(svc.deps.orchestrator.runSuggest(svc.deps.history.getHistory(), { language: lang }))
            .then((suggestion) => svc.sendJson(res, 200, { ok: true, suggestion }))
            .catch(() => svc.sendJson(res, 500, { ok: false, code: 'AI_SUGGEST_FAILED', error: 'Suggestion failed.' }));
        return true;
    }

    if (method === 'POST' && pathStr === '/api/v1/ai/dismiss-suggestion') {
        if (!svc.deps.orchestrator || typeof svc.deps.orchestrator.dismissTopic !== 'function') return svc.unavailable(res, 'AI recommender');
        const topic = body && typeof body.topic === 'string' ? body.topic.trim().slice(0, 80) : '';
        if (!topic) return svc.sendJson(res, 400, { ok: false, code: 'INVALID_BODY', error: 'topic is required.' });
        return svc.sendJson(res, 200, { ok: true, result: svc.deps.orchestrator.dismissTopic(topic) });
    }

    return null;
}

function handleDeviceConsoleUpdatesCloudExport(svc, method, pathStr, body, res) {
    // Hardware wattage estimate
    if (method === 'POST' && pathStr === '/api/v1/device/estimate') {
        const profiler = svc.deps.deviceProfiler || new DeviceProfiler();
        const m = svc.deps.metricCollector && typeof svc.deps.metricCollector.getMetrics === 'function'
            ? svc.deps.metricCollector.getMetrics()
            : {};
        const battery = {
            hasBattery: m.batterySupported === true,
            isCharging: typeof m.isCharging === 'boolean' ? m.isCharging : null
        };
        Promise.resolve(profiler.profile(battery))
            .then((profile) => {
                if (body && body.apply === true && profile && Number.isInteger(profile.wattW) && profile.wattW >= 5 && profile.wattW <= 2000) {
                    svc.storage.updateSettings({ deviceWattage: profile.wattW, wattSource: profile.wattSource || 'estimated' });
                }
                return svc.sendJson(res, 200, { ok: true, profile });
            })
            .catch((err) => svc.sendJson(res, 500, { ok: false, code: 'ESTIMATE_FAILED', error: err && err.message }));
        return true;
    }

    // Manual Enterprise Console Sync + Drain
    if (method === 'POST' && pathStr === '/api/v1/console/sync') {
        if (!svc.deps.consoleClient || typeof svc.deps.consoleClient.sync !== 'function') {
            return svc.unavailable(res, 'Console client');
        }
        if (typeof svc.deps.consoleClient.isConfigured === 'function' && !svc.deps.consoleClient.isConfigured()) {
            return svc.sendJson(res, 400, { ok: false, code: 'NOT_CONFIGURED', error: 'Console URL / agent key is not configured.' });
        }
        Promise.resolve(svc.deps.consoleClient.sync())
            .then(async (syncRes) => {
                let drained = null;
                if (syncRes && syncRes.ok && !syncRes.disabled && svc.deps.executor && svc.deps.queue && !svc.taskManager.pausedAll) {
                    drained = await svc.deps.executor.drain(svc.deps.queue);
                }
                return svc.sendJson(res, syncRes && syncRes.ok ? 200 : 502, { ...syncRes, drained });
            })
            .catch((err) => svc.sendJson(res, 502, { ok: false, code: 'SYNC_FAILED', error: err && err.message }));
        return true;
    }

    // Updates download / install-on-quit / install-now
    if (method === 'POST' && pathStr === '/api/v1/updates/download') {
        if (!svc.deps.updates || typeof svc.deps.updates.downloadUpdate !== 'function') return svc.unavailable(res, 'Update service');
        Promise.resolve(svc.deps.updates.downloadUpdate())
            .then((r) => svc.sendJson(res, r && r.ok ? 200 : 400, r))
            .catch((err) => svc.sendJson(res, 500, { ok: false, error: err && err.message }));
        return true;
    }
    if (method === 'PATCH' && pathStr === '/api/v1/updates/install-on-quit') {
        if (!svc.deps.updates || typeof svc.deps.updates.setInstallOnQuit !== 'function') return svc.unavailable(res, 'Update service');
        if (!body || typeof body.enabled !== 'boolean') return svc.sendJson(res, 400, { ok: false, code: 'INVALID_BODY', error: 'enabled boolean is required.' });
        const r = svc.deps.updates.setInstallOnQuit(body.enabled);
        return svc.sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && pathStr === '/api/v1/updates/install') {
        if (!svc.deps.updates || typeof svc.deps.updates.installNow !== 'function') return svc.unavailable(res, 'Update service');
        const hasActive = svc.taskManager && svc.taskManager.getActiveTasks().length > 0;
        const hasPin = Boolean((svc.storage.getSettings() || {}).cancelPinHash);
        const proceed = async () => {
            if (hasActive && hasPin) {
                const pinErr = await svc.verifyCancelPin(body && body.pin);
                if (pinErr) return svc.sendJson(res, 403, pinErr);
            }
            const r = svc.deps.updates.installNow();
            return svc.sendJson(res, r && r.ok ? 200 : 400, r);
        };
        proceed().catch((err) => svc.sendJson(res, 500, { ok: false, error: err && err.message }));
        return true;
    }

    // Cloud custom folder / reset / dismiss recovery
    if (method === 'PUT' && pathStr === '/api/v1/cloud/folder') {
        if (!svc.deps.cloudSync || typeof svc.deps.cloudSync.setCustomDirectory !== 'function') return svc.unavailable(res, 'Cloud sync service');
        const dirPath = body && typeof body.dirPath === 'string' ? body.dirPath.trim() : '';
        if (!dirPath || dirPath.length > 512 || !path.isAbsolute(dirPath) || dirPath.includes('..') || dirPath.includes('\0')) {
            return svc.sendJson(res, 400, { ok: false, code: 'INVALID_PATH', error: 'dirPath must be a clean absolute directory path.' });
        }
        const r = svc.deps.cloudSync.setCustomDirectory(dirPath);
        return svc.sendJson(res, r && r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && pathStr === '/api/v1/cloud/folder/reset') {
        if (!svc.deps.cloudSync || typeof svc.deps.cloudSync.setCustomDirectory !== 'function') return svc.unavailable(res, 'Cloud sync service');
        return svc.sendJson(res, 200, svc.deps.cloudSync.setCustomDirectory(null));
    }
    if (method === 'POST' && pathStr === '/api/v1/cloud/dismiss-recovery') {
        if (!svc.deps.cloudSync || typeof svc.deps.cloudSync.dismissRecovery !== 'function') return svc.unavailable(res, 'Cloud sync service');
        return svc.sendJson(res, 200, svc.deps.cloudSync.dismissRecovery());
    }

    // Bulk Export / Import Settings & Templates
    if (method === 'GET' && pathStr === '/api/v1/export/settings') {
        const sanitized = sanitizeSettingsForApi(svc.storage.getSettings());
        delete sanitized.secretPresence;
        return svc.sendJson(res, 200, {
            app: 'PowerPilot',
            schema: 1,
            exportedAt: new Date().toISOString(),
            settings: sanitized
        });
    }
    if (method === 'POST' && pathStr === '/api/v1/import/settings') {
        const raw = body && typeof body.settings === 'object' && !Array.isArray(body.settings) ? body.settings : body;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return svc.sendJson(res, 400, { success: false, code: 'INVALID_BODY', error: 'Settings object required.' });
        }
        const current = svc.storage.getSettings();
        // Filter only allowed non-secret SETTINGS_SCHEMA keys via single-key validation for clean portable import
        const applied = {};
        const skipped = [];
        for (const [k, v] of Object.entries(raw)) {
            const single = validateSettings({ [k]: v }, current);
            if (single.ok) applied[k] = v;
            else skipped.push(k);
        }
        if (Object.keys(applied).length === 0) {
            return svc.sendJson(res, 400, { success: false, code: 'NO_VALID_SETTINGS', error: 'No valid settings to import.', skipped });
        }
        svc.storage.updateSettings(applied);
        if (typeof svc.deps.onSettingsUpdated === 'function') {
            try { svc.deps.onSettingsUpdated(applied, svc.storage.getSettings()); } catch (_) { /* best-effort runtime hook */ }
        }
        if (svc.deps.audit) svc.deps.audit.append({ actor: 'api', action: 'settings_imported', target: 'settings', detail: `keys=${Object.keys(applied).length}` });
        return svc.sendJson(res, 200, { success: true, appliedKeys: Object.keys(applied), skippedKeys: skipped });
    }
    if (method === 'GET' && pathStr === '/api/v1/export/templates') {
        if (typeof svc.storage.getTemplates !== 'function') return svc.unavailable(res, 'Template storage');
        const payload = TemplateTransfer.collectExportable(svc.storage.getTemplates()) || {
            schema: TemplateTransfer.EXPORT_SCHEMA,
            app: 'PowerPilot',
            exportedAt: new Date().toISOString(),
            templates: []
        };
        return svc.sendJson(res, 200, payload);
    }
    if (method === 'POST' && pathStr === '/api/v1/import/templates') {
        if (typeof svc.storage.getTemplates !== 'function' || typeof svc.storage.saveTemplates !== 'function') {
            return svc.unavailable(res, 'Template storage');
        }
        const rawText = typeof body === 'string' ? body : JSON.stringify(body || {});
        const parsed = TemplateTransfer.parseImportPayload(rawText);
        if (!parsed.ok) return svc.sendJson(res, 400, { success: false, code: parsed.code, error: 'Invalid templates import payload.' });
        const merged = TemplateTransfer.mergeImportedTemplates(parsed.templates, svc.storage.getTemplates());
        svc.storage.saveTemplates(merged.templates);
        return svc.sendJson(res, 200, { success: true, addedCount: merged.added.length, rejectedCount: merged.rejected, added: merged.added });
    }

    return null;
}

function handleSecurityPinAndRotation(svc, method, pathStr, body, res) {
    if (method === 'GET' && pathStr === '/api/v1/security/cancel-pin') {
        return svc.sendJson(res, 200, { set: Boolean((svc.storage.getSettings() || {}).cancelPinHash) });
    }
    if (method === 'PUT' && pathStr === '/api/v1/security/cancel-pin') {
        const pin = body && body.pin;
        const check = validateCancelPin(pin);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        setCancelPinAction({
            pin,
            currentPin: body && body.currentPin,
            requireCancelPin: (p) => svc.verifyCancelPin(p),
            storageService: svc.storage,
            auditLog: svc.deps.audit || null,
            t: (k) => k,
            hashPin: Pin.hashPin
        })
            .then((r) => svc.sendJson(res, r && r.success ? 200 : 403, r))
            .catch((err) => svc.sendJson(res, 500, { success: false, error: err && err.message }));
        return true;
    }
    if (method === 'DELETE' && pathStr === '/api/v1/security/cancel-pin') {
        clearCancelPinAction({
            currentPin: body && (body.currentPin || body.pin),
            requireCancelPin: (p) => svc.verifyCancelPin(p),
            storageService: svc.storage,
            auditLog: svc.deps.audit || null,
            t: (k) => k
        })
            .then((r) => svc.sendJson(res, r && r.success ? 200 : 403, r))
            .catch((err) => svc.sendJson(res, 500, { success: false, error: err && err.message }));
        return true;
    }

    if (method === 'POST' && pathStr === '/api/v1/security/rotate-key') {
        const role = (body && typeof body.role === 'string') ? body.role : (svc.storage.getSettings().localApiKeyRole || 'admin');
        const newKey = svc.generateApiKey(role);
        let profilePath = null;
        if ((!body || body.saveProfile !== false) && svc.deps.userDataDir && fs.existsSync(svc.deps.userDataDir)) {
            const s = svc.storage.getSettings();
            try {
                profilePath = writePrivateProfile(svc.deps.userDataDir, {
                    version: 1,
                    host: svc.boundHost && svc.boundHost !== '::' && svc.boundHost !== '0.0.0.0' ? svc.boundHost : '127.0.0.1',
                    port: s.localApiPort || 18456,
                    tls: s.localApiTlsEnabled === true,
                    caFile: s.localApiCaFile || null,
                    role: s.localApiKeyRole || role,
                    apiKey: newKey,
                    updatedAt: new Date().toISOString()
                }, { applyAcl: false });
            } catch (_) { /* best-effort profile sync */ }
        }
        if (svc.deps.audit) {
            svc.deps.audit.append({ actor: 'api', action: 'api_key_rotated', target: 'local-api', detail: `role=${role}` });
        }
        return svc.sendJson(res, 200, {
            success: true,
            apiKey: newKey,
            role: svc.storage.getSettings().localApiKeyRole || role,
            masked: svc.storage.getSettings().localApiKeyMasked,
            profilePath
        });
    }

    return null;
}

function routeExtendedDomain(svc, method, pathStr, body, res, ctx) {
    const w = handleWarningRoutes(svc, method, pathStr, body, res);
    if (w !== null) return w;
    const ai = handleAiModelAndInsights(svc, method, pathStr, body, res, ctx);
    if (ai !== null) return ai;
    const dev = handleDeviceConsoleUpdatesCloudExport(svc, method, pathStr, body, res);
    if (dev !== null) return dev;
    return handleSecurityPinAndRotation(svc, method, pathStr, body, res);
}

module.exports = {
    routeExtendedDomain
};
