/**
 * agents.test.mjs - F9.1 / TS-9.1
 * Orkestratör yönlendirme + 4 ajan + susturma + kuyruk + denetim.
 * LLM teması yok (sahte AiService) - tam deterministik.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentOrchestrator, AGENT_MANIFESTS } = require('../../src/main/services/AgentOrchestrator.js');
const HistoryService = require('../../src/main/services/HistoryService.js');
const docsQaAgent = require('../../src/main/services/agents/docsQaAgent.js');
const templateAgent = require('../../src/main/services/agents/templateAgent.js');
const connectionAgent = require('../../src/main/services/agents/connectionAgent.js');
const diagnoseAgent = require('../../src/main/services/agents/diagnoseAgent.js');

function makeOrchestrator(overrides = {}) {
    const storage = {
        getSettings: () => ({}),
        ...(overrides.storage || {})
    };
    const history = {
        recordAgentRun: vi.fn(),
        ...(overrides.history || {})
    };
    const aiService = {
        parseCommand: vi.fn(async (text) => ({ ok: true, proposal: { action: 'sleep', text } })),
        ...(overrides.aiService || {})
    };
    return { orch: new AgentOrchestrator({ aiService, storage, history }), storage, history, aiService };
}

describe('AgentOrchestrator yönlendirme (TS-9.1 + WP-8)', () => {
    it('manifest 7 ajanı listeler', () => {
        const ids = AgentOrchestrator.manifests().map((m) => m.id).sort();
        expect(ids).toEqual(['command', 'connection', 'diagnose', 'docs_qa', 'energy', 'recommender', 'template']);
        expect(AGENT_MANIFESTS).toHaveLength(7);
    });

    it('niyetler doğru ajana gider', () => {
        expect(AgentOrchestrator.route('neden kapanmadı?').agentId).toBe('diagnose');
        expect(AgentOrchestrator.route('bu ay ne kadar tasarruf ettim').agentId).toBe('energy');
        expect(AgentOrchestrator.route('bana kural öner').agentId).toBe('recommender');
        expect(AgentOrchestrator.route('render bitince kapatan şablon oluştur').agentId).toBe('template');
        expect(AgentOrchestrator.route('REST API 18456 portunu aç').agentId).toBe('connection');
        expect(AgentOrchestrator.route('Smart Finish koşulları nasıl çalışır?').agentId).toBe('docs_qa');
    });

    it('runAssistant LLM yokken doküman sorusunu yerel Docs RAG ile yanıtlar', async () => {
        const { orch } = makeOrchestrator({
            aiService: { parseCommand: vi.fn(async () => ({ ok: false, code: 'AI_NOT_READY' })) }
        });
        const res = await orch.runAssistant('MCP sunucusu nasıl bağlanır?', { language: 'tr' });
        expect(res.ok).toBe(true);
        expect(res.kind).toBe('docs_answer');
        expect(res.citations.length).toBeGreaterThan(0);
    });

    it('eşleşme yoksa güvenli varsayılan command', () => {
        expect(AgentOrchestrator.route('2 saat sonra kapat').agentId).toBe('command');
        expect(AgentOrchestrator.route('').agentId).toBe('command');
        expect(AgentOrchestrator.route(null).agentId).toBe('command');
    });
});

describe('AgentOrchestrator çalıştırma (TS-9.1)', () => {
    it('runCommand ayrıştırıcıya devreder + denetim kaydı düşer', async () => {
        const { orch, history, aiService } = makeOrchestrator();
        const r = await orch.runCommand('2 saat sonra kapat');
        expect(r.ok).toBe(true);
        expect(aiService.parseCommand).toHaveBeenCalledWith('2 saat sonra kapat');
        expect(history.recordAgentRun).toHaveBeenCalledTimes(1);
        const rec = history.recordAgentRun.mock.calls[0][0];
        expect(rec.agentId).toBe('command');
        expect(rec.intent.length).toBeLessThanOrEqual(80);
    });

    it('meşgulken ikinci komut BUSY döner', async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const { orch } = makeOrchestrator({
            aiService: { parseCommand: vi.fn(() => gate) }
        });
        const first = orch.runCommand('kapat');
        const second = await orch.runCommand('uyut');
        expect(second).toMatchObject({ ok: false, code: 'BUSY' });
        release({ ok: true });
        await first;
    });

    it('susturulmuşken komut çalışmaz (AI_SILENCED)', async () => {
        const { orch, aiService } = makeOrchestrator({
            storage: { getSettings: () => ({ aiSilencedUntil: Date.now() + 3600000 }) }
        });
        expect(await orch.runCommand('kapat')).toMatchObject({ ok: false, code: 'AI_SILENCED' });
        expect(aiService.parseCommand).not.toHaveBeenCalled();
    });

    it('T-CSP-06: dakikada 10 AI komutundan sonra RATE_LIMITED, pencere dolunca tekrar çalışır', async () => {
        let now = 1_700_000_000_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        try {
            const { orch, aiService } = makeOrchestrator();
            for (let i = 0; i < 10; i += 1) {
                expect(await orch.runCommand(`kapat ${i}`)).toMatchObject({ ok: true });
            }
            expect(await orch.runCommand('kapat 11')).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
            expect(aiService.parseCommand).toHaveBeenCalledTimes(10);

            now += 60001;
            expect(await orch.runCommand('kapat 12')).toMatchObject({ ok: true });
        } finally {
            clock.mockRestore();
        }
    });

    it('runDiagnose korunan-uygulama gerekçesini çevirir', async () => {
        const { orch } = makeOrchestrator();
        const r = await orch.runDiagnose('Korunan uygulama(lar) çalışıyor: code.exe');
        expect(r.ok).toBe(true);
        expect(r.explanation).toMatch(/code\.exe/);
        expect(r.whatToDo).toBeDefined();
    });

    it('runEnergy sayıları cümleye döker + eşik üstü önerir', async () => {
        const { orch } = makeOrchestrator();
        const r = await orch.runEnergy({
            enabled: true, preventedUptimeHours: '6.0', costSavedFormatted: '2.25 TL'
        });
        expect(r.summary).toContain('6.0');
        expect(r.summary).toContain('2.25 TL');
        expect(r.suggestion.templateId).toBe('tpl_nightly_sleep');
    });

    it('runEnergy düşük tasarrufta önermez', async () => {
        const { orch } = makeOrchestrator();
        const r = await orch.runEnergy({ enabled: true, preventedUptimeHours: '1.0', costSavedFormatted: '0.38 TL' });
        expect(r.suggestion).toBeNull();
    });
    it('runEnergy istatistik kapalıyken kısa devre', async () => {
        const { orch } = makeOrchestrator();
        const r = await orch.runEnergy({ enabled: false });
        expect(r.suggestion).toBeNull();
    });

    it('runEnergy eksik veride sayı uydurmaz (WBS-E7)', async () => {
        const { orch } = makeOrchestrator();
        const r = await orch.runEnergy({ enabled: true, preventedUptimeHours: '5.0', kwhSaved: null, costSavedFormatted: null });
        expect(r.summary).toContain('5.0');
        expect(r.summary).not.toContain('kWh');
        expect(r.summary).not.toContain('null');
        expect(r.suggestion.templateId).toBe('tpl_nightly_sleep');
        const r2 = await orch.runEnergy({ enabled: true, preventedUptimeHours: '5.0', kwhSaved: '1.88', costSavedFormatted: null });
        expect(r2.summary).toContain('1.88');
    });
});

function freezeTime(ts) {
    const RealDate = globalThis.Date;
    const mockDate = function (...args) {
        return args.length === 0 ? new RealDate(ts) : new RealDate(...args);
    };
    mockDate.now = () => ts;
    mockDate.parse = RealDate.parse;
    mockDate.UTC = RealDate.UTC;
    vi.stubGlobal('Date', mockDate);
}

describe('recommender sessizlik kuralları (TS-9.1)', () => {
    function nightlies(n, baseTs) {
        const list = [];
        for (let i = 0; i < n; i++) {
            const d = new Date(baseTs - i * 86400000);
            d.setHours(2, 10, 0, 0);
            list.push({ resultCode: 'success', action: 'shutdown', timestamp: d.toISOString() });
        }
        return list;
    }

    it('7 günde 3+ gece kapatması → teklif', async () => {
        // Salı öğlen dondurulur (sessiz saat + tavan dışı, flake yok).
        const tuesdayNoon = new Date(2026, 9, 13, 12, 0).getTime();
        freezeTime(tuesdayNoon);
        try {
            const { orch } = makeOrchestrator();
            const r = await orch.runSuggest(nightlies(3, tuesdayNoon));
            expect(r.suggestion).not.toBeNull();
            expect(r.suggestion.topic).toBe('nightly');
            expect(r.suggestion.text).toContain('3');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('desen yoksa teklif yok (NO_PATTERN)', async () => {
        const tuesdayNoon = new Date(2026, 9, 13, 12, 0).getTime();
        freezeTime(tuesdayNoon);
        try {
            const { orch } = makeOrchestrator();
            const r = await orch.runSuggest([{ resultCode: 'success', action: 'lock', timestamp: new Date(tuesdayNoon).toISOString() }]);
            expect(r.suggestion).toBeNull();
            expect(r.reason).toBe('NO_PATTERN');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('gece 23:00 teklif üretilmez (QUIET_HOURS)', async () => {
        const night = new Date(2026, 9, 13, 23, 0).getTime();
        freezeTime(night);
        try {
            const { orch } = makeOrchestrator();
            const r = await orch.runSuggest(nightlies(5, night));
            expect(r.suggestion).toBeNull();
            expect(r.reason).toBe('QUIET_HOURS');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('haftalık tavan: 7 gün içinde teklif edildiyse susar', async () => {
        const tuesdayNoon = new Date(2026, 9, 13, 12, 0).getTime();
        freezeTime(tuesdayNoon);
        try {
            const { orch } = makeOrchestrator({
                storage: { getSettings: () => ({ aiAdvisorLastAt: tuesdayNoon - 86400000 }) }
            });
            const r = await orch.runSuggest(nightlies(5, tuesdayNoon));
            expect(r.suggestion).toBeNull();
            expect(r.reason).toBe('WEEKLY_CAP');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reddedilen konuda 30 gün susar', async () => {
        const tuesdayNoon = new Date(2026, 9, 13, 12, 0).getTime();
        freezeTime(tuesdayNoon);
        try {
            const { orch } = makeOrchestrator({
                storage: { getSettings: () => ({ aiDismissed: { nightly: tuesdayNoon - 5 * 86400000 } }) }
            });
            const r = await orch.runSuggest(nightlies(5, tuesdayNoon));
            expect(r.suggestion).toBeNull();
            expect(r.reason).toBe('DISMISSED_30D');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('susturulmuşken öneri üretilmez', async () => {
        const { orch } = makeOrchestrator({
            storage: { getSettings: () => ({ aiSilencedUntil: Date.now() + 3600000 }) }
        });
        const r = await orch.runSuggest([]);
        expect(r.suggestion).toBeNull();
        expect(r.reason).toBe('SILENCED');
    });

    it('teklif anında haftalık sayaç işlenir (WBS-9.3)', async () => {
        const tuesdayNoon = new Date(2026, 9, 13, 12, 0).getTime();
        freezeTime(tuesdayNoon);
        try {
            const updateSettings = vi.fn();
            const { orch } = makeOrchestrator({
                storage: { getSettings: () => ({}), updateSettings }
            });
            const r = await orch.runSuggest(nightlies(3, tuesdayNoon));
            expect(r.suggestion).not.toBeNull();
            expect(updateSettings).toHaveBeenCalledWith({ aiAdvisorLastAt: tuesdayNoon });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('dismissTopic reddi 30 güne yazar', () => {
        const updateSettings = vi.fn();
        const { orch } = makeOrchestrator({
            storage: { getSettings: () => ({}), updateSettings }
        });
        expect(orch.dismissTopic('nightly')).toBe(true);
        const arg = updateSettings.mock.calls[0][0];
        expect(typeof arg.aiDismissed.nightly).toBe('number');
        expect(orch.dismissTopic('')).toBe(false);
    });
});

describe('HistoryService.recordAgentRun (F9.5)', () => {
    it('ham metin saklanmaz, şekil sabittir', async () => {
        const added = [];
        const svc = new HistoryService({ addHistoryRecord: (r) => added.push(r) });
        svc.recordAgentRun({ agentId: 'command', intent: 'x'.repeat(200), outcome: 'ok', msDuration: 12.7 });
        expect(added).toHaveLength(1);
        const rec = added[0];
        expect(rec.kind).toBe('agent_run');
        expect(rec.intent.length).toBeLessThanOrEqual(80);
        expect(rec.msDuration).toBe(12);
        expect(rec.timestamp).toBeDefined();
    });
});

describe('WP-8 Ajanları - docsQaAgent, templateAgent, connectionAgent, diagnoseAgent ve runAssistant tam kapsam', () => {
    it('docsQaAgent: boş sorgu, eşleşmeyen sorgu, yerel RAG ve LLM RAG sentezi (TR + EN)', async () => {

        expect((await docsQaAgent.execute({ text: '   ', language: 'tr' })).code).toBe('EMPTY');
        expect((await docsQaAgent.execute({ text: '', language: 'en' })).code).toBe('EMPTY');

        const noHitTr = await docsQaAgent.execute({ text: 'zzzzxxxxqqqq12345', language: 'tr' });
        expect(noHitTr.ok).toBe(true);
        expect(noHitTr.mode).toBe('fallback');
        const noHitEn = await docsQaAgent.execute({ text: 'zzzzxxxxqqqq12345', language: 'en' });
        expect(noHitEn.ok).toBe(true);
        expect(noHitEn.mode).toBe('fallback');

        const localHit = await docsQaAgent.execute({ text: 'Wake-on-LAN magic packet nedir?', language: 'tr' });
        expect(localHit.ok).toBe(true);
        expect(localHit.mode).toBe('rag_local');
        expect(localHit.citations.length).toBeGreaterThan(0);

        const disposed = vi.fn();
        const fakeBackend = {
            getStatus: () => ({ loaded: true }),
            createSession: vi.fn(async () => ({
                completePrompt: vi.fn(async () => ({ text: 'LLM tarafından kaynak bağlama dayalı sentezlenen detaylı yanıt.' }))
            })),
            disposeSession: disposed
        };
        const llmHit = await docsQaAgent.execute({
            text: 'How does Smart Finish work?',
            language: 'en',
            aiBackend: fakeBackend
        });
        expect(llmHit.ok).toBe(true);
        expect(llmHit.mode).toBe('rag_llm');
        expect(llmHit.answer).toContain('LLM tarafından');
        expect(disposed).toHaveBeenCalledTimes(1);

        // Kısa yanıt veya hata durumunda güvenli biçimde rag_local'a düşer.
        const failingBackend = {
            getStatus: () => ({ loaded: true }),
            createSession: vi.fn(async () => ({
                completePrompt: vi.fn(async () => { throw new Error('llm fail'); })
            })),
            disposeSession: vi.fn()
        };
        const fallbackHit = await docsQaAgent.execute({
            text: 'REST API port 18456 nasıl kullanılır?',
            language: 'tr',
            aiBackend: failingBackend
        });
        expect(fallbackHit.ok).toBe(true);
        expect(fallbackHit.mode).toBe('rag_local');
    });

    it('templateAgent: tüm koşul/zamanlama/süre türlerini, olumsuzluğu ve TR/EN netleştirmeleri kapsar', async () => {
        expect((await templateAgent.execute({ text: '', language: 'tr' })).code).toBe('EMPTY');
        expect((await templateAgent.execute({ text: '', language: 'en' })).code).toBe('EMPTY');
        expect((await templateAgent.execute({ text: 'bilgisayarı sakın kapatma şablon oluştur', language: 'tr' })).code).toBe('NEGATED_INTENT');
        expect((await templateAgent.execute({ text: 'sakın kapatma create template', language: 'en' })).code).toBe('NEGATED_INTENT');

        const clarifyActionTr = await templateAgent.execute({ text: 'sadece bir şablon oluştur', language: 'tr' });
        expect(clarifyActionTr.kind).toBe('clarify');
        expect(clarifyActionTr.needsClarification.missingFields).toEqual(['action']);

        const clarifyActionEn = await templateAgent.execute({ text: 'just create a template', language: 'en' });
        expect(clarifyActionEn.kind).toBe('clarify');

        const clarifyTriggerTr = await templateAgent.execute({ text: 'bilgisayarı kapat', language: 'tr' });
        expect(clarifyTriggerTr.kind).toBe('clarify');
        expect(clarifyTriggerTr.needsClarification.missingFields).toEqual(['trigger']);

        const clarifyTriggerEn = await templateAgent.execute({ text: 'shutdown computer', language: 'en' });
        expect(clarifyTriggerEn.kind).toBe('clarify');

        const cases = [
            { text: 'her hafta içi 23:30 uyut şablon oluştur', lang: 'tr', cat: 'schedule' },
            { text: 'every weekend 01:15 hibernate', lang: 'en', cat: 'schedule' },
            { text: 'in 1 hour 30 minutes 15 seconds restart', lang: 'en', cat: 'schedule' },
            { text: 'disk kopyalama 2 mb/s altına düşünce kapat', lang: 'tr', cat: 'render' },
            { text: 'when idle for 20 minutes lock', lang: 'en', cat: 'power' },
            { text: 'when download drops below 100 kbps shutdown', lang: 'en', cat: 'download' },
            { text: 'when cpu render drops below 15% sleep', lang: 'en', cat: 'render' },
            { text: 'when battery below 25% hibernate', lang: 'en', cat: 'power' },
            { text: 'when steam.exe closes shutdown', lang: 'en', cat: 'gaming' },
            { text: 'when code closes lock', lang: 'en', cat: 'security' },
            { text: 'when node.exe exits sign out', lang: 'en', cat: 'productivity' },
            { text: '"Gece Yedekleme" disk bitince kapat', lang: 'tr', cat: 'custom' },
            { text: 'adı Ofis Çıkışı 45 dakika sonra kilitle', lang: 'tr', cat: 'schedule' }
        ];
        for (const c of cases) {
            const res = await templateAgent.execute({ text: c.text, language: c.lang });
            expect(res.ok, c.text).toBe(true);
            expect(res.kind, c.text).toBe('template_proposal');
            expect(res.templateProposal.category, c.text).toBe(c.cat);
        }
    });

    it('connectionAgent: MCP, Webhook, WoL, UPS, Kurumsal Konsol ve Yerel REST API dallarını kapsar', async () => {
        // 1. MCP (API kapalı vs açık, TR vs EN)
        const mcp1 = await connectionAgent.execute({ text: 'MCP sunucusunu kur', language: 'tr', currentSettings: { localApiEnabled: false } });
        expect(mcp1.connectionProposal.target).toBe('mcp');
        expect(mcp1.connectionProposal.requiresPin).toBe(true);
        const mcp2 = await connectionAgent.execute({ text: 'setup cursor mcp', language: 'en', currentSettings: { localApiEnabled: true, localApiPort: 18456 } });
        expect(mcp2.connectionProposal.requiresPin).toBe(false);

        // 2. Webhook (http reddi, eksik URL, geçerli HTTPS)
        const whHttp = await connectionAgent.execute({ text: 'webhook ekle http://insecure.local/hook', language: 'tr' });
        expect(whHttp.kind).toBe('clarify');
        const whMissing = await connectionAgent.execute({ text: 'add webhook for zapier', language: 'en' });
        expect(whMissing.kind).toBe('clarify');
        const whOk = await connectionAgent.execute({
            text: '"Bildirim" n8n webhook ekle https://hooks.example.com/pp task_created task_blocked',
            language: 'tr'
        });
        expect(whOk.kind).toBe('connection_proposal');
        expect(whOk.connectionProposal.webhook.name).toBe('Bildirim');
        expect(whOk.connectionProposal.webhook.events).toEqual(['task_created', 'task_blocked']);

        // 3. Wake-on-LAN (eksik MAC, kaydetme, anında gönderme)
        const wolClarify = await connectionAgent.execute({ text: 'wake on lan cihazı ekle', language: 'tr' });
        expect(wolClarify.kind).toBe('clarify');
        const wolSave = await connectionAgent.execute({ text: '"Ofis PC" WoL ekle AA:BB:CC:DD:EE:FF 192.168.1.255', language: 'tr' });
        expect(wolSave.connectionProposal.target).toBe('wol_device');
        const wolSend = await connectionAgent.execute({ text: 'wake AA-BB-CC-DD-EE-FF now', language: 'en' });
        expect(wolSend.connectionProposal.target).toBe('wol_send');

        // 4. UPS / NUT (etkinleştir + host + name, devre dışı bırak)
        const upsOn = await connectionAgent.execute({ text: 'UPS etkinleştir host: 192.168.1.50 name: mainups', language: 'tr' });
        expect(upsOn.connectionProposal.settingsPatch).toMatchObject({ upsEnabled: true, upsHost: '192.168.1.50', upsName: 'mainups' });
        const upsOff = await connectionAgent.execute({ text: 'disable nut ups server: nut.local', language: 'en' });
        expect(upsOff.connectionProposal.settingsPatch.upsEnabled).toBe(false);

        // 5. Kurumsal Konsol (clarify + geçerli ayarlar)
        const entClarify = await connectionAgent.execute({ text: 'kurumsal konsol', language: 'tr' });
        expect(entClarify.kind).toBe('clarify');
        const entOk = await connectionAgent.execute({
            text: 'kurumsal konsol https://console.vellium.dev agent id: node-01 sunucu',
            language: 'tr'
        });
        expect(entOk.connectionProposal.requiresPin).toBe(true);
        expect(entOk.connectionProposal.settingsPatch).toMatchObject({
            consoleUrl: 'https://console.vellium.dev',
            agentId: 'node-01',
            deviceRole: 'server'
        });
        const entWs = await connectionAgent.execute({ text: 'enterprise console workstation', language: 'en' });
        expect(entWs.connectionProposal.settingsPatch.deviceRole).toBe('workstation');

        // 6. Yerel REST API / LAN / TLS (clarify + aç/kapat/port/rol)
        const apiClarify = await connectionAgent.execute({ text: 'yerel api', language: 'tr' });
        expect(apiClarify.kind).toBe('clarify');
        const apiOpen = await connectionAgent.execute({
            text: 'REST API port 18456 üzerinden aç tls operator',
            language: 'tr',
            currentSettings: { localApiEnabled: true, localApiTlsEnabled: true }
        });
        expect(apiOpen.connectionProposal.settingsPatch).toMatchObject({
            localApiPort: 18456,
            localApiEnabled: true,
            localApiTlsEnabled: true,
            localApiKeyRole: 'operator'
        });
        const lanFail = await connectionAgent.execute({
            text: 'yerel ağ lan aç',
            language: 'tr',
            currentSettings: { localApiEnabled: true, localApiTlsEnabled: true }
        });
        expect(lanFail.ok).toBe(false);
        expect(lanFail.code).toBe('LAN_ALLOWLIST_REQUIRED');
        const lanToggle = await connectionAgent.execute({
            text: 'yerel ağ lan aç',
            language: 'tr',
            currentSettings: {
                localApiEnabled: true,
                localApiTlsEnabled: true,
                lanAllowedIps: ['192.168.1.0/24'],
                localApiCertFile: 'cert.pem',
                localApiKeyFile: 'key.pem'
            }
        });
        expect(lanToggle.connectionProposal.settingsPatch.lanModeEnabled).toBe(true);
        const apiClose = await connectionAgent.execute({ text: 'disable local api', language: 'en' });
        expect(apiClose.connectionProposal.settingsPatch.localApiEnabled).toBe(false);

        // 7. Eşleşmeyen genel istek
        const fallback = await connectionAgent.execute({ text: 'merhaba bağlantı', language: 'tr' });
        expect(fallback.kind).toBe('clarify');
        const fallbackEn = await connectionAgent.execute({ text: 'hello integration', language: 'en' });
        expect(fallbackEn.kind).toBe('clarify');
    });

    it('diagnoseAgent: tüm engelleme nedenlerini TR ve EN dilinde açıklar', async () => {
        const reasons = [
            'Korunan uygulama: code.exe',
            'USER_ACTIVE uzaktan kapatma',
            'Çakışan görev CONFLICT',
            'Tam ekran FULLSCREEN',
            'Bilinmeyen kural',
            ''
        ];
        for (const r of reasons) {
            const tr = await diagnoseAgent.execute({ reason: r, language: 'tr' });
            const en = await diagnoseAgent.execute({ reason: r, language: 'en' });
            expect(tr.ok).toBe(true);
            expect(en.ok).toBe(true);
            expect(tr.explanation.length).toBeGreaterThan(0);
            expect(en.explanation.length).toBeGreaterThan(0);
        }
    });

    it('AgentOrchestrator.runAssistant tüm 7 ajanı ve intentHint yönlendirmesini çalıştırır', async () => {
        const { orch } = makeOrchestrator();
        expect((await orch.runAssistant('indirme bitince kapat şablon oluştur')).kind).toBe('template_proposal');
        expect((await orch.runAssistant('REST API port 18456 aç')).kind).toBe('connection_proposal');
        expect((await orch.runAssistant('Smart Finish nedir?')).kind).toBe('docs_answer');
        expect((await orch.runAssistant('neden kapanmadı?', { lastBlockedReason: 'FULLSCREEN' })).kind).toBe('diagnose');
        expect((await orch.runAssistant('ne kadar tasarruf ettim?', { energyStats: { enabled: false } })).kind).toBe('energy');
        expect((await orch.runAssistant('bana kural öner', { historyList: [] })).kind).toBe('recommender');
        expect((await orch.runAssistant('herhangi bir metin', { intentHint: 'diagnose' })).kind).toBe('diagnose');
    });
});
