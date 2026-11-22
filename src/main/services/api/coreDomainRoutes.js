'use strict';

/**
 * coreDomainRoutes.js
 *
 * Modular Local REST API routes for full headless parity:
 *  - Tasks (full creation with triggers/conditions/recurrence/chains + pause/resume/snooze/run-now/delete/pause-all)
 *  - Templates (list, save/override, delete/hide, reset, restore-defaults, run)
 *  - Redacted Settings & Security Settings & Security Posture
 *  - History, Energy Statistics, Local Health Summary
 */

const {
    validateTaskData,
    validateTaskId,
    validateSnooze,
    validateSettings,
    validateSecuritySettings
} = require('../../ipc/validate');
const TemplateService = require('../TemplateService');
const { summarize: summarizeHealth } = require('../HealthMetrics');
const { SECRET_SETTING_FIELDS } = require('../../security/SecretStore');

const DESTRUCTIVE_ACTIONS = new Set(['shutdown', 'restart']);
const RESTART_REQUIRED_KEYS = new Set([
    'localApiPort', 'localApiEnabled', 'lanModeEnabled',
    'localApiTlsEnabled', 'localApiTlsStrict', 'localApiRequireClientCert',
    'localApiCertFile', 'localApiKeyFile', 'localApiPfxFile', 'localApiCaFile'
]);

function splitSecrets(patch) {
    const rest = { ...(patch || {}) };
    const secrets = {};
    for (const field of SECRET_SETTING_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(rest, field)) {
            secrets[field] = rest[field];
            delete rest[field];
        }
    }
    return { rest, secrets };
}

async function persistSettingsWithSecretStore(svc, patch) {
    const { rest, secrets } = splitSecrets(patch);
    const secretEntries = Object.entries(secrets);
    if (secretEntries.length > 0) {
        const store = svc.deps && svc.deps.secretStore;
        const canEncrypt = store && typeof store.isAsyncEncryptionAvailable === 'function'
            ? await store.isAsyncEncryptionAvailable()
            : false;
        if (!store || !canEncrypt) {
            return { ok: false, status: 503, code: 'SECRET_BACKEND_UNAVAILABLE', error: 'DPAPI/safeStorage unavailable; plaintext secret persistence is forbidden.' };
        }
        for (const [k, v] of secretEntries) {
            if (typeof v === 'string' && v.length > 0) {
                await store.setSecret(k, v);
            } else {
                store.deleteSecret(k);
            }
        }
        // Keep null markers in storage for cleared secrets; never write plaintext values to SQLite.
        const markers = {};
        for (const [k] of secretEntries) markers[k] = null;
        Object.assign(rest, markers);
    }
    if (Object.keys(rest).length > 0) {
        const saved = svc.storage.updateSettings(rest);
        if (saved === false) {
            return { ok: false, status: 500, code: 'SETTINGS_PERSIST_FAILED', error: 'Settings could not be persisted.' };
        }
    }
    if (secretEntries.length > 0 && svc.deps && svc.deps.secretStore && svc.storage && svc.storage.data) {
        await svc.deps.secretStore.hydrateData(svc.storage.data);
    }
    return { ok: true };
}

function scheduleApiRestartIfNeeded(svc, patch) {
    if (!svc || !svc.server || !patch) return false;
    const needsRestart = Object.keys(patch).some((k) => RESTART_REQUIRED_KEYS.has(k));
    if (!needsRestart) return false;
    const timer = setTimeout(() => {
        try { svc.restart().catch(() => {}); } catch (_) { /* best-effort */ }
    }, 150);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
}
const API_SECRET_FIELDS = new Set([
    'localApiKeyHash',
    'localApiKeyPem',
    'localApiPfxPassphrase',
    'consoleAgentKey',
    'consoleClientKeyPem',
    'consoleClientPfxPassphrase',
    'cancelPinHash',
    'cancelPinSalt',
    'auditHmacKey',
    'backupAesKey'
]);

function sanitizeSettingsForApi(settings) {
    const out = {};
    for (const [k, v] of Object.entries(settings || {})) {
        if (API_SECRET_FIELDS.has(k)) continue;
        out[k] = v;
    }
    const secretPresence = {};
    for (const k of API_SECRET_FIELDS) {
        secretPresence[k] = typeof (settings && settings[k]) === 'string' && settings[k].length > 0;
    }
    out.secretPresence = secretPresence;
    return out;
}

function buildTaskFromTemplate(tpl, overrides = {}) {
    const trigger = tpl.trigger ? { ...tpl.trigger } : null;
    const condGroup = tpl.defaultConditionGroup
        ? { ...tpl.defaultConditionGroup }
        : (tpl.defaultCondition ? { operator: 'AND', conditions: [tpl.defaultCondition] } : undefined);

    const payload = {
        name: typeof overrides.name === 'string' && overrides.name.trim()
            ? overrides.name.trim().slice(0, 120)
            : String(tpl.name || `Template ${tpl.id}`).slice(0, 120),
        action: tpl.action
    };

    if (condGroup && Array.isArray(condGroup.conditions) && condGroup.conditions.length > 0) {
        payload.conditionGroup = condGroup;
        payload.trigger = trigger || { type: 'composite' };
    } else if (tpl.schedule && tpl.schedule.timeOfDay) {
        payload.trigger = { type: 'scheduled_time' };
        payload.recurrence = {
            enabled: true,
            frequency: tpl.schedule.frequency || 'daily',
            timeOfDay: tpl.schedule.timeOfDay,
            ...(Array.isArray(tpl.schedule.daysOfWeek) ? { daysOfWeek: tpl.schedule.daysOfWeek } : {})
        };
    } else if (trigger) {
        payload.trigger = trigger;
    } else {
        payload.trigger = { type: 'duration', durationMs: 30 * 60000 };
    }

    if (overrides.warningConfig) payload.warningConfig = overrides.warningConfig;
    if (overrides.safetyPolicy) payload.safetyPolicy = overrides.safetyPolicy;
    return payload;
}

function handleTasksRoutes(svc, method, path, body, res, ctx) {
    const { role } = ctx;
    const settings = svc.storage.getSettings();

    // POST /api/v1/tasks - full AutomationTask creation (triggers + conditions + recurrence + chain)
    if (method === 'POST' && path === '/api/v1/tasks') {
        const check = validateTaskData(body);
        if (!check.ok) {
            return svc.sendJson(res, 400, { success: false, error: check.error, code: check.code });
        }
        if (DESTRUCTIVE_ACTIONS.has(body.action) && role !== 'admin') {
            return svc.sendJson(res, 403, { error: `Role '${role || 'none'}' insufficient for ${body.action} (requires 'admin')`, code: 'FORBIDDEN' });
        }
        const task = svc.taskManager.createTask({ ...body, source: 'local_api' });
        if (svc.deps.audit) {
            svc.deps.audit.append({ actor: 'api', action: 'task_created', target: task.id, detail: body.action });
        }
        return svc.sendJson(res, 201, { success: true, task: task.toJSON ? task.toJSON() : task });
    }

    // POST /api/v1/tasks/clear-finished
    if (method === 'POST' && path === '/api/v1/tasks/clear-finished') {
        if (typeof svc.taskManager.removeTerminalTasks !== 'function') {
            return svc.unavailable(res, 'Task lifecycle');
        }
        const result = svc.taskManager.removeTerminalTasks();
        return svc.sendJson(res, 200, { success: true, removed: result.removed || 0 });
    }

    // POST /api/v1/tasks/pause-all
    if (method === 'POST' && path === '/api/v1/tasks/pause-all') {
        if (typeof svc.taskManager.togglePauseAll !== 'function') {
            return svc.unavailable(res, 'Task pause-all');
        }
        const hasPin = Boolean((settings || {}).cancelPinHash);
        const executePause = async () => {
            if (hasPin) {
                const pinErr = await svc.verifyCancelPin(body && body.pin);
                if (pinErr) return svc.sendJson(res, 403, pinErr);
            }
            let pausedAll = Boolean(svc.taskManager.pausedAll);
            if (body && typeof body.paused === 'boolean') {
                if (pausedAll !== body.paused) pausedAll = svc.taskManager.togglePauseAll();
            } else {
                pausedAll = svc.taskManager.togglePauseAll();
            }
            if (svc.deps.audit) {
                svc.deps.audit.append({ actor: 'api', action: pausedAll ? 'automation_paused' : 'automation_resumed', target: 'all', detail: '' });
            }
            return svc.sendJson(res, 200, { success: true, pausedAll });
        };
        if (hasPin) {
            executePause().catch((err) => svc.sendJson(res, 500, { success: false, error: err && err.message }));
            return true;
        }
        let pausedAll = Boolean(svc.taskManager.pausedAll);
        if (body && typeof body.paused === 'boolean') {
            if (pausedAll !== body.paused) pausedAll = svc.taskManager.togglePauseAll();
        } else {
            pausedAll = svc.taskManager.togglePauseAll();
        }
        if (svc.deps.audit) {
            svc.deps.audit.append({ actor: 'api', action: pausedAll ? 'automation_paused' : 'automation_resumed', target: 'all', detail: '' });
        }
        return svc.sendJson(res, 200, { success: true, pausedAll });
    }

    // POST /api/v1/tasks/:id/{pause,resume,snooze,run-now}
    const actionMatch = typeof path === 'string' && path.match(/^\/api\/v1\/tasks\/([^/]+)\/(pause|resume|snooze|run-now)$/);
    if (method === 'POST' && actionMatch) {
        const taskId = decodeURIComponent(actionMatch[1]);
        const op = actionMatch[2];
        const idCheck = validateTaskId(taskId);
        if (!idCheck.ok) return svc.sendJson(res, 400, { success: false, error: idCheck.error, code: idCheck.code });

        if (op === 'pause') {
            if (typeof svc.taskManager.pauseTask !== 'function') return svc.unavailable(res, 'Task pause');
            const runPause = () => {
                const r = svc.taskManager.pauseTask(taskId);
                if (!r || !r.ok) return svc.sendJson(res, r && r.code === 'NOT_FOUND' ? 404 : 409, { success: false, code: (r && r.code) || 'PAUSE_FAILED', error: (r && r.message) || 'Could not pause task' });
                return svc.sendJson(res, 200, { success: true, ...r });
            };
            const providedPin = (body && body.pin) || (ctx.headers && ctx.headers['x-cancel-pin']) || undefined;
            if (settings && settings.cancelPinHash) {
                svc.verifyCancelPin(providedPin)
                    .then((pinErr) => (pinErr ? svc.sendJson(res, 403, pinErr) : runPause()))
                    .catch(() => svc.sendJson(res, 500, { success: false, error: 'PIN verification failed' }));
                return true;
            }
            return runPause();
        }
        if (op === 'resume') {
            if (typeof svc.taskManager.resumeTask !== 'function') return svc.unavailable(res, 'Task resume');
            const r = svc.taskManager.resumeTask(taskId);
            if (!r || !r.ok) return svc.sendJson(res, r && r.code === 'NOT_FOUND' ? 404 : 409, { success: false, code: (r && r.code) || 'RESUME_FAILED', error: (r && r.message) || 'Could not resume task' });
            return svc.sendJson(res, 200, { success: true, ...r });
        }
        if (op === 'snooze') {
            if (typeof svc.taskManager.snoozeTask !== 'function') return svc.unavailable(res, 'Task snooze');
            const minutes = body && body.minutes !== undefined ? Number(body.minutes) : 10;
            const snCheck = validateSnooze({ taskId, minutes });
            if (!snCheck.ok) return svc.sendJson(res, 400, { success: false, error: snCheck.error, code: snCheck.code });
            const runSnooze = () => {
                const r = svc.taskManager.snoozeTask(taskId, snCheck.minutes);
                if (!r || !r.ok) return svc.sendJson(res, r && r.code === 'NOT_FOUND' ? 404 : 409, { success: false, code: (r && r.code) || 'SNOOZE_FAILED', error: (r && r.message) || 'Could not snooze task' });
                return svc.sendJson(res, 200, { success: true, ...r });
            };
            const providedPin = (body && body.pin) || (ctx.headers && ctx.headers['x-cancel-pin']) || undefined;
            if (settings && settings.cancelPinHash) {
                svc.verifyCancelPin(providedPin)
                    .then((pinErr) => (pinErr ? svc.sendJson(res, 403, pinErr) : runSnooze()))
                    .catch(() => svc.sendJson(res, 500, { success: false, error: 'PIN verification failed' }));
                return true;
            }
            return runSnooze();
        }
        if (op === 'run-now') {
            if (typeof svc.taskManager.runTaskNow !== 'function') return svc.unavailable(res, 'Task execution');
            const target = (svc.taskManager.tasks || []).find((t) => t && t.id === taskId);
            if (!target) return svc.sendJson(res, 404, { success: false, code: 'TASK_NOT_FOUND', error: `Task ${taskId} not found` });
            if (DESTRUCTIVE_ACTIONS.has(target.action) && role !== 'admin') {
                return svc.sendJson(res, 403, { error: `Role '${role || 'none'}' insufficient to run ${target.action} (requires 'admin')`, code: 'FORBIDDEN' });
            }
            if (svc.isRemoteShutdownBlocked(settings, target.action)) {
                return svc.sendJson(res, 403, { error: 'Remote power action blocked while user is active.', code: 'REMOTE_SHUTDOWN_BLOCKED' });
            }
            const started = svc.taskManager.runTaskNow(taskId);
            if (!started) return svc.sendJson(res, 409, { success: false, code: 'RUN_REJECTED', error: 'Task could not be started (paused, disabled, or already running).' });
            return svc.sendJson(res, 200, { success: true, taskId });
        }
    }

    // DELETE /api/v1/tasks/:id
    const delMatch = typeof path === 'string' && path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (method === 'DELETE' && delMatch) {
        const taskId = decodeURIComponent(delMatch[1]);
        const idCheck = validateTaskId(taskId);
        if (!idCheck.ok) return svc.sendJson(res, 400, { success: false, error: idCheck.error, code: idCheck.code });
        if (typeof svc.taskManager.removeTask !== 'function') return svc.unavailable(res, 'Task removal');
        const r = svc.taskManager.removeTask(taskId);
        if (!r || !r.ok) return svc.sendJson(res, r && r.code === 'NOT_FOUND' ? 404 : 409, { success: false, code: (r && r.code) || 'REMOVE_FAILED', error: (r && r.message) || 'Could not remove task' });
        return svc.sendJson(res, 200, { success: true, taskId });
    }

    return null;
}

function handleTemplatesRoutes(svc, method, path, body, res, ctx) {
    const { role, query } = ctx;
    const tplSvc = svc.deps.templates || (typeof svc.storage.getTemplates === 'function' ? new TemplateService(svc.storage) : null);

    if (method === 'GET' && path === '/api/v1/templates') {
        if (!tplSvc) return svc.unavailable(res, 'Template service');
        const includeHidden = query.get('includeHidden') === '1' || query.get('includeHidden') === 'true';
        return svc.sendJson(res, 200, {
            templates: tplSvc.getTemplates({ includeHidden }),
            categories: TemplateService.getCategories()
        });
    }

    if (method === 'POST' && path === '/api/v1/templates') {
        if (!tplSvc) return svc.unavailable(res, 'Template service');
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return svc.sendJson(res, 400, { success: false, code: 'INVALID_BODY', error: 'Invalid template payload.' });
        }
        const allowedCategories = new Set(TemplateService.getCategories());
        const safeIcon = (typeof body.icon === 'string' && /^[a-z0-9_]{1,40}$/.test(body.icon.trim())) ? body.icon.trim() : 'bookmark';
        const safeCategory = (typeof body.category === 'string' && allowedCategories.has(body.category)) ? body.category : 'custom';
        const probe = {
            action: body.action,
            ...(body.trigger ? { trigger: body.trigger } : {}),
            ...(body.defaultConditionGroup || body.defaultCondition
                ? { conditionGroup: body.defaultConditionGroup || { operator: 'AND', conditions: [body.defaultCondition] } }
                : {})
        };
        const check = validateTaskData(probe);
        if (!check.ok && !body.schedule) {
            return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        }
        const record = {
            id: typeof body.id === 'string' && body.id ? body.id.slice(0, 64) : `user_tpl_${Date.now()}`,
            name: String(body.name || '').trim().slice(0, 80),
            description: String(body.description || '').trim().slice(0, 200),
            action: body.action,
            icon: safeIcon,
            category: safeCategory,
            ...(body.defaultCondition ? { defaultCondition: body.defaultCondition } : {}),
            ...(body.defaultConditionGroup ? { defaultConditionGroup: body.defaultConditionGroup } : {}),
            ...(body.schedule ? { schedule: body.schedule } : {}),
            ...(body.trigger ? { trigger: body.trigger } : {})
        };
        if (!TemplateService.isValidTemplate(record)) {
            return svc.sendJson(res, 400, { success: false, code: 'INVALID_TEMPLATE', error: 'Template failed schema validation.' });
        }
        if (tplSvc.isBuiltInId(record.id)) {
            const s = svc.storage.getSettings();
            const overrides = { ...(s.templateOverrides || {}), [record.id]: record };
            const hidden = (Array.isArray(s.hiddenBuiltInTemplates) ? s.hiddenBuiltInTemplates : []).filter((id) => id !== record.id);
            svc.storage.updateSettings({ templateOverrides: overrides, hiddenBuiltInTemplates: hidden });
            return svc.sendJson(res, 201, { success: true, template: { ...record, builtIn: true, modified: true } });
        }
        const list = (svc.storage.getTemplates() || []).filter((t) => t.id !== record.id);
        list.push(record);
        svc.storage.saveTemplates(list);
        return svc.sendJson(res, 201, { success: true, template: { ...record, custom: true, builtIn: false } });
    }

    if (method === 'POST' && path === '/api/v1/templates/restore-defaults') {
        if (!tplSvc) return svc.unavailable(res, 'Template service');
        const patch = { hiddenBuiltInTemplates: [] };
        if (body && body.resetEdits === true) patch.templateOverrides = {};
        svc.storage.updateSettings(patch);
        return svc.sendJson(res, 200, { success: true, templates: tplSvc.getTemplates() });
    }

    const tplOpMatch = typeof path === 'string' && path.match(/^\/api\/v1\/templates\/([^/]+)\/(reset|run)$/);
    if (method === 'POST' && tplOpMatch) {
        if (!tplSvc) return svc.unavailable(res, 'Template service');
        const tplId = decodeURIComponent(tplOpMatch[1]);
        const op = tplOpMatch[2];
        const idCheck = validateTaskId(tplId);
        if (!idCheck.ok) return svc.sendJson(res, 400, { success: false, code: idCheck.code, error: idCheck.error });

        if (op === 'reset') {
            if (!tplSvc.isBuiltInId(tplId)) {
                return svc.sendJson(res, 404, { success: false, code: 'INVALID_TEMPLATE', error: 'Not a built-in template.' });
            }
            const s = svc.storage.getSettings();
            const overrides = { ...(s.templateOverrides || {}) };
            delete overrides[tplId];
            const hidden = (Array.isArray(s.hiddenBuiltInTemplates) ? s.hiddenBuiltInTemplates : []).filter((id) => id !== tplId);
            svc.storage.updateSettings({ templateOverrides: overrides, hiddenBuiltInTemplates: hidden });
            return svc.sendJson(res, 200, { success: true, template: tplSvc.getBuiltInById(tplId) });
        }

        const all = tplSvc.getTemplates({ includeHidden: true });
        const tpl = all.find((t) => t && t.id === tplId);
        if (!tpl) return svc.sendJson(res, 404, { success: false, code: 'TEMPLATE_NOT_FOUND', error: `Template ${tplId} not found.` });
        if (DESTRUCTIVE_ACTIONS.has(tpl.action) && role !== 'admin') {
            return svc.sendJson(res, 403, { error: `Role '${role || 'none'}' insufficient to run ${tpl.action} (requires 'admin')`, code: 'FORBIDDEN' });
        }
        const taskPayload = buildTaskFromTemplate(tpl, body || {});
        const check = validateTaskData(taskPayload);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        const task = svc.taskManager.createTask({ ...taskPayload, source: 'local_api' });
        return svc.sendJson(res, 201, { success: true, templateId: tplId, task: task.toJSON ? task.toJSON() : task });
    }

    const tplDel = typeof path === 'string' && path.match(/^\/api\/v1\/templates\/([^/]+)$/);
    if (method === 'DELETE' && tplDel) {
        if (!tplSvc) return svc.unavailable(res, 'Template service');
        const tplId = decodeURIComponent(tplDel[1]);
        const idCheck = validateTaskId(tplId);
        if (!idCheck.ok) return svc.sendJson(res, 400, { success: false, code: idCheck.code, error: idCheck.error });
        if (tplSvc.isBuiltInId(tplId)) {
            const s = svc.storage.getSettings();
            const hidden = Array.isArray(s.hiddenBuiltInTemplates) ? [...s.hiddenBuiltInTemplates] : [];
            if (!hidden.includes(tplId)) hidden.push(tplId);
            svc.storage.updateSettings({ hiddenBuiltInTemplates: hidden });
            return svc.sendJson(res, 200, { success: true, hidden: true, id: tplId });
        }
        if (!String(tplId).startsWith('user_tpl_')) {
            return svc.sendJson(res, 403, { success: false, code: 'PROTECTED_TEMPLATE', error: 'Protected template cannot be deleted.' });
        }
        svc.storage.saveTemplates((svc.storage.getTemplates() || []).filter((t) => t.id !== tplId));
        return svc.sendJson(res, 200, { success: true, id: tplId });
    }

    return null;
}

function handleSettingsAndStatsRoutes(svc, method, path, body, res, ctx) {
    const { query } = ctx;

    if (method === 'GET' && path === '/api/v1/settings') {
        return svc.sendJson(res, 200, { settings: sanitizeSettingsForApi(svc.storage.getSettings()) });
    }

    if (method === 'PATCH' && path === '/api/v1/settings') {
        const current = svc.storage.getSettings();
        const check = validateSettings(body, current);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        const hasSecretKey = Object.keys(body).some((k) => SECRET_SETTING_FIELDS.includes(k));
        const finalize = () => {
            if (typeof svc.deps.onSettingsUpdated === 'function') {
                try { svc.deps.onSettingsUpdated(body, svc.storage.getSettings()); } catch (_) { /* best-effort runtime hook */ }
            }
            if (svc.deps.audit) {
                svc.deps.audit.append({ actor: 'api', action: 'settings_updated', target: 'settings', detail: Object.keys(body).join(',') });
            }
            const restartScheduled = scheduleApiRestartIfNeeded(svc, body);
            return svc.sendJson(res, 200, { success: true, restartScheduled, settings: sanitizeSettingsForApi(svc.storage.getSettings()) });
        };
        if (hasSecretKey) {
            persistSettingsWithSecretStore(svc, body)
                .then((r) => (r.ok ? finalize() : svc.sendJson(res, r.status, { success: false, code: r.code, error: r.error })))
                .catch((err) => svc.sendJson(res, 500, { success: false, error: err && err.message }));
            return true;
        }
        const saved = svc.storage.updateSettings(body);
        if (saved === false) return svc.sendJson(res, 500, { success: false, code: 'SETTINGS_PERSIST_FAILED', error: 'Settings could not be persisted.' });
        return finalize();
    }

    if (method === 'PATCH' && path === '/api/v1/settings/security') {
        const current = svc.storage.getSettings();
        const check = validateSecuritySettings(body, current);
        if (!check.ok) return svc.sendJson(res, 400, { success: false, code: check.code, error: check.error });
        const hasSecretKey = Object.keys(body).some((k) => SECRET_SETTING_FIELDS.includes(k));
        const finalize = () => {
            if (typeof body.automationPaused === 'boolean' && svc.taskManager) {
                svc.taskManager.pausedAll = body.automationPaused;
            }
            if (typeof svc.deps.onSettingsUpdated === 'function') {
                try { svc.deps.onSettingsUpdated(body, svc.storage.getSettings()); } catch (_) { /* best-effort */ }
            }
            if (svc.deps.audit) {
                svc.deps.audit.append({ actor: 'api', action: 'security_settings_updated', target: 'security', detail: Object.keys(body).join(',') });
            }
            const restartScheduled = scheduleApiRestartIfNeeded(svc, body);
            return svc.sendJson(res, 200, { success: true, restartScheduled, settings: sanitizeSettingsForApi(svc.storage.getSettings()) });
        };
        if (hasSecretKey) {
            persistSettingsWithSecretStore(svc, body)
                .then((r) => (r.ok ? finalize() : svc.sendJson(res, r.status, { success: false, code: r.code, error: r.error })))
                .catch((err) => svc.sendJson(res, 500, { success: false, error: err && err.message }));
            return true;
        }
        const saved = svc.storage.updateSettings(body);
        if (saved === false) return svc.sendJson(res, 500, { success: false, code: 'SETTINGS_PERSIST_FAILED', error: 'Security settings could not be persisted.' });
        return finalize();
    }

    if (method === 'GET' && path === '/api/v1/security/status') {
        const s = svc.storage.getSettings();
        return svc.sendJson(res, 200, {
            security: {
                ...svc.getSecurityStatus(),
                cancelPinConfigured: Boolean(s && s.cancelPinHash),
                autonomyMode: (s && s.autonomyMode) || 'classic',
                agentDisabled: Boolean(s && s.agentDisabled),
                automationPaused: Boolean(svc.taskManager && svc.taskManager.pausedAll),
                storageMaintenance: Boolean(svc.storage && svc.storage.maintenanceMode),
                auditTampered: Boolean(svc.storage && svc.storage.auditTampered)
            }
        });
    }

    if (method === 'GET' && path === '/api/v1/history') {
        if (!svc.deps.history || typeof svc.deps.history.getHistory !== 'function') return svc.unavailable(res, 'History service');
        const filter = {};
        if (query.get('action')) filter.action = query.get('action');
        if (query.get('resultCode')) filter.resultCode = query.get('resultCode');
        const limit = Math.min(500, Math.max(1, Number(query.get('limit')) || 100));
        const all = svc.deps.history.getHistory(filter) || [];
        return svc.sendJson(res, 200, { history: all.slice(0, limit), total: all.length, limit });
    }

    if (method === 'DELETE' && path === '/api/v1/history') {
        if (!svc.deps.history || typeof svc.deps.history.clear !== 'function') return svc.unavailable(res, 'History service');
        svc.deps.history.clear();
        if (svc.deps.audit) svc.deps.audit.append({ actor: 'api', action: 'history_cleared', target: 'history', detail: '' });
        return svc.sendJson(res, 200, { success: true });
    }

    if (method === 'GET' && path === '/api/v1/statistics') {
        if (!svc.deps.energy || typeof svc.deps.energy.getStatistics !== 'function') return svc.unavailable(res, 'Energy statistics');
        const opts = {};
        if (query.get('days')) {
            const d = Number(query.get('days'));
            if (Number.isInteger(d) && d >= 1 && d <= 3650) opts.days = d;
        }
        return svc.sendJson(res, 200, { statistics: svc.deps.energy.getStatistics(opts) });
    }

    if (method === 'GET' && path === '/api/v1/health') {
        let installedAtMs = null;
        try {
            const created = typeof svc.storage.getMeta === 'function' ? svc.storage.getMeta('created_at') : null;
            const parsed = created ? Date.parse(created) : NaN;
            if (Number.isFinite(parsed)) installedAtMs = parsed;
        } catch (_) { /* optional */ }
        const history = svc.deps.history && typeof svc.deps.history.getHistory === 'function'
            ? (svc.deps.history.getHistory() || [])
            : [];
        return svc.sendJson(res, 200, { health: summarizeHealth({ history, installedAtMs, nowMs: Date.now() }) });
    }

    return null;
}

function routeCoreDomain(svc, method, path, body, res, ctx) {
    const t = handleTasksRoutes(svc, method, path, body, res, ctx);
    if (t !== null) return t;
    const tpl = handleTemplatesRoutes(svc, method, path, body, res, ctx);
    if (tpl !== null) return tpl;
    return handleSettingsAndStatsRoutes(svc, method, path, body, res, ctx);
}

module.exports = {
    routeCoreDomain,
    sanitizeSettingsForApi,
    API_SECRET_FIELDS
};
