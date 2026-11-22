/**
 * security-audit.test.mjs - O-13
 * Güvenlikle ilgili mutasyonlarda denetim kaydı zorunludur; yazılamazsa
 * işlem geri alınır ve AUDIT_WRITE_FAILED döner.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import LocalApiService from '../../src/main/services/LocalApiService.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSource = fs.readFileSync(path.resolve(here, '../../main.js'), 'utf8');

describe('O-13 denetim yazımı zorunlu', () => {
    it('applySettingsPatch güvenlik denetimi başarısızsa AUDIT_WRITE_FAILED fırlatır', () => {
        const start = mainSource.indexOf('async function applySettingsPatch');
        expect(start).toBeGreaterThan(-1);
        const body = mainSource.slice(start, start + 5000);
        const auditBlock = body.slice(body.indexOf('if (auditAction)'), body.indexOf('scheduleTrayUpdate()'));
        expect(auditBlock).toMatch(/catch \(auditErr\)[\s\S]*?AUDIT_WRITE_FAILED/);
        // Eski fail-open davranışı kalmamalı: yalnızca log.warn ile devam etmez.
        expect(auditBlock).not.toMatch(/catch \(auditErr\) \{\s*log\.warn\([^\n]*\);\s*\}/);
    });

    it('generate-api-key denetim hatasında önceki anahtar alanlarını geri yükler', () => {
        const start = mainSource.indexOf("ipcHandle('generate-api-key'");
        expect(start).toBeGreaterThan(-1);
        const body = mainSource.slice(start, start + 2200);
        expect(body).toMatch(/previousKey/);
        expect(body).toMatch(/AUDIT_WRITE_FAILED/);
        expect(body).toMatch(/updateSettings\(previousKey\)/);
    });

    it('generateApiKey kalıcılaştırma başarısızsa anahtar döndürmez', () => {
        const storage = {
            getSettings: () => ({}),
            updateSettings: vi.fn(() => false)
        };
        const svc = new LocalApiService(storage, {}, {}, {});
        expect(() => svc.generateApiKey('admin')).toThrowError(/kalıcılaştırılamadı/);
    });
});
