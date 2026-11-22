/**
 * automationtask.test.mjs - AutomationTask modeli: varsayılanlar, fromLegacyTimer, toJSON.
 */
import { describe, it, expect } from 'vitest';
import { AutomationTask, TASK_STATUS } from '../../src/main/services/models/AutomationTask.js';

describe('AutomationTask', () => {
    it('varsayılanlar güvenli aralıktadır', () => {
        const t = new AutomationTask({});
        expect(t.enabled).toBe(true);
        expect(t.warningConfig.durationSeconds).toBe(30);
        expect(t.snoozeConfig.maxCount).toBe(3);
        expect(t.recurrence.enabled).toBe(false);
        expect(t.status).toBe(TASK_STATUS.DRAFT);
    });

    it('fromLegacyTimer SCHEDULED + hedef zaman kurar', () => {
        const before = Date.now();
        const t = AutomationTask.fromLegacyTimer('sleep', 1800000);
        expect(t.action).toBe('sleep');
        expect(t.status).toBe(TASK_STATUS.SCHEDULED);
        expect(t.trigger.type).toBe('duration');
        expect(t.trigger.targetTime).toBeGreaterThanOrEqual(before + 1800000 - 1000);
    });

    it('toJSON tüm kritik alanları taşır', () => {
        const t = new AutomationTask({ name: 'X', action: 'hibernate' });
        const j = t.toJSON();
        for (const k of ['id', 'name', 'status', 'action', 'trigger', 'conditionGroup', 'safetyPolicy', 'warningConfig', 'snoozeConfig', 'recurrence']) {
            expect(j).toHaveProperty(k);
        }
    });

    it('mod damgası varsayılan classic, full korunur (P0-1)', () => {
        expect(new AutomationTask({}).mode).toBe('classic');
        expect(new AutomationTask({ mode: 'full' }).mode).toBe('full');
        expect(new AutomationTask({ mode: 'xyz' }).mode).toBe('classic');
        expect(new AutomationTask({ mode: 'full' }).toJSON().mode).toBe('full');
    });
});
