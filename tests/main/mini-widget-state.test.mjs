/**
 * mini-widget-state.test.mjs - mini pencere sayaç sözleşmesi.
 *
 * GERÇEK EKSİK (bu turda bulundu ve düzeltildi):
 *   Mini pencere `taskManager.getActiveTasks().length > 0` olduğunda açılıyor
 *   ama sayaç verisini YALNIZCA ana pencerenin hızlı zamanlayıcı renderer'ı
 *   gönderiyordu (`app.js` updateDisplay → updateMiniTimer). Diğer görevlerde
 *   (Smart Finish, şablon, zamanlanmış, zincir) widget açılıyor ama içi
 *   `--` / `00:00` kalıyordu - kullanıcıya boş bir widget gösteriliyordu.
 *
 *   Ölçüm (öncesi): createTask({duration 1h}) → pencere gizle →
 *     mini: {"action":"--","countdown":"00:00"}
 *   Ölçüm (sonrası):
 *     mini: {"action":"Bilgisayarı Kapat","countdown":"59:57"}
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { computeState, formatCountdown, hasCountdown } =
    require(path.join(root, 'src', 'main', 'services', 'MiniWidgetState.js'));

const t = (key) => (key === 'statusMonitoring' ? 'İzleniyor' : key);
const actionLabel = (a) => ({ shutdown: 'Bilgisayarı Kapat', sleep: 'Uyku' }[a] || String(a));
const taskDisplayName = (task) => String((task && task.name) || '');

function task(overrides = {}) {
    return {
        id: 't1',
        action: 'shutdown',
        name: 'Gece yedeği',
        trigger: { type: 'duration', targetTime: 0 },
        ...overrides
    };
}

describe('formatCountdown', () => {
    it('bir saatten kısa süre MM:SS', () => {
        expect(formatCountdown(95_000)).toBe('01:35');
        expect(formatCountdown(0)).toBe('00:00');
    });

    it('bir saatten uzun süre HH:MM:SS', () => {
        expect(formatCountdown(3_600_000)).toBe('01:00:00');
        expect(formatCountdown(3_599_000)).toBe('59:59');
    });

    it('bir günden uzun süre gün önekiyle', () => {
        expect(formatCountdown(90_061_000, 'gün')).toBe('1g 01:01:01');
        expect(formatCountdown(172_800_000, 'day')).toBe('2d 00:00:00');
    });

    it('geçersiz/negatif değer çökmez, 00:00 döner', () => {
        expect(formatCountdown(-5000)).toBe('00:00');
        expect(formatCountdown(NaN)).toBe('00:00');
        expect(formatCountdown(undefined)).toBe('00:00');
        expect(formatCountdown(Infinity)).toBe('00:00');
    });
});

describe('hasCountdown', () => {
    it('targetTime olan görev sayaç taşır', () => {
        expect(hasCountdown(task({ trigger: { targetTime: Date.now() + 1000 } }))).toBe(true);
    });

    it('koşullu görev (targetTime yok) sayaç taşımaz', () => {
        expect(hasCountdown(task({ trigger: { notBefore: 0 } }))).toBe(false);
        expect(hasCountdown(task({ trigger: {} }))).toBe(false);
        expect(hasCountdown(null)).toBe(false);
    });
});

describe('computeState - gerçek kullanıcı senaryoları', () => {
    const now = 1_700_000_000_000;

    it('normal (zamanlanmış) görevde GERÇEK sayaç üretir - boş widget yok', () => {
        const state = computeState({
            tasks: [task({ trigger: { type: 'duration', targetTime: now + 3_600_000 } })],
            now, t, actionLabel, taskDisplayName, daySuffix: 'gün'
        });
        expect(state).not.toBeNull();
        expect(state.monitoring).toBe(false);
        expect(state.actionText).toBe('Bilgisayarı Kapat');
        expect(state.formattedCountdown).toBe('01:00:00');
        expect(state.secondsRemaining).toBe(3600);
    });

    it('birden fazla zamanlı görevde EN YAKIN olanı gösterir', () => {
        const state = computeState({
            tasks: [
                task({ id: 'far', trigger: { targetTime: now + 7_200_000 } }),
                task({ id: 'near', action: 'sleep', trigger: { targetTime: now + 60_000 } })
            ],
            now, t, actionLabel, taskDisplayName
        });
        expect(state.taskId).toBe('near');
        expect(state.actionText).toBe('Uyku');
        expect(state.formattedCountdown).toBe('01:00');
    });

    it('koşullu görevde geri sayım UYDURMAZ; izleniyor + ilerleme gösterir', () => {
        const state = computeState({
            tasks: [task({
                name: 'Chromium kapanınca kilitle',
                trigger: { notBefore: 0 },
                conditionGroup: { conditions: [{ type: 'process_running' }] },
                lastProgressMessage: 'chrome.exe hâlâ çalışıyor'
            })],
            now, t, actionLabel, taskDisplayName
        });
        expect(state.monitoring).toBe(true);
        expect(state.formattedCountdown).toBe('');
        expect(state.statusText).toBe('İzleniyor');
        expect(state.progressText).toBe('chrome.exe hâlâ çalışıyor');
        // Kullanıcıya sahte "00:00" gösterilmez.
        expect(state.formattedCountdown).not.toBe('00:00');
    });

    it('hedef zaman geçmişse negatif değer değil 0 gösterir', () => {
        const state = computeState({
            tasks: [task({ trigger: { targetTime: now - 30_000 } })],
            now, t, actionLabel, taskDisplayName
        });
        expect(state.secondsRemaining).toBe(0);
        expect(state.formattedCountdown).toBe('00:00');
    });

    it('boş görev listesinde null döner (widget kapanır)', () => {
        expect(computeState({ tasks: [], now, t, actionLabel, taskDisplayName })).toBeNull();
        expect(computeState({ tasks: null, now, t, actionLabel, taskDisplayName })).toBeNull();
    });
});

describe('ana süreç bağlantısı (mini pencere sayaç beslemesi)', () => {
    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

    it('mini pencere açılınca sayaç senkronizasyonu başlar', () => {
        expect(mainSrc).toContain('startMiniSync()');
        expect(mainSrc).toMatch(/function startMiniSync\s*\(/);
        expect(mainSrc).toMatch(/miniSyncTimer = timers\.setInterval\(pushMiniTimerState, 1000\)/);
    });

    it('besleme TaskManager aktif görevlerinden gelir (renderer\'a bağımlı değil)', () => {
        const block = mainSrc.slice(
            mainSrc.indexOf('function pushMiniTimerState'),
            mainSrc.indexOf('function startMiniSync')
        );
        expect(block).toMatch(/taskManager\.getActiveTasks\(\)/);
        expect(block).toContain("send('timer-tick'");
        expect(block).not.toContain('updateMiniTimer');
    });

    it('pencere kapanınca senkronizasyon durur (sızıntı yok)', () => {
        expect(mainSrc).toContain('stopMiniSync()');
        // İki `closed` dinleyicisi var (biri ekran dinleyicilerini söker);
        // senkronizasyonu durduran ikincisidir.
        const occurrences = [...mainSrc.matchAll(/miniWindow\.on\('closed'/g)].map((m) => m.index);
        expect(occurrences.length).toBeGreaterThanOrEqual(2);
        const blocks = occurrences.map((i) => mainSrc.slice(i, i + 700));
        expect(blocks.some((b) => b.includes('stopMiniSync'))).toBe(true);
    });

    it('mini widget iptal düğmesi gösterilen görevi iptal edebilir', () => {
        const block = mainSrc.slice(
            mainSrc.indexOf("ipcHandle('cancel-action'"),
            mainSrc.indexOf("ipcHandle('get-mini-labels'")
        );
        expect(block).toContain('miniWidgetTaskId');
        expect(block).toMatch(/taskManager\.cancelTask\(miniWidgetTaskId\)/);
    });

    it('tek doğruluk kaynağı: no-op mini sayaç kanalı yok', () => {
        // P1-6 (altıncı tur): işleyicisi boş olan ve hiçbir çağıranı bulunmayan
        // `update-mini-timer` kanalı kaldırıldı. Geri gelirse bu kapı düşer.
        expect(mainSrc).not.toContain("ipcOn('update-mini-timer'");
        const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
        expect(preloadSrc).not.toContain('update-mini-timer');
        expect(preloadSrc).not.toContain('updateMiniTimer');
    });
});
