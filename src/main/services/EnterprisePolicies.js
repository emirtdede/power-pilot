/**
 * EnterprisePolicies.js - FAZ B.
 * Tek-şirket pilotunun 3 politika şablonu:
 *   P1 nightly-shutdown - mesai-dışı kapatma (yinelenen görev olarak somutlaşır)
 *   P2 pre-patch-wake    - yama-öncesi uyandırma (konsol-tarafı WoL işi)
 *   P3 idle-lock         - boşta kilit (PCI/CIS şablonları: 5/10/15dk)
 * Electron bağımlılığı yok → konsol sunucusu da require edebilir.
 */

const POLICY_TYPES = ['nightly-shutdown', 'pre-patch-wake', 'idle-lock', 'rolling-restart'];
const IDLE_PRESETS_MIN = [5, 10, 15];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TARGETS = 500;
const MAX_ROLLING_TARGETS = 50;

function fail(message, code) {
    return { ok: false, error: message, code: code || 'INVALID_POLICY' };
}

function isValidTime(s) {
    return typeof s === 'string' && TIME_RE.test(s);
}

function isValidDays(days) {
    return Array.isArray(days) && days.length > 0 && days.length <= 7 &&
        days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/**
 * {days:[0-6], timeOfDay:'HH:mm'} → sonraki oluşumun epoch-ms'i.
 * nowMs enjekte edilebilir (test).
 */
function nextOccurrence(days, timeOfDay, nowMs = Date.now()) {
    const [hh, mm] = timeOfDay.split(':').map(Number);
    const wanted = new Set(days);
    for (let add = 0; add < 8; add++) {
        const d = new Date(nowMs + add * 86400000);
        if (!wanted.has(d.getDay())) continue;
        const cand = new Date(d);
        cand.setHours(hh, mm, 0, 0);
        if (cand.getTime() > nowMs) return cand.getTime();
    }
    return null;
}

function validatePolicy(policy) {
    if (!policy || typeof policy !== 'object') return fail('Geçersiz politika gövdesi.', 'INVALID_BODY');
    if (typeof policy.id !== 'string' || !policy.id || policy.id.length > 64) {
        return fail('Politika id gerekli (en fazla 64 karakter).', 'INVALID_ID');
    }
    if (!POLICY_TYPES.includes(policy.type)) {
        return fail(`Geçersiz politika tipi: ${String(policy.type)}.`, 'INVALID_TYPE');
    }
    if (!Array.isArray(policy.targets) || policy.targets.length === 0 || policy.targets.length > MAX_TARGETS) {
        return fail(`targets 1..${MAX_TARGETS} cihaz içermeli.`, 'INVALID_TARGETS');
    }
    if (policy.targets.some((t) => typeof t !== 'string' || !t || t.length > 128)) {
        return fail('Hedef id geçersiz.', 'INVALID_TARGETS');
    }
    const p = policy.params || {};
    if (policy.type === 'nightly-shutdown') {
        if (!isValidTime(p.timeOfDay)) return fail('timeOfDay HH:mm olmalı.', 'INVALID_PARAMS');
        if (!isValidDays(p.days)) return fail('days 0..6 gün listesi olmalı.', 'INVALID_PARAMS');
        if (p.warningSeconds !== undefined && (!Number.isInteger(p.warningSeconds) || p.warningSeconds < 0 || p.warningSeconds > 600)) {
            return fail('warningSeconds 0..600 olmalı.', 'INVALID_PARAMS');
        }
        if (p.snoozeMax !== undefined && (!Number.isInteger(p.snoozeMax) || p.snoozeMax < 0 || p.snoozeMax > 3)) {
            return fail('snoozeMax 0..3 olmalı.', 'INVALID_PARAMS');
        }
    } else if (policy.type === 'pre-patch-wake') {
        if (!isValidTime(p.wakeTime)) return fail('wakeTime HH:mm olmalı.', 'INVALID_PARAMS');
        if (p.waveSize !== undefined && (!Number.isInteger(p.waveSize) || p.waveSize < 1 || p.waveSize > 100)) {
            return fail('waveSize 1..100 olmalı.', 'INVALID_PARAMS');
        }
        if (p.waveGapSec !== undefined && (!Number.isInteger(p.waveGapSec) || p.waveGapSec < 1 || p.waveGapSec > 120)) {
            return fail('waveGapSec 1..120 olmalı.', 'INVALID_PARAMS');
        }
    } else if (policy.type === 'idle-lock') {
        if (!Number.isInteger(p.idleMinutes) || p.idleMinutes < 1 || p.idleMinutes > 120) {
            return fail('idleMinutes 1..120 olmalı.', 'INVALID_PARAMS');
        }
        if (p.graceSeconds !== undefined && (!Number.isInteger(p.graceSeconds) || p.graceSeconds < 0 || p.graceSeconds > 300)) {
            return fail('graceSeconds 0..300 olmalı.', 'INVALID_PARAMS');
        }
    } else if (policy.type === 'rolling-restart') {
        // FAZ D: sunucular tek-tek, bakım penceresinde, reboot-kanıtı beklenerek.
        if (policy.targets.length > MAX_ROLLING_TARGETS) {
            return fail(`rolling-restart en fazla ${MAX_ROLLING_TARGETS} sunucu.`, 'INVALID_TARGETS');
        }
        if (p.rebootTimeoutSec !== undefined && (!Number.isInteger(p.rebootTimeoutSec) || p.rebootTimeoutSec < 120 || p.rebootTimeoutSec > 3600)) {
            return fail('rebootTimeoutSec 120..3600 olmalı.', 'INVALID_PARAMS');
        }
    }
    return { ok: true };
}

/**
 * P1/P3 → createTask girdisi (yinelenen ilk vuruş targetTime ile kurulur;
 * icra sonrası TaskManager.calculateNextRecurrence zinciri sürdürür).
 */
function materializeToTask(policy, { source = 'console', nowMs = Date.now() } = {}) {
    const check = validatePolicy(policy);
    if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
    const p = policy.params || {};
    const base = {
        source,
        policyId: policy.id,
        mode: 'classic',
        safetyPolicy: {
            checkUserActivity: true,
            checkProtectedApps: true,
            checkFullscreen: true,
            checkSystemLoad: true,
            forceCloseApps: false,
            remoteApprovalRequired: false
        }
    };
    if (policy.type === 'nightly-shutdown') {
        const targetTime = nextOccurrence(p.days, p.timeOfDay, nowMs);
        const warningSeconds = p.warningSeconds === undefined ? 60 : p.warningSeconds;
        const snoozeMax = p.snoozeMax === undefined ? 1 : p.snoozeMax;
        return {
            ...base,
            name: `Kurumsal: Gece Kapat (${p.timeOfDay})`,
            action: 'shutdown',
            trigger: { type: 'scheduled_time', targetTime },
            recurrence: { enabled: true, frequency: 'custom', daysOfWeek: [...p.days], timeOfDay: p.timeOfDay },
            warningConfig: { enabled: warningSeconds > 0, durationSeconds: warningSeconds, silentMode: false },
            snoozeConfig: { allowed: snoozeMax > 0, maxCount: snoozeMax, currentCount: 0, durationMinutes: 10 }
        };
    }
    // idle-lock
    if (policy.type !== 'idle-lock') {
        throw Object.assign(new Error('Bu politika yerel göreve değil konsol-işine somutlaşır.'), { code: 'WRONG_MATERIALIZER' });
    }
    const grace = p.graceSeconds === undefined ? 0 : p.graceSeconds;
    return {
        ...base,
        name: `Kurumsal: Boşta Kilitle (${p.idleMinutes}dk)`,
        action: 'lock',
        // Koşul-güdümlü izleme görevi: süre/targetTime YOK → TaskManager MONITORING başlatır.
        trigger: { type: 'user_idle' },
        conditionGroup: {
            operator: 'AND',
            conditions: [{ type: 'user_idle', idleSeconds: p.idleMinutes * 60, stabilitySeconds: 10 }]
        },
        warningConfig: { enabled: grace > 0, durationSeconds: grace, silentMode: false },
        snoozeConfig: { allowed: false, maxCount: 0, currentCount: 0, durationMinutes: 10 }
    };
}

/**
 * P2 → konsol-tarafı WoL işi: hedeflere dalgalı (staggered) notBefore damgası.
 * targets: [{agentId, mac, broadcastIp, port}] - MAC'siz hedef atlanır (raporlanır).
 */
function materializeWakeJobs(policy, targets, { baseTimeMs = Date.now() } = {}) {
    const check = validatePolicy({ ...policy, targets: targets.filter((t) => t && typeof t === 'object').map((t) => t.agentId) });
    if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
    const p = policy.params || {};
    const waveSize = p.waveSize || 20;
    const waveGapSec = p.waveGapSec || 5;
    const jobs = [];
    const skipped = [];
    let slot = 0;
    for (const t of targets) {
        if (!t || !t.mac) {
            skipped.push(t && t.agentId ? t.agentId : '?');
            continue;
        }
        const wave = Math.floor(slot / waveSize);
        jobs.push({
            agentId: t.agentId,
            mac: t.mac,
            broadcastIp: t.broadcastIp || '255.255.255.255',
            port: t.port || 9,
            notBefore: baseTimeMs + wave * waveGapSec * 1000,
            wave
        });
        slot++;
    }
    return { jobs, skipped };
}

module.exports = {
    POLICY_TYPES,
    IDLE_PRESETS_MIN,
    MAX_TARGETS,
    validatePolicy,
    materializeToTask,
    materializeWakeJobs,
    nextOccurrence
};
