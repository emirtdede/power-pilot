/**
 * health-metrics.test.mjs - C5 yerel sağlık özeti
 *
 * Saf fonksiyon: depo/saat enjekte edilir, ağ yok, OS yok.
 * Ürünün "telemetri yok" vaadi: bu modül yalnızca cihazdaki kayıtları
 * özetler, hiçbir şey göndermez.
 */
import { describe, it, expect } from 'vitest';
import { summarize, FAILURE_CODES } from '../../src/main/services/HealthMetrics.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const DAY = 86400000;

describe('HealthMetrics.summarize', () => {
    it('boş geçmişte güvenli varsayılan döner', () => {
        const s = summarize({ history: [], installedAtMs: NOW - 3 * DAY, nowMs: NOW });
        expect(s.totalRecords).toBe(0);
        expect(s.successRatePercent).toBeNull();
        expect(s.hasFailures).toBe(false);
        expect(s.daysInstalled).toBe(3);
        expect(s.lastFailureAt).toBeNull();
    });

    it('geçmiş yoksa çökmez', () => {
        const s = summarize({ history: null, installedAtMs: null, nowMs: NOW });
        expect(s.totalRecords).toBe(0);
        expect(s.daysInstalled).toBeNull();
    });

    it('başarı oranı yalnızca denenen (başarı + hata) üzerinden hesaplanır', () => {
        const history = [
            { resultCode: 'success', timestamp: '2026-11-17T10:00:00.000Z' },
            { resultCode: 'success', timestamp: '2026-11-16T10:00:00.000Z' },
            { resultCode: 'success', timestamp: '2026-11-15T10:00:00.000Z' },
            { resultCode: 'os_execution_failed', timestamp: '2026-11-14T10:00:00.000Z' }
        ];
        const s = summarize({ history, installedAtMs: NOW - 10 * DAY, nowMs: NOW });
        expect(s.successCount).toBe(3);
        expect(s.failureCount).toBe(1);
        // İptaller orana girmez: 3/4 = 75.
        expect(s.successRatePercent).toBe(75);
    });

    it('iptal ve erteleme başarısızlık sayılmaz', () => {
        const s = summarize({
            history: [
                { resultCode: 'cancelled_by_user' },
                { resultCode: 'snoozed_by_user' },
                { resultCode: 'success' }
            ],
            installedAtMs: NOW - DAY,
            nowMs: NOW
        });
        expect(s.cancelledCount).toBe(2);
        expect(s.failureCount).toBe(0);
        expect(s.successRatePercent).toBe(100);
        expect(s.hasFailures).toBe(false);
    });

    it('tüm hata kodları hata sayılır', () => {
        const history = [...FAILURE_CODES].map((code) => ({ resultCode: code, timestamp: '2026-11-17T09:00:00.000Z' }));
        const s = summarize({ history, installedAtMs: NOW - DAY, nowMs: NOW });
        expect(s.failureCount).toBe(FAILURE_CODES.size);
        expect(s.successRatePercent).toBe(0);
        expect(s.hasFailures).toBe(true);
    });

    it('bilinmeyen sonuç kodu "diğer" sayılır, orana girmez', () => {
        const s = summarize({
            history: [{ resultCode: 'interrupted_by_shutdown' }, { resultCode: 'success' }],
            installedAtMs: NOW - DAY,
            nowMs: NOW
        });
        expect(s.otherCount).toBe(1);
        expect(s.successRatePercent).toBe(100);
    });

    it('en son hatayı ISO olarak verir (ham kod sızdırmaz)', () => {
        const s = summarize({
            history: [
                { resultCode: 'timeout', timestamp: '2026-11-10T10:00:00.000Z' },
                { resultCode: 'os_execution_failed', timestamp: '2026-11-16T10:00:00.000Z' }
            ],
            installedAtMs: NOW - 20 * DAY,
            nowMs: NOW
        });
        expect(s.lastFailureAt).toBe('2026-11-16T10:00:00.000Z');
        // Dönen nesnede ham hata kodu alanı yok.
        expect(Object.keys(s)).not.toContain('code');
        expect(Object.keys(s)).not.toContain('lastFailureCode');
    });

    it('kurulum yaşı negatife düşmez (saat geri alınmışsa)', () => {
        const s = summarize({ history: [], installedAtMs: NOW + 5 * DAY, nowMs: NOW });
        expect(s.daysInstalled).toBe(0);
    });

    it('geçersiz nowMs Date.now() varsayılanına düşer', () => {
        const s = summarize({ history: [], installedAtMs: Date.now() - 2 * DAY, nowMs: 'abc' });
        expect(s.daysInstalled).toBeGreaterThanOrEqual(1);
    });

    it('geçersiz kurulum tarihi gizlenir', () => {
        const s = summarize({ history: [], installedAtMs: NaN, nowMs: NOW });
        expect(s.daysInstalled).toBeNull();
    });
});
