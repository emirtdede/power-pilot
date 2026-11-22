/**
 * template-save.test.mjs - "Şablonu Kaydet" sözleşmesi.
 *
 * GERÇEK HATA (bu turda bulundu ve düzeltildi): Smart Finish görünümündeki
 * "Şablonu Kaydet" düğmesi hiçbir zaman çalışmıyordu.
 *
 *   renderer (app.js:1373)  →  saveTemplate({ name, action, description, defaultCondition })
 *                               ^ `id` GÖNDERMİYOR
 *   main.js                 →  if (!TemplateService.isValidTemplate(tpl)) return INVALID_TEMPLATE
 *   TemplateService.js:185  →  if (typeof tpl.id !== 'string') return false
 *   main.js (sonra)         →  id: tpl.id || `user_tpl_${Date.now()}`
 *
 * Yani id, doğrulamadan SONRA üretiliyordu; doğrulama ise id'yi zorunlu
 * tutuyordu → kullanıcı her seferinde "Şablon koşulu veya zamanlaması
 * geçersiz." görüyordu. Ölçüm (gerçek UI): 10 şablon → kaydet → 10 şablon.
 * Düzeltmeden sonra: 10 → 11, ad korunuyor, yeniden açılışta kalıcı.
 *
 * Kural: doğrulama NORMALEŞTİRİLMİŞ kayıt üzerinde yapılır (id sunucuda üretilir).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TemplateService from '../../src/main/services/TemplateService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

/** main.js'deki save-template gövdesini kabaca çıkar (doğrulama sırası için). */
function saveTemplateBlock() {
    const start = mainSrc.indexOf("ipcHandle('save-template'");
    expect(start, "main.js içinde save-template handler bulunmalı").toBeGreaterThan(-1);
    const end = mainSrc.indexOf("ipcHandle('delete-template'", start);
    expect(end, 'delete-template handler sınırı bulunmalı').toBeGreaterThan(start);
    return mainSrc.slice(start, end);
}

describe('save-template - istemci id göndermez, sunucu üretir', () => {
    it('TemplateService.isValidTemplate id olmadan false döner (birim sözleşmesi)', () => {
        // Bu davranış DOĞRU; hata, handler'ın ham payload'ı doğrulamasıydı.
        expect(TemplateService.isValidTemplate({
            name: 'Şablon',
            action: 'shutdown',
            defaultCondition: { type: 'network_speed', thresholdKbps: 100 }
        })).toBe(false);
    });

    it('id eklenince aynı şablon geçerli olur (normalizasyon yeterli)', () => {
        expect(TemplateService.isValidTemplate({
            id: 'user_tpl_1',
            name: 'Şablon',
            action: 'shutdown',
            defaultCondition: { type: 'network_speed', thresholdKbps: 100 }
        })).toBe(true);
    });

    it('handler, ham payload yerine NORMALEŞTİRİLMİŞ kaydı doğrular', () => {
        const block = saveTemplateBlock();

        // 1) id üretimi doğrulamadan ÖNCE olmalı.
        const idAt = block.indexOf("user_tpl_${Date.now()}");
        const validateAt = block.indexOf('TemplateService.isValidTemplate');
        expect(idAt, 'handler id üretmeli').toBeGreaterThan(-1);
        expect(validateAt, 'handler şablonu doğrulamalı').toBeGreaterThan(-1);
        expect(idAt, 'id üretimi doğrulamadan ÖNCE olmalı (aksi halde UI kaydı kırılır)')
            .toBeLessThan(validateAt);

        // 2) Doğrulama `record` üzerinde olmalı - `tpl` (ham payload) üzerinde DEĞİL.
        expect(block).toContain('isValidTemplate(record)');
        expect(block, 'ham payload doğrulanmamalı').not.toContain('isValidTemplate(tpl)');
    });

    it('kaydedilen kayıt istemci id göndermese de geçerli olur (uçtan uca model)', () => {
        // Handler'ın yaptığı normalizasyonun birebir modeli.
        const tpl = {
            name: 'Gece render',
            action: 'shutdown',
            description: '',
            defaultCondition: { type: 'process_running', processName: 'handbrake.exe', triggerOnClose: true }
        };
        const record = {
            id: tpl.id || `user_tpl_${Date.now()}`,
            name: String(tpl.name || '').slice(0, 80),
            description: String(tpl.description || '').slice(0, 200),
            action: tpl.action,
            icon: 'bookmark',
            category: 'custom',
            ...(tpl.defaultCondition ? { defaultCondition: tpl.defaultCondition } : {})
        };
        expect(TemplateService.isValidTemplate(record)).toBe(true);
        expect(record.id.startsWith('user_tpl_')).toBe(true);
    });

    it('geçersiz koşul hâlâ reddedilir (gevşetme yok)', () => {
        const record = {
            id: 'user_tpl_2',
            name: 'Bozuk',
            action: 'shutdown',
            category: 'custom',
            defaultCondition: { type: 'file_event' } // desteklenmeyen tip
        };
        expect(TemplateService.isValidTemplate(record)).toBe(false);
    });
});
