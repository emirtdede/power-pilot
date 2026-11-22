/**
 * AgentOrchestrator.js - F9.1 + WP-8
 * Deterministik yönlendirici + tek-uçuş kuyruğu + susturma + denetim.
 *
 * 7 ajan:
 *  - command     : doğal dil → güç görevi (DeterministicParser + opsiyonel LLM)
 *  - template    : doğal dil → doğrulanmış otomasyon şablonu önerisi
 *  - connection  : doğal dil → API / Webhook / WoL / UPS / MCP / Konsol ayarı önerisi
 *  - docs_qa     : yerel DocsKnowledgeBase BM25 + opsiyonel LLM RAG soru-cevap
 *  - diagnose    : engelleme / hata teşhisi
 *  - energy      : tasarruf anlatıcısı
 *  - recommender : haftalık kullanım deseni önericisi
 */
'use strict';

const commandAgent = require('./agents/commandAgent');
const diagnoseAgent = require('./agents/diagnoseAgent');
const energyAgent = require('./agents/energyAgent');
const recommenderAgent = require('./agents/recommenderAgent');
const templateAgent = require('./agents/templateAgent');
const connectionAgent = require('./agents/connectionAgent');
const docsQaAgent = require('./agents/docsQaAgent');
const { guardProposal } = require('./NegationGuard');

const AGENT_MANIFESTS = [
    { id: 'command', version: '1.0.0', cost: 'llm' },
    { id: 'diagnose', version: '1.0.0', cost: 'free' },
    { id: 'energy', version: '1.0.0', cost: 'free' },
    { id: 'recommender', version: '1.0.0', cost: 'free' },
    { id: 'template', version: '1.0.0', cost: 'free' },
    { id: 'connection', version: '1.0.0', cost: 'free' },
    { id: 'docs_qa', version: '1.0.0', cost: 'hybrid' }
];

const AGENTS = {
    command: commandAgent,
    diagnose: diagnoseAgent,
    energy: energyAgent,
    recommender: recommenderAgent,
    template: templateAgent,
    connection: connectionAgent,
    docs_qa: docsQaAgent
};

// WP-10.T7 / T-CSP-06: AI komutları dakikada en fazla 10 kez çalıştırılır.
const AI_RATE_WINDOW_MS = 60000;
const AI_RATE_MAX = 10;

// Sıra önemli: açık niyetler (şablon, teşhis, enerji, öneri, doküman sorusu vs bağlantı yapılandırma)
const QUESTION_ONLY_RE = /(?:nasıl|nasil|nedir|nerede|nereden|ne\s+işe\s+yarar|farkı\s+nedir|\b(?:how\s+to|how\s+do|what\s+is|where\s+is|difference\s+between)\b)/i;
const IMPERATIVE_CONN_RE = /(?:aç|ac|kapat|etkinleştir|etkinlestir|kur|ayarla|ekle|kaydet|gönder|gonder|uyandır|uyandir|yapılandır|yapilandir|enable|disable|set|configure|setup|add|save|wake|send|https?:\/\/|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})/i;
const ROUTE_RULES = [
    { agentId: 'template', re: /(?:şablon|sablon|template)\s*(?:oluştur|olustur|yarat|ekle|yap|kaydet|kur|create|make|add|new|build)|(?:oluştur|olustur|create|make|build|new)\b.{0,40}\b(?:şablon|sablon|template)/i },
    { agentId: 'diagnose', re: /neden.*(?:kapan|olmad|engellen|çalışmad|calismad|durdu|iptal)|niçin|nedir.*olmad|açıkla|sebep|why.*(?:block|fail|not\s*shut)/i },
    { agentId: 'energy', re: /tasarruf|enerji|fatura|kwh|tüketim|ne kadar.*(?:tasarruf|kwh|saat)|energy\s*sav/i },
    { agentId: 'recommender', re: /kural\s*öner|öner|tavsiye|ne\s*yapsam|suggest\s*rule/i },
    {
        agentId: 'connection',
        match: (input) => {
            if (QUESTION_ONLY_RE.test(input) && !/(?:https?:\/\/|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|\bport\s*\d{4,5})/i.test(input)) {
                return false;
            }
            const hasTarget = /\b(?:webhook|n8n|wol|wake[\s-]*on[\s-]*lan|mcp|nut|ups|rest\s*api|local\s*api|yerel\s*api|lan\s*mod|tls|konsol|console)\b|(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(input);
            return hasTarget && IMPERATIVE_CONN_RE.test(input);
        }
    },
    { agentId: 'docs_qa', re: /nasıl|nasil|nedir|nerede|nereden|hangi\s+(?:koşul|kosul|eylem|kısayol|kisayol|port|komut|özellik|ozellik|ikon|destek)|doküman|dokuman|belge|rehber|yardım|yardim|kısayol|kisayol|çökme|cokme|tanılama|tanilama|destek\s*paketi|\b(?:how\s+to|how\s+do|what\s+is|where\s+is|docs|documentation|help\s+me|shortcut|crash\s+report)\b|\?$/i }
];

class AgentOrchestrator {
    constructor({ aiService = null, aiBackend = null, storage = null, history = null } = {}) {
        this.aiService = aiService;
        this.aiBackend = aiBackend || (aiService && aiService.backend) || null;
        this.storage = storage;
        this.history = history;
        this.busy = false;
        this.commandStarts = [];
    }

    static manifests() {
        return AGENT_MANIFESTS.map((m) => ({ ...m }));
    }

    // Saf yönlendirme: metin → ajan id (kural, yoksa güvenli varsayılan command).
    static route(text) {
        const input = String(text || '').trim();
        if (!input) return { agentId: 'command', confidence: 1 };
        for (const rule of ROUTE_RULES) {
            if (typeof rule.match === 'function' ? rule.match(input) : rule.re.test(input)) {
                return { agentId: rule.agentId, confidence: 1 };
            }
        }
        return { agentId: 'command', confidence: 1 };
    }

    getSettings() {
        try {
            return (this.storage && typeof this.storage.getSettings === 'function')
                ? this.storage.getSettings() || {}
                : {};
        } catch (_) {
            return {};
        }
    }

    isSilenced() {
        const s = this.getSettings();
        return typeof s.aiSilencedUntil === 'number' && s.aiSilencedUntil > Date.now();
    }

    audit(agentId, intent, outcome, msDuration) {
        if (this.history && typeof this.history.recordAgentRun === 'function') {
            try {
                this.history.recordAgentRun({ agentId, intent, outcome, msDuration });
            } catch (_) {}
        }
    }

    _checkRateLimit(agentId, text) {
        if (this.isSilenced()) {
            return { ok: false, code: 'AI_SILENCED', message: 'AI susturuldu.' };
        }
        if (this.busy) {
            return { ok: false, code: 'BUSY', message: 'AI meşgul, birazdan tekrar deneyin.' };
        }
        const now = Date.now();
        this.commandStarts = this.commandStarts.filter((startedAt) => now - startedAt < AI_RATE_WINDOW_MS);
        if (this.commandStarts.length >= AI_RATE_MAX) {
            this.audit(agentId, String(text).slice(0, 80), 'rate_limited', 0);
            return { ok: false, code: 'RATE_LIMITED', message: 'AI komut sınırı aşıldı, bir dakika sonra tekrar deneyin.' };
        }
        this.commandStarts.push(now);
        return null;
    }

    async runCommand(text) {
        const gate = this._checkRateLimit('command', text);
        if (gate) return gate;
        this.busy = true;
        const started = Date.now();
        try {
            const res = await AGENTS.command.execute({ text, aiService: this.aiService });
            // WP-06.T2: AI çıktısı da olumsuzluk kapısından geçer.
            const proposal = res && (res.proposal || (res.action ? res : null));
            const guard = guardProposal(text, proposal);
            if (!guard.ok) {
                this.audit('command', String(text).slice(0, 80), guard.code, Date.now() - started);
                return { ok: false, code: guard.code, message: guard.error };
            }
            this.audit('command', String(text).slice(0, 80), res.ok ? 'ok' : (res.code || 'fail'), Date.now() - started);
            return res;
        } finally {
            this.busy = false;
        }
    }

    async runTemplate(text, { language = 'tr' } = {}) {
        const gate = this._checkRateLimit('template', text);
        if (gate) return gate;
        this.busy = true;
        const started = Date.now();
        try {
            const res = await AGENTS.template.execute({ text, language });
            this.audit('template', String(text).slice(0, 80), res.ok ? 'ok' : (res.code || 'fail'), Date.now() - started);
            return res;
        } finally {
            this.busy = false;
        }
    }

    async runConnection(text, { language = 'tr' } = {}) {
        const gate = this._checkRateLimit('connection', text);
        if (gate) return gate;
        this.busy = true;
        const started = Date.now();
        try {
            const res = await AGENTS.connection.execute({
                text,
                language,
                currentSettings: this.getSettings()
            });
            this.audit('connection', String(text).slice(0, 80), res.ok ? 'ok' : (res.code || 'fail'), Date.now() - started);
            return res;
        } finally {
            this.busy = false;
        }
    }

    async runDocsQa(text, { language = 'tr' } = {}) {
        const gate = this._checkRateLimit('docs_qa', text);
        if (gate) return gate;
        this.busy = true;
        const started = Date.now();
        try {
            const res = await AGENTS.docs_qa.execute({
                text,
                language,
                aiBackend: this.aiBackend
            });
            this.audit('docs_qa', String(text).slice(0, 80), res.ok ? (res.mode || 'ok') : (res.code || 'fail'), Date.now() - started);
            return res;
        } finally {
            this.busy = false;
        }
    }

    /**
     * Birleşik asistan giriş noktası: isteği doğru ajana yönlendirir (veya zorlanan
     * `intentHint` ile doğrudan ilgili ajanı çalıştırır).
     */
    async runAssistant(text, { language = 'tr', intentHint = null, energyStats = null, historyList = null, lastBlockedReason = '' } = {}) {
        const routed = intentHint && AGENTS[intentHint]
            ? { agentId: intentHint }
            : AgentOrchestrator.route(text);
        const agentId = routed.agentId;

        if (agentId === 'template') return this.runTemplate(text, { language });
        if (agentId === 'connection') return this.runConnection(text, { language });
        if (agentId === 'docs_qa') return this.runDocsQa(text, { language });
        if (agentId === 'diagnose') {
            const res = await this.runDiagnose(lastBlockedReason || text, { language });
            return { ...res, agentId: 'diagnose', kind: 'diagnose' };
        }
        if (agentId === 'energy') {
            const res = await this.runEnergy(energyStats || { enabled: false }, { language });
            return { ...res, agentId: 'energy', kind: 'energy' };
        }
        if (agentId === 'recommender') {
            const res = await this.runSuggest(historyList || [], { language });
            return { ...res, agentId: 'recommender', kind: 'recommender' };
        }
        const cmdRes = await this.runCommand(text);
        // Komut ayrıştırıcı model yüklü olmadığı için AI_NOT_READY döndüyse ama soru dokümanlarda varsa
        // kullanıcıyı boş bırakmak yerine yerel Docs RAG'e düşmeyi dene.
        if (cmdRes && cmdRes.ok === false && cmdRes.code === 'AI_NOT_READY') {
            const ragTry = await AGENTS.docs_qa.execute({ text, language, aiBackend: null });
            if (ragTry && ragTry.ok && Array.isArray(ragTry.citations) && ragTry.citations.length > 0) {
                return ragTry;
            }
        }
        return { ...cmdRes, agentId: 'command' };
    }

    async runDiagnose(reason, { language = 'tr' } = {}) {
        const started = Date.now();
        const res = await AGENTS.diagnose.execute({ reason, language });
        this.audit('diagnose', String(reason || '').slice(0, 80), 'ok', Date.now() - started);
        return res;
    }

    async runEnergy(stats, { language = 'tr' } = {}) {
        const started = Date.now();
        const res = await AGENTS.energy.execute({ stats, language });
        this.audit('energy', 'stats-summary', 'ok', Date.now() - started);
        return res;
    }

    async runSuggest(historyList, { language = 'tr' } = {}) {
        if (this.isSilenced()) {
            return { ok: true, suggestion: null, reason: 'SILENCED' };
        }
        const started = Date.now();
        const res = await AGENTS.recommender.execute({
            history: historyList,
            settings: this.getSettings(),
            now: Date.now(),
            language
        });
        // WBS-9.3: Haftalık tavan teklif ANINDA işler (görüntülenmese bile hak yenilenmez).
        if (res.suggestion && this.storage && typeof this.storage.updateSettings === 'function') {
            try { this.storage.updateSettings({ aiAdvisorLastAt: Date.now() }); } catch (_) {}
        }
        this.audit('recommender', 'weekly-scan', res.suggestion ? 'suggested' : (res.reason || 'none'), Date.now() - started);
        return res;
    }

    // WBS-9.3: Reddedilen konu 30 gün susturulur.
    dismissTopic(topic) {
        if (!topic || !this.storage || typeof this.storage.updateSettings !== 'function') return false;
        try {
            const current = this.getSettings().aiDismissed || {};
            current[String(topic).slice(0, 40)] = Date.now();
            this.storage.updateSettings({ aiDismissed: current });
            return true;
        } catch (_) {
            return false;
        }
    }
}

module.exports = { AgentOrchestrator, AGENTS, AGENT_MANIFESTS };
