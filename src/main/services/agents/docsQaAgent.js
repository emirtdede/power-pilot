/**
 * agents/docsQaAgent.js - WP-8
 * Yerel Doküman RAG Ajanı:
 * 1. DocsKnowledgeBase (BM25 + TR/EN eşanlamlı genişletme) ile en alakalı
 *    doküman parçacıklarını çeker.
 * 2. Yerel GGUF LLM yüklüyse çekilen bağlamla sıkı kaynak-bağlı yanıt sentezler.
 * 3. LLM yüklü değilse doğrudan en alakalı doküman parçacıklarından temiz,
 *    kaynaklı, dokümantasyon derin bağlantılı yanıt döndürür.
 */
'use strict';

const { searchDocs } = require('../DocsKnowledgeBase');
const log = require('../../logger');

const RAG_MAX_TOKENS = 280;
const RAG_TEMPERATURE = 0.1;

function buildGroundedPrompt(question, chunks, language) {
    const isTr = String(language || 'tr').toLowerCase().startsWith('tr');
    const context = chunks
        .map((c, idx) => `[${idx + 1}] ${c.title}\n${c.body}${c.command ? `\nKomut: ${c.command}` : ''}`)
        .join('\n\n');
    const system = isTr
        ? 'Sen Power Pilot resmi uygulama dokümantasyon asistanısın. SADECE verilen kaynak bağlama dayanarak kısa, net ve doğru Türkçe yanıt ver. Kaynakta olmayan özellik veya komut uydurma. /no_think'
        : 'You are the official Power Pilot documentation assistant. Answer concisely and accurately ONLY from the provided context. Never invent features or commands not in the context. /no_think';
    const user = isTr
        ? `Kaynak Bağlam:\n${context}\n\nKullanıcı Sorusu: ${question}\nYanıt: /no_think`
        : `Context:\n${context}\n\nUser Question: ${question}\nAnswer: /no_think`;
    return { system, user };
}

function stripThinkingBlocks(raw) {
    return String(raw || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^[\s\S]*?<\/think>/i, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

async function synthesizeWithLlm(backend, question, chunks, language) {
    if (!backend || typeof backend.getStatus !== 'function') return null;
    const status = backend.getStatus();
    if (!status || !status.loaded || typeof backend.createSession !== 'function') return null;

    const { system, user } = buildGroundedPrompt(question, chunks, language);
    let session = null;
    try {
        session = await backend.createSession(system);
        if (!session || typeof session.completePrompt !== 'function') return null;
        const res = await session.completePrompt(user, {
            temperature: RAG_TEMPERATURE,
            maxTokens: RAG_MAX_TOKENS
        });
        const text = typeof res === 'string' ? res : String(res && res.text !== undefined ? res.text : '');
        const clean = stripThinkingBlocks(text);
        return clean.length >= 12 ? clean : null;
    } catch (err) {
        log.warn('[docsQaAgent] LLM RAG sentezi başarısız, deterministik özet kullanılıyor:', err && err.message);
        return null;
    } finally {
        if (session && typeof backend.disposeSession === 'function') {
            try { await backend.disposeSession(session); } catch (_) { /* yut */ }
        }
    }
}

module.exports = {
    id: 'docs_qa',
    version: '1.0.0',
    description: 'Uygulama dokümantasyonuna göre yerel RAG soru-cevap sağlar.',

    async execute({ text, language = 'tr', aiBackend = null }) {
        const query = String(text || '').trim();
        const isTr = String(language || 'tr').toLowerCase().startsWith('tr');
        if (!query) {
            return {
                ok: false,
                code: 'EMPTY',
                message: isTr ? 'Lütfen dokümantasyonla ilgili sorunuzu yazın.' : 'Please type your question about Power Pilot.'
            };
        }

        const hits = searchDocs(query, { lang: language, topK: 3, minScore: 0.4 });
        if (hits.length === 0) {
            return {
                ok: true,
                agentId: 'docs_qa',
                kind: 'docs_answer',
                mode: 'fallback',
                answer: isTr
                    ? 'Bu soruyla doğrudan eşleşen bir doküman bölümü bulunamadı. Smart Finish koşulları, Şablonlar, REST API, MCP, CLI, Wake-on-LAN, UPS, Kısayollar, İkonlar veya Tanılama hakkında soru sorabilirsiniz.'
                    : 'No exact documentation match was found. Try asking about Smart Finish conditions, Templates, REST API, MCP, CLI, Wake-on-LAN, UPS, Shortcuts, App Icons, or Diagnostics.',
                citations: [],
                docSectionId: 'docs-sec-quickstart',
                command: null
            };
        }

        const llmAnswer = await synthesizeWithLlm(aiBackend, query, hits, language);
        const primary = hits[0];
        const fallbackAnswer = hits.length === 1
            ? primary.body
            : `${primary.body}\n\n• ${hits[1].title}: ${hits[1].body}`;

        return {
            ok: true,
            agentId: 'docs_qa',
            kind: 'docs_answer',
            mode: llmAnswer ? 'rag_llm' : 'rag_local',
            title: primary.title,
            answer: llmAnswer || fallbackAnswer,
            docSectionId: primary.sectionId,
            command: primary.command || (hits.find((h) => h.command) || {}).command || null,
            citations: hits.map((h) => ({
                id: h.id,
                title: h.title,
                sectionId: h.sectionId,
                score: h.score
            }))
        };
    }
};
