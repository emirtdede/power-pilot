/**
 * templates.test.mjs - TemplateService: 10 hazır şablon + kullanıcı birleşimi + karantina.
 * Kural: ölü şablon yasaktır (koşul destekli YA DA zamanlamalı olmalı).
 */
import { describe, it, expect, vi } from 'vitest';
import TemplateService from '../../src/main/services/TemplateService.js';

function condTypesOf(tpl) {
    if (tpl.defaultCondition) return [tpl.defaultCondition.type];
    if (tpl.defaultConditionGroup) return tpl.defaultConditionGroup.conditions.map((c) => c.type);
    return [];
}

describe('TemplateService hazır şablonlar (WBS-6.3 + WP-7)', () => {
    it('22 hazır şablon döner, id benzersizdir ve 7 kategoriye dağılmıştır', () => {
        const tpls = new TemplateService().getTemplates();
        expect(tpls).toHaveLength(22);
        const ids = tpls.map((t) => t.id);
        expect(new Set(ids).size).toBe(22);
        const categories = new Set(tpls.map((t) => t.category));
        expect(categories.size).toBeGreaterThanOrEqual(7);
    });

    it('tüm şablonlar canlıdır: koşul destekli YA DA zamanlamalı (ölü şablon yok)', () => {
        const tpls = new TemplateService().getTemplates();
        for (const t of tpls) {
            expect(TemplateService.isValidTemplate(t)).toBe(true);
        }
    });

    it('koşullu şablonların her koşulu motor-desteklidir', () => {
        const tpls = new TemplateService().getTemplates();
        for (const t of tpls) {
            for (const type of condTypesOf(t)) {
                expect(TemplateService.isSupportedCondition(type)).toBe(true);
            }
        }
    });

    it('stabilite süreleri IPC sınırları içindedir (0..3600)', () => {
        const tpls = new TemplateService().getTemplates();
        const secs = [];
        for (const t of tpls) {
            if (t.defaultCondition?.stabilitySeconds !== undefined) secs.push(t.defaultCondition.stabilitySeconds);
            if (t.defaultConditionGroup?.stabilitySeconds !== undefined) secs.push(t.defaultConditionGroup.stabilitySeconds);
        }
        expect(secs.length).toBeGreaterThan(0);
        for (const s of secs) {
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(3600);
        }
    });

    it('zamanlamalı şablon HH:MM biçimindedir', () => {
        const tpls = new TemplateService().getTemplates().filter((t) => t.schedule);
        expect(tpls.length).toBeGreaterThan(0);
        for (const t of tpls) {
            expect(t.schedule.timeOfDay).toMatch(/^\d{2}:\d{2}$/);
        }
    });
});

describe('TemplateService kullanıcı şablonları (WBS-6.4 + WP-7)', () => {
    it('kullanıcı şablonları custom bayrağıyla birleşir', () => {
        const storage = { getTemplates: () => [{ id: 'user_tpl_1', name: 'Benimki', action: 'sleep', defaultCondition: { type: 'cpu_usage' } }] };
        const tpls = new TemplateService(storage).getTemplates();
        expect(tpls).toHaveLength(23);
        const custom = tpls.find((t) => t.id === 'user_tpl_1');
        expect(custom.custom).toBe(true);
        expect(custom.disabled).toBeUndefined();
    });

    it('yerleşik şablon override (düzenleme) ve gizleme/geri getirme çalışır', () => {
        const storage = {
            getTemplates: () => [],
            getSettings: () => ({
                templateOverrides: {
                    tpl_render_shutdown: {
                        name: 'Özel Render Kapatma',
                        action: 'sleep',
                        defaultCondition: { type: 'cpu_usage', thresholdPercent: 15, stabilitySeconds: 90 }
                    }
                },
                hiddenBuiltInTemplates: ['tpl_meeting_lock']
            })
        };
        const svc = new TemplateService(storage);
        const tpls = svc.getTemplates();
        expect(tpls).toHaveLength(21);
        expect(tpls.find((t) => t.id === 'tpl_meeting_lock')).toBeUndefined();
        const edited = tpls.find((t) => t.id === 'tpl_render_shutdown');
        expect(edited.modified).toBe(true);
        expect(edited.name).toBe('Özel Render Kapatma');
        expect(edited.action).toBe('sleep');
        const hidden = svc.getHiddenBuiltIns();
        expect(hidden.map((h) => h.id)).toEqual(['tpl_meeting_lock']);
    });

    it('duration tetikleyicili şablonları doğrular', () => {
        expect(TemplateService.isValidTemplate({
            id: 'user_tpl_dur',
            name: '45 Dk Kapat',
            action: 'shutdown',
            trigger: { type: 'duration', durationMs: 45 * 60000 }
        })).toBe(true);
        expect(TemplateService.isValidTemplate({
            id: 'user_tpl_bad_dur',
            name: 'Geçersiz Süre',
            action: 'shutdown',
            trigger: { type: 'duration', durationMs: 0 }
        })).toBe(false);
    });

    it('bozuk kullanıcı kaydı karantinaya alınır (uygulama açılır)', () => {
        const storage = { getTemplates: () => [{ id: 'user_tpl_x', name: 'Bozuk', action: 'shutdown', defaultCondition: { type: 'file_event' } }] };
        const tpls = new TemplateService(storage).getTemplates();
        const bad = tpls.find((t) => t.id === 'user_tpl_x');
        expect(bad.disabled).toBe(true);
        expect(bad.disabledReason).toBeDefined();
    });

    it('isValidTemplate geçersizleri reddeder', () => {
        expect(TemplateService.isValidTemplate(null)).toBe(false);
        expect(TemplateService.isValidTemplate({})).toBe(false);
        expect(TemplateService.isValidTemplate({ id: 'a', name: 'x'.repeat(81), action: 'sleep', defaultCondition: { type: 'cpu_usage' } })).toBe(false);
        expect(TemplateService.isValidTemplate({ id: 'a', name: 'N', action: 'sleep', schedule: { timeOfDay: 'gece' } })).toBe(false);
        expect(TemplateService.isValidTemplate({ id: 'a', name: 'N', action: 'sleep', schedule: { timeOfDay: '99:99' } })).toBe(false);
        expect(TemplateService.isValidTemplate({ id: 'a', name: 'N', action: 'invalid_action', schedule: { timeOfDay: '01:00' } })).toBe(false);
    });
});
