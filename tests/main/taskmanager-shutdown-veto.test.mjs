/**
 * taskmanager-shutdown-veto.test.mjs — A6 entegrasyon
 *
 * Gerçek `TaskManager` + gerçek `TerminalActionVerifier` (enjekte edilmiş
 * timer). OS güç çağrısı ASLA yapılmaz: `PowerService` yerine sahte nesne.
 * Senaryo: `shutdown` komutu "başarılı" döner ama süreç hâlâ ayaktadır
 * (pencere dolar) → kullanıcıya "kapatma engellendi" raporu gider.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import TaskManager from '../../src/main/services/TaskManager.js';
import { TerminalActionVerifier } from '../../src/main/services/TerminalActionVerifier.js';

const live = [];
afterEach(() => {
    for (const tm of live.splice(0)) {
        if (tm.loopInterval) clearInterval(tm.loopInterval);
        if (tm.terminalVerifier) tm.terminalVerifier.disarm();
    }
});

function spawnWith({ powerResult = { success: true } } = {}) {
    let captured = null;
    const timers = {
        setTimer: (fn) => { captured = fn; return 1; },
        clearTimer: () => { captured = null; },
        fire: () => { const f = captured; captured = null; if (f) f(); return !!f; }
    };
    const storage = { getTasks: () => [], saveTask: vi.fn(), deleteTask: vi.fn(), getSettings: () => ({}) };
    const history = { record: vi.fn(), getHistory: () => [], clear: () => {} };
    const webhook = { triggerEvent: vi.fn() };
    const power = { execute: vi.fn(async () => powerResult), isValidAction: () => true };
    const tm = new TaskManager(storage, null, null, history, webhook, null, null, power);
    tm.terminalVerifier = new TerminalActionVerifier({ graceMs: 25000, ...timers });
    live.push(tm);
    return { tm, power, history, timers };
}

const flush = async (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TaskManager A6 — kapatma engellendi raporu', () => {
    it('kapatma komutu başarılı ama süreç ayaktaysa veto raporlanır', async () => {
        const { tm, power, timers } = spawnWith();
        const veto = vi.fn();
        tm.setVetoListener(veto);

        const task = tm.createTask({
            name: 'Kapatma',
            action: 'shutdown',
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(120);

        expect(power.execute).toHaveBeenCalledWith('shutdown', expect.anything());
        // Komut başarı döndü → görev tamamlandı.
        expect(task.status).toBe('completed');
        // Doğrulama penceresi kuruldu ama henüz dolmadı.
        expect(veto).not.toHaveBeenCalled();

        timers.fire();
        expect(veto).toHaveBeenCalledTimes(1);
        expect(veto.mock.calls[0][0]).toMatchObject({
            taskId: task.id,
            action: 'shutdown',
            code: 'SHUTDOWN_VETOED'
        });
    });

    it('sleep için veto doğrulaması kurulmaz', async () => {
        const { tm, timers } = spawnWith();
        const veto = vi.fn();
        tm.setVetoListener(veto);

        const task = tm.createTask({
            name: 'Uyku',
            action: 'sleep',
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(120);

        expect(task.status).toBe('completed');
        expect(timers.fire()).toBe(false);
        expect(veto).not.toHaveBeenCalled();
    });

    it('başarısız kapatmada veto doğrulaması kurulmaz (hata zaten raporlandı)', async () => {
        const { tm, timers } = spawnWith({ powerResult: { success: false, error: 'erişim engellendi' } });
        const veto = vi.fn();
        tm.setVetoListener(veto);

        const task = tm.createTask({
            name: 'Kapatma',
            action: 'shutdown',
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(120);

        expect(task.status).toBe('failed');
        expect(timers.fire()).toBe(false);
        expect(veto).not.toHaveBeenCalled();
    });

    it('kullanıcı iptal ederse bekleyen veto raporu düşer', async () => {
        const { tm, timers } = spawnWith();
        const veto = vi.fn();
        tm.setVetoListener(veto);

        const task = tm.createTask({
            name: 'Kapatma',
            action: 'shutdown',
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(120);
        expect(task.status).toBe('completed');

        tm.cancelTask(task.id);
        expect(timers.fire()).toBe(false);
        expect(veto).not.toHaveBeenCalled();
    });

    it('görev yeniden çalıştırıldıysa eski pencere rapor üretmez', async () => {
        const { tm, timers } = spawnWith();
        const veto = vi.fn();
        tm.setVetoListener(veto);

        const task = tm.createTask({
            name: 'Kapatma',
            action: 'shutdown',
            source: 'user_interface',
            trigger: { type: 'duration', durationMs: 1 }
        });

        await flush(10);
        tm.evaluateTasks();
        await flush(120);
        expect(task.status).toBe('completed');

        // lastRunAt değişti → pencere eskimiş sayılır.
        task.lastRunAt = new Date(Date.now() + 5000).toISOString();
        timers.fire();
        expect(veto).not.toHaveBeenCalled();
    });
});
