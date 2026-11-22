/**
 * data-wipe.test.mjs - "Verilerimi sil" akışı (Store 10.2.7).
 * Gerçek dosya sistemi yerine enjekte edilen fs kullanılır; hiçbir kullanıcı
 * dosyası silinmez.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    planWipe, performWipe, performWipeAsync, WIPE_ENTRIES, ESSENTIAL_ENTRIES,
    writePendingWipe, applyPendingWipe
} = require('../../src/main/services/DataWipe.js');

const ROOT = 'C:\\Users\\u\\AppData\\Roaming\\powerpilot';
const TMP_MARKER = path.join(os.tmpdir(), `pp-wipe-marker-${process.pid}-${Date.now()}.json`);

describe('planWipe', () => {
    it('yalnızca kökte var olan bilinen girdileri planlar', () => {
        const existing = new Set([
            path.join(ROOT, 'powerpilot.db'),
            path.join(ROOT, 'backups')
        ]);
        const plan = planWipe(ROOT, { exists: (p) => existing.has(p) });
        expect(plan.root).toBe(path.resolve(ROOT));
        expect(plan.targets).toEqual([
            path.join(ROOT, 'powerpilot.db'),
            path.join(ROOT, 'backups')
        ]);
    });

    it('secrets/anahtar ve model dizinleri listede (gizlilik kapsamı)', () => {
        expect(WIPE_ENTRIES).toContain('secrets.v1.json');
        expect(WIPE_ENTRIES).toContain('models');
        expect(WIPE_ENTRIES).toContain('logs');
        // Zorunlu (kullanıcı verisi) ile isteğe bağlı (Chromium önbelleği)
        // ayrımı korunmalı; aksi hâlde kilitli önbellek klasörü yüzünden
        // kullanıcıya yanlışlıkla "veriler silinemedi" denir.
        expect(ESSENTIAL_ENTRIES).toContain('powerpilot.db');
        expect(ESSENTIAL_ENTRIES).toContain('secrets.v1.json');
        expect(ESSENTIAL_ENTRIES).not.toContain('GPUCache');
        expect(ESSENTIAL_ENTRIES).not.toContain('Local Storage');
    });

    it('boş/geçersiz yol INVALID_PATH fırlatır', () => {
        expect(() => planWipe('')).toThrow(/userDataPath/);
        expect(() => planWipe(null)).toThrow(/userDataPath/);
    });

    it('üretilen her yol kökün doğrudan altında kalır (path traversal yok)', () => {
        const plan = planWipe(ROOT, { exists: () => true });
        for (const target of plan.targets) {
            expect(path.dirname(target)).toBe(path.resolve(ROOT));
        }
    });
});

describe('performWipe', () => {
    it('onBefore silmeden ÖNCE çalışır (DB kapatma)', () => {
        const order = [];
        const exists = (p) => p.endsWith('powerpilot.db');
        performWipe(ROOT, {
            exists,
            onBefore: () => order.push('close'),
            rm: () => { order.push('remove'); }
        });
        expect(order).toEqual(['close', 'remove']);
    });

    it('onBefore hata fırlatırsa hiçbir şey silinmez', () => {
        const rm = vi.fn();
        expect(() => performWipe(ROOT, {
            exists: () => true,
            onBefore: () => { throw new Error('db busy'); },
            rm
        })).toThrow(/db busy/);
        expect(rm).not.toHaveBeenCalled();
    });

    it('başarılı silmede ok:true, removed listesi dolu', () => {
        const rm = vi.fn();
        const exists = (p) => p.endsWith('powerpilot.db') || p.endsWith('backups');
        const result = performWipe(ROOT, { exists, rm });
        expect(result.ok).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.removed).toHaveLength(2);
        expect(rm).toHaveBeenCalledTimes(2);
    });

    it('silinemeyen dosya failed listesine düşer, ok:false (sessizce yutulmaz)', () => {
        const rm = (target) => {
            if (target.endsWith('backups')) {
                const err = new Error('kilitli');
                err.code = 'EBUSY';
                throw err;
            }
        };
        const exists = (p) => p.endsWith('powerpilot.db') || p.endsWith('backups');
        const result = performWipe(ROOT, { exists, rm });
        expect(result.ok).toBe(false);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0].error).toBe('EBUSY');
        expect(result.removed).toHaveLength(1);
    });

    it('geçici kilit hatası sonraki denemede başarılı olabilir', () => {
        let attempt = 0;
        const rm = () => {
            attempt += 1;
            if (attempt === 1) {
                const err = new Error('kilitli');
                err.code = 'EBUSY';
                throw err;
            }
        };
        const result = performWipe(ROOT, { exists: (p) => p.endsWith('powerpilot.db'), rm });
        expect(result.ok).toBe(true);
        expect(attempt).toBe(2);
    });

    it('readdir verilirse kökteki TÜM girdiler hedeflenir (Chromium klasörleri dahil)', () => {
        const entries = ['powerpilot.db', 'DawnGraphiteCache', 'DIPS', 'Network', 'Local State'];
        const plan = planWipe(ROOT, { exists: () => true, readdir: () => entries });
        expect(plan.targets).toEqual(entries.map((e) => path.join(ROOT, e)));
    });

    it('readdir kök dışına çıkan adları atlar (traversal koruması)', () => {
        const plan = planWipe(ROOT, { exists: () => true, readdir: () => ['..', 'a\\b'] });
        for (const t of plan.targets) expect(path.dirname(t)).toBe(path.resolve(ROOT));
        expect(plan.targets).not.toContain(path.resolve(path.join(ROOT, '..')));
    });

    it('kilitli Chromium klasörü hata değil (optionalFailed), temel veri silinmişse ok:true', () => {
        // Kullanıcıya "veriler silinemedi" demek yanıltıcı olurdu: içerikler
        // clearStorageData ile boşaltıldı, klasörler yeniden oluşturulur.
        const rm = (target) => {
            if (/GPUCache|Local Storage/.test(target)) {
                const err = new Error('kilitli');
                err.code = 'EBUSY';
                throw err;
            }
        };
        const result = performWipe(ROOT, {
            exists: () => true,
            readdir: () => ['powerpilot.db', 'secrets.v1.json', 'GPUCache', 'Local Storage'],
            rm
        });
        expect(result.ok).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.optionalFailed.map((f) => path.basename(f.path)).sort())
            .toEqual(['GPUCache', 'Local Storage']);
    });

    it('performWipeAsync ana iş parçacığını kilitlemeden zorunlu ve isteğe bağlı girdileri siler', async () => {
        const removedOrder = [];
        const rm = async (target) => {
            removedOrder.push(path.basename(target));
            if (target.endsWith('GPUCache')) {
                const err = new Error('busy');
                err.code = 'EBUSY';
                throw err;
            }
        };
        const result = await performWipeAsync(ROOT, {
            exists: () => true,
            readdir: () => ['GPUCache', 'powerpilot.db', 'secrets.v1.json'],
            rm
        });
        expect(result.ok).toBe(true);
        expect(result.failed).toEqual([]);
        expect(result.optionalFailed.map((f) => path.basename(f.path))).toEqual(['GPUCache']);
        // Zorunlu girdiler isteğe bağlılardan önce işlenir.
        expect(removedOrder.indexOf('powerpilot.db')).toBeLessThan(removedOrder.indexOf('GPUCache'));
    });
});

describe('bekleyen silme işareti (pending wipe)', () => {
    it('temel girdi kilitliyse sonraki açılış için işaretlenir ve uygulanır', () => {
        const marker = TMP_MARKER;
        let stored = null;
        const write = writePendingWipe(marker, {
            root: ROOT,
            paths: [path.join(ROOT, 'powerpilot.db')]
        });
        expect(write).toBe(true);
        // Gerçek dosya yazımı testte dosya sistemi kullanır; okumak için
        // aynı yolu okuyoruz.
        stored = JSON.parse(fs.readFileSync(marker, 'utf8'));
        expect(stored.root).toBe(ROOT);
        expect(stored.paths).toHaveLength(1);
        const result = applyPendingWipe(marker, { rm: () => {} });
        expect(result.removed).toBe(1);
        expect(result.remaining).toEqual([]);
        expect(fs.existsSync(marker)).toBe(false);
    });

    it('işaret yoksa sessizce hiçbir şey yapmaz', () => {
        const result = applyPendingWipe(path.join(os.tmpdir(), `pp-no-marker-${process.pid}.json`));
        expect(result).toEqual({ removed: 0, remaining: [] });
    });

    it('mutlak olmayan yollar yok sayılır (dışarıdan gelen işaret güvenilmez)', () => {
        const marker = `${TMP_MARKER}.2`;
        fs.writeFileSync(marker, JSON.stringify({ root: ROOT, paths: ['relative\\evil.txt'] }), 'utf8');
        const rm = vi.fn();
        const result = applyPendingWipe(marker, { rm });
        expect(rm).not.toHaveBeenCalled();
        expect(result.removed).toBe(0);
        fs.rmSync(marker, { force: true });
    });
});
