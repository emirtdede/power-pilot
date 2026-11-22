/**
 * ai-service.test.mjs - WBS-7.3 / TS-7.3
 * AiService: sahte tamamlayıcı ile eşleme tablosu + davranış kapıları.
 * Gerçek model gerekmez; determinizm parametreleri iddia edilir.
 */
import { describe, it, expect, vi } from 'vitest';
import { AiService, PARSE_SCHEMA, GRAMMAR_SCHEMA } from '../../src/main/services/AiService.js';

function readyBackend() {
    return { getStatus: () => ({ loaded: true, code: 'READY' }) };
}
function coldBackend() {
    return { getStatus: () => ({ loaded: false, code: 'MODEL_MISSING', message: 'AI modeli indirilmedi.' }) };
}
// Girdideki anahtara göre hazır çıktıyı seçen sahte tamamlayıcı.
// DİKKAT: yalnızca kullanıcı bölümü taranır (system prompt örnekleri eşleşmemeli).
function keyedCompleter(table, calls = null) {
    return vi.fn(async (prompt, opts) => {
        if (calls) calls.push({ prompt, opts });
        const userPart = String(prompt).split('Kullanıcı: ')[1] || '';
        for (const [key, out] of Object.entries(table)) {
            if (userPart.includes(key)) return out;
        }
        return '{"action":"shutdown","kind":"duration","missing":["durationMs"],"question":"Süre ne kadar olsun? (örn. 2 saat)"}';
    });
}

describe('AiService eşleme tablosu (TS-7.3)', () => {
    const table = {
        '2 saat sonra kapat': '{"action":"shutdown","kind":"duration","durationMs":7200000}',
        'yarın 23:00 uyut': `{"action":"sleep","kind":"scheduled_time","targetTime":${Date.now() + 3600000}}`,
        'dün kapat': `{"action":"shutdown","kind":"scheduled_time","targetTime":${Date.now() - 1000}}`,
        'cpu boşta kapat': '{"action":"shutdown","kind":"condition","condition":{"type":"cpu_usage","thresholdPercent":10}}',
        'indirme bitince': '{"action":"hibernate","kind":"condition","condition":{"type":"network_speed","thresholdKbps":50}}',
        'bilinmeyen koşul': '{"action":"shutdown","kind":"condition","condition":{"type":"file_event"}}',
        'belirsiz kapat': '{"action":"shutdown","kind":"duration","missing":["durationMs"],"question":"Süre ne kadar olsun? (örn. 2 saat)"}',
        'bozuk json': 'bu json değil {{{',
        'yasak eylem': '{"action":"format","kind":"duration","durationMs":1000}',
        'negatif süre': '{"action":"shutdown","kind":"duration","durationMs":-5}',
        'dev süre': '{"action":"shutdown","kind":"duration","durationMs":9999999999}',
        'tuhaf tür': '{"action":"sleep","kind":"teleport"}',
        'ekstra alan': '{"action":"lock","kind":"duration","durationMs":60000,"note":"hemen"}'
    };

    it('süre cümlesi → duration önerisi', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('2 saat sonra kapat');
        expect(r.ok).toBe(true);
        expect(r.proposal.trigger).toEqual({ type: 'duration', durationMs: 7200000 });
        expect(r.proposal.source).toBeUndefined();
    });

    it('gelecek saat → scheduled_time önerisi', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('yarın 23:00 uyut');
        expect(r.ok).toBe(true);
        expect(r.proposal.trigger.type).toBe('scheduled_time');
    });

    it('geçmiş saat → süre sorulur (deterministik öncelik, uydurma yok)', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('dün kapat');
        expect(r.ok).toBe(true);
        expect(r.needsClarification.missingFields).toContain('durationMs');
    });

    it('buildProposal geçmiş targetTime reddeder (çekirdek dal)', () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = svc.buildProposal({ action: 'shutdown', kind: 'scheduled_time', targetTime: Date.now() - 1000 });
        expect(r.needsClarification.missingFields).toContain('targetTime');
    });

    it('koşul nesnesi → conditionGroup önerisi (çekirdek)', () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = svc.buildProposal(JSON.parse(table['cpu boşta kapat']));
        expect(r.ok).toBe(true);
        expect(r.proposal.conditionGroup.conditions[0].type).toBe('cpu_usage');
    });

    it('desteksiz koşul → condition netleştirmesi (createTask beklenmez)', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('bilinmeyen koşul');
        expect(r.ok).toBe(true);
        expect(r.needsClarification.missingFields).toContain('condition');
        expect(r.proposal).toBeUndefined();
    });

    it('modelin eksik bildirimi sorusuyla geçirilir', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('belirsiz kapat');
        expect(r.needsClarification.question).toMatch(/Süre/);
    });

    it('bozuk JSON → genel netleştirme (çökme yok)', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('bozuk json');
        expect(r.ok).toBe(true);
        expect(r.needsClarification).toBeDefined();
    });

    it('yasak eylem → netleştirme', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('yasak eylem');
        expect(r.needsClarification).toBeDefined();
        expect(r.proposal).toBeUndefined();
    });

    it('negatif/dev süre → durationMs netleştirmesi', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        expect((await svc.parseCommand('negatif süre')).needsClarification.missingFields).toContain('durationMs');
        expect((await svc.parseCommand('dev süre')).needsClarification.missingFields).toContain('durationMs');
    });

    it('bilinmeyen tür → netleştirme', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        expect((await svc.parseCommand('tuhaf tür')).needsClarification).toBeDefined();
    });

    it('ekstra alanlar eşlemeyi bozmaz', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter(table) });
        const r = await svc.parseCommand('ekstra alan');
        expect(r.ok).toBe(true);
        expect(r.proposal.action).toBe('lock');
    });

    it('kod bloğu sarmalı (```json) soyulur', async () => {
        const svc = new AiService({
            backend: readyBackend(),
            completer: vi.fn(async () => '```json\n{"action":"sleep","kind":"duration","durationMs":60000}\n```')
        });
        const r = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(r.ok).toBe(true);
        expect(r.proposal.trigger.durationMs).toBe(60000);
    });
});

describe('AiService davranış kapıları (TS-7.3)', () => {
    it('model yüklü değilse AI_NOT_READY (görev kurulmaz)', async () => {
        const completer = vi.fn();
        const svc = new AiService({ backend: coldBackend(), completer });
        const r = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(r).toMatchObject({ ok: false, code: 'AI_NOT_READY' });
        expect(completer).not.toHaveBeenCalled();
    });

    it('boş girdi reddedilir', async () => {
        const svc = new AiService({ backend: readyBackend(), completer: vi.fn() });
        expect(await svc.parseCommand('   ')).toMatchObject({ ok: false, code: 'EMPTY' });
    });

    it('tamamlayıcı patlarsa AI_ERROR (fırlatma yok)', async () => {
        const svc = new AiService({
            backend: readyBackend(),
            completer: vi.fn(async () => { throw new Error('kaput'); })
        });
        expect(await svc.parseCommand('yedek klasörü sabitlenince kapat')).toMatchObject({ ok: false, code: 'AI_ERROR' });
    });

    it('determinizm parametreleri iddia edilir (temperature 0, max 256, şema)', async () => {
        const calls = [];
        const svc = new AiService({ backend: readyBackend(), completer: keyedCompleter({ x: '{"action":"lock","kind":"duration","durationMs":1000}' }, calls) });
        await svc.parseCommand('x');
        expect(calls).toHaveLength(1);
        expect(calls[0].opts.temperature).toBe(0);
        expect(calls[0].opts.maxTokens).toBe(256);
        expect(calls[0].opts.schema).toEqual(GRAMMAR_SCHEMA);
        expect(calls[0].prompt).toContain('x');
    });

    it('şema 6 eylemi ve 3 türü kilitler', () => {
        expect(PARSE_SCHEMA.properties.action.enum).toHaveLength(6);
        expect(PARSE_SCHEMA.properties.kind.enum).toEqual(['duration', 'scheduled_time', 'condition']);
        expect(PARSE_SCHEMA.required).toEqual(['action', 'kind']);
    });

    it('gramer şeması kaçış kapısı içermez (model taahhüt eder)', () => {
        expect(GRAMMAR_SCHEMA.properties.missing).toBeUndefined();
        expect(GRAMMAR_SCHEMA.properties.question).toBeUndefined();
        expect(GRAMMAR_SCHEMA.properties.condition.properties.type.enum).toContain('network_speed');
        expect(GRAMMAR_SCHEMA.properties.condition.properties.type.enum).toContain('directory_idle');
        expect(GRAMMAR_SCHEMA.properties.condition.properties.dirPath).toEqual({ type: 'string' });
        expect(GRAMMAR_SCHEMA.properties.condition.required).toEqual(['type']);
    });
});

describe('AiService gerçek-yol completer (K1)', () => {
    function sessionBackend(reply, calls = null) {
        const session = {
            completePrompt: vi.fn(async (prompt, opts) => {
                if (calls) calls.push({ prompt, opts });
                return reply;
            }),
            dispose: vi.fn(async () => {})
        };
        return {
            getStatus: () => ({ loaded: true, code: 'READY' }),
            ensureLlama: async () => ({ createGrammarForJsonSchema: async () => ({ kind: 'grammar' }) }),
            createSession: vi.fn(async () => session),
            disposeSession: vi.fn(async () => {}),
            __session: session
        };
    }

    it('oturum completePrompt ile çağrılır, sonra dispose edilir', async () => {
        const calls = [];
        const backend = sessionBackend('{"action":"lock","kind":"duration","durationMs":600000}', calls);
        const svc = new AiService({ backend }); // gerçek defaultCompleter
        const res = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(res).toMatchObject({ ok: true, proposal: { action: 'lock' } });
        expect(res.proposal.trigger).toEqual({ type: 'duration', durationMs: 600000 });
        expect(calls).toHaveLength(1);
        expect(calls[0].opts).toMatchObject({ temperature: 0, maxTokens: 256 });
        expect(calls[0].opts.grammar).toEqual({ kind: 'grammar' });
        expect(calls[0].prompt).toContain('yedek klasörü sabitlenince kapat');
        expect(backend.createSession).toHaveBeenCalledWith(expect.stringContaining('SADECE JSON'));
        expect(backend.disposeSession).toHaveBeenCalledTimes(1);
    });

    it('completePrompt yoksa AI_ERROR ve oturum yine kapatılır', async () => {
        const backend = sessionBackend('x');
        backend.createSession = vi.fn(async () => ({}));
        const svc = new AiService({ backend });
        const res = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(res).toMatchObject({ ok: false, code: 'AI_ERROR' });
        expect(backend.disposeSession).toHaveBeenCalledTimes(1);
    });

    it('createSession yoksa AI_ERROR', async () => {
        const svc = new AiService({ backend: { getStatus: () => ({ loaded: true, code: 'READY' }) } });
        const res = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(res).toMatchObject({ ok: false, code: 'AI_ERROR' });
    });
});

describe('AiService deterministik öncelik (K1b)', () => {
    it('zamanlı cümle LLM çağrılmadan çözülür (model bile gerekmez)', async () => {
        const completer = vi.fn(async () => { throw new Error('çağrılmamalıydı'); });
        const svc = new AiService({
            backend: { getStatus: () => ({ loaded: false, code: 'MODEL_MISSING' }) },
            completer
        });
        const r1 = await svc.parseCommand('10 dakika sonra ekranı kilitle');
        expect(r1).toMatchObject({ ok: true, proposal: { action: 'lock' } });
        expect(r1.proposal.trigger).toEqual({ type: 'duration', durationMs: 600000 });
        const r2 = await svc.parseCommand('2 saat sonra kapat');
        expect(r2).toMatchObject({ ok: true, proposal: { action: 'shutdown' } });
        expect(r2.proposal.trigger).toEqual({ type: 'duration', durationMs: 7200000 });
        expect(completer).not.toHaveBeenCalled();
    });

    it('süresiz cümle netleştirme sorar (LLM yok)', async () => {
        const svc = new AiService({
            backend: { getStatus: () => ({ loaded: false }) },
            completer: vi.fn(async () => { throw new Error('çağrılmamalıydı'); })
        });
        const res = await svc.parseCommand('bilgisayarı kapat');
        expect(res.ok).toBe(true);
        expect(res.needsClarification.missingFields).toEqual(['durationMs']);
    });

    it('koşul cümlesi deterministik öneriye dönüşür (LLM yok)', async () => {
        const completer = vi.fn(async () => { throw new Error('çağrılmamalıydı'); });
        const svc = new AiService({
            backend: { getStatus: () => ({ loaded: true, code: 'READY' }) },
            completer
        });
        const res = await svc.parseCommand('indirme bitince kapat');
        expect(completer).not.toHaveBeenCalled();
        expect(res).toMatchObject({ ok: true, proposal: { action: 'shutdown' } });
        expect(res.proposal.conditionGroup.conditions[0]).toEqual({ type: 'network_speed', thresholdKbps: 50 });
    });

    it('çıkarılamayan koşul LLM yoluna düşer', async () => {
        const completer = vi.fn(async () => '{"action":"shutdown","kind":"condition","condition":{"type":"network_speed","thresholdKbps":50}}');
        const svc = new AiService({
            backend: { getStatus: () => ({ loaded: true, code: 'READY' }) },
            completer
        });
        const res = await svc.parseCommand('yedek klasörü sabitlenince kapat');
        expect(completer).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ ok: true, proposal: { action: 'shutdown' } });
        expect(res.proposal.conditionGroup.conditions[0].type).toBe('network_speed');
    });
});
