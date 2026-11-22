/**
 * tasksView.js - WP-13.T7
 * Görev tablosu delta yardımcıları. Tam render yalnızca görev kümesi
 * (id/status/action/trigger) değiştiğinde; aksi halde sadece süre hücreleri.
 */
(function (root) {
    'use strict';

    function taskSignature(list, { filter = 'active', lang = 'en' } = {}) {
        return JSON.stringify({
            filter,
            lang,
            rows: (list || []).map((task) => [
                task.id,
                task.status,
                task.enabled !== false,
                task.action,
                task.name || '',
                task.trigger && task.trigger.type,
                task.trigger && task.trigger.targetTime
            ])
        });
    }

    function needsFullRender(signature, lastSignature, childCount, listLength) {
        return signature !== lastSignature || childCount !== listLength;
    }

    function updateDurationCells(tbody, list, formatFn) {
        if (!tbody) return 0;
        const byId = new Map((list || []).map((task) => [String(task.id), task]));
        let changed = 0;
        tbody.querySelectorAll('[data-task-id]').forEach((row) => {
            const task = byId.get(row.getAttribute('data-task-id'));
            const cell = row.querySelector('[data-task-duration]');
            if (!task || !cell) return;
            const next = (task.trigger && task.trigger.targetTime)
                ? formatFn(task.trigger.targetTime)
                : '-';
            if (cell.textContent !== next) {
                cell.textContent = next;
                changed += 1;
            }
        });
        return changed;
    }

    const api = { taskSignature, needsFullRender, updateDurationCells };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.PPTasksView = api;
})(typeof window !== 'undefined' ? window : globalThis);
