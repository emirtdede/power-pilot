/**
 * policy-explicitness.test.mjs — P1-6 kök neden regresyonu
 *
 * Ölçülen kusur: `AutomationTask` her göreve TAM `safetyPolicy` nesnesi
 * yazıyordu (varsayılan `false` değerlerle). Sonuç: kalıcı Ayarlar
 * (`forceCloseApps`, `remoteApprovalRequired`, `protectFullscreen`,
 * `protectActiveIo`) hiçbir zaman uygulanamıyordu — görev düzeyi varsayılan
 * değer onları gölgeliyordu. Arayüzde ayar vardı, davranışta yoktu (plasebo).
 *
 * Bu testler, kalıcı ayarın gerçekten devreye girdiğini ve yalnızca AÇIKÇA
 * verilmiş görev düzeyi değerin onu ezebildiğini kanıtlar.
 */
import { describe, it, expect } from 'vitest';
import Engine from '../../src/main/services/SafetyPolicyEngine.js';
import { AutomationTask } from '../../src/main/services/models/AutomationTask.js';

const OFF_LOAD = { checkSystemLoad: false, checkProtectedApps: false, checkUserActivity: false, checkFullscreen: false };

function engine(settings = {}) {
    return new Engine({ getSettings: () => ({ ...settings }) }, () => { throw new Error('exec yok'); }, () => 9999, {
        processProvider: () => [],
        powerMonitor: { getActiveRequests: async () => ({ ok: true, hasActiveRequest: false, categories: [] }) }
    });
}

describe('AutomationTask — explicit politika işareti', () => {
    it('politika verilmezse hiçbir alan explicit değildir', () => {
        const t = new AutomationTask({});
        expect(t.safetyPolicy).toMatchObject({ forceCloseApps: false, remoteApprovalRequired: false });
        expect(t.safetyPolicyExplicit).toEqual({});
    });

    it('MADDELENMİŞ tam nesnede varsayılana eşit değer explicit sayılmaz (gölgeleme yok)', () => {
        // Konsol politikası gibi 6/6 alanı dolduran nesne "kullanıcı seçimi" değildir.
        const t = new AutomationTask({
            safetyPolicy: {
                checkUserActivity: true,
                checkProtectedApps: true,
                checkFullscreen: true,
                checkSystemLoad: true,
                forceCloseApps: false,
                remoteApprovalRequired: false
            }
        });
        expect(t.safetyPolicyExplicit).toEqual({});
    });

    it('KISMİ nesnede verilen her alan bilinçli tercihtir', () => {
        // UI/CLI yalnızca dokunduğu alanı gönderir; `false` gerçek bir karardır.
        const t = new AutomationTask({ safetyPolicy: { forceCloseApps: false, remoteApprovalRequired: false } });
        expect(t.safetyPolicyExplicit).toEqual({ forceCloseApps: true, remoteApprovalRequired: true });
    });

    it('varsayılandan FARKLI değer explicit sayılır', () => {
        const t = new AutomationTask({ safetyPolicy: { forceCloseApps: true, checkFullscreen: false } });
        expect(t.safetyPolicyExplicit).toEqual({ forceCloseApps: true, checkFullscreen: true });
    });

    it('kayıtlı explicit işaret aynen korunur (round-trip)', () => {
        const first = new AutomationTask({ safetyPolicy: { remoteApprovalRequired: true } });
        const restored = new AutomationTask(first.toJSON());
        expect(restored.safetyPolicyExplicit).toEqual({ remoteApprovalRequired: true });
        expect(restored.safetyPolicy.remoteApprovalRequired).toBe(true);
        expect(AutomationTask.isExplicitPolicy(restored, 'remoteApprovalRequired')).toBe(true);
    });

    it('eski kayıt (işaret yok) varsayılandan farklıysa explicit kabul edilir', () => {
        const legacy = { safetyPolicy: { checkFullscreen: false } };
        expect(AutomationTask.isExplicitPolicy(legacy, 'checkFullscreen')).toBe(true);
        expect(AutomationTask.isExplicitPolicy({ safetyPolicy: { checkFullscreen: true } }, 'checkFullscreen')).toBe(false);
    });
});

describe('SafetyPolicyEngine — kalıcı ayar görev varsayılanını ezer', () => {
    it('protectFullscreen=false kalıcı ayarı gerçekten uygulanır', async () => {
        // Görev kendi politikasında AÇIKÇA seçmediyse kalıcı ayar kazanır.
        const task = new AutomationTask({ action: 'lock', safetyPolicy: OFF_LOAD });
        const eng = engine({ protectFullscreen: false });
        const r = await eng.evaluate(task);
        // Kapı kapalı olduğu için tam ekran kontrolü çalışmaz → engel yok.
        expect(r.allowed).toBe(true);
    });

    it('görev AÇIKÇA checkFullscreen=true derse kalıcı ayarı ezer', async () => {
        let asked = 0;
        const eng = new Engine(
            { getSettings: () => ({ protectFullscreen: false }) },
            () => { throw new Error('exec yok'); },
            () => 9999,
            {
                processProvider: () => [],
                powerMonitor: { getActiveRequests: async () => ({ ok: true, hasActiveRequest: false, categories: [] }) }
            }
        );
        eng.getFullscreenState = async () => { asked += 1; return { ok: true, fullscreen: false }; };
        const task = new AutomationTask({ action: 'lock', safetyPolicy: { checkFullscreen: true } });
        const r = await eng.evaluate(task);
        expect(asked).toBe(1);
        expect(r.allowed).toBe(true);
    });

    it('protectActiveIo=false kalıcı ayarı gerçekten uygulanır', async () => {
        const task = new AutomationTask({ action: 'lock', safetyPolicy: OFF_LOAD });
        const eng = engine({ protectActiveIo: false });
        const r = await eng.evaluate(task);
        expect(r.allowed).toBe(true);
    });
});
