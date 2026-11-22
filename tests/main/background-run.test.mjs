/**
 * Temel vaat kilidi: aktif görev varken pencere kapatılırsa uygulama ÇIKMAZ.
 *
 * "1 saat sonra kapat" diyen kullanıcı pencereyi kapatıp işine döner. Uygulama
 * bu durumda sonlanırsa görev hiç çalışmaz ve kullanıcı bilgisayarının
 * kapanmadığını saatler sonra fark eder. Bu davranış ölçüldü
 * (`scratch/probe-background-run.cjs`, 5/5 PASS): ana pencere gizleniyor,
 * mini widget görünür kalıyor, görev `scheduled` olarak devam ediyor.
 *
 * Test, sözleşmeyi kaynak düzeyinde kilitler: kapatma olayı aktif görev
 * varken `preventDefault()` çağırmalı ve pencereyi gizlemeli; çıkış
 * niyetinde (`isQuitting`) ise engellememeli.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mainSrc = fs.readFileSync(path.join(here, '../../main.js'), 'utf8');

const closeHandler = () => {
    const idx = mainSrc.indexOf("mainWindow.on('close'");
    expect(idx).toBeGreaterThan(-1);
    return mainSrc.slice(idx, idx + 900);
};

describe('arka planda çalışma - pencere kapatma sözleşmesi', () => {
    it('aktif görev varken kapatma engellenir ve pencere gizlenir', () => {
        const block = closeHandler();
        expect(block).toMatch(/hasActive/);
        expect(block).toMatch(/!isQuitting\s*&&\s*hasActive/);
        expect(block).toMatch(/event\.preventDefault\(\)/);
        expect(block).toMatch(/mainWindow\.hide\(\)/);
    });

    it('kullanıcıya arka planda çalıştığı bildirilir (tepsi balonu)', () => {
        const block = closeHandler();
        expect(block).toMatch(/trayBackgroundRunning/);
        expect(block).toMatch(/displayBalloon/);
    });

    it('gerçek çıkışta kapatma engellenmez (isQuitting kaçış kapısı)', () => {
        const block = closeHandler();
        // Engelleme koşulu isQuitting'e bağlı olmalı; aksi hâlde uygulama
        // hiç kapanmaz ve kullanıcı süreci zorla öldürmek zorunda kalır.
        expect(block).toMatch(/if \(!isQuitting && hasActive\)/);
    });

    it('görev döngüsü pencere görünürlüğünden bağımsız (TaskManager zamanlayıcısı)', () => {
        // Pencere gizlenince görev döngüsü durdurulmamalı; aksi hâlde
        // "arka planda çalışıyor" iddiası yalan olur.
        const closeIdx = mainSrc.indexOf("mainWindow.on('close'");
        const block = mainSrc.slice(closeIdx, closeIdx + 900);
        expect(block).not.toMatch(/clearInterval\(taskManager\.loopInterval\)/);
        expect(block).not.toMatch(/taskManager\.stopLoop/);
    });

    it('mini widget aktif görev varken gösterilir', () => {
        expect(mainSrc).toMatch(/function updateMiniWindowVisibility\(\)/);
        expect(mainSrc).toMatch(/getActiveTasks\(\)\.length > 0/);
    });

    it('tepsi balonu pencereyi nasıl geri açacağını söyler (17 dil)', () => {
        // Kullanıcı pencereyi kapatınca uygulamanın çalışmaya devam ettiğini
        // öğreniyor ama geri dönüş yolunu bilmiyordu. Balon metni artık
        // "tepsi simgesine çift tıkla" yönergesini içerir.
        const hints = {
            tr: /tepsi simgesine çift tıklayın/i,
            en: /double-click the tray icon/i,
            de: /doppelklicken sie auf das taskleistensymbol/i,
            fr: /double-cliquez/i,
            ja: /ダブルクリック/,
            zh: /双击托盘图标/
        };
        for (const [lang, re] of Object.entries(hints)) {
            const file = path.join(here, `../../src/main/locales/${lang}.server.json`);
            const json = JSON.parse(fs.readFileSync(file, 'utf8'));
            expect(json.trayBackgroundRunning, `${lang} ipucu`).toMatch(re);
        }
    });

    it('tüm dillerde tepsi ipucu var (çevrilmemiş İngilizce metin sızmaz)', () => {
        const dir = path.join(here, '../../src/main/locales');
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.server.json'));
        expect(files.length).toBe(17);
        for (const f of files) {
            const json = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const text = json.trayBackgroundRunning;
            expect(typeof text, f).toBe('string');
            expect(text.length, `${f} çok kısa`).toBeGreaterThan(30);
            // İpucu eklendi mi? Uzunluk artışı tek başına yeterli değil;
            // çift tıklama niyeti her dilde geçmeli (ligatür/anahtar değil).
            expect(text, `${f} yönergesiz`).toMatch(/tıkla|click|klick|clique|clic|Doppelklick|ダブルクリック|双击|두 번|نقرًا مزدوجًا|kliknij|Dubbelklik|dobbeltklikk|dobbeltklik|dvojklikem/i);
        }
    });
});
