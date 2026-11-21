/**
 * agent-template-contract.test.mjs - ajan kaydı ve şablon bütünlüğü kapısı.
 *
 * İki sözleşme, her ikisi de "tanımlı ama ulaşılamaz" kusur sınıfına karşı:
 *
 * 1. AJAN KAYDI. Üç ayrı yer aynı ajan kümesini anlatır:
 *      AGENT_MANIFESTS (tanıtım)  ->  AGENTS (uygulama)  ->  ROUTE_RULES (yönlendirme)
 *    Bunlardan biri diğerinden koparsa:
 *      - manifestte olup AGENTS'te olmayan ajan: çağrılınca `undefined.execute`
 *        ile çöker,
 *      - AGENTS'te olup manifestte olmayan ajan: hiçbir yerde duyurulmaz, ölü kod,
 *      - yönlendirme kuralı olmayan ajan: elle `intentHint` verilmedikçe asla
 *        seçilmez (ulaşılamaz yetenek).
 *    Denetimde üçü de birebir tutarlıydı; bu test o durumu kalıcı kılar.
 *
 * 2. ŞABLON BÜTÜNLÜĞÜ. Her yerleşik şablon `isValidTemplate`'ten geçmeli,
 *    kategorisi `TEMPLATE_CATEGORIES` içinde, koşul tipleri
 *    `SUPPORTED_TEMPLATE_CONDITIONS` içinde olmalı. Aksi halde kullanıcı
 *    şablonu seçer, oluşturma reddedilir ya da motor koşulu tanımaz; ikisi de
 *    kullanıcıya "çalışmayan düğme" olarak yansır.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const { AGENTS, AGENT_MANIFESTS } = require('../../src/main/services/AgentOrchestrator.js');
const TemplateService = require('../../src/main/services/TemplateService.js');

describe('ajan kaydı: manifest, uygulama ve yönlendirme aynı kümeyi anlatır', () => {
    const manifestIds = AGENT_MANIFESTS.map((m) => m.id).sort();
    const agentIds = Object.keys(AGENTS).sort();

    it('her manifestin bir uygulaması var', () => {
        const orphans = manifestIds.filter((id) => !(id in AGENTS));
        expect(orphans, `manifestte var, AGENTS'te yok: ${orphans.join(', ')}`).toEqual([]);
    });

    it('her uygulamanın bir manifesti var', () => {
        const ghosts = agentIds.filter((id) => !manifestIds.includes(id));
        expect(ghosts, `AGENTS'te var, manifestte yok: ${ghosts.join(', ')}`).toEqual([]);
    });

    it('her ajanın çağrılabilir execute fonksiyonu var', () => {
        const broken = agentIds.filter((id) => typeof AGENTS[id]?.execute !== 'function');
        expect(broken, `execute yok: ${broken.join(', ')}`).toEqual([]);
    });

    it('manifest kimlikleri benzersiz', () => {
        expect(new Set(manifestIds).size, 'yinelenen manifest kimliği').toBe(manifestIds.length);
    });

    it('komut dışındaki her ajanın yönlendirme kuralı var', () => {
        // `command` bilinçli olarak kural tanımlamaz: hiçbir kurala uymayan
        // girdinin güvenli varsayılanıdır. Diğer her ajanın en az bir kuralı
        // olmalı, yoksa kullanıcı o yeteneğe hiç ulaşamaz.
        const src = read('src/main/services/AgentOrchestrator.js');
        const routeBlock = (src.match(/const ROUTE_RULES = \[([\s\S]*?)\n\];/) || [])[1] || '';
        const routed = new Set([...routeBlock.matchAll(/agentId:\s*'([a-z_]+)'/g)].map((m) => m[1]));
        expect(routed.size, 'yönlendirme kuralı bulunamadı').toBeGreaterThan(0);

        const unreachable = agentIds.filter((id) => id !== 'command' && !routed.has(id));
        expect(unreachable, `kuralı yok (ulaşılamaz): ${unreachable.join(', ')}`).toEqual([]);
    });

    it('her yönlendirme kuralı gerçek bir ajana işaret eder', () => {
        const src = read('src/main/services/AgentOrchestrator.js');
        const routeBlock = (src.match(/const ROUTE_RULES = \[([\s\S]*?)\n\];/) || [])[1] || '';
        const routed = [...new Set([...routeBlock.matchAll(/agentId:\s*'([a-z_]+)'/g)].map((m) => m[1]))];
        const ghosts = routed.filter((id) => !(id in AGENTS));
        expect(ghosts, `kural var, ajan yok: ${ghosts.join(', ')}`).toEqual([]);
    });
});

describe('şablon bütünlüğü: her yerleşik şablon kurulabilir ve geçerli', () => {
    const service = new TemplateService(null);
    const categories = new Set(TemplateService.TEMPLATE_CATEGORIES);
    const conditions = new Set(TemplateService.SUPPORTED_TEMPLATE_CONDITIONS);

    it('yerleşik şablon listesi boş değil', () => {
        expect(service.templates.length).toBeGreaterThan(10);
    });

    it('her şablon isValidTemplate doğrulamasından geçer', () => {
        const invalid = service.templates.filter((t) => !TemplateService.isValidTemplate(t)).map((t) => t.id);
        expect(invalid, `geçersiz şablon: ${invalid.join(', ')}`).toEqual([]);
    });

    it('her şablonun kategorisi tanımlı kategorilerden biri', () => {
        const unknown = service.templates.filter((t) => !categories.has(t.category)).map((t) => `${t.id}:${t.category}`);
        expect(unknown, `bilinmeyen kategori: ${unknown.join(', ')}`).toEqual([]);
    });

    it('her şablonun koşul tipleri motor tarafından destekleniyor', () => {
        const collect = (t) => {
            const out = [];
            if (t.defaultCondition?.type) out.push(t.defaultCondition.type);
            for (const c of t.defaultConditionGroup?.conditions || []) if (c?.type) out.push(c.type);
            return out;
        };
        const unsupported = [];
        for (const t of service.templates) {
            for (const type of collect(t)) {
                if (!conditions.has(type)) unsupported.push(`${t.id}:${type}`);
            }
        }
        expect(unsupported, `desteklenmeyen koşul: ${unsupported.join(', ')}`).toEqual([]);
    });

    it('şablon kimlikleri benzersiz', () => {
        const ids = service.templates.map((t) => t.id);
        expect(new Set(ids).size, 'yinelenen şablon kimliği').toBe(ids.length);
    });

    it('her şablonun adı, açıklaması ve eylemi var', () => {
        const incomplete = service.templates
            .filter((t) => !t.name || !t.description || !t.action)
            .map((t) => t.id);
        expect(incomplete, `eksik alan: ${incomplete.join(', ')}`).toEqual([]);
    });
});
