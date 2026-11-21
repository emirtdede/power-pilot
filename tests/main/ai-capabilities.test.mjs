/**
 * ai-capabilities.test.mjs — WP-8: templateAgent, connectionAgent, DocsKnowledgeBase ve docsQaAgent.
 * Tamamen yerel ve deterministik (LLM çağrısı gerektirmez).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import templateAgent from '../../src/main/services/agents/templateAgent.js';
import connectionAgent from '../../src/main/services/agents/connectionAgent.js';
import docsQaAgent from '../../src/main/services/agents/docsQaAgent.js';
import { searchDocs, listAllDocChunks } from '../../src/main/services/DocsKnowledgeBase.js';
import TemplateService from '../../src/main/services/TemplateService.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('templateAgent (WP-8)', () => {
    it('TR doğal dilinden geçerli koşullu şablon üretir', async () => {
        const res = await templateAgent.execute({
            text: 'Render bitince CPU %10 altına düşünce bilgisayarı kapatan şablon oluştur',
            language: 'tr'
        });
        expect(res.ok).toBe(true);
        expect(res.kind).toBe('template_proposal');
        expect(res.templateProposal.action).toBe('shutdown');
        expect(res.templateProposal.defaultCondition.type).toBe('cpu_usage');
        expect(TemplateService.isValidTemplate({ id: 'user_tpl_test', ...res.templateProposal })).toBe(true);
    });

    it('EN zamanlı şablon ve süreli şablon üretir', async () => {
        const sched = await templateAgent.execute({
            text: 'Create a template to sleep every night at 23:30',
            language: 'en'
        });
        expect(sched.ok).toBe(true);
        expect(sched.templateProposal.schedule).toEqual({ timeOfDay: '23:30', recurrence: 'daily' });

        const dur = await templateAgent.execute({
            text: 'Create a template to lock after 30 minutes',
            language: 'en'
        });
        expect(dur.ok).toBe(true);
        expect(dur.templateProposal.trigger).toEqual({ type: 'duration', durationMs: 30 * 60000 });
    });

    it('olumsuz niyeti reddeder ve eksik bilgide açıklama ister', async () => {
        const neg = await templateAgent.execute({ text: 'bilgisayarı kapatma şablonu', language: 'tr' });
        expect(neg.ok).toBe(false);
        expect(neg.code).toBe('NEGATED_INTENT');

        const clarify = await templateAgent.execute({ text: 'yeni bir şablon oluştur', language: 'tr' });
        expect(clarify.ok).toBe(true);
        expect(clarify.needsClarification).toBeDefined();
    });
});

describe('connectionAgent (WP-8)', () => {
    it('REST API, MCP, HTTPS Webhook, WoL ve UPS önerileri üretir', async () => {
        const api = await connectionAgent.execute({
            text: 'Yerel REST API 19000 portunu aç',
            language: 'tr',
            currentSettings: {}
        });
        expect(api.ok).toBe(true);
        expect(api.connectionProposal.settingsPatch).toMatchObject({ localApiEnabled: true, localApiPort: 19000 });
        expect(api.connectionProposal.requiresPin).toBe(true);

        const mcp = await connectionAgent.execute({
            text: 'Claude Desktop MCP sunucusu yapılandır',
            language: 'tr',
            currentSettings: { localApiEnabled: true, localApiPort: 18456 }
        });
        expect(mcp.ok).toBe(true);
        expect(mcp.connectionProposal.target).toBe('mcp');
        expect(mcp.connectionProposal.snippet).toContain('power-pilot');

        const wh = await connectionAgent.execute({
            text: 'https://n8n.example.com/webhook/pp için webhook ekle',
            language: 'tr',
            currentSettings: {}
        });
        expect(wh.ok).toBe(true);
        expect(wh.connectionProposal.target).toBe('webhook');
        expect(wh.connectionProposal.webhook.url).toBe('https://n8n.example.com/webhook/pp');

        const wol = await connectionAgent.execute({
            text: 'AA:BB:CC:DD:EE:FF cihazını Wake-on-LAN olarak kaydet',
            language: 'tr',
            currentSettings: {}
        });
        expect(wol.ok).toBe(true);
        expect(wol.connectionProposal.target).toBe('wol_device');
        expect(wol.connectionProposal.wolDevice.macAddress).toBe('AA:BB:CC:DD:EE:FF');

        const ups = await connectionAgent.execute({
            text: 'UPS NUT sunucusu 192.168.1.50 etkinleştir',
            language: 'tr',
            currentSettings: {}
        });
        expect(ups.ok).toBe(true);
        expect(ups.connectionProposal.settingsPatch).toMatchObject({ upsEnabled: true, upsHost: '192.168.1.50' });
    });

    it('güvensiz http:// webhook adresini reddedip HTTPS ister', async () => {
        const httpWh = await connectionAgent.execute({
            text: 'Add webhook ' + 'http:' + '//insecure.local/hook',
            language: 'en',
            currentSettings: {}
        });
        expect(httpWh.ok).toBe(true);
        expect(httpWh.needsClarification).toBeDefined();
        expect(httpWh.needsClarification.question).toContain('HTTPS');
    });
});

describe('DocsKnowledgeBase & docsQaAgent (WP-8 Yerel RAG)', () => {
    it('en az 15 doküman parçası barındırır ve TR/EN sorgularda doğru bölümü bulur', () => {
        expect(listAllDocChunks().length).toBeGreaterThanOrEqual(15);
        const mcpHits = searchDocs('MCP sunucusu Claude Desktop nasıl bağlanır', { lang: 'tr' });
        expect(mcpHits.length).toBeGreaterThan(0);
        expect(mcpHits[0].sectionId).toBe('docs-sec-mcp');

        const pinHits = searchDocs('How is the cancel PIN encrypted?', { lang: 'en' });
        expect(pinHits.length).toBeGreaterThan(0);
        expect(pinHits[0].sectionId).toBe('docs-sec-power-safety');
    });

    it('docsQaAgent LLM olmadan yerel kaynaklı yanıt ve derin bağlantı döndürür', async () => {
        const res = await docsQaAgent.execute({
            text: 'Destek paketi ZIP çökme raporu nasıl alınır?',
            language: 'tr',
            aiBackend: null
        });
        expect(res.ok).toBe(true);
        expect(res.kind).toBe('docs_answer');
        expect(res.mode).toBe('rag_local');
        expect(res.citations.length).toBeGreaterThan(0);
        expect(res.docSectionId).toBeTruthy();
    });
});

/**
 * Bilgi tabanı GERÇEĞİ anlatmalı.
 *
 * Denetim kusuru (beşinci tur): uygulama içi dokümanlar (Docs ekranı + AI RAG
 * korpusu) var olmayan yetenekleri anlatıyordu:
 *   - MCP: schedule_smart_finish, cancel_task, snooze_task, list_templates,
 *     get_stats adlı 5 araç "sunuluyor" deniyordu; sunucuda yoklar. Gerçekte
 *     olan 5 araç da (cancel_timer, power_action, audit_verify, inventory,
 *     pending_orders) hiç anılmıyordu.
 *   - REST: tasks/smart-finish, DELETE tasks/:id, tasks/:id/snooze, history,
 *     stats uçları anılıyordu; hiçbiri yok. Gerçek uçların çoğu yoktu.
 *   - CLI: src/cli/index.js, `schedule --in/--at`, snooze, pause/resume,
 *     history, stats anılıyordu; dosya adı ve komutların hiçbiri yok.
 *
 * Bu, "placebo" kusurun doküman tarafıdır: kullanıcı belgelenmiş bir yeteneği
 * arar, bulamaz. Kullanıcı en çok bu metinlere güvendiği için kapı şart.
 */
describe('Doküman gerçeği — belgelenen her yetenek kodda var', () => {
    const docs = readDoc('src/main/services/DocsKnowledgeBase.js');
    const mcp = readDoc('src/mcp/server.js');
    const api = readDoc('src/main/services/LocalApiService.js');
    const cli = readDoc('src/cli/commands.js');

    it('dokümanda anılan her MCP aracı sunucuda kayıtlı', () => {
        const section = docs.slice(docs.indexOf("id: 'mcp-server-guide'"), docs.indexOf("id: 'rest-api-endpoints'"));
        const cited = new Set([...section.matchAll(/powerpilot_[a-z_]+/g)].map((m) => m[0]));
        const real = new Set([...mcp.matchAll(/case '(powerpilot_[a-z_]+)'/g)].map((m) => m[1]));

        const ghosts = [...cited].filter((t) => !real.has(t));
        expect(ghosts, `dokümanda var, sunucuda yok: ${ghosts.join(', ')}`).toEqual([]);
    });

    it('sunucudaki her MCP aracı dokümanda anılır (belgesiz yetenek yok)', () => {
        const section = docs.slice(docs.indexOf("id: 'mcp-server-guide'"), docs.indexOf("id: 'rest-api-endpoints'"));
        const cited = new Set([...section.matchAll(/powerpilot_[a-z_]+/g)].map((m) => m[0]));
        const real = new Set([...mcp.matchAll(/case '(powerpilot_[a-z_]+)'/g)].map((m) => m[1]));

        const undocumented = [...real].filter((t) => !cited.has(t));
        expect(undocumented, `sunucuda var, dokümanda yok: ${undocumented.join(', ')}`).toEqual([]);
    });

    it('dokümanda anılan her REST yolu gerçekten yönlendiriliyor', () => {
        const real = new Set();
        for (const m of api.matchAll(/path === '(\/api\/v1\/[a-z/-]+)'/g)) real.add(m[1]);
        for (const m of api.matchAll(/'(\/api\/v1\/power\/[a-z]+)'\s*:/g)) real.add(m[1]);
        real.add('/api/v1/tasks/:id/cancel');

        const normalize = (p) => p.replace(/:[a-zA-Z]+/g, ':id').replace(/\/$/, '');
        const known = new Set([...real].map(normalize));

        const cited = new Set([...docs.matchAll(/\/api\/v1\/[a-z\-/:]+/g)].map((m) => m[0]));
        const ghosts = [...cited].filter((p) => !known.has(normalize(p)));
        expect(ghosts, `dokümanda var, API'de yok: ${ghosts.join(', ')}`).toEqual([]);
    });

    it('dokümanda anılan CLI dosyası ve komutları gerçek', () => {
        // src/cli/index.js diye bir dosya hiç olmadı.
        expect(fs.existsSync(path.join(root, 'src/cli/index.js')), 'docs src/cli/index.js diyor').toBe(false);
        for (const m of docs.matchAll(/(src\/cli\/[a-z]+\.js)/g)) {
            expect(fs.existsSync(path.join(root, m[1])), `dokümanda anılan dosya yok: ${m[1]}`).toBe(true);
        }

        // Dokümanda geçen `node src/cli/powerpilot.js <cmd>` komutları katalogda olmalı.
        const cmds = new Set([...cli.matchAll(/^\s{4}'?([a-z][a-z-]+)'?\s*:\s*\{/gm)].map((m) => m[1]));
        const power = new Set([...(cli.match(/const POWER_ACTIONS = \[([^\]]+)\]/) || [])[1]?.matchAll(/'([a-z]+)'/g) || []].map((x) => x[1]));
        const known = new Set([...cmds, ...power]);

        const citedCmds = new Set([...docs.matchAll(/node src\/cli\/powerpilot\.js ([a-z][a-z-]+)/g)].map((m) => m[1]));
        const ghosts = [...citedCmds].filter((c) => !known.has(c));
        expect(ghosts, `dokümanda var, CLI'da yok: ${ghosts.join(', ')}`).toEqual([]);
    });

    it('webhook olay listesi hem dokümanda hem doğrulayıcıda aynı', () => {
        // Denetim kusuru (altıncı tur): `task_cancel_too_late` olayı motorda
        // gerçekten üretiliyor ve doğrulayıcıda kabul ediliyordu, ama uygulama
        // içi doküman hâlâ altı olay sayıyordu. Kullanıcı yedinci olayı
        // belgelenmiş sanıp arar ya da belgede olmadığı için hiç kullanmaz.
        const validate = readDoc('src/main/ipc/validate.js');
        const eventBlock = (validate.match(/const WEBHOOK_EVENTS = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
        const real = new Set([...eventBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
        expect(real.size, 'doğrulayıcıda webhook olayı bulunamadı').toBeGreaterThan(0);

        const section = docs.slice(docs.indexOf("id: 'webhooks-n8n'"), docs.indexOf("id: 'wol-ups-enterprise'"));
        const cited = new Set([...section.matchAll(/\btask_[a-z_]+|[a-z_]+_started\b/g)].map((m) => m[0]));

        const missing = [...real].filter((e) => !cited.has(e));
        expect(missing, `doğrulayıcıda var, dokümanda yok: ${missing.join(', ')}`).toEqual([]);

        const ghosts = [...cited].filter((e) => !real.has(e));
        expect(ghosts, `dokümanda var, doğrulayıcıda yok: ${ghosts.join(', ')}`).toEqual([]);
    });
});

function readDoc(p) {
    return fs.readFileSync(path.join(root, p), 'utf8');
}
