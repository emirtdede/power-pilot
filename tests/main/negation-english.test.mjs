/**
 * negation-english.test.mjs - P1-7 regresyon kapısı
 *
 * Ölçülen kusur: NegationGuard yalnızca Türkçe biliyordu. İngilizce
 * "don't shut down in 10 minutes" cümlesi olumlu sanılıyor ve yıkıcı
 * eyleme dönüşebiliyordu. Bu test iki dilin birlikte denetlendiğini kilitler.
 */
import { describe, it, expect } from 'vitest';
import { inspect, guardProposal } from '../../src/main/services/NegationGuard.js';

describe('NegationGuard - İngilizce olumsuzluk (P1-7)', () => {
    it('İngilizce olumsuz cümleler yakalanır', () => {
        for (const text of [
            "don't shut down in 10 minutes",
            'do not restart the pc',
            'never sleep tonight',
            'please do not power off',
            "don't reboot"
        ]) {
            expect(inspect(text).negated, text).toBe(true);
        }
    });

    it('İngilizce olumlu cümleler yanlış pozitif üretmez', () => {
        for (const text of [
            'shut down in 10 minutes',
            'restart the pc at 3am',
            'sleep after the render finishes',
            'power off when the download completes'
        ]) {
            expect(inspect(text).negated, text).toBe(false);
        }
    });

    it('Türkçe davranış korunur', () => {
        expect(inspect('kapatma').negated).toBe(true);
        expect(inspect('bilgisayarı kapatmayın').negated).toBe(true);
        expect(inspect('45 dk sonra kapat').negated).toBe(false);
    });

    it('guardProposal İngilizce olumsuzlukta yıkıcı eylemi reddeder', () => {
        const r = guardProposal("don't shut down", { action: 'shutdown' });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('NEGATED_INTENT');
    });

    it('guardProposal İngilizce olumluda geçirir', () => {
        const r = guardProposal('shut down in 10 minutes', { action: 'shutdown' });
        expect(r.ok).toBe(true);
    });
});
