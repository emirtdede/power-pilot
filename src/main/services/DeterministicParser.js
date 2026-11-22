/**
 * DeterministicParser.js - K1b.
 * Türkçe güç cümlelerini LLM'siz çözer (eylem + süre/saat). Neden:
 * 1.7B model milisaniye hesabını tutturamıyor (canlı kanıt: "2 saat"→200000ms),
 * oysa kurallar %100 deterministiktir (AgentOrchestrator felsefesiyle aynı).
 * Koşul cümleleri (bitince/durunca/...) bilerek LLM'e bırakılır (null döner).
 * Çıktı, AiService.buildProposal girdisiyle birebirdir.
 */

const MS = { sn: 1000, dk: 60000, saat: 3600000, gun: 86400000 };

const { isNegated } = require('./NegationGuard');

const ACTION_PATTERNS = [
    { action: 'restart', re: /yeniden\s*başlat/i },
    { action: 'hibernate', re: /haz[ıi]rda\s*beklet/i },
    { action: 'sleep', re: /uyku|uyut/i },
    { action: 'lock', re: /kilit/i },
    { action: 'signout', re: /oturumu?\s*kapat|oturumdan\s*[çc][ıi]k|[çc][ıi]k[ıi][şs]\s*yap/i },
    { action: 'shutdown', re: /kapat|kapan/i }
];

// Koşul ipucu varsa ve açık süre yoksa LLM'e bırak (örn. "indirme bitince kapat").
// (Aşağıdaki parseCondition yaygın kalıpları yakalar; artığı LLM'e gider.)
const CONDITION_CUES = /bitince|bitmesi|bittiğinde|kapanınca|açılınca|durunca|dursa|düşünce|azalınca|dolunca|kesilince|bağlanınca|şarj|pil|indirme|render|yedek|ağ|wifi|internet|yüzde\s*%|%\s*\d/i;

const TR_WORDS = {
    yarım: 0.5, yarim: 0.5,
    bir: 1, iki: 2, üç: 3, uc: 3, dört: 4, dort: 4, beş: 5, bes: 5,
    altı: 6, alti: 6, yedi: 7, sekiz: 8, dokuz: 9, on: 10,
    yirmi: 20, otuz: 30, kırk: 40, kirk: 40, elli: 50, altmış: 60, altmis: 60
};

const UNIT_PATTERNS = [
    { unit: 'sn', re: /saniye|sn\b/ },
    { unit: 'dk', re: /dakika|dak\b|dk\b/ },
    { unit: 'saat', re: /saat/ },
    { unit: 'gun', re: /g[üu]n/ }
];

function normalize(text) {
    return String(text || '').toLocaleLowerCase('tr');
}

// "yirmi beş" / "on beş" gibi birleşik sayılar + rakamlar.
// Rakam varsa EN SOND AKİ alınır ("1 saat 30 dakika" → 30, birim saat değilse
// çağrıcı pencereyi daraltır); yoksa sözcükler baştan taranır.
function parseCount(text) {
    const digits = String(text || '').match(/\d+(?:[.,]\d+)?/g);
    if (digits && digits.length > 0) {
        const v = parseFloat(digits[digits.length - 1].replace(',', '.'));
        if (Number.isFinite(v) && v > 0) return v;
    }
    const words = String(text || '').split(/[\s_.-]+/).filter(Boolean);
    let total = 0;
    let used = 0;
    for (const w of words) {
        const v = TR_WORDS[w];
        if (v === undefined) {
            if (used > 0) break;
            continue;
        }
        total += v;
        used++;
        if (used >= 2) break;
    }
    return used > 0 ? total : null;
}

// Metindeki TÜM süre öbekleri toplanır ("1 saat 30 dakika" → 90dk).
// Pencere: birimin önündeki en fazla 30 karakter (sayı+sözcük avı için).
function parseDurationMs(text) {
    let totalMs = 0;
    let found = 0;
    for (const { unit, re } of UNIT_PATTERNS) {
        const rx = new RegExp(`([\\d.,\\s\\wçÇğĞıIöÖşŞüÜ]{1,30}?)(${re.source})`, 'gi');
        let m;
        while ((m = rx.exec(text)) !== null && found < 4) {
            const count = parseCount(m[1]);
            if (count !== null) {
                totalMs += Math.round(count * MS[unit]);
                found++;
            }
            if (m[0].length === 0) rx.lastIndex++;
        }
    }
    if (found === 0 || totalMs <= 0 || totalMs > 2500000000) return null;
    return totalMs;
}

function parseClockTarget(text, nowMs = Date.now()) {
    const lower = text;
    const isPmCue = /akşam|aksam|öğleden\s*sonra|ogleden\s*sonra|gece/.test(lower);
    const isAmCue = /sabah|öğlen|oglen|sabahleyin|gece\s*yarısı/.test(lower);

    let h = null;
    let min = 0;
    const hm = lower.match(/(\d{1,2})[:.](\d{2})/);
    if (hm) {
        h = parseInt(hm[1], 10);
        min = parseInt(hm[2], 10);
        if (h > 23 || min > 59) return null;
    } else if (isPmCue || isAmCue) {
        // "akşam 8", "sabah 8" - yalnızca ipucu varken çıplak saat kabul edilir.
        const hOnly = lower.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
        if (!hOnly) return null;
        h = parseInt(hOnly[1], 10);
        if (h > 23) return null;
    } else {
        return null;
    }

    // 24 saat gösterimi: 24:00 geçersizdir (00:00 kullanılmalı).
    if (h === 24) return null;

    if (isPmCue && h < 12 && !(h < 6 && /gece/.test(lower))) h += 12;
    if (isAmCue && h === 12) h = 0;

    const isTomorrow = /yar[ıi]n/.test(lower);
    const d = new Date(nowMs);
    d.setHours(h, min, 0, 0);
    let target = d.getTime();
    if (isTomorrow) {
        target += 86400000;
    } else if (target <= nowMs) {
        // L-11: geçmiş saat → ertesi gün; hemen tetiklenmez.
        target += 86400000;
    }
    return target;
}

function findAction(text) {
    for (const { action, re } of ACTION_PATTERNS) {
        if (re.test(text)) return action;
    }
    return null;
}

// Yaygın koşul kalıpları → SmartFinish koşul nesnesi (motor listesiyle birebir).
// Çıkarılamayan (örn. yolsuz dosya koşulu) null döner → LLM'e gider.
function parseCondition(text) {
    if (/indirme|download|y[üu]kleme/.test(text) && /bitince|bitti|tamamlan|durunca|dursa/.test(text)) {
        return { type: 'network_speed', thresholdKbps: 50 };
    }
    if (/(ağ|wifi|internet|network)/.test(text) && /(durunca|dursa|yavaş)/.test(text)) {
        return { type: 'network_speed', thresholdKbps: 50 };
    }
    const pct = text.match(/%(\d{1,3})/);
    if (/pil|batarya|şarj/.test(text)) {
        const v = pct ? parseInt(pct[1], 10) : 20;
        if (v > 0 && v <= 100) return { type: 'battery_level', belowPercent: v };
        return null;
    }
    if (/cpu|işlemci/.test(text) && /boş|düş|rahat|bitince|bitti/.test(text)) {
        return { type: 'cpu_usage', thresholdPercent: 10 };
    }
    const closer = text.match(/(\S+?)\s+(kapanınca|kapandığında|kapatılınca)/);
    if (closer) {
        const raw = closer[1].replace(/['"“”]/g, '');
        if (!/^(bilgisayar|pc|sistem|windows|ekran)$/.test(raw) && raw.length <= 40) {
            const proc = /\.exe$/i.test(raw) ? raw : `${raw}.exe`;
            return { type: 'process_running', processName: proc.toLowerCase(), triggerOnClose: true };
        }
        return null;
    }
    const pathish = text.match(/([a-z]:\\[^\s"“”]+|"[^"]+"|\/[^\s"“”]+)/);
    if (pathish && /bitince|bitti|değişmezse|sabitlenince|tamamlanınca|yedek/.test(text)) {
        return { type: 'file_stable', filePath: pathish[1].replace(/^"|"$/g, ''), stableSeconds: 300 };
    }
    return null;
}

/**
 * @returns {object|null} buildProposal girdisi ya da null (LLM'e bırak).
 */
function parse(text) {
    if (!text || typeof text !== 'string' || !text.trim()) return null;
    const t = normalize(text);
    // K-03: olumsuz cümlede yıkıcı eylem ASLA önerilmez. Sessiz geçiş yok:
    // parser null döner, çağıran katman netleştirme ister.
    if (isNegated(t)) return null;
    const action = findAction(t);
    if (!action) return null;
    const durationMs = parseDurationMs(t);
    if (durationMs !== null) {
        return { action, kind: 'duration', durationMs };
    }
    const condition = parseCondition(t);
    if (condition) {
        return { action, kind: 'condition', condition };
    }
    if (CONDITION_CUES.test(t)) return null; // Artık koşul → LLM.
    const targetTime = parseClockTarget(t);
    if (targetTime !== null) {
        return { action, kind: 'scheduled_time', targetTime };
    }
    return { action, kind: 'duration', missing: ['durationMs'] };
}

module.exports = { parse, parseDurationMs, parseClockTarget, parseCount, parseCondition, findAction, ACTION_PATTERNS };
