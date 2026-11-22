/**
 * security-gate.test.mjs - `scripts/security-check.mjs` gerçekten temiz geçmeli
 *
 * Neden: CI'da bu kapı kırmızıysa sürüm çıkmaz. Kapı bir kez XML **ad alanı**
 * tanımlayıcısını (`http://schemas.microsoft.com/...`) "düz HTTP istemci"
 * sanıp yanlış pozitif üretti ve sürekli kırmızı kaldı. Bu test kapının
 * kendisini çalıştırır; yeni bir ihlal eklendiğinde burada kırılır.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('güvenlik kapısı', () => {
    it('security-check temiz geçer (ihlal yok)', () => {
        let out = '';
        let code = 0;
        try {
            out = execFileSync(process.execPath, [path.join(root, 'scripts/security-check.mjs')], {
                cwd: root,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            code = err.status || 1;
            out = `${err.stdout || ''}${err.stderr || ''}`;
        }
        expect(code, `security-check başarısız:\n${out}`).toBe(0);
        expect(out).toMatch(/temiz/);
    }, 120000);
});
