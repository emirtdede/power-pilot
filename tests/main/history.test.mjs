/**
 * history.test.mjs - HistoryService: kayıt şekli (gizlilik), filtre, temizleme.
 */
import { describe, it, expect, vi } from 'vitest';
import HistoryService from '../../src/main/services/HistoryService.js';

function makeService(records = []) {
    const storage = {
        _records: [...records],
        getHistory: vi.fn(function () { return this._records; }),
        addHistoryRecord: vi.fn(function (r) { this._records.unshift(r); }),
        clearHistory: vi.fn(function () { this._records = []; })
    };
    return { svc: new HistoryService(storage), storage };
}

function sampleTask() {
    return {
        id: 'task_1', name: 'Gece Kapatma', action: 'shutdown', source: 'user_interface',
        snoozeConfig: { currentCount: 2 },
        apiKey: 'pp_key_GİZLİ', password: 'GİZLİ', token: 'GİZLİ'
    };
}

describe('HistoryService', () => {
    it('kayıt gizli alanları SIZDIRMAZ (parola/token/key yok)', () => {
        const { svc, storage } = makeService();
        svc.record(sampleTask(), 'success', 'ok');
        const saved = storage.addHistoryRecord.mock.calls[0][0];
        const json = JSON.stringify(saved);
        expect(json).not.toMatch(/GİZLİ/);
        expect(saved.taskId).toBe('task_1');
        expect(saved.resultCode).toBe('success');
        expect(saved.snoozeCount).toBe(2);
    });

    it('snoozeConfig yoksa snoozeCount 0 olur', () => {
        const { svc, storage } = makeService();
        svc.record({ id: 't', name: 'N', action: 'sleep', source: 'cli' }, 'success');
        expect(storage.addHistoryRecord.mock.calls[0][0].snoozeCount).toBe(0);
    });

    it('resultCode ve source filtresi çalışır', () => {
        const { svc } = makeService([
            { resultCode: 'success', source: 'user_interface' },
            { resultCode: 'blocked_by_policy', source: 'local_api' },
            { resultCode: 'success', source: 'local_api' }
        ]);
        expect(svc.getHistory({ resultCode: 'success' })).toHaveLength(2);
        expect(svc.getHistory({ source: 'local_api' })).toHaveLength(2);
        expect(svc.getHistory({})).toHaveLength(3);
    });

    it('clear depoya iletilir', () => {
        const { svc, storage } = makeService([{ resultCode: 'success' }]);
        svc.clear();
        expect(storage.clearHistory).toHaveBeenCalled();
    });
});
