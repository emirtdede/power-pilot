/**
 * EnergyEstimateService.js - FAZ D + WP-6 Zenginleştirilmiş İstatistik Motoru.
 * Kapanış kaydı → sonraki açılış kaydı (bootHistory) = GERÇEK kapalı-süre.
 * Eşleşmeyen kapanışlar SADECE kullanıcı beyanlı assumedOffHours ile ve
 * isEstimate:true + missing listesiyle raporlanır; beyan yoksa "-" döner.
 *
 * WP-6 eklemeleri (tam geriye dönük uyumlu):
 *  - Dönem filtresi (`days`: 7 | 30 | null/tümü)
 *  - Eylem & tetikleyici kaynak dağılımları, başarı oranı, günlük/saatlik seriler
 *  - Tahmini CO₂ azaltımı (0.42 kg/kWh), aylık/yıllık projeksiyon, aktif seri
 *  - Son tasarruf olayları tablosu ve enerji profili özeti
 */
'use strict';

const POWER_DOWN_ACTIONS = new Set(['shutdown', 'sleep', 'hibernate']);
const CO2_KG_PER_KWH = 0.42;

function dayKeyOf(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

class EnergyEstimateService {
    constructor(storageService) {
        this.storage = storageService;
    }

    /**
     * WP-11.T8: boot/down sıralı iki-pointer. Aynı boot'a düşen ardışık
     * kapanışlardan yalnızca SONUNCUSU sayılır (çift sayım yok). 14 günü aşan
     * eşleşme bozuk sayılır.
     * @returns {{measuredHours:number, unmatched:number, sessions:Array<{downAt:string,bootAt:string,hours:number}>}}
     */
    static matchOffHours(powerDowns, boots) {
        const downMs = (powerDowns || [])
            .map((d) => new Date(d).getTime())
            .filter((t) => Number.isFinite(t))
            .sort((a, b) => a - b);
        const bootMs = (boots || [])
            .map((b) => new Date(b).getTime())
            .filter((t) => Number.isFinite(t))
            .sort((a, b) => a - b);
        let measuredHours = 0;
        let unmatched = 0;
        const sessions = [];
        let bi = 0;
        let i = 0;
        while (i < downMs.length) {
            const t = downMs[i];
            while (bi < bootMs.length && bootMs[bi] <= t) bi += 1;
            if (bi >= bootMs.length) {
                unmatched += downMs.length - i;
                break;
            }
            const next = bootMs[bi];
            let last = i;
            while (last + 1 < downMs.length && downMs[last + 1] < next) last += 1;
            const hours = (next - downMs[last]) / 3600000;
            if (hours > 0 && hours <= 24 * 14) {
                measuredHours += hours;
                sessions.push({
                    downAt: new Date(downMs[last]).toISOString(),
                    bootAt: new Date(next).toISOString(),
                    hours: Math.round(hours * 100) / 100
                });
            } else {
                unmatched += 1;
            }
            i = last + 1;
        }
        return { measuredHours, unmatched, sessions };
    }

    getStatistics(options = {}) {
        const settings = this.storage.getSettings();
        if (!settings.statsEnabled) {
            return { enabled: false };
        }

        const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
        const rawDays = options && options.days != null ? Number(options.days) : null;
        const periodDays = Number.isInteger(rawDays) && rawDays > 0 && rawDays <= 3650 ? rawDays : null;
        const cutoffMs = periodDays ? (nowMs - periodDays * 86400000) : null;

        const allHistory = Array.isArray(this.storage.getHistory()) ? this.storage.getHistory() : [];
        const history = cutoffMs == null
            ? allHistory
            : allHistory.filter((h) => {
                if (!h || !h.timestamp) return false;
                const ms = new Date(h.timestamp).getTime();
                return Number.isFinite(ms) && ms >= cutoffMs;
            });

        const successExecutions = history.filter((h) => h && h.resultCode === 'success');
        const cancelledExecutions = history.filter((h) => h && h.resultCode === 'cancelled_by_user');
        const blockedExecutions = history.filter((h) => h && h.resultCode === 'blocked_by_policy');
        const failedExecutions = history.filter((h) => h && (h.resultCode === 'os_execution_failed' || h.resultCode === 'failed'));
        const snoozedExecutions = history.filter((h) => h && h.resultCode === 'snoozed_by_user');
        const missedExecutions = history.filter((h) => h && (h.resultCode === 'missed' || h.resultCode === 'expired'));

        const downs = successExecutions
            .filter((h) => POWER_DOWN_ACTIONS.has(h.action))
            .map((h) => h.timestamp);
        const boots = typeof this.storage.getBootHistory === 'function' ? this.storage.getBootHistory() : [];
        const { measuredHours, unmatched, sessions } = EnergyEstimateService.matchOffHours(downs, boots);

        const assumed = typeof settings.assumedOffHours === 'number' && settings.assumedOffHours > 0
            ? settings.assumedOffHours
            : null;
        const estimatedHours = assumed !== null ? unmatched * assumed : 0;

        const missing = [];
        const deviceWatt = settings.deviceWattage;
        const hasWatt = typeof deviceWatt === 'number' && Number.isFinite(deviceWatt) && deviceWatt > 0;
        if (!hasWatt) missing.push('watt');
        if (unmatched > 0 && assumed === null) missing.push('offhours');

        const totalHours = measuredHours + estimatedHours;
        const kwhSaved = hasWatt ? (deviceWatt * totalHours) / 1000 : null;

        const costPerKwh = settings.electricityCostPerKwh;
        const hasPrice = typeof costPerKwh === 'number' && Number.isFinite(costPerKwh) && costPerKwh >= 0;
        if (!hasPrice) missing.push('price');
        const currency = settings.currency || 'TL';

        const costSaved = hasWatt && hasPrice ? kwhSaved * costPerKwh : null;
        const estimatedCo2Kg = kwhSaved == null ? null : (kwhSaved * CO2_KG_PER_KWH);

        // P1-6: `priceEffectiveFrom` önceden yalnızca saklanıyor, doğrulanıyor ama
        // hiçbir yerde okunmuyordu (ölü veri = plasebo). Artık tarifenin ne zaman
        // geçerli olduğu hesaplanır ve eskimiş tarife kullanıcıya bildirilir.
        const priceEffectiveFrom = typeof settings.priceEffectiveFrom === 'string'
            && /^\d{4}-(0[1-9]|1[0-2])$/.test(settings.priceEffectiveFrom)
            ? settings.priceEffectiveFrom
            : null;
        let priceAgeMonths = null;
        if (priceEffectiveFrom) {
            const [py, pm] = priceEffectiveFrom.split('-').map((v) => parseInt(v, 10));
            const nowDate = new Date(nowMs);
            priceAgeMonths = (nowDate.getFullYear() - py) * 12 + (nowDate.getMonth() + 1 - pm);
            if (!Number.isFinite(priceAgeMonths) || priceAgeMonths < 0) priceAgeMonths = null;
        }
        // 12 aydan eski tarife "eskimiş" sayılır (elektrik fiyatları yılda en az
        // bir kez değişir; daha eski bir değer maliyet hesabını yanıltır).
        const priceStale = hasPrice && priceAgeMonths !== null && priceAgeMonths >= 12;

        // Eylem dağılımı
        const actionCounts = { shutdown: 0, restart: 0, sleep: 0, hibernate: 0, lock: 0, signout: 0 };
        for (const h of successExecutions) {
            if (h.action && Object.prototype.hasOwnProperty.call(actionCounts, h.action)) {
                actionCounts[h.action] += 1;
            }
        }
        const actionBreakdown = Object.entries(actionCounts)
            .map(([action, count]) => ({
                action,
                count,
                pct: successExecutions.length > 0 ? Math.round((count / successExecutions.length) * 100) : 0
            }))
            .sort((a, b) => b.count - a.count);

        // Kaynak dağılımı
        const sourceMap = new Map();
        for (const h of history) {
            const src = (h && h.source) ? String(h.source) : 'user_interface';
            sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
        }
        const sourceBreakdown = [...sourceMap.entries()]
            .map(([source, count]) => ({
                source,
                count,
                pct: history.length > 0 ? Math.round((count / history.length) * 100) : 0
            }))
            .sort((a, b) => b.count - a.count);

        // 24 saatlik yoğunluk haritası
        const hourlyDistribution = new Array(24).fill(0);
        const activeDaySet = new Set();
        for (const h of successExecutions) {
            if (!h || !h.timestamp) continue;
            const ms = new Date(h.timestamp).getTime();
            if (!Number.isFinite(ms)) continue;
            hourlyDistribution[new Date(ms).getHours()] += 1;
            activeDaySet.add(dayKeyOf(ms));
        }

        // Günlük zaman serisi (7 veya 30 gün penceresi)
        const chartDays = periodDays === 7 ? 7 : 30;
        const dailyBuckets = new Map();
        for (let i = chartDays - 1; i >= 0; i--) {
            const key = dayKeyOf(nowMs - i * 86400000);
            dailyBuckets.set(key, { date: key, runs: 0, hours: 0, kwh: 0 });
        }
        for (const h of successExecutions) {
            if (!h || !h.timestamp) continue;
            const ms = new Date(h.timestamp).getTime();
            if (!Number.isFinite(ms)) continue;
            const key = dayKeyOf(ms);
            if (dailyBuckets.has(key)) dailyBuckets.get(key).runs += 1;
        }
        for (const sess of sessions) {
            const ms = new Date(sess.downAt).getTime();
            const key = dayKeyOf(ms);
            if (dailyBuckets.has(key)) {
                const b = dailyBuckets.get(key);
                b.hours = Math.round((b.hours + sess.hours) * 100) / 100;
                if (hasWatt) b.kwh = Math.round(((deviceWatt * b.hours) / 1000) * 1000) / 1000;
            }
        }
        const dailySeries = [...dailyBuckets.values()];

        // Aktif gün serisi (bugünden geriye ardışık başarılı gün sayısı)
        let activeStreakDays = 0;
        for (let i = 0; i < 365; i++) {
            const k = dayKeyOf(nowMs - i * 86400000);
            if (activeDaySet.has(k)) activeStreakDays += 1;
            else if (i > 0) break;
        }

        // Projeksiyonlar (gözlemlenen dönem gün sayısına göre)
        const observedDays = (() => {
            if (periodDays) return periodDays;
            const timestamps = history
                .map((h) => h && h.timestamp ? new Date(h.timestamp).getTime() : NaN)
                .filter((ms) => Number.isFinite(ms));
            if (timestamps.length === 0) return 30;
            const oldest = Math.min(...timestamps);
            return Math.max(1, Math.min(365, Math.ceil((nowMs - oldest) / 86400000)));
        })();
        const monthlyProjectedKwh = kwhSaved == null ? null : Number(((kwhSaved / observedDays) * 30).toFixed(2));
        const yearlyProjectedCost = costSaved == null ? null : Number(((costSaved / observedDays) * 365).toFixed(2));

        const totalRuns = history.length;
        const decided = successExecutions.length + failedExecutions.length + blockedExecutions.length;
        const successRatePct = decided > 0 ? Math.round((successExecutions.length / decided) * 100) : (successExecutions.length > 0 ? 100 : 0);
        const longestOffSessionHours = sessions.length > 0
            ? Number(Math.max(...sessions.map((s) => s.hours)).toFixed(1))
            : 0;

        const recentSavingsEvents = [...sessions]
            .reverse()
            .slice(0, 12)
            .map((s) => ({
                downAt: s.downAt,
                bootAt: s.bootAt,
                hours: Number(s.hours.toFixed(1)),
                kwh: hasWatt ? Number(((deviceWatt * s.hours) / 1000).toFixed(2)) : null,
                cost: hasWatt && hasPrice ? Number((((deviceWatt * s.hours) / 1000) * costPerKwh).toFixed(2)) : null,
                currency
            }));

        return {
            enabled: true,
            periodDays,
            totalRuns,
            totalActionsCount: successExecutions.length,
            cancelledCount: cancelledExecutions.length,
            blockedCount: blockedExecutions.length,
            failedCount: failedExecutions.length,
            snoozedCount: snoozedExecutions.length,
            missedCount: missedExecutions.length,
            successRatePct,
            preventedUptimeHours: totalHours.toFixed(1),
            measuredHours: measuredHours.toFixed(1),
            estimatedHours: estimatedHours.toFixed(1),
            unmeasuredCount: assumed === null ? unmatched : 0,
            method: measuredHours > 0 && estimatedHours === 0 ? 'measured'
                : measuredHours > 0 ? 'mixed'
                : estimatedHours > 0 ? 'assumed' : 'none',
            kwhSaved: kwhSaved == null ? null : kwhSaved.toFixed(2),
            costSaved: costSaved == null ? null : Number(costSaved.toFixed(2)),
            costSavedFormatted: costSaved == null ? null : `${costSaved.toFixed(2)} ${currency}`,
            currency,
            estimatedCo2Kg: estimatedCo2Kg == null ? null : estimatedCo2Kg.toFixed(2),
            monthlyProjectedKwh,
            yearlyProjectedCost,
            yearlyProjectedCostFormatted: yearlyProjectedCost == null ? null : `${yearlyProjectedCost.toFixed(2)} ${currency}`,
            activeStreakDays,
            longestOffSessionHours,
            actionBreakdown,
            sourceBreakdown,
            dailySeries,
            hourlyDistribution,
            recentSavingsEvents,
            profile: {
                deviceWattage: hasWatt ? deviceWatt : null,
                wattSource: settings.wattSource || 'unset',
                electricityCostPerKwh: hasPrice ? costPerKwh : null,
                priceSource: settings.priceSource || 'unset',
                priceEffectiveFrom,
                priceAgeMonths,
                priceStale,
                currency,
                assumedOffHours: assumed
            },
            missing,
            isEstimate: estimatedHours > 0 || unmatched > 0
        };
    }
}

module.exports = EnergyEstimateService;
