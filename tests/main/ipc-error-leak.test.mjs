/**
 * IPC hata sızıntısı sözleşmesi.
 *
 * Regresyon: `schedule-action` ve `create-task` ham `err.message` değerini
 * renderer'a döndürüyordu. TaskManager bu mesajları Türkçe ürettiği için
 * İngilizce/Japonca arayüzde kullanıcı Türkçe teknik metin görüyordu
 * ("Görev kalıcılaştırılamadı."). Ayrıca iç hata ayrıntısı UI'a sızıyordu.
 *
 * Kural: IPC yanıtlarında kullanıcıya giden metin her zaman `t(...)` ile
 * çevrilir; ham hata yalnızca loglanır.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

describe('IPC hata yönetimi - kullanıcıya ham hata metni gitmez', () => {
    it('hiçbir IPC yanıtı ham err.message taşımıyor', () => {
        const offenders = [];
        mainSrc.split(/\r?\n/).forEach((line, i) => {
            // `message: err.message` / `message: e.stack` gibi doğrudan aktarımlar.
            if (/message:\s*(err|e|error)\.(message|stack)\b/.test(line)) {
                offenders.push(`main.js:${i + 1}: ${line.trim()}`);
            }
        });
        expect(offenders, offenders.join('\n')).toEqual([]);
    });

    it('görev oluşturma hataları çevrilmiş metinle döner', () => {
        // schedule-action ve create-task iki ayrı yerde aynı çevrilmiş anahtarı kullanır.
        const matches = mainSrc.match(/message:\s*t\('errorTaskCreationFailed'\)/g) || [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it('teknik ayrıntı loglanır (sessizce yutulmaz)', () => {
        expect(mainSrc).toMatch(/\[IPC\] schedule-action görev oluşturamadı:/);
        expect(mainSrc).toMatch(/\[IPC\] create-task oluşturamadı:/);
    });
});
