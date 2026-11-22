/**
 * performance.test.mjs - WP-13.T5/T6/T8
 * Timer kayıt defteri, tray debounce kaynağı ve taskManager değişim sinyali.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TimerRegistry } from '../../src/main/util/TimerRegistry.js';
import TaskManager from '../../src/main/services/TaskManager.js';

const root = path.resolve(__dirname, '../..');

describe('TimerRegistry (T-PERF-04)', () => {
    it('timeout ve interval kaydeder, clear ve clearAll temizler', async () => {
        const reg = new TimerRegistry();
        const fired = [];
        reg.setTimeout(() => fired.push('timeout'), 5);
        const interval = reg.setInterval(() => fired.push('interval'), 5);
        expect(reg.size).toBe(2);
        reg.clear(interval);
        expect(reg.size).toBe(1);
        await new Promise((r) => setTimeout(r, 20));
        expect(fired).toEqual(['timeout']);
        reg.clearAll();
        expect(reg.size).toBe(0);
        expect(() => reg.setTimeout(() => {}, 1)).toThrow('TIMER_REGISTRY_CLOSED');
    });

    it('clearAll açık interval bırakmaz', async () => {
        const reg = new TimerRegistry();
        let count = 0;
        reg.setInterval(() => { count += 1; }, 5);
        await new Promise((r) => setTimeout(r, 18));
        const before = count;
        reg.clearAll();
        await new Promise((r) => setTimeout(r, 18));
        expect(count).toBe(before);
        expect(reg.size).toBe(0);
    });
});

describe('Tray debounce kaynağı (T-PERF-03)', () => {
    it('3 sn interval yok; 100 ms debounce + imza karşılaştırması var', () => {
        const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
        expect(source).not.toMatch(/setInterval\(\s*updateTrayMenu/);
        expect(source).toMatch(/trayUpdater\(\)/);
        expect(source).toMatch(/lastTraySignature/);
        expect(source).toMatch(/},\s*100\);/);
        expect(source).toMatch(/timers\.clearAll\(\)/);
    });
});

describe('TaskManager değişim sinyali', () => {
    it('persistChanges yalnızca değişen görevi yazar ve changeListener çağırır', () => {
        const storage = {
            getSettings: () => ({ automationPaused: false }),
            saveTask: vi.fn(() => true), deleteTask: vi.fn(() => true),
            getTasks: () => []
        };
        const tm = new TaskManager(storage, null, null, null, null);
        tm.timerRegistry = { setInterval: () => 1 };
        tm.startLoop();
        const listener = vi.fn();
        tm.setChangeListener(listener);
        tm.tasks.push({ id: 'task-1', toJSON: () => ({ id: 'task-1', status: 'draft' }) });
        expect(tm.persistChanges()).toBe(1);
        expect(storage.saveTask).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(tm.persistChanges()).toBe(0);
        expect(storage.saveTask).toHaveBeenCalledTimes(1);
        clearInterval(tm.loopInterval);
    });
});
