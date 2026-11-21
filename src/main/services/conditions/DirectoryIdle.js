/**
 * conditions/DirectoryIdle.js — WP-07.T2 (K-05)
 * Klasör "sabitlendi" koşulu. `file_stable` yalnızca DOSYA içindir;
 * klasör mtime'ı indirme sırasında da değişmediği için erken kapanmaya yol
 * açıyordu. Bu modül klasörün içeriğini özetler:
 *
 * - Özyinelemeli tarama: en fazla derinlik 2, en fazla 5000 girdi.
 * - Symlink/reparse noktaları ATLANIR (döngü ve yanlış sinyal yok).
 * - İmza = son değişiklik zamanı + toplam boyut + dosya sayısı.
 * - Kısmi indirme uzantıları (.crdownload/.part/.tmp/.download) varsa
 *   klasör asla "sabit" sayılmaz.
 * - Boş klasör sabit SAYILMAZ (fileCount > 0 şartı).
 * - Hata → satisfied:false (fail-closed; audit çağıran tarafta).
 */

const fs = require('fs');
const path = require('path');

const PARTIAL_EXT = new Set(['.crdownload', '.part', '.tmp', '.download', '.partial', '.opdownload']);

const DEFAULT_LIMITS = Object.freeze({
    maxDepth: 2,
    maxEntries: 5000,
    timeoutMs: 3000
});

function isPartialFile(name) {
    return PARTIAL_EXT.has(path.extname(name).toLowerCase());
}

/**
 * Klasör imzasını üretir.
 * @param {string} dirPath
 * @param {object} [limits]
 * @returns {{ok:boolean, code?:string, signature?:string, latestMtime?:number, totalSize?:number, fileCount?:number, hasPartial?:boolean, entryCount?:number}}
 */
function scanDirectory(dirPath, limits = {}) {
    const maxDepth = Number.isInteger(limits.maxDepth) ? limits.maxDepth : DEFAULT_LIMITS.maxDepth;
    const maxEntries = Number.isInteger(limits.maxEntries) ? limits.maxEntries : DEFAULT_LIMITS.maxEntries;
    const timeoutMs = Number.isInteger(limits.timeoutMs) ? limits.timeoutMs : DEFAULT_LIMITS.timeoutMs;
    const startedAt = Date.now();

    let rootStat;
    try {
        rootStat = fs.lstatSync(dirPath);
    } catch (err) {
        return { ok: false, code: 'DIRECTORY_UNAVAILABLE', error: err.message };
    }
    if (rootStat.isSymbolicLink()) return { ok: false, code: 'REPARSE_POINT' };
    if (!rootStat.isDirectory()) return { ok: false, code: 'NOT_A_DIRECTORY' };

    let latestMtime = 0;
    let totalSize = 0;
    let fileCount = 0;
    let entryCount = 0;
    let hasPartial = false;

    const stack = [{ dir: dirPath, depth: 0 }];
    while (stack.length > 0) {
        if (Date.now() - startedAt > timeoutMs) {
            return { ok: false, code: 'SCAN_TIMEOUT' };
        }
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            return { ok: false, code: 'DIRECTORY_UNAVAILABLE', error: err.message };
        }
        for (const entry of entries) {
            entryCount += 1;
            if (entryCount > maxEntries) return { ok: false, code: 'SCAN_LIMIT_EXCEEDED' };
            const full = path.join(dir, entry.name);
            let st;
            try {
                st = fs.lstatSync(full);
            } catch (_) {
                continue; // yarış: dosya silinmiş olabilir; sinyal üretme
            }
            if (st.isSymbolicLink()) continue; // reparse atla
            if (entry.isDirectory()) {
                if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
                continue;
            }
            if (!entry.isFile()) continue;
            if (isPartialFile(entry.name)) hasPartial = true;
            fileCount += 1;
            totalSize += st.size;
            if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        }
    }

    return {
        ok: true,
        signature: `${Math.round(latestMtime)}:${totalSize}:${fileCount}`,
        latestMtime,
        totalSize,
        fileCount,
        hasPartial,
        entryCount
    };
}

/**
 * P1-8: `scanDirectory`'nin ASENKRON eşdeğeri.
 *
 * Ölçülen kusur: tarama `fs.readdirSync`/`lstatSync` ile yapılıyor ve
 * TaskManager'ın 1 saniyelik değerlendirme döngüsünün İÇİNDE çağrılıyordu.
 * Ağ paylaşımı, yavaş disk veya 5000 girdilik bir klasörde bu çağrı ana
 * süreci (dolayısıyla tüm UI'ı ve zamanlayıcıları) saniyelerce kilitliyordu.
 *
 * Aynı sözleşme ve aynı güvenlik kuralları; yalnızca `fs.promises` kullanır.
 * @param {string} dirPath
 * @param {object} [limits]
 * @returns {Promise<{ok:boolean, code?:string, signature?:string, latestMtime?:number, totalSize?:number, fileCount?:number, hasPartial?:boolean, entryCount?:number}>}
 */
async function scanDirectoryAsync(dirPath, limits = {}) {
    const maxDepth = Number.isInteger(limits.maxDepth) ? limits.maxDepth : DEFAULT_LIMITS.maxDepth;
    const maxEntries = Number.isInteger(limits.maxEntries) ? limits.maxEntries : DEFAULT_LIMITS.maxEntries;
    const timeoutMs = Number.isInteger(limits.timeoutMs) ? limits.timeoutMs : DEFAULT_LIMITS.timeoutMs;
    const startedAt = Date.now();

    let rootStat;
    try {
        rootStat = await fs.promises.lstat(dirPath);
    } catch (err) {
        return { ok: false, code: 'DIRECTORY_UNAVAILABLE', error: err.message };
    }
    if (rootStat.isSymbolicLink()) return { ok: false, code: 'REPARSE_POINT' };
    if (!rootStat.isDirectory()) return { ok: false, code: 'NOT_A_DIRECTORY' };

    let latestMtime = 0;
    let totalSize = 0;
    let fileCount = 0;
    let entryCount = 0;
    let hasPartial = false;

    const stack = [{ dir: dirPath, depth: 0 }];
    while (stack.length > 0) {
        if (Date.now() - startedAt > timeoutMs) {
            return { ok: false, code: 'SCAN_TIMEOUT' };
        }
        const { dir, depth } = stack.pop();
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (err) {
            return { ok: false, code: 'DIRECTORY_UNAVAILABLE', error: err.message };
        }
        for (const entry of entries) {
            entryCount += 1;
            if (entryCount > maxEntries) return { ok: false, code: 'SCAN_LIMIT_EXCEEDED' };
            const full = path.join(dir, entry.name);
            let st;
            try {
                st = await fs.promises.lstat(full);
            } catch (_) {
                continue; // yarış: dosya silinmiş olabilir; sinyal üretme
            }
            if (st.isSymbolicLink()) continue; // reparse atla
            if (entry.isDirectory()) {
                if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
                continue;
            }
            if (!entry.isFile()) continue;
            if (isPartialFile(entry.name)) hasPartial = true;
            fileCount += 1;
            totalSize += st.size;
            if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        }
    }

    return {
        ok: true,
        signature: `${Math.round(latestMtime)}:${totalSize}:${fileCount}`,
        latestMtime,
        totalSize,
        fileCount,
        hasPartial,
        entryCount
    };
}

module.exports = { scanDirectory, scanDirectoryAsync, isPartialFile, PARTIAL_EXT, DEFAULT_LIMITS };
