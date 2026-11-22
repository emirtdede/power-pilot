/**
 * processNames.js - Süreç adı kanonikleştirme (WP-04).
 *
 * Windows'ta aynı süreç `chrome`, `chrome.exe`, `CHROME.EXE` olarak
 * raporlanabilir. Koşul motoru ve güvenlik motoru tek biçim kullanır.
 */

function canonicalProcessName(raw) {
    if (typeof raw !== 'string') return '';
    let name = raw.trim().toLowerCase();
    if (!name) return '';
    // Tam yol verilirse yalnızca dosya adı kalır.
    const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (slash >= 0) name = name.slice(slash + 1);
    // Zone/ADS eklerini at.
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(0, colon);
    if (name.endsWith('.exe')) name = name.slice(0, -4);
    return name;
}

function processNamesEqual(a, b) {
    const ca = canonicalProcessName(a);
    const cb = canonicalProcessName(b);
    return ca.length > 0 && ca === cb;
}

function toProcessSet(list) {
    const set = new Set();
    if (!Array.isArray(list)) return set;
    for (const item of list) {
        const raw = typeof item === 'string' ? item : (item && (item.name || item.processName));
        const name = canonicalProcessName(raw);
        if (name) set.add(name);
    }
    return set;
}

module.exports = { canonicalProcessName, processNamesEqual, toProcessSet };
