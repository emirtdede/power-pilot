/**
 * task-remove.test.mjs - biten görevleri kaldırma sözleşmesi.
 *
 * GERÇEK HATA (bu turda bulundu ve düzeltildi): iptal edilen/tamamlanan
 * görevler diskte kalıcı olarak kalıyor ve "Tüm" filtresinde EYLEM DÜĞMESİ
 * OLMAYAN satırlar olarak sonsuza kadar birikiyordu. Kullanıcının bunları
 * temizlemesinin hiçbir yolu yoktu (ne tekli silme ne toplu temizleme).
 *
 * Ölçüm (öncesi): 15 görev oluştur → 15'i iptal → "Tüm" → 15 satır,
 *   her satırda 0 eylem düğmesi; yeniden başlatmada 15 satır hâlâ orada.
 * Ölçüm (sonrası): her terminal satırda "Kaldır" → tıkla → satır kalkar,
 *   veriden silinir, yeniden başlatmada dönmez; "Bitenleri temizle" 8 → 0.
 *
 * Güvenlik kuralı: ÇALIŞAN görev silinemez (TASK_NOT_TERMINAL); önce iptal.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TaskManager from '../../src/main/services/TaskManager.js';
import { AutomationTask } from '../../src/main/services/models/AutomationTask.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

/** Bellek içi storage sahtesi - persistChanges gerçekten yazabilsin. */
function makeStorage() {
    const tasks = [];
    return {
        tasks,
        getTasks() { return JSON.parse(JSON.stringify(tasks)); },
        saveTask(t) {
            const i = tasks.findIndex((x) => x.id === t.id);
            if (i >= 0) tasks[i] = t; else tasks.push(t);
            return true;
        },
        deleteTask(id) {
            const i = tasks.findIndex((x) => x.id === id);
            if (i >= 0) tasks.splice(i, 1);
            return true;
        },
        getSettings() { return {}; }
    };
}

function makeManager() {
    const storage = makeStorage();
    const tm = new TaskManager(storage);
    if (tm.loopInterval) clearInterval(tm.loopInterval);
    return { tm, storage };
}

describe('TaskManager.removeTask - biten görevleri kaldırma', () => {
    it('terminal durumdaki görev kaldırılır (bellek + disk)', () => {
        const { tm, storage } = makeManager();
        const task = new AutomationTask({
            name: 'İptal edilmiş', action: 'shutdown',
            trigger: { type: 'duration', durationMs: 60000, targetTime: Date.now() + 60000 },
            status: 'cancelled'
        });
        tm.tasks.push(task);
        tm._savedTaskState = new Map([[task.id, JSON.stringify(task.toJSON())]]);
        storage.tasks.push(task.toJSON());

        const res = tm.removeTask(task.id);
        expect(res.ok).toBe(true);
        expect(res.code).toBe('REMOVED');
        expect(tm.tasks).toHaveLength(0);
        expect(storage.tasks).toHaveLength(0);
    });

    it('ÇALIŞAN görev kaldırılamaz (önce iptal edilmeli)', () => {
        for (const status of ['scheduled', 'monitoring', 'waiting', 'executing', 'warning', 'snoozed']) {
            const { tm } = makeManager();
            const task = new AutomationTask({
                name: 'Çalışan', action: 'shutdown',
                trigger: { type: 'duration', durationMs: 60000, targetTime: Date.now() + 60000 },
                status
            });
            tm.tasks.push(task);
            const res = tm.removeTask(task.id);
            expect(res.ok, `${status} durumundaki görev silinmemeli`).toBe(false);
            expect(res.code).toBe('TASK_NOT_TERMINAL');
            expect(tm.tasks).toHaveLength(1);
        }
    });

    it('tüm terminal durumlar kaldırılabilir', () => {
        for (const status of ['completed', 'cancelled', 'blocked', 'failed', 'expired']) {
            expect(TaskManager.isTerminalStatus(status), `${status} terminal olmalı`).toBe(true);
        }
        // P1-6 (üçüncü tur): `disabled` artık DURAKLATILMIŞ görevi temsil eder
        // ve sürdürülebilir; terminal sayılsaydı "Bitenleri temizle" onu
        // sessizce silerdi. `waiting`/`snoozed` de gerçek, geçici durumlardır.
        for (const status of ['scheduled', 'monitoring', 'executing', 'warning', 'waiting', 'snoozed', 'draft', 'disabled']) {
            expect(TaskManager.isTerminalStatus(status), `${status} terminal OLMAMALI`).toBe(false);
        }
    });

    it('olmayan görev NOT_FOUND döner', () => {
        const { tm } = makeManager();
        const res = tm.removeTask('task_yok');
        expect(res.ok).toBe(false);
        expect(res.code).toBe('NOT_FOUND');
    });

    it('removeTerminalTasks yalnızca terminal durumdakileri siler', () => {
        const { tm } = makeManager();
        const cancelled = new AutomationTask({
            name: 'Bitmiş', action: 'shutdown', status: 'cancelled',
            trigger: { type: 'duration', durationMs: 60000, targetTime: Date.now() + 60000 }
        });
        const running = new AutomationTask({
            name: 'Çalışıyor', action: 'shutdown', status: 'scheduled',
            trigger: { type: 'duration', durationMs: 60000, targetTime: Date.now() + 60000 }
        });
        tm.tasks.push(cancelled, running);
        const res = tm.removeTerminalTasks();
        expect(res.ok).toBe(true);
        expect(res.removed).toBe(1);
        expect(tm.tasks).toHaveLength(1);
        expect(tm.tasks[0].name).toBe('Çalışıyor');
    });

    it('IPC ve preload yüzeyi mevcut', () => {
        expect(mainSrc).toContain("ipcHandle('remove-task'");
        expect(mainSrc).toContain("ipcHandle('remove-terminal-tasks'");
        expect(preloadSrc).toContain("removeTask: (taskId) => ipcRenderer.invoke('remove-task'");
        expect(preloadSrc).toContain("removeTerminalTasks: () => ipcRenderer.invoke('remove-terminal-tasks'");
    });

    it('UI terminal satırda kaldırma düğmesi sunar (eylemsiz satır kalmaz)', () => {
        // isTaskRemovable tanımlı ve terminal kümesi sunucuyla aynı olmalı.
        expect(appSrc).toContain('function isTaskRemovable');
        const m = appSrc.match(/TASK_REMOVABLE_STATUSES = new Set\(\[([^\]]+)\]\)/);
        expect(m, 'TASK_REMOVABLE_STATUSES tanımlı olmalı').toBeTruthy();
        for (const status of ['completed', 'cancelled', 'blocked', 'failed', 'expired', 'disabled']) {
            expect(m[1]).toContain(`'${status}'`);
        }
        // Terminal satırda btn-task-remove üretilmeli.
        expect(appSrc).toContain('btn-task-remove');
        expect(appSrc).toContain('removeTaskFromList(task.id)');
        // Toplu temizleme düğmesi bağlı olmalı.
        expect(appSrc).toContain('btn-clear-finished');
        expect(appSrc).toContain('removeTerminalTasks');
    });

    it('yeni i18n anahtarları 17 dilde eşit', () => {
        const langs = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];
        const keys = ['taskRemove', 'taskRemoved', 'taskRemoveFailed', 'taskRemoveNotFinished', 'clearFinishedTasks', 'finishedTasksCleared'];
        for (const lang of langs) {
            const file = path.join(root, 'src', 'renderer', 'locales', `${lang}.json`);
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            for (const key of keys) {
                expect(data[key], `${lang}.json → ${key} eksik`).toBeTruthy();
            }
        }
    });
});
