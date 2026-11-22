/**
 * dom-token-safety.test.mjs - classList token sözleşmesi.
 *
 * Gerçek hata (bu sürümde bulundu): kontrast düzeltmesi sırasında
 * `classList.add/remove/toggle` çağrılarına `'text-primary dark:text-primary-light'`
 * gibi BOŞLUK İÇEREN tek bir string verildi. `DOMTokenList` boşluk kabul etmez;
 * geçersiz token'ı sessizce reddeder - hata fırlatmaz, hiçbir şey yapmaz.
 *
 * Kullanıcıya etkisi:
 *   - Görev filtresi (Tümü/Aktif) seçili durumu görsel olarak bozulurdu
 *     (`toggle('text-slate-600', 'dark:text-slate-400', !on)` → force argümanı
 *     string olduğu için toggle hiç çalışmaz).
 *   - Aktif menü ve zaman aralığı düğmesi (5dk/30dk/...) vurgusu kaybolurdu.
 *
 * Bu test tüm renderer kaynaklarında bunu yasaklar.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SOURCES = [
    'src/index.html',
    'src/renderer/app.js',
    'src/renderer/tasksView.js',
    'src/renderer/i18n.js',
    'src/mini.html'
];

const CALL = /classList\.(add|remove|toggle|replace)\(/;

function readLines(rel) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return [];
    return fs.readFileSync(abs, 'utf8').split(/\r?\n/);
}

describe('classList güvenliği - token tek tek verilmeli', () => {
    it('classList çağrılarında boşluk içeren token yok', () => {
        const offenders = [];
        for (const rel of SOURCES) {
            readLines(rel).forEach((line, i) => {
                if (!CALL.test(line)) return;
                const literals = line.match(/'[^']*'/g) || [];
                for (const lit of literals) {
                    const token = lit.slice(1, -1);
                    if (token.includes(' ')) {
                        offenders.push(`${rel}:${i + 1}  ${lit}  ← boşluklu token classList'e verilemez`);
                    }
                }
            });
        }
        expect(offenders, `Geçersiz classList token'ları:\n${offenders.join('\n')}`).toEqual([]);
    });

    it('toggle 3. argümanı boolean ifadedir (token değil)', () => {
        const offenders = [];
        for (const rel of SOURCES) {
            readLines(rel).forEach((line, i) => {
                const m = line.match(/classList\.toggle\(([^)]*)\)/);
                if (!m) return;
                // Argümanları kaba ayrıştır: 'a', 'b', force
                const args = m[1].split(',').map((s) => s.trim()).filter(Boolean);
                if (args.length !== 2) return; // 1 arg = normal toggle, 3+ = force
                // 2 argüman: ikincisi string ise hatalı (token'ı force sanmış)
                if (/^'/.test(args[1])) {
                    offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 140)}`);
                }
            });
        }
        expect(offenders, `toggle(token, force) imzası bozuk:\n${offenders.join('\n')}`).toEqual([]);
    });
});
