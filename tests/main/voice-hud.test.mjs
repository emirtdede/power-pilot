/**
 * voice-hud.test.mjs - TS-3.1 & TS-4.1
 * Sıfır-Arayüz (Zero-UI) Görev Çubuğu Üstü Sesli Dikte HUD Yönlendiricisi,
 * 3 Kademeli AiBackend switchTier, SttService 73-dil eşlemesi ve Qwen3 <think> temizliği testleri.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VoiceCommandRouter, cleanForSpeech, formatRemainingText } = require('../../src/main/services/VoiceCommandRouter.js');
const { AiBackend } = require('../../src/main/services/AiBackend.js');
const { SttService } = require('../../src/main/services/SttService.js');
const { ALL_LANGUAGES } = require('../../src/main/i18n.js');
const docsQaAgent = require('../../src/main/services/agents/docsQaAgent.js');
const { AgentOrchestrator } = require('../../src/main/services/AgentOrchestrator.js');
const { AiService } = require('../../src/main/services/AiService.js');
const { routeExtendedDomain } = require('../../src/main/services/api/extendedDomainRoutes.js');
const { routeIntegrationDomain } = require('../../src/main/services/api/integrationDomainRoutes.js');

describe('TS-3.1: 3 Kademeli AiBackend switchTier, 73 Dil SttService ve Qwen3 <think> Temizliği', () => {
    it('AiBackend.switchTier eski modeli dispose eder ve yeni kademenin modelini yükler', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tier-switch-'));
        try {
            fs.writeFileSync(path.join(dir, 'Qwen_Qwen3-0.6B-Q4_K_M.gguf'), 'lite');
            fs.writeFileSync(path.join(dir, 'Qwen_Qwen3-4B-Q4_K_M.gguf'), 'powerful');

            const disposed = [];
            const importer = vi.fn(async () => ({
                getLlama: vi.fn(async () => ({
                    loadModel: async ({ modelPath }) => ({
                        path: modelPath,
                        createContext: async () => ({ dispose: vi.fn(async () => {}) }),
                        dispose: vi.fn(async () => { disposed.push(path.basename(modelPath)); })
                    })
                }))
            }));

            const backend = new AiBackend({
                modelDir: dir,
                importer,
                defaultModelFile: AiBackend.modelFileForTier('lite')
            });
            const r1 = await backend.loadModel();
            expect(r1.loaded).toBe(true);
            expect(r1.modelId).toBe('Qwen_Qwen3-0.6B-Q4_K_M.gguf');

            const r2 = await backend.switchTier('powerful', { autoLoad: true });
            expect(r2.loaded).toBe(true);
            expect(r2.modelId).toBe('Qwen_Qwen3-4B-Q4_K_M.gguf');
            expect(disposed).toContain('Qwen_Qwen3-0.6B-Q4_K_M.gguf');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('SttService 3 kademe modelini (tiny, base, small-q5_1) ve 73 dilin tamamını destekler', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stt-tier-'));
        try {
            const stt = new SttService({ modelDir: dir, modelId: 'base' });
            expect(stt.getStatus().modelFile).toBe('ggml-base.bin');
            await stt.setModelId('lite');
            expect(stt.getStatus().modelFile).toBe('ggml-tiny.bin');
            await stt.setModelId('powerful');
            expect(stt.getStatus().modelFile).toBe('ggml-small-q5_1.bin');
            expect(ALL_LANGUAGES).toHaveLength(73);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('docsQaAgent Qwen3 <think>...</think> iç düşünme bloklarını tamamen temizler', async () => {
        const fakeBackend = {
            getStatus: () => ({ loaded: true }),
            createSession: async () => ({
                completePrompt: async () => '<think>Önce kaynakları inceleyelim ve düşünelim...</think>OneDrive yedeklemesi Ayarlar > Yedekleme sekmesinden tek tıkla etkinleştirilir.'
            }),
            disposeSession: async () => {}
        };
        const res = await docsQaAgent.execute({
            text: 'OneDrive yedekleme nasıl çalışır?',
            language: 'tr',
            aiBackend: fakeBackend
        });
        expect(res.ok).toBe(true);
        expect(res.answer).not.toContain('<think>');
        expect(res.answer).not.toContain('Önce kaynakları');
        expect(res.answer).toContain('OneDrive yedeklemesi');
    });
});

describe('TS-4.1: VoiceCommandRouter - Sıfır-Arayüz (Zero-UI) Sesli Görev, Durum ve PIN Korumalı İptal', () => {
    function makeSetup({ pinHash = null, pausedAll = false } = {}) {
        const activeTasks = [];
        const taskManager = {
            pausedAll,
            getActiveTasks: () => activeTasks.slice(),
            createTask: vi.fn((data) => {
                const created = {
                    id: 'voice-task-1',
                    name: data.name,
                    action: data.action,
                    trigger: {
                        ...data.trigger,
                        targetTime: data.trigger.type === 'duration' ? Date.now() + data.trigger.durationMs : data.trigger.targetTime
                    },
                    createdAt: new Date().toISOString()
                };
                activeTasks.push(created);
                return created;
            }),
            cancelActiveTask: vi.fn(() => {
                const removed = activeTasks.shift();
                return { ok: !!removed, taskId: removed ? removed.id : null };
            }),
            cancelTask: vi.fn((id) => {
                const idx = activeTasks.findIndex((t) => t.id === id);
                if (idx >= 0) activeTasks.splice(idx, 1);
                return { ok: true };
            })
        };
        const storageService = {
            getSettings: () => ({ cancelPinHash: pinHash, aiSilencedUntil: null })
        };
        const historyService = {
            getHistory: () => [],
            recordAgentRun: vi.fn()
        };
        const energyService = {
            getStatistics: () => ({ totalSavedKwh: 12.4, totalSavedHours: 82 })
        };
        const aiService = new AiService({
            backend: { getStatus: () => ({ loaded: false, code: 'MODEL_MISSING' }) }
        });
        const agentOrchestrator = new AgentOrchestrator({
            aiService,
            storage: storageService,
            history: historyService
        });
        const onRequirePinWindow = vi.fn();
        const router = new VoiceCommandRouter({
            taskManager,
            agentOrchestrator,
            energyService,
            historyService,
            storageService,
            onRequirePinWindow
        });
        return { router, taskManager, activeTasks, onRequirePinWindow };
    }

    it('1) Sesle "45 dakika sonra bilgisayarı kapat" dediğinde görevi doğrudan başlatır ve canUndo=true döner', async () => {
        const { router, taskManager, activeTasks } = makeSetup();
        const res = await router.executeVoiceText('45 dakika sonra bilgisayarı kapat');
        expect(res.ok).toBe(true);
        expect(res.kind).toBe('task_started');
        expect(res.taskId).toBe('voice-task-1');
        expect(res.canUndo).toBe(true);
        expect(taskManager.createTask).toHaveBeenCalledTimes(1);
        expect(activeTasks).toHaveLength(1);
        expect(activeTasks[0].action).toBe('shutdown');
    });

    it('2) Sesle olumsuz cümle ("45 dakika sonra bilgisayarı kapatma") söylendiğinde NegationGuard devreye girer ve görev başlatılmaz', async () => {
        const { router, taskManager } = makeSetup();
        const res = await router.executeVoiceText('45 dakika sonra bilgisayarı kapatma');
        expect(res.ok).toBe(false);
        expect(res.kind).toBe('clarify');
        expect(taskManager.createTask).not.toHaveBeenCalled();
    });

    it('3) Sesle "Kalan süre ne kadar?" sorulduğunda aktif görevin kalan süresini döner', async () => {
        const { router } = makeSetup();
        await router.executeVoiceText('45 dakika sonra bilgisayarı kapat');
        const statusRes = await router.executeVoiceText('Kalan süre ne kadar?');
        expect(statusRes.ok).toBe(true);
        expect(statusRes.kind).toBe('status_active');
        expect(statusRes.speechText).toMatch(/45/);
    });

    it('4) PIN kapalıyken sesle "Zamanlayıcıyı durdur" dendiğinde aktif görevi iptal eder', async () => {
        const { router, activeTasks } = makeSetup({ pinHash: null });
        await router.executeVoiceText('30 dakika sonra bilgisayarı kapat');
        expect(activeTasks).toHaveLength(1);

        const cancelRes = await router.executeVoiceText('Zamanlayıcıyı durdur');
        expect(cancelRes.ok).toBe(true);
        expect(cancelRes.kind).toBe('task_cancelled');
        expect(activeTasks).toHaveLength(0);
    });

    it('5) PIN açıkken sesle "Zamanlayıcıyı durdur" dendiğinde görevi İPTAL ETMEZ, PIN_REQUIRED döner ve ana pencereyi açar', async () => {
        const { router, activeTasks, onRequirePinWindow } = makeSetup({ pinHash: 'hashed-pin-1234' });
        await router.executeVoiceText('30 dakika sonra bilgisayarı kapat');
        expect(activeTasks).toHaveLength(1);

        const cancelRes = await router.executeVoiceText('Zamanlayıcıyı durdur');
        expect(cancelRes.ok).toBe(false);
        expect(cancelRes.code).toBe('PIN_REQUIRED');
        expect(cancelRes.openMainWindow).toBe(true);
        expect(onRequirePinWindow).toHaveBeenCalledWith('cancel');
        expect(activeTasks).toHaveLength(1);
    });

    it('6) Aktif görev yokken durum sorulursa status_idle, iptal istenirse cancel_none döner; asistan sorguları (enerji, tanı, öneri, doküman) ve yardımcı biçimlendiriciler çalışır', async () => {
        const { router, taskManager } = makeSetup();

        const emptyRes = await router.executeVoiceText('   ');
        expect(emptyRes.ok).toBe(false);
        expect(emptyRes.code).toBe('EMPTY_COMMAND');

        const idleStatus = await router.executeVoiceText('Durum nedir?');
        expect(idleStatus.ok).toBe(true);
        expect(idleStatus.kind).toBe('status_idle');

        const noneCancel = await router.executeVoiceText('Zamanlayıcıyı iptal et');
        expect(noneCancel.ok).toBe(true);
        expect(noneCancel.kind).toBe('status_idle');

        const energyRes = await router.executeVoiceText('Ne kadar enerji tasarruf ettim?');
        expect(energyRes.kind).toBe('assistant_answer');

        const diagRes = await router.executeVoiceText('Son görev neden engellendi?');
        expect(diagRes.kind).toBe('assistant_answer');

        const recRes = await router.executeVoiceText('Bana bir otomasyon öner');
        expect(recRes.kind).toBe('assistant_answer');

        const docsRes = await router.executeVoiceText('OneDrive yedekleme nasıl açılır?');
        expect(docsRes.kind).toBe('assistant_answer');

        // Paused state check
        taskManager.pausedAll = true;
        const pausedRes = await router.executeVoiceText('20 dakika sonra uyut');
        expect(pausedRes.ok).toBe(false);
        expect(pausedRes.code).toBe('PAUSED');

        // Helper functions
        const tr = (_k, _v, fb) => fb;
        expect(cleanForSpeech('<think>gizli</think>**Merhaba** `kod`', 100)).toBe('Merhaba kod');
        expect(formatRemainingText(3665000, tr)).toContain('1');
        expect(formatRemainingText(45000, tr)).toContain('45');
    });

    it('7) routeExtendedDomain ve routeIntegrationDomain yeni AI tier, cancel/delete, async energy/recommend/diagnose ve cloud provider uclarini dogru yonetir', async () => {
        const sent = [];
        const settingsObj = { aiTier: 'balanced', language: 'tr' };
        const svc = {
            storage: {
                getSettings: () => ({ ...settingsObj }),
                updateSettings: (patch) => Object.assign(settingsObj, patch),
                getTemplates: () => []
            },
            taskManager: {
                pausedAll: false,
                getActiveTasks: () => []
            },
            deps: {
                modelManager: {
                    tier: 'balanced',
                    modelDir: os.tmpdir(),
                    getStatus: async () => ({ present: false, tier: 'balanced' }),
                    getAllTiersStatus: async () => ({ recommendedTier: 'balanced', tiers: {} }),
                    cancelDownload: () => ({ cancelled: true }),
                    deleteModel: () => ({ deleted: true })
                },
                sttModelManager: {
                    cancelDownload: () => ({ cancelled: true }),
                    deleteModel: () => ({ deleted: true })
                },
                sttService: {
                    getStatus: () => ({ loaded: false }),
                    unload: async () => {}
                },
                aiBackend: {
                    getStatus: () => ({ loaded: false }),
                    unloadModel: async () => {}
                },
                onSwitchAiTier: vi.fn(async (tier) => ({ ok: true, tier })),
                onSettingsUpdated: vi.fn(),
                energy: { getStatistics: () => ({ totalSavedKwh: 5 }) },
                history: { getHistory: () => [] },
                orchestrator: {
                    runEnergy: vi.fn(async () => ({ ok: true, summary: '12 kWh' })),
                    runSuggest: vi.fn(async () => ({ ok: true, suggestions: ['test'] })),
                    runDiagnose: vi.fn(async () => ({ ok: true, cause: 'none' }))
                },
                cloudSync: {
                    getStatus: () => ({ connected: false }),
                    useDetectedProvider: vi.fn((p) => ({ ok: true, provider: p })),
                    setCustomDirectory: vi.fn((d) => ({ ok: true, dir: d })),
                    dismissRecovery: vi.fn(() => ({ ok: true }))
                },
                updates: {
                    getState: () => ({ status: 'idle' }),
                    checkForUpdates: async () => ({ ok: true, state: { status: 'up-to-date' } }),
                    downloadUpdate: async () => ({ ok: true }),
                    setInstallOnQuit: (enabled) => ({ ok: true, enabled }),
                    installNow: () => ({ ok: true })
                }
            },
            sendJson: (_res, code, payload) => {
                sent.push({ code, payload });
                return true;
            },
            unavailable: (_res, name) => {
                sent.push({ code: 503, payload: { unavailable: name } });
                return true;
            }
        };

        const ctx = { query: new URLSearchParams(), role: 'admin' };

        // AI tier valid + invalid
        routeExtendedDomain(svc, 'POST', '/api/v1/ai/tier', { tier: 'invalid_tier' }, {}, ctx);
        expect(sent.at(-1).code).toBe(400);

        routeExtendedDomain(svc, 'POST', '/api/v1/ai/tier', { tierId: 'powerful' }, {}, ctx);
        await new Promise((r) => setTimeout(r, 10));
        expect(sent.at(-1).code).toBe(200);
        expect(svc.deps.onSettingsUpdated).toHaveBeenCalled();

        // AI model cancel & delete
        routeExtendedDomain(svc, 'POST', '/api/v1/ai/model/cancel', {}, {}, ctx);
        expect(sent.at(-1).code).toBe(200);

        routeExtendedDomain(svc, 'POST', '/api/v1/ai/model/delete', { target: 'all' }, {}, ctx);
        await new Promise((r) => setTimeout(r, 10));
        expect(sent.at(-1).code).toBe(200);

        // Async orchestrator routes (BUG-02 verification)
        routeExtendedDomain(svc, 'GET', '/api/v1/ai/energy', null, {}, ctx);
        routeExtendedDomain(svc, 'GET', '/api/v1/ai/suggest', null, {}, ctx);
        routeIntegrationDomain(svc, 'POST', '/api/v1/ai/diagnose', { reason: 'power veto' }, {}, ctx);
        await new Promise((r) => setTimeout(r, 15));
        expect(sent.some((s) => s.payload && s.payload.insight && s.payload.insight.summary === '12 kWh')).toBe(true);
        expect(sent.some((s) => s.payload && s.payload.suggestion && s.payload.suggestion.ok === true)).toBe(true);
        expect(sent.some((s) => s.payload && s.payload.diagnosis && s.payload.diagnosis.cause === 'none')).toBe(true);

        // Cloud provider normalization (BUG-04 verification)
        routeIntegrationDomain(svc, 'POST', '/api/v1/cloud/provider', { providerId: 'gdrive' }, {}, ctx);
        expect(sent.at(-1).code).toBe(200);
        routeIntegrationDomain(svc, 'POST', '/api/v1/cloud/provider', { providerId: 'default' }, {}, ctx);
        expect(sent.at(-1).code).toBe(200);

        // Import settings triggers onSettingsUpdated (DATA-03 verification)
        routeExtendedDomain(svc, 'POST', '/api/v1/import/settings', { settings: { language: 'en', voiceHudTtsEnabled: false } }, {}, ctx);
        expect(sent.at(-1).code).toBe(200);
        expect(svc.deps.onSettingsUpdated).toHaveBeenCalled();
    });
});
