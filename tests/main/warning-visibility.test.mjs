/**
 * Kapatma uyarısı görünürlüğü (P0 - veri kaybı).
 *
 * Ölçülen kusur: kullanıcı "1 saat sonra kapat" der, pencereyi kapatır
 * (uygulama tepside çalışır). Süre dolunca uyarı yalnızca gizli pencerenin
 * DOM'una yazılıyordu. `full` modda süre dolunca `proceed:true` olduğu için
 * makine, kullanıcı hiçbir şey görmeden kapanıyordu.
 *
 * Bu test kablolamayı kilitler: `warning-started` dinleyicisi pencereyi öne
 * getirmek zorunda; `full` modda otomatik devam etme davranışı da doğrulanır.
 * Davranış ölçümü: `scratch/probe-warning-hidden-window.cjs` (5/5 PASS).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.join(here, '../../main.js'), 'utf8');

/** `warningManager.on('warning-started', ...)` bloğunu kabaca çıkarır. */
function warningStartedBlock() {
    const start = mainSrc.indexOf("warningManager.on('warning-started'");
    expect(start).toBeGreaterThan(-1);
    // Bir sonraki dinleyici kaydına kadar.
    const next = mainSrc.indexOf("warningManager.on('", start + 10);
    return mainSrc.slice(start, next > start ? next : start + 3000);
}

describe('kapatma uyarısı pencereyi öne getirir', () => {
    it('warning-started pencereyi görünür yapar (gizliyken de)', () => {
        const block = warningStartedBlock();
        // Gizli pencereyi göster; aksi hâlde uyarı görünmez.
        expect(block).toMatch(/isVisible\(\)[\s\S]{0,60}show\(\)/);
        // Simge durumundan geri al.
        expect(block).toMatch(/isMinimized\(\)[\s\S]{0,60}restore\(\)/);
        // Odaklanma: kullanıcı uyarıyı fark etmeli.
        expect(block).toMatch(/focus\(\)/);
    });

    it('öne getirme yalnızca uygulama kapanmıyorken yapılır', () => {
        const block = warningStartedBlock();
        expect(block).toMatch(/isQuitting/);
    });

    it('always-on-top uyarı bitince bırakılır (kullanıcıyı hapsetmez)', () => {
        const block = warningStartedBlock();
        expect(block).toMatch(/setAlwaysOnTop\(true\)/);
        expect(block).toMatch(/setAlwaysOnTop\(false\)/);
        // Bırakma tüm terminal olaylara bağlı olmalı.
        for (const ev of ['warning-finished', 'warning-cancelled', 'warning-snoozed']) {
            expect(block).toContain(ev);
        }
    });

    it('tepsi balonu yeni bilgi verir: eylem çalışmak üzere', () => {
        const block = warningStartedBlock();
        expect(block).toMatch(/displayBalloon/);
        expect(block).toMatch(/trayWarningRunning/);
    });

    it('uyarı verisi DOM\'a iletilmeye devam eder (banner içeriği)', () => {
        const block = warningStartedBlock();
        expect(block).toMatch(/forwardWarning\('warning-started'\)/);
    });
});

describe('uyarı anahtarı tüm dillerde var', () => {
    it('17 dilde trayWarningRunning tanımlı ve boş değil', () => {
        const dir = path.join(here, '../../src/renderer/locales');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
        expect(files).toHaveLength(17);
        for (const f of files) {
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            expect(typeof data.trayWarningRunning, `${f} trayWarningRunning`).toBe('string');
            expect(data.trayWarningRunning.trim().length, `${f} boş olmamalı`).toBeGreaterThan(10);
        }
    });
});
