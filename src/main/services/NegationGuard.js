/**
 * NegationGuard.js — WP-06.T1 (K-03)
 * Türkçe olumsuzluk koruması. "Kapatma", "kapatmayın", "kapanmasın" gibi
 * cümlelerde yıkıcı güç eylemi ÖNERİLMEZ ve ÇALIŞTIRILMAZ.
 *
 * İlke: fail-closed. Olumsuzluk şüphesi varsa eylem reddedilir ve kullanıcıdan
 * netleştirme istenir. Sözlük + kelime sınırı + AI çıktısı için aynı kapı.
 *
 * Kapsam bilinçli olarak dar tutulur: yalnızca güç eylemi fiilleri denetlenir.
 * "İndirmeyi kapatma" gibi nesne olumsuzluğu da güvenli tarafa düşer.
 */

const DESTRUCTIVE_ACTIONS = new Set(['shutdown', 'restart', 'sleep', 'hibernate', 'signout', 'lock']);

// Eylem fiili kökleri. Sıra önemli değil; en erken eşleşme kullanılır.
const ACTION_STEMS = [
    'kapat', 'kapan', 'uyut', 'uyu', 'başlat', 'baslat', 'kilitle', 'kilitlen',
    'çık', 'cik', 'durdur', 'sonlandır', 'sonlandir'
];

// P1-7: İngilizce fiil kökleri. Önceden guard YALNIZCA Türkçe biliyordu;
// "don't shut down in 10 minutes" cümlesi olumlu sanılıp yıkıcı eyleme
// dönüşebiliyordu. Artık iki dil birlikte denetlenir.
const ACTION_STEMS_EN = [
    'shut down', 'shutdown', 'shutting down', 'power off', 'poweroff',
    'restart', 'reboot', 'sleep', 'suspend', 'hibernate', 'sign out', 'signout',
    'log off', 'logoff', 'lock', 'turn off', 'close down'
];

// İngilizce olumsuzluk belirteçleri (fiilden önce veya sonra yakın pencerede).
const NEGATION_CUES_EN = [
    /\bdon'?t\b/, /\bdo\s+not\b/, /\bdoesn'?t\b/, /\bdoes\s+not\b/,
    /\bnever\b/, /\bnot\b/, /\bno\b/, /\bavoid\b/, /\bwithout\b/,
    /\bcancel\b/, /\bstop\b/, /\bprevent\b/, /\bhold\s+off\b/
];

// -ma/-me olumsuzluk eki. "kapatmak" (olumlu mastar) DIŞLANIR: -ma'dan sonra
// k geliyorsa olumlu mastardır. kapatma, kapatmayın, kapatmam, kapatmayacağım,
// kapanmasın, kapanma, uyutmayın, kilitlemeyin...
const NEGATIVE_INFLECTION = /^(?:ma|me)(?![kc])/;

// Geniş zaman/simdiki zaman olumsuzu: "kapatmıyor", "uyumuyor", "başlatmıyor".
const PRESENT_NEGATIVE = /^(?:m|n)[ıiuü]yor/;

// Geniş zaman olumsuzu: "kapatmaz", "kapanmaz".
const AORIST_NEGATIVE = /^m[ae]z/;

// Gelecek zaman olumsuzu: "kapatmayacağım", "kapanmayacak" (-ma ile başlar,
// NEGATIVE_INFLECTION yakalar; burada yalnızca yazım varyantı için tutulur).
const FUTURE_NEGATIVE = /^(?:ma|me)[yY][ae]/;

// Genel olumsuzluk belirteçleri (eylemden bağımsız, yakınlık penceresinde).
const NEGATION_CUES = [
    /\bdeğil\b/, /\byok\b/, /\bistemiyorum\b/, /\bistemem\b/, /\bgerek\s*yok\b/,
    /\bsakın\b/, /\basla\b/, /\bhiçbir\s*zaman\b/, /\bhicbir\s*zaman\b/,
    /\bvazgeç/, /\bvazgec/, /\biptal\b/
];

function normalize(text) {
    return String(text || '').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
}

function findStem(text) {
    let best = null;
    for (const stem of ACTION_STEMS) {
        const idx = text.indexOf(stem);
        if (idx === -1) continue;
        // Aynı konumda daha uzun kök (uyu < uyut) tercih edilir.
        if (best === null || idx < best.index || (idx === best.index && stem.length > best.stem.length)) {
            best = { stem, index: idx, lang: 'tr' };
        }
    }
    return best;
}

function findStemEn(text) {
    let best = null;
    for (const stem of ACTION_STEMS_EN) {
        const idx = text.indexOf(stem);
        if (idx === -1) continue;
        if (best === null || idx < best.index || (idx === best.index && stem.length > best.stem.length)) {
            best = { stem, index: idx, lang: 'en' };
        }
    }
    return best;
}

/**
 * Metinde güç eylemi fiiline bağlı olumsuzluk var mı?
 * @returns {{negated: boolean, reason: string, stem?: string, snippet?: string}}
 */
function inspect(text) {
    const t = normalize(text);
    if (!t) return { negated: false, reason: '' };

    // P1-7: iki dil birlikte denetlenir. En erken eşleşen fiil seçilir;
    // hiçbiri yoksa cümle güç eylemi önermiyor demektir.
    const tr = findStem(t);
    const en = findStemEn(t);
    let found = tr;
    if (en && (!tr || en.index < tr.index)) found = en;
    if (!found) {
        return { negated: false, reason: '' };
    }

    const snippet = t.slice(found.index, Math.min(t.length, found.index + 40));

    if (found.lang === 'tr') {
        // Fiilden sonraki 24 karakter (çekim + kısa nesne) incelenir.
        const tail = t.slice(found.index + found.stem.length, found.index + found.stem.length + 24);
        if (NEGATIVE_INFLECTION.test(tail) || PRESENT_NEGATIVE.test(tail) ||
            AORIST_NEGATIVE.test(tail) || FUTURE_NEGATIVE.test(tail)) {
            return { negated: true, reason: 'NEGATED_ACTION', stem: found.stem, snippet };
        }
    }

    // "Sakın kapat", "kapatmak istemiyorum", "don't shut down" gibi yapılar.
    const windowStart = Math.max(0, found.index - 32);
    const windowEnd = Math.min(t.length, found.index + found.stem.length + 40);
    const around = t.slice(windowStart, windowEnd);

    // Türkçe genel olumsuzluk belirteçleri her iki fiil için de geçerli olabilir;
    // İngilizce belirteçler ise yalnızca İngilizce fiille anlamlıdır.
    for (const cue of NEGATION_CUES) {
        if (cue.test(around)) {
            return { negated: true, reason: 'NEGATION_CUE', stem: found.stem, snippet };
        }
    }
    if (found.lang === 'en') {
        for (const cue of NEGATION_CUES_EN) {
            if (cue.test(around)) {
                return { negated: true, reason: 'NEGATION_CUE_EN', stem: found.stem, snippet };
            }
        }
    }

    return { negated: false, reason: '', stem: found.stem };
}

function isNegated(text) {
    return inspect(text).negated;
}

/**
 * Parser / AI çıktısı için kapı.
 * @param {string} text kullanıcı cümlesi
 * @param {object|null} proposal {action,...}
 * @returns {{ok: boolean, code?: string, error?: string}}
 */
function guardProposal(text, proposal) {
    const verdict = inspect(text);
    if (!verdict.negated) return { ok: true };
    if (!proposal || !proposal.action) return { ok: true };
    if (!DESTRUCTIVE_ACTIONS.has(proposal.action)) return { ok: true };
    return {
        ok: false,
        code: 'NEGATED_INTENT',
        error: 'Cümlede olumsuzluk var; yıkıcı eylem önerilmedi. Lütfen netleştirin.'
    };
}

module.exports = {
    NegationGuard: { inspect, isNegated, guardProposal, DESTRUCTIVE_ACTIONS, ACTION_STEMS },
    inspect,
    isNegated,
    guardProposal,
    DESTRUCTIVE_ACTIONS
};
