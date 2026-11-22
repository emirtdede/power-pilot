'use strict';

/**
 * src/cli/formatters.js
 *
 * Clean, scannable human-readable CLI formatters for common commands.
 * Raw JSON is always available via `--json`.
 */

function pad(str, width) {
    const s = String(str == null ? '' : str);
    return s.length >= width ? `${s.slice(0, Math.max(1, width - 1))} ` : s.padEnd(width, ' ');
}

function formatStatus(body) {
    if (!body || typeof body !== 'object') return String(body);
    return [
        `Power Pilot v${body.version || '?'} (${body.status || 'unknown'})`,
        `  Mode         : ${body.headless ? 'Headless Daemon' : 'Desktop App'}`,
        `  Transport    : ${body.transport || 'disabled'} (${body.boundHost || '127.0.0.1'}:${body.port || 18456})`,
        `  Role         : ${body.keyRole || 'unknown'}`,
        `  Active Tasks : ${body.activeTasksCount ?? 0}`,
        `  Paused All   : ${body.pausedAll ? 'YES' : 'no'}`
    ].join('\n');
}

function formatTasks(body) {
    const list = body && Array.isArray(body.tasks) ? body.tasks : null;
    if (!list) return JSON.stringify(body, null, 2);
    if (list.length === 0) return 'No automation tasks found.';
    const lines = [
        `${pad('ID', 24)} ${pad('ACTION', 11)} ${pad('STATUS', 12)} NAME`,
        '-'.repeat(72)
    ];
    for (const t of list) {
        lines.push(`${pad(t.id, 24)} ${pad(t.action, 11)} ${pad(t.status, 12)} ${t.name || ''}`);
    }
    lines.push(`Total: ${body.total ?? list.length}`);
    return lines.join('\n');
}

function formatTemplates(body) {
    const list = body && Array.isArray(body.templates) ? body.templates : null;
    if (!list) return JSON.stringify(body, null, 2);
    if (list.length === 0) return 'No templates found.';
    const lines = [
        `${pad('ID', 26)} ${pad('ACTION', 11)} ${pad('CATEGORY', 14)} NAME`,
        '-'.repeat(76)
    ];
    for (const t of list) {
        lines.push(`${pad(t.id, 26)} ${pad(t.action, 11)} ${pad(t.category || 'custom', 14)} ${t.name || ''}`);
    }
    return lines.join('\n');
}

function formatHealth(body) {
    const h = body && body.health ? body.health : body;
    if (!h || typeof h !== 'object') return JSON.stringify(body, null, 2);
    return [
        'Power Pilot Health Summary',
        `  Total Records : ${h.totalRecords ?? 0}`,
        `  Success       : ${h.successCount ?? 0}`,
        `  Failures      : ${h.failureCount ?? 0}`,
        `  Cancelled     : ${h.cancelledCount ?? 0}`,
        `  Success Rate  : ${h.successRatePercent == null ? 'N/A' : `${h.successRatePercent}%`}`
    ].join('\n');
}

function formatCloudStatus(body) {
    const c = body && body.cloud ? body.cloud : body;
    if (!c || typeof c !== 'object') return JSON.stringify(body, null, 2);
    return [
        'Cloud Backup & Sync',
        `  Connected     : ${c.connected ? 'YES' : 'no'}`,
        `  Provider      : ${c.provider || 'local'}`,
        `  Auto Sync     : ${c.autoSync ? 'ON' : 'off'}`,
        `  Sync Folder   : ${c.syncDir || '-'}`,
        `  Daily Backups : ${c.dailyBackupCount ?? 0}/15`,
        `  Last Sync     : ${c.lastSyncedAt || 'never'}`
    ].join('\n');
}

function formatSecurityStatus(body) {
    const s = body && body.security ? body.security : body;
    if (!s || typeof s !== 'object') return JSON.stringify(body, null, 2);
    return [
        'Security Posture',
        `  Transport       : ${s.transport || 'disabled'} (HTTPS=${s.httpsActive ? 'yes' : 'no'}, mTLS=${s.mtlsRequired ? 'yes' : 'no'})`,
        `  Key Role        : ${s.keyRole || 'none'} (rotationDue=${s.rotationDue ? 'YES' : 'no'})`,
        `  Cancel PIN      : ${s.cancelPinConfigured ? 'SET' : 'not set'}`,
        `  Autonomy Mode   : ${s.autonomyMode || 'classic'}`,
        `  Automation      : ${s.automationPaused ? 'PAUSED' : 'active'}`,
        `  Audit Integrity : ${s.auditTampered ? 'TAMPERED' : 'ok'}`
    ].join('\n');
}

function formatAiStatus(body) {
    if (!body || typeof body !== 'object') return JSON.stringify(body, null, 2);
    return [
        'Local AI Status',
        `  Loaded   : ${body.loaded ? 'YES' : 'no'} (${body.code || 'OK'})`,
        `  RAM      : ${body.ramGb ?? '?'} GB (ok=${body.ramOk ? 'yes' : 'no'})`,
        `  Download : ${(body.download && body.download.state) || 'idle'}`
    ].join('\n');
}

module.exports = {
    formatStatus,
    formatTasks,
    formatTemplates,
    formatHealth,
    formatCloudStatus,
    formatSecurityStatus,
    formatAiStatus
};
