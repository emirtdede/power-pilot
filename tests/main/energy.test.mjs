/**
 * energy.test.mjs - EnergyEstimateService FAZ D: gerçek-ölçüm (kapanış→açılış),
 * beyanlı varsayım damgası, uydurma-sayı yok.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EnergyEstimateService = require('../../src/main/services/EnergyEstimateService.js');

function makeService(settings, history, boots = []) {
    return new EnergyEstimateService({
        getSettings: () => settings,
        getHistory: () => history,
        getBootHistory: () => boots
    });
}

const BASE_SETTINGS = { statsEnabled: true, deviceWattage: 150, electricityCostPerKwh: 2.5, currency: 'TL' };
// 19:30 kapanış → 07:30 açılış = 12.0h gerçek kapalı-süre
const DOWN = '2026-10-13T19:30:00.000Z';
const BOOT = '2026-10-14T07:30:00.000Z';

function down(action = 'shutdown', timestamp = DOWN) {
    return { resultCode: 'success', action, timestamp };
}

describe('EnergyEstimateService', () => {
    it('statsEnabled:false → {enabled:false}', () => {
        const svc = makeService({ statsEnabled: false }, []);
        expect(svc.getStatistics()).toEqual({ enabled: false });
    });

    it('2 kapanış + açılışlar → 24.0 gerçek saat, 3.60 kWh, 9.00 TL', () => {
        const svc = makeService(BASE_SETTINGS, [
            down('shutdown', '2026-10-14T19:30:00.000Z'),
            down(), down('sleep', DOWN),
            { resultCode: 'cancelled_by_user' }, { resultCode: 'blocked_by_policy' }
        ], [BOOT, '2026-10-15T07:30:00.000Z']);
        const st = svc.getStatistics();
        expect(st.enabled).toBe(true);
        expect(st.totalActionsCount).toBe(3);
        expect(st.cancelledCount).toBe(1);
        expect(st.blockedCount).toBe(1);
        expect(st.preventedUptimeHours).toBe('24.0');
        expect(st.measuredHours).toBe('24.0');
        expect(st.method).toBe('measured');
        expect(st.kwhSaved).toBe('3.60');
        expect(st.costSavedFormatted).toBe('9.00 TL');
        expect(st.isEstimate).toBe(false);
    });

    it('özel watt + para birimi formüle yansır', () => {
        const svc = makeService(
            { statsEnabled: true, deviceWattage: 65, electricityCostPerKwh: 1, currency: 'USD' },
            [down()], [BOOT]
        );
        const st = svc.getStatistics();
        // 65W × 12h / 1000 = 0.78
        expect(st.kwhSaved).toBe('0.78');
        expect(st.costSavedFormatted).toBe('0.78 USD');
    });

    it('boş geçmiş sıfır üretir (NaN yok)', () => {
        const st = makeService(BASE_SETTINGS, []).getStatistics();
        expect(st.kwhSaved).toBe('0.00');
        expect(st.preventedUptimeHours).toBe('0.0');
    });

    it('watt yoksa kWh null + missing watt (ölçülen saat yine raporlanır)', () => {
        const st = makeService({ ...BASE_SETTINGS, deviceWattage: null }, [down()], [BOOT]).getStatistics();
        expect(st.kwhSaved).toBeNull();
        expect(st.costSavedFormatted).toBeNull();
        expect(st.missing).toContain('watt');
        expect(st.preventedUptimeHours).toBe('12.0');
    });

    it('fiyat yoksa TL null + missing price, kWh çalışır', () => {
        const st = makeService({ ...BASE_SETTINGS, deviceWattage: 200, electricityCostPerKwh: null }, [down()], [BOOT]).getStatistics();
        expect(st.kwhSaved).toBe('2.40');
        expect(st.costSavedFormatted).toBeNull();
        expect(st.missing).toEqual(['price']);
    });

    it('eşleşmeyen kapanış + beyan yoksa unmeasured + missing offhours (uydurma yok)', () => {
        const st = makeService(BASE_SETTINGS, [down()], []).getStatistics();
        expect(st.preventedUptimeHours).toBe('0.0');
        expect(st.kwhSaved).toBe('0.00');
        expect(st.unmeasuredCount).toBe(1);
        expect(st.missing).toContain('offhours');
        expect(st.isEstimate).toBe(true);
    });

    it('eşleşmeyen kapanış + beyanlı varsayım = damgalı tahmin', () => {
        const st = makeService({ ...BASE_SETTINGS, assumedOffHours: 10 }, [down()], []).getStatistics();
        expect(st.preventedUptimeHours).toBe('10.0');
        expect(st.estimatedHours).toBe('10.0');
        expect(st.method).toBe('assumed');
        expect(st.kwhSaved).toBe('1.50'); // 150W × 10h
        expect(st.isEstimate).toBe(true);
        expect(st.missing).not.toContain('offhours');
    });

    it('ikisi de doluyken + eşleşme varsa missing boştur', () => {
        const st = makeService(BASE_SETTINGS, [down()], [BOOT]).getStatistics();
        expect(st.missing).toEqual([]);
    });

    it('lock gibi kapanış-dışı eylemler saate katılmaz', () => {
        const st = makeService(BASE_SETTINGS, [down('lock', DOWN)], [BOOT]).getStatistics();
        expect(st.preventedUptimeHours).toBe('0.0');
        expect(st.totalActionsCount).toBe(1);
    });

    it('WP-6: dönem filtresi, CO2 tahmini, dağılımlar, 24s harita ve projeksiyon üretir', () => {
        const nowMs = Date.parse('2026-10-16T12:00:00.000Z');
        const history = [
            { resultCode: 'success', action: 'shutdown', source: 'user_interface', timestamp: '2026-10-14T19:30:00.000Z' },
            { resultCode: 'success', action: 'sleep', source: 'cli', timestamp: '2026-10-15T22:00:00.000Z' },
            { resultCode: 'blocked_by_policy', action: 'shutdown', source: 'local_api', timestamp: '2026-10-15T23:00:00.000Z' },
            { resultCode: 'success', action: 'shutdown', source: 'user_interface', timestamp: '2026-08-01T20:00:00.000Z' }
        ];
        const boots = ['2026-10-15T07:30:00.000Z', '2026-10-16T06:00:00.000Z'];
        const st = makeService(BASE_SETTINGS, history, boots).getStatistics({ days: 7, nowMs });

        expect(st.totalRuns).toBe(3);
        expect(st.totalActionsCount).toBe(2);
        expect(st.blockedCount).toBe(1);
        expect(st.successRatePct).toBe(67);
        expect(st.preventedUptimeHours).toBe('20.0');
        expect(st.kwhSaved).toBe('3.00');
        expect(st.estimatedCo2Kg).toBe('1.26');
        expect(st.monthlyProjectedKwh).not.toBeNull();
        expect(st.yearlyProjectedCostFormatted).toContain('TL');
        expect(st.hourlyDistribution).toHaveLength(24);
        expect(st.dailySeries).toHaveLength(7);
        expect(st.actionBreakdown.length).toBeGreaterThanOrEqual(2);
        expect(st.sourceBreakdown.length).toBeGreaterThanOrEqual(2);
        expect(st.recentSavingsEvents).toHaveLength(2);
        expect(st.longestOffSessionHours).toBe(12);
    });
});
