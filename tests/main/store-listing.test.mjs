/**
 * store-listing.test.mjs - C3 mağaza metni sözleşmesi
 *
 * Partner Center'ın sessiz ret nedenleri (metin çok uzun / dil eksik / alan boş)
 * CI'da yakalanır. Ayrıca metinlerin ürünün gerçek davranışıyla çelişmediğini
 * doğrular: "telemetri yok" beyanı, engellenme raporu ve yerel AI.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LISTING = JSON.parse(fs.readFileSync(path.join(root, 'docs/store/store-listing.json'), 'utf8'));

const LANGS = ['tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl', 'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'];

// Partner Center alan sınırları.
const LIMITS = {
    appName: 256,
    shortDescription: 270,
    description: 10000
};
const MAX_FEATURES = 10;
const MAX_FEATURE_LEN = 200;

describe('C3 - mağaza metni (17 dil)', () => {
    it('17 dilin tamamı tanımlı, fazlası yok', () => {
        expect(Object.keys(LISTING.languages).sort()).toEqual([...LANGS].sort());
    });

    it('her dilde zorunlu alanlar dolu ve boş değil', () => {
        for (const lang of LANGS) {
            const entry = LISTING.languages[lang];
            for (const field of ['storeLanguage', 'appName', 'shortDescription', 'description']) {
                expect(typeof entry[field], `${lang}.${field}`).toBe('string');
                expect(entry[field].trim().length, `${lang}.${field} boş`).toBeGreaterThan(0);
            }
            expect(Array.isArray(entry.features), `${lang}.features`).toBe(true);
            expect(entry.features.length).toBeGreaterThan(0);
        }
    });

    it('Partner Center uzunluk sınırları aşılmıyor', () => {
        for (const lang of LANGS) {
            const entry = LISTING.languages[lang];
            for (const [field, max] of Object.entries(LIMITS)) {
                expect(entry[field].length, `${lang}.${field} ${entry[field].length} > ${max}`).toBeLessThanOrEqual(max);
            }
            expect(entry.features.length, `${lang}.features adet`).toBeLessThanOrEqual(MAX_FEATURES);
            for (const feature of entry.features) {
                expect(typeof feature).toBe('string');
                expect(feature.trim().length).toBeGreaterThan(0);
                expect(feature.length, `${lang} özellik: ${feature.slice(0, 40)}`).toBeLessThanOrEqual(MAX_FEATURE_LEN);
            }
        }
    });

    it('uygulama adı tüm dillerde aynı (marka tutarlılığı)', () => {
        for (const lang of LANGS) {
            expect(LISTING.languages[lang].appName).toBe('Power Pilot');
        }
    });

    it('yer tutucu/ham anahtar sızıntısı yok', () => {
        // Yalnızca metin alanları denetlenir; JSON iskeletindeki süslü
        // parantezler yanlış pozitif üretmemeli.
        const strings = [];
        for (const lang of LANGS) {
            const entry = LISTING.languages[lang];
            strings.push(entry.storeLanguage, entry.appName, entry.shortDescription, entry.description, ...entry.features);
        }
        for (const value of strings) {
            // Türkçe/Portekizce gibi dillerde "todos" (hepsi) kelimesi geçebilir;
            // bu yüzden işaretçiler büyük/küçük harfe duyarlı aranır.
            expect(value).not.toMatch(/\{\{|\}\}|data-i18n/i);
            expect(value).not.toMatch(/\bTODO\b|\bFIXME\b|\blorem ipsum\b/);
        }
    });

    it('gizlilik beyanı gerçek ürünle tutarlı: telemetri yok + veri silme', () => {
        // Bu iki ifade hem politika hem ürün gerçeği; metinden düşerse
        // mağaza beyanı yanlış olur.
        for (const lang of ['tr', 'en']) {
            const body = LISTING.languages[lang].description.toLowerCase();
            expect(body).toMatch(/telemetri|telemetry/);
            expect(body).toMatch(/sil|delete|erase/);
        }
    });

    it('A6 engellenme raporu ve yerel AI metinde anlatılıyor', () => {
        for (const lang of ['tr', 'en']) {
            const body = LISTING.languages[lang].description.toLowerCase();
            expect(body).toMatch(/engellen|blocked/);
            expect(body).toMatch(/ai|yapay zek/i);
        }
    });

    it('Store kapsamı doğru anlatılıyor: kurumsal özellikler ayrı sürümde', () => {
        for (const lang of ['tr', 'en']) {
            const body = LISTING.languages[lang].description.toLowerCase();
            expect(body).toMatch(/enterprise|kurumsal/);
        }
    });

    it('metinler birbirinin kopyası değil (gerçekten çevrilmiş)', () => {
        const descs = LANGS.map((l) => LISTING.languages[l].description);
        // tr/en dışındaki diller İngilizce metnin aynısı olmamalı.
        const en = LISTING.languages.en.description;
        const sameAsEnglish = LANGS.filter((l) => l !== 'en' && LISTING.languages[l].description === en);
        expect(sameAsEnglish).toEqual([]);
        expect(new Set(descs).size).toBe(LANGS.length);
    });

    it('Partner Center zorunlu gizlilik/support URL’leri tanımlı', () => {
        // Microsoft Store, uygulama veri toplamasa bile gizlilik politikası
        // URL'si ister; eksikse başvuru reddedilir.
        const meta = LISTING.metadata || {};
        for (const field of ['privacyPolicyUrl', 'supportUrl', 'supportEmail', 'websiteUrl']) {
            expect(typeof meta[field], `metadata.${field}`).toBe('string');
            expect(meta[field].trim().length, `metadata.${field} boş`).toBeGreaterThan(0);
        }
        expect(meta.privacyPolicyUrl).toMatch(/^https:\/\//);
        expect(meta.supportUrl).toMatch(/^https:\/\//);
        expect(meta.supportEmail).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    });

    it('URL’ler allowlist’teki gerçek sayfalara işaret eder (404 dead-link yok)', () => {
        // Regresyon: mağaza başvurusunda tıklanan her URL 200 + gerçek içerik
        // döndürmeli. `/power-pilot/privacy` ve `/power-pilot/support` yolları
        // vellium.dev SPA'sında yayınlanmadığı için 404 sayfası render ediyordu
        // (başlık: "Bu sayfa burada değil."). Bu test o desenin geri gelmesini
        // engeller ve yalnızca canlı doğrulanmış yolları kabul eder.
        const meta = LISTING.metadata || {};
        const allowlisted = ['privacyPolicyUrl', 'supportUrl', 'eulaUrl', 'contactUrl', 'websiteUrl'];
        const verifiedPaths = [
            '/en/legal/privacy',
            '/en/legal/support',
            '/en/legal/products/power-pilot',
            '/en/contact',
            '/'
        ];
        for (const field of allowlisted) {
            expect(typeof meta[field], `metadata.${field}`).toBe('string');
            const url = new URL(meta[field]);
            expect(url.protocol).toBe('https:');
            expect(url.hostname).toBe('vellium.dev');
            // Ölü SPA yolu /power-pilot/* tekrar eklenmesin.
            expect(url.pathname, `metadata.${field} ölü yol`).not.toMatch(/^\/power-pilot\//);
            expect(verifiedPaths).toContain(url.pathname === '/' ? '/' : url.pathname);
        }
        // Uygulama-içi raporlama kanalı ana sayfa değil, iletişim sayfası olmalı.
        expect(meta.contactUrl).toBe('https://vellium.dev/en/contact');
    });

    it('gizlilik politikası belgesi gerçekten var ve iki dilli', () => {
        const docRel = (LISTING.metadata && LISTING.metadata.privacyPolicyDoc) || 'docs/store/PRIVACY_POLICY.md';
        const docPath = path.join(root, docRel);
        expect(fs.existsSync(docPath), docRel).toBe(true);
        const body = fs.readFileSync(docPath, 'utf8');
        // Hem İngilizce hem Türkçe bölüm olmalı (mağaza iki dilde listeleniyor).
        expect(body).toMatch(/## English/);
        expect(body).toMatch(/## Türkçe/);
        // Ürünün gerçek davranışıyla çelişmesin: telemetri yok + veri silme +
        // mikrofon beyanı.
        expect(body.toLowerCase()).toMatch(/telemetry|telemetri/);
        expect(body.toLowerCase()).toMatch(/delete my data|verilerimi sil/);
        expect(body.toLowerCase()).toMatch(/microphone|mikrofon/);
    });

    it('yayınlanabilir gizlilik sayfası JS olmadan okunur (Store denetimi)', () => {
        // vellium.dev bir SPA: /power-pilot/privacy HTTP 200 dönse de HTML
        // yalnızca "Vellium" kabuğu; JS çalışmadan politika görünmüyor. Mağaza
        // incelemesinde metnin görünmesi gerektiği için statik sayfa şart.
        const htmlPath = path.join(root, 'docs/store/privacy.html');
        expect(fs.existsSync(htmlPath), 'docs/store/privacy.html').toBe(true);
        const html = fs.readFileSync(htmlPath, 'utf8');
        // JS olmadan okunmalı: hiç <script> olmamalı.
        expect(html).not.toMatch(/<script/i);
        // İçerik gerçekten gömülü olmalı (boş kabuk değil).
        expect(html).toMatch(/no telemetry/i);
        expect(html).toMatch(/Delete my\s+data/i);
        expect(html).toMatch(/Microphone/i);
        expect(html).toMatch(/%LOCALAPPDATA%/);
        // İki dil tek dosyada.
        expect(html).toMatch(/id="english"/);
        expect(html).toMatch(/id="turkce"/);
        // Anlamlı metin uzunluğu (kabuk sayfalar ~2 KB; politika >8 KB).
        expect(Buffer.byteLength(html, 'utf8')).toBeGreaterThan(8000);
    });
});
