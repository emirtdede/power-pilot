/**
 * enterprise-policies-extra.test.mjs - kalan politika dalları
 * (rolling-restart, parametre sınırları, WoL dalgalandırma kenarları)
 */
import { describe, it, expect } from 'vitest';
import {
    POLICY_TYPES,
    IDLE_PRESETS_MIN,
    validatePolicy,
    materializeToTask,
    materializeWakeJobs,
    nextOccurrence
} from '../../src/main/services/EnterprisePolicies.js';

const NOW = new Date('2026-01-05T10:00:00').getTime(); // Pazartesi

const policy = (over = {}) => Object.assign({
    id: 'p1',
    type: 'nightly-shutdown',
    targets: ['a1'],
    params: { timeOfDay: '23:00', days: [1, 2, 3] }
}, over);

describe('EnterprisePolicies - sabitler ve nextOccurrence', () => {
    it('sabit listeler', () => {
        expect(POLICY_TYPES).toEqual(['nightly-shutdown', 'pre-patch-wake', 'idle-lock', 'rolling-restart']);
        expect(IDLE_PRESETS_MIN).toEqual([5, 10, 15]);
    });

    it('bugün/ileri gün seçimi ve boş gün listesi', () => {
        const today = nextOccurrence([new Date(NOW).getDay()], '12:00', NOW);
        expect(today).toBeGreaterThan(NOW);
        const tomorrow = nextOccurrence([(new Date(NOW).getDay() + 1) % 7], '09:00', NOW);
        expect(tomorrow - NOW).toBeGreaterThan(12 * 3600000);
        expect(nextOccurrence([], '09:00', NOW)).toBeNull();
        // Saat geçmişse bir sonraki haftaya kayar
        const sameDayPast = nextOccurrence([new Date(NOW).getDay()], '09:00', NOW);
        expect(sameDayPast - NOW).toBeGreaterThan(6 * 86400000);
    });
});

describe('EnterprisePolicies - rolling-restart ve sınırlar', () => {
    it('rolling-restart hedef/parametre sınırları', () => {
        const p = (targets, params = {}) => policy({ type: 'rolling-restart', targets, params });
        expect(validatePolicy(p(['a'])).ok).toBe(true);
        expect(validatePolicy(p(Array.from({ length: 51 }, (_, i) => `a${i}`))).code).toBe('INVALID_TARGETS');
        expect(validatePolicy(p(['a'], { rebootTimeoutSec: 60 })).code).toBe('INVALID_PARAMS');
        expect(validatePolicy(p(['a'], { rebootTimeoutSec: 3601 })).code).toBe('INVALID_PARAMS');
        expect(validatePolicy(p(['a'], { rebootTimeoutSec: 600 })).ok).toBe(true);
    });

    it('targets kimlik biçimi ve tip listesi', () => {
        expect(validatePolicy(policy({ targets: ['x'.repeat(129)] })).code).toBe('INVALID_TARGETS');
        expect(validatePolicy(policy({ targets: [''] })).code).toBe('INVALID_TARGETS');
        expect(validatePolicy(policy({ type: 'bilinmeyen' })).code).toBe('INVALID_TYPE');
        expect(validatePolicy(policy({ id: 'a'.repeat(65) })).code).toBe('INVALID_ID');
    });

    it('nightly-shutdown uç değerleri', () => {
        expect(validatePolicy(policy({ params: { timeOfDay: '00:00', days: [0] } })).ok).toBe(true);
        expect(validatePolicy(policy({ params: { timeOfDay: '23:59', days: [6], warningSeconds: 600, snoozeMax: 3 } })).ok).toBe(true);
        expect(validatePolicy(policy({ params: { timeOfDay: '23:59', days: [1, 2, 3, 4, 5, 6, 0] } })).ok).toBe(true);
    });

    it('idle-lock uç değerleri', () => {
        const p = (params) => policy({ type: 'idle-lock', params });
        expect(validatePolicy(p({ idleMinutes: 1 })).ok).toBe(true);
        expect(validatePolicy(p({ idleMinutes: 120 })).ok).toBe(true);
        expect(validatePolicy(p({ idleMinutes: 10, graceSeconds: 0 })).ok).toBe(true);
        expect(validatePolicy(p({ idleMinutes: 10, graceSeconds: 300 })).ok).toBe(true);
        expect(validatePolicy(p({})).code).toBe('INVALID_PARAMS');
    });
});

describe('EnterprisePolicies - materialize dal ve kenarları', () => {
    it('nightly-shutdown varsayılan uyarı/erteleme', () => {
        const out = materializeToTask(policy({ params: { timeOfDay: '23:00', days: [1] } }), { source: 'console', nowMs: NOW });
        expect(out.warningConfig).toEqual({ enabled: true, durationSeconds: 60, silentMode: false });
        expect(out.snoozeConfig).toMatchObject({ allowed: true, maxCount: 1, currentCount: 0 });
        expect(out.trigger.targetTime).toBeGreaterThan(NOW);
    });

    it('warningSeconds/snoozeMax sıfır → kapalı', () => {
        const out = materializeToTask(policy({ params: { timeOfDay: '23:00', days: [1], warningSeconds: 0, snoozeMax: 0 } }), { nowMs: NOW });
        expect(out.warningConfig.enabled).toBe(false);
        expect(out.snoozeConfig.allowed).toBe(false);
    });

    it('idle-lock koşullu görev üretir', () => {
        const out = materializeToTask(policy({ type: 'idle-lock', params: { idleMinutes: 10, graceSeconds: 30 } }), { nowMs: NOW });
        expect(out.trigger).toEqual({ type: 'user_idle' });
        expect(out.conditionGroup.conditions[0]).toMatchObject({ type: 'user_idle', idleSeconds: 600, stabilitySeconds: 10 });
        expect(out.warningConfig).toMatchObject({ enabled: true, durationSeconds: 30 });
        expect(out.snoozeConfig.allowed).toBe(false);
    });

    it('desteklenmeyen somutlaştırma WRONG_MATERIALIZER; geçersiz politika fırlatır', () => {
        try { materializeToTask(policy({ type: 'rolling-restart', params: {} })); } catch (err) { expect(err.code).toBe('WRONG_MATERIALIZER'); }
        try { materializeToTask({ id: '' }); } catch (err) { expect(err.code).toBe('INVALID_ID'); }
        const prePatch = policy({ type: 'pre-patch-wake', params: { wakeTime: '05:00' } });
        expect(() => materializeToTask(prePatch)).toThrow();
    });

    it('safetyPolicy tüm kontroller açık', () => {
        const out = materializeToTask(policy(), { nowMs: NOW });
        expect(out.safetyPolicy).toMatchObject({ checkSystemLoad: true, checkProtectedApps: true, checkUserActivity: true, checkFullscreen: true, forceCloseApps: false });
    });
});

describe('EnterprisePolicies - materializeWakeJobs', () => {
    const wake = (over = {}) => policy({ type: 'pre-patch-wake', params: { wakeTime: '05:00', waveSize: 2, waveGapSec: 5 }, ...over });
    const targets = [
        { agentId: 'a1', mac: 'AA:BB:CC:DD:EE:01', broadcastIp: '192.168.1.255', port: 9 },
        { agentId: 'a2', mac: 'AA:BB:CC:DD:EE:02' },
        { agentId: 'a3' },
        null
    ];

    it('dalgalar hâlinde iş üretir, MAC\'siz hedefleri atlar', () => {
        const { jobs, skipped } = materializeWakeJobs(wake(), targets, { baseTimeMs: NOW });
        expect(jobs).toHaveLength(2);
        expect(jobs[0]).toMatchObject({ agentId: 'a1', broadcastIp: '192.168.1.255', port: 9, notBefore: NOW, wave: 0 });
        // waveSize=2 → ilk iki hedef aynı dalgada
        expect(jobs[1]).toMatchObject({ agentId: 'a2', broadcastIp: '255.255.255.255', port: 9, notBefore: NOW, wave: 0 });
        expect(skipped).toEqual(['a3', '?']);

        // waveSize=1 → her hedef ayrı dalga
        const perWave = materializeWakeJobs(wake({ params: { wakeTime: '05:00', waveSize: 1, waveGapSec: 5 } }), targets, { baseTimeMs: NOW });
        expect(perWave.jobs[1].notBefore).toBe(NOW + 5000);
    });

    it('waveSize/waveGapSec varsayılanları uygulanır', () => {
        const p = policy({ type: 'pre-patch-wake', params: { wakeTime: '05:00' }, targets: ['a1', 'a2'] });
        const { jobs } = materializeWakeJobs(p, [{ agentId: 'a1', mac: 'M1' }, { agentId: 'a2', mac: 'M2' }], { baseTimeMs: NOW });
        expect(jobs[1].notBefore).toBe(NOW);
    });

    it('geçersiz politika fırlatır', () => {
        expect(() => materializeWakeJobs({ id: '' }, [])).toThrow();
        expect(() => materializeWakeJobs(wake(), [])).toThrow(); // boş hedef listesi
    });
});
