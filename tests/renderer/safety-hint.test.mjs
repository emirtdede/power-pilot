/**
 * safety-hint.test.mjs - P0/BLOCKER-001 görünürlük kapısı (S-10, statik doğrulama)
 *
 * `powercfg /requests` yükseltme gerektirdiğinde kapı atlanır; bu durum
 * kullanıcıya Ayarlar → Entegrasyonlar ekranında gösterilmelidir ve 17 dilin
 * tamamında çevirisi bulunmalıdır.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const LANGS = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];
const KEYS = ['safetyLoadCheckUnavailableTitle', 'safetyLoadCheckUnavailableDesc'];

describe('P0 güvenlik uyarısı (Ayarlar → Entegrasyonlar)', () => {
    it('index.html uyarı satırını varsayılan gizli olarak içerir ve i18n anahtarlarına bağlar', () => {
        const html = read('src/index.html');
        const match = html.match(/<div id="api-safety-hint"[^>]*>/);
        expect(match).not.toBeNull();
        expect(match[0]).toContain('hidden');
        for (const key of KEYS) {
            expect(html).toContain(`data-i18n="${key}"`);
        }
    });

    it('renderer yalnızca powerRequestCheck.available === false iken gösterir', () => {
        const app = read('src/renderer/app.js');
        expect(app).toContain("getElementById('api-safety-hint')");
        expect(app).toMatch(/sec\.powerRequestCheck\s*&&\s*sec\.powerRequestCheck\.available\s*===\s*false/);
        expect(app).toMatch(/hint\.classList\.toggle\('hidden',\s*!unavailable\)/);
    });

    it('17 dilin tamamında iki anahtar bulunur (renderer + server kopyası)', () => {
        for (const lang of LANGS) {
            const renderer = JSON.parse(read(`src/renderer/locales/${lang}.json`));
            const server = JSON.parse(read(`src/main/locales/${lang}.server.json`));
            for (const key of KEYS) {
                expect(typeof renderer[key], `${lang}.json ${key}`).toBe('string');
                expect(renderer[key].length, `${lang}.json ${key}`).toBeGreaterThan(0);
                expect(server[key], `${lang}.server.json ${key}`).toBe(renderer[key]);
            }
        }
        expect(JSON.parse(read('src/renderer/locales/tr.json')).safetyLoadCheckUnavailableTitle)
            .toBe('Aktif güç isteği kontrolü devre dışı');
    });

    it('main süreç yetenek durumunu get-security-status yanıtına ekler ve açılışta audit yazar', () => {
        const main = read('main.js');
        expect(main).toContain('powerRequestCheck:');
        expect(main).toContain('power_request_check_unavailable');
        expect(main).toContain('probePowerRequestCapability');
    });
});
