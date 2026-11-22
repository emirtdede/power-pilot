/**
 * enterprise-policies.test.mjs - FAZ B
 * 3 politika şablonu: doğrulama, göreve somutlaşma, WoL dalgalandırma.
 */
import { describe, it, expect } from 'vitest';
import { validatePolicy, materializeToTask, materializeWakeJobs, nextOccurrence } from '../../src/main/services/EnterprisePolicies.js';

const P1 = { id: 'pol-gece', type: 'nightly-shutdown', targets: ['a1'], params: { timeOfDay: '19:30', days: [1, 2, 3, 4, 5] } };
const P2 = { id: 'pol-yama', type: 'pre-patch-wake', targets: ['a1', 'a2'], params: { wakeTime: '03:00', waveSize: 1, waveGapSec: 5 } };
const P3 = { id: 'pol-kilit', type: 'idle-lock', targets: ['a1'], params: { idleMinutes: 10 } };

describe('validatePolicy', () => {
    it('3 şablon da geçerli', () => {
        expect(validatePolicy(P1).ok).toBe(true);
        expect(validatePolicy(P2).ok).toBe(true);
        expect(validatePolicy(P3).ok).toBe(true);
    });

    it('bozuk girdiler reddedilir', () => {
        expect(validatePolicy(null).ok).toBe(false);
        expect(validatePolicy({ ...P1, type: 'format' }).ok).toBe(false);
        expect(validatePolicy({ ...P1, targets: [] }).ok).toBe(false);
        expect(validatePolicy({ ...P1, params: { timeOfDay: '25:00', days: [1] } }).ok).toBe(false);
        expect(validatePolicy({ ...P3, params: { idleMinutes: 0 } }).ok).toBe(false);
        expect(validatePolicy({ ...P1, targets: new Array(501).fill('x') }).ok).toBe(false);
    });
});

describe('nextOccurrence', () => {
    it('sonraki hafta-içi 19:30 bulunur (yerel saat)', () => {
        // 2026-10-14 Çarşamba 12:00 yerel → aynı gün 19:30 yerel
        const wed = new Date(2026, 9, 14, 12, 0, 0).getTime();
        const t = nextOccurrence([1, 2, 3, 4, 5], '19:30', wed);
        const d = new Date(t);
        expect(d.getDay()).toBe(3);
        expect(d.getHours()).toBe(19);
        expect(d.getMinutes()).toBe(30);
    });

    it('saat geçmişse ertesi güne sarkar', () => {
        const wedLate = new Date(2026, 9, 14, 20, 0, 0).getTime();
        const d = new Date(nextOccurrence([1, 2, 3, 4, 5], '19:30', wedLate));
        expect(d.getDay()).toBe(4); // Perşembe
    });

    it('hafta-sonu atlanır', () => {
        // 2026-10-17 Cumartesi → Pazartesi
        const sat = new Date(2026, 9, 17, 12, 0, 0).getTime();
        const d = new Date(nextOccurrence([1, 2, 3, 4, 5], '19:30', sat));
        expect(d.getDay()).toBe(1);
    });
});

describe('materializeToTask', () => {
    it('P1 yinelenen kapatma görevi üretir', () => {
        const task = materializeToTask(P1, { source: 'console', nowMs: Date.UTC(2026, 9, 14, 12, 0, 0) });
        expect(task.action).toBe('shutdown');
        expect(task.source).toBe('console');
        expect(task.policyId).toBe('pol-gece');
        expect(task.trigger.type).toBe('scheduled_time');
        expect(task.recurrence.enabled).toBe(true);
        expect(task.warningConfig.durationSeconds).toBe(60); // varsayılan uyarı
        expect(task.snoozeConfig.maxCount).toBe(1); // tek erteleme
    });

    it('P3 koşul-güdümlü kilit görevi üretir (süre yok → izleme)', () => {
        const task = materializeToTask(P3, { source: 'console' });
        expect(task.action).toBe('lock');
        expect(task.trigger.targetTime).toBeUndefined();
        expect(task.conditionGroup.conditions[0].type).toBe('user_idle');
        expect(task.conditionGroup.conditions[0].idleSeconds).toBe(600);
    });

    it('P2 göreve değil WoL işine somutlaşır', () => {
        expect(() => materializeToTask(P2)).toThrow();
    });
});

describe('materializeWakeJobs', () => {
    it('dalgalı notBefore üretir, MACsiz hedefi raporlar', () => {
        const targets = [
            { agentId: 'a1', mac: 'AA:BB:CC:DD:EE:01' },
            { agentId: 'a2', mac: 'AA:BB:CC:DD:EE:02' },
            { agentId: 'a3', mac: null }
        ];
        const { jobs, skipped } = materializeWakeJobs(P2, targets, { baseTimeMs: 1000000 });
        expect(jobs).toHaveLength(2);
        expect(jobs[0].notBefore).toBe(1000000);
        expect(jobs[1].notBefore).toBe(1005000); // waveSize=1, gap=5sn
        expect(skipped).toEqual(['a3']);
    });
});
