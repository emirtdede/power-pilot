/**
 * performance.test.mjs - WP-13.T7/T8
 * 100 görevde delta güncelleme yalnızca süre hücrelerini değiştirir.
 */
import { describe, it, expect } from 'vitest';
import { taskSignature, needsFullRender, updateDurationCells } from '../../src/renderer/tasksView.js';

function makeTask(i, targetTime) {
    return {
        id: `t${i}`,
        status: 'scheduled',
        action: 'shutdown',
        name: `Görev ${i}`,
        trigger: { type: 'scheduled_time', targetTime }
    };
}

function buildTable(list) {
    const tbody = document.createElement('tbody');
    for (const task of list) {
        const row = document.createElement('tr');
        row.setAttribute('data-task-id', task.id);
        const name = document.createElement('td');
        name.textContent = task.name;
        const duration = document.createElement('td');
        duration.setAttribute('data-task-duration', '');
        duration.textContent = 'eski';
        row.append(name, duration);
        tbody.appendChild(row);
    }
    return tbody;
}

describe('görev tablosu delta (T-PERF-05)', () => {
    it('100 görevde yalnızca süre hücreleri değişir, satır kimliği korunur', () => {
        const now = Date.now();
        const list = Array.from({ length: 100 }, (_, i) => makeTask(i, now + (i + 1) * 60000));
        const tbody = buildTable(list);
        const rowsBefore = Array.from(tbody.children);
        const format = (target) => `${Math.floor((target - now) / 1000)}sn`;

        const changed = updateDurationCells(tbody, list, format);

        expect(changed).toBe(100);
        expect(Array.from(tbody.children)).toEqual(rowsBefore);
        expect(tbody.children[0].querySelector('[data-task-duration]').textContent).toBe('60sn');
        expect(tbody.children[0].querySelector('td').textContent).toBe('Görev 0');
    });

    it('imza değişmezse tam render gerekmez; küme değişirse gerekir', () => {
        const list = [makeTask(1, 1000), makeTask(2, 2000)];
        const sig = taskSignature(list, { filter: 'active', lang: 'tr' });
        expect(needsFullRender(sig, sig, 2, 2)).toBe(false);
        expect(needsFullRender(sig, '', 2, 2)).toBe(true);
        const changed = [{ ...list[0], status: 'completed' }, list[1]];
        expect(needsFullRender(taskSignature(changed), sig, 2, 2)).toBe(true);
    });

    it('aynı süre metni için DOM yazımı yapılmaz', () => {
        const now = Date.now();
        const list = [makeTask(1, now + 60000)];
        const tbody = buildTable(list);
        const format = () => 'sabit';
        expect(updateDurationCells(tbody, list, format)).toBe(1);
        expect(updateDurationCells(tbody, list, format)).toBe(0);
    });
});
