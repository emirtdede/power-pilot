/**
 * template-transfer.test.mjs - Faz 3 şablon içe/dışa aktarma kuralları
 *
 * Dışa aktarım: yalnızca kullanıcı şablonları, sürümlü zarf.
 * İçe aktarım: boyut/sözdizimi/şema kapıları, sunucu tarafı kimlik üretimi,
 * hazır şablonların üzerine yazılmaması.
 */
import { describe, it, expect } from 'vitest';
import TemplateTransfer from '../../src/main/services/TemplateTransfer.js';

const cloudTpl = {
    id: 'user_tpl_1',
    name: 'Render bitince kapat',
    description: 'Bulut render kuyruğu boşalınca',
    action: 'shutdown',
    defaultConditionGroup: { operator: 'AND', conditions: [{ type: 'cpu_usage', operator: 'below', value: 10 }] }
};

describe('TemplateTransfer - dışa aktarım', () => {
    it('yalnızca user_tpl_ kayıtlarını sürümlü zarfa koyar', () => {
        const payload = TemplateTransfer.collectExportable([
            { id: 'tpl_builtin', name: 'Hazır', action: 'sleep' },
            cloudTpl
        ], '2026-01-02T03:04:05.000Z');

        expect(payload.schema).toBe(TemplateTransfer.EXPORT_SCHEMA);
        expect(payload.app).toBe('PowerPilot');
        expect(payload.exportedAt).toBe('2026-01-02T03:04:05.000Z');
        expect(payload.templates).toHaveLength(1);
        expect(payload.templates[0].id).toBe('user_tpl_1');
    });

    it('kullanıcı şablonu yoksa null döner (boş dosya üretilmez)', () => {
        expect(TemplateTransfer.collectExportable([])).toBeNull();
        expect(TemplateTransfer.collectExportable([{ id: 'tpl_x' }])).toBeNull();
        expect(TemplateTransfer.collectExportable(null)).toBeNull();
    });
});

describe('TemplateTransfer - içe aktarım ayrıştırma', () => {
    it('zarf ve düz dizi biçimlerini kabul eder', () => {
        const wrapped = TemplateTransfer.parseImportPayload(JSON.stringify({ templates: [cloudTpl] }));
        expect(wrapped.ok).toBe(true);
        expect(wrapped.templates).toHaveLength(1);

        const bare = TemplateTransfer.parseImportPayload(JSON.stringify([cloudTpl]));
        expect(bare.ok).toBe(true);
        expect(bare.templates).toHaveLength(1);
    });

    it('bozuk JSON, yanlış şema ve aşırı boyutu reddeder', () => {
        expect(TemplateTransfer.parseImportPayload('{ nope').code).toBe('PARSE_ERROR');
        expect(TemplateTransfer.parseImportPayload(JSON.stringify({ hello: 1 })).code).toBe('INVALID_SCHEMA');
        expect(TemplateTransfer.parseImportPayload('x'.repeat(TemplateTransfer.MAX_FILE_BYTES + 1)).code).toBe('FILE_TOO_LARGE');
        expect(TemplateTransfer.parseImportPayload(null).code).toBe('PARSE_ERROR');
    });
});

describe('TemplateTransfer - birleştirme', () => {
    it('geçerli şablonu yeni kimlikle kullanıcı şablonu olarak ekler', () => {
        const before = [{ id: 'tpl_builtin', name: 'Hazır', action: 'sleep' }];
        const merged = TemplateTransfer.mergeImportedTemplates([cloudTpl], before, 1700000000000);

        expect(merged.rejected).toBe(0);
        expect(merged.added).toHaveLength(1);
        expect(merged.added[0].id).toMatch(/^user_tpl_imp_/);
        expect(merged.added[0].id).not.toBe(cloudTpl.id);
        expect(merged.added[0].category).toBe('custom');
        expect(merged.added[0].defaultConditionGroup.conditions[0].type).toBe('cpu_usage');
        expect(merged.templates).toHaveLength(2);
        expect(merged.templates[0].id).toBe('tpl_builtin');
    });

    it('dosyadaki kimlik kullanılmaz; aynı dosya iki kez içe aktarılınca çakışmaz', () => {
        const first = TemplateTransfer.mergeImportedTemplates([cloudTpl], [], 1700000000000);
        const second = TemplateTransfer.mergeImportedTemplates([cloudTpl], first.templates, 1700000000000);

        const ids = second.templates.map((t) => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('geçersiz kayıtları reddeder, sayar ve yazmaz', () => {
        const merged = TemplateTransfer.mergeImportedTemplates([
            { id: 'x', name: '', action: 'sleep' },            // boş ad
            { id: 'y', name: 'Ölü', action: 'sleep' },         // koşul/zaman yok
            cloudTpl
        ], [], 1700000000000);

        expect(merged.rejected).toBe(2);
        expect(merged.added).toHaveLength(1);
        expect(merged.templates).toHaveLength(1);
    });

    it('en fazla MAX_IMPORTED kayıt işler (kötü niyetli dosya sınırı)', () => {
        const many = Array.from({ length: TemplateTransfer.MAX_IMPORTED + 25 }, (_, i) => ({
            ...cloudTpl,
            id: `user_tpl_${i}`,
            name: `T${i}`
        }));
        const merged = TemplateTransfer.mergeImportedTemplates(many, [], 1700000000000);
        expect(merged.added).toHaveLength(TemplateTransfer.MAX_IMPORTED);
    });

    it('gelen ad/açıklama IPC sınırlarında kırpılır', () => {
        const merged = TemplateTransfer.mergeImportedTemplates([{
            ...cloudTpl,
            name: 'N'.repeat(200),
            description: 'D'.repeat(400)
        }], [], 1700000000000);

        expect(merged.added[0].name).toHaveLength(80);
        expect(merged.added[0].description).toHaveLength(200);
    });

    it('mevcut hazır şablon listesi korunur (üzerine yazma yok)', () => {
        const builtins = [
            { id: 'tpl_a', name: 'A', action: 'sleep', defaultCondition: { type: 'cpu_usage' } },
            { id: 'tpl_b', name: 'B', action: 'lock', defaultCondition: { type: 'user_idle' } }
        ];
        const merged = TemplateTransfer.mergeImportedTemplates([{ ...cloudTpl, id: 'tpl_a' }], builtins, 1700000000000);

        expect(merged.templates.slice(0, 2)).toEqual(builtins);
        expect(merged.added[0].id.startsWith('tpl_a')).toBe(false);
    });
});
