/**
 * DataWipe.js - "Verilerimi sil" akışı (Store politikası 10.2.7).
 *
 * Amaç: kullanıcı uygulamayı kaldırdığında/gizliliğini sıfırlamak istediğinde
 * tüm yerel verinin (görevler, ayarlar, geçmiş, anahtarlar, yedekler, modeller,
 * loglar) gerçekten silindiğinden emin olmak. Hiçbir dosya yolu dışarıdan
 * gelmez; yalnızca kullanıcı verisi kökü altındaki bilinen girdiler silinir.
 *
 * Bu modül saf tutulur (fs/exec enjekte edilebilir) ki birim testle
 * doğrulanabilsin; IPC katmanı yalnızca orkestrasyonu yapar.
 */

const fs = require('fs');
const path = require('path');

/** Kullanıcı verisi kökünde silinecek bilinen girdiler. */
const WIPE_ENTRIES = [
    'powerpilot.db',
    'powerpilot.db-wal',
    'powerpilot.db-shm',
    'secrets.v1.json',
    'data.json',
    'backups',
    'models',
    'audit-checkpoints',
    'logs',
    'Crashpad',
    'blob_storage',
    'Cache',
    'Code Cache',
    'GPUCache',
    'Local Storage',
    'Session Storage',
    'IndexedDB',
    'Network Persistent State',
    'Preferences',
    'TransportSecurity'
];

/**
 * Silinmesi ZORUNLU girdiler (kullanıcıya ait gerçek veri). Chromium'un kendi
 * çalışma klasörleri (`Cache`, `GPUCache`, `Local Storage`, `Session Storage` …)
 * uygulama açıkken kilitli olabilir ve yeniden oluşturulur; içerikleri
 * `session.clearStorageData()` ile boşaltılır, bu yüzden "silinemedi" hatası
 * sayılmazlar.
 */
const ESSENTIAL_ENTRIES = [
    'powerpilot.db',
    'powerpilot.db-wal',
    'powerpilot.db-shm',
    'secrets.v1.json',
    'data.json',
    'backups',
    'models',
    'audit-checkpoints',
    'logs'
];

/**
 * Silinecek yolları üretir. Var olmayanlar atlanır.
 *
 * `readdir` verilirse kökteki **tüm** girdiler hedeflenir: userData klasörü
 * tamamen uygulamaya aittir ve Chromium kendi klasörlerini sürüm sürüm
 * değiştirir (`DawnGraphiteCache`, `DIPS`, `Network`, `Local State`, …).
 * Sabit listeye takılı kalmak "tüm veriler silindi" sözünü bozar.
 *
 * @param {string} userDataPath
 * @returns {{root:string, targets:string[]}}
 */
function planWipe(userDataPath, { exists = fs.existsSync, readdir = null } = {}) {
    const root = path.resolve(String(userDataPath || ''));
    if (!userDataPath || typeof userDataPath !== 'string') {
        const err = new Error('userDataPath gerekli.');
        err.code = 'INVALID_PATH';
        throw err;
    }
    const targets = [];
    if (typeof readdir === 'function') {
        let names = [];
        try {
            names = readdir(root) || [];
        } catch (_) {
            names = [];
        }
        for (const name of names) {
            const full = path.join(root, String(name));
            // Savunma: birleşim kökün dışına çıkmamalı.
            if (path.dirname(full) !== root) continue;
            if (exists(full)) targets.push(full);
        }
        return { root, targets };
    }
    for (const entry of WIPE_ENTRIES) {
        const full = path.join(root, entry);
        // Savunma: birleşim kökün dışına çıkmamalı (girdiler sabit olsa da).
        if (path.dirname(full) !== root) continue;
        if (exists(full)) targets.push(full);
    }
    return { root, targets };
}

function removeWithRetry(target, { rm = fs.rmSync, attempts = 3 } = {}) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 120 });
            return { path: target, removed: true };
        } catch (err) {
            lastError = err;
        }
    }
    return {
        path: target,
        removed: false,
        error: (lastError && lastError.code) || 'REMOVE_FAILED'
    };
}

/**
 * Planı uygular. `onBefore` geri çağrısı (DB kapatma vb.) silmeden önce
 * çalışır; hata fırlatırsa silme başlamaz (veri yarım kalmaz).
 *
 * `ok` yalnızca **temel kullanıcı verisi** (WIPE_ENTRIES: DB, anahtarlar,
 * yedekler, loglar, modeller …) silindiğinde true olur. Chromium'un kendi
 * çalışma klasörleri (GPUCache, DawnGraphiteCache, Network …) uygulama açıkken
 * kilitli olabilir ve yeniden oluşturulur; bunlar `optionalFailed` olarak
 * raporlanır ve kullanıcıya hata gösterilmez - içerikleri
 * `session.clearStorageData()` ile zaten boşaltılmıştır.
 * @returns {{ok:boolean, root:string, removed:string[], failed:Array<{path:string,error:string}>, optionalFailed:Array<{path:string,error:string}>}}
 */
function performWipe(userDataPath, { onBefore = null, exists = fs.existsSync, rm = fs.rmSync, readdir = null } = {}) {
    const { root, targets } = planWipe(userDataPath, { exists, readdir });
    const essential = new Set(ESSENTIAL_ENTRIES.map((name) => path.join(root, name)));
    if (typeof onBefore === 'function') onBefore();
    const removed = [];
    const failed = [];
    const optionalFailed = [];
    for (const target of targets) {
        const result = removeWithRetry(target, { rm });
        if (result.removed) {
            removed.push(result.path);
        } else if (essential.has(target)) {
            failed.push({ path: result.path, error: result.error });
        } else {
            optionalFailed.push({ path: result.path, error: result.error });
        }
    }
    return { ok: failed.length === 0, root, removed, failed, optionalFailed };
}

/**
 * Bir sonraki açılışta silinecek girdileri işaretler (kilitli dosyalar için).
 *
 * Chromium (Local Storage, GPUCache, Network …) çalışırken bu klasörleri açık
 * tutar. "Tüm verileri sil" sırasında silinemeyen girdi olursa kullanıcıya
 * "silinemedi" demek yanıltıcıdır: uygulama zaten kapanıyor, dosyalar bir
 * sonraki açılışta (hiçbir veri gösterilmeden once) silinebilir. İşaret
 * dosyası userData'nın DIŞINDA tutulur ki wipe onu da silmesin.
 */
const PENDING_MARKER_NAME = 'powerpilot-pending-wipe.json';

function writePendingWipe(markerPath, { root, paths }) {
    const payload = {
        root: String(root || ''),
        paths: (Array.isArray(paths) ? paths : []).map((p) => String(p)),
        createdAt: Date.now()
    };
    try {
        fs.writeFileSync(markerPath, JSON.stringify(payload), 'utf8');
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * İşaret dosyasındaki girdileri siler. Kök eşleşmezse (farklı profil) hiçbir
 * şeye dokunmaz ve işareti temizler.
 * @returns {{removed:number, remaining:string[]}}
 */
function applyPendingWipe(markerPath, { rm = fs.rmSync, readFile = null, unlink = null } = {}) {
    const reader = readFile || ((p) => fs.readFileSync(p, 'utf8'));
    const remover = unlink || ((p) => fs.rmSync(p, { force: true }));
    let payload = null;
    try {
        payload = JSON.parse(reader(markerPath));
    } catch (_) {
        return { removed: 0, remaining: [] };
    }
    const remaining = [];
    let removed = 0;
    for (const target of Array.isArray(payload && payload.paths) ? payload.paths : []) {
        if (!path.isAbsolute(target)) continue;
        const result = removeWithRetry(target, { rm });
        if (result.removed) removed += 1;
        else remaining.push(target);
    }
    if (remaining.length === 0) {
        try { remover(markerPath); } catch (_) { /* işaret zaten yok */ }
    }
    return { removed, remaining };
}

/**
 * Planı ana iş parçacığını (UI / Win32 mesaj döngüsünü) kilitlemeden asenkron uygular.
 * Önce temel kullanıcı verileri (DB, anahtarlar, yedekler, modeller, loglar) kısa
 * asenkron yeniden denemelerle silinir; ardından Chromium çalışma klasörleri tek
 * geçişte paralel temizlenir (kilitli olanlar olay döngüsünü dondurmadan optionalFailed'a düşer).
 */
async function removeWithRetryAsync(target, { rm = fs.promises.rm, attempts = 3, delayMs = 50 } = {}) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
        try {
            await rm(target, { recursive: true, force: true });
            return { path: target, removed: true };
        } catch (err) {
            lastError = err;
            if (i + 1 < attempts && delayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
    }
    return {
        path: target,
        removed: false,
        error: (lastError && lastError.code) || 'REMOVE_FAILED'
    };
}

async function performWipeAsync(userDataPath, {
    onBefore = null,
    exists = fs.existsSync,
    rm = fs.promises.rm,
    readdir = null
} = {}) {
    const { root, targets } = planWipe(userDataPath, { exists, readdir });
    const essential = new Set(ESSENTIAL_ENTRIES.map((name) => path.join(root, name)));
    if (typeof onBefore === 'function') await onBefore();
    const essentialTargets = [];
    const optionalTargets = [];
    for (const target of targets) {
        if (essential.has(target)) essentialTargets.push(target);
        else optionalTargets.push(target);
    }

    const removed = [];
    const failed = [];
    const optionalFailed = [];

    // 1. Önce zorunlu kullanıcı verileri (asenkron + kısa bekleme)
    for (const target of essentialTargets) {
        const result = await removeWithRetryAsync(target, { rm, attempts: 3, delayMs: 50 });
        if (result.removed) removed.push(result.path);
        else failed.push({ path: result.path, error: result.error });
    }

    // 2. İsteğe bağlı Chromium önbellek/oturum klasörleri (tek geçiş, kilitleme yok)
    const optResults = await Promise.all(
        optionalTargets.map((target) => removeWithRetryAsync(target, { rm, attempts: 1, delayMs: 0 }))
    );
    for (const result of optResults) {
        if (result.removed) removed.push(result.path);
        else optionalFailed.push({ path: result.path, error: result.error });
    }

    return { ok: failed.length === 0, root, removed, failed, optionalFailed };
}

module.exports = {
    WIPE_ENTRIES,
    ESSENTIAL_ENTRIES,
    PENDING_MARKER_NAME,
    planWipe,
    performWipe,
    performWipeAsync,
    removeWithRetry,
    removeWithRetryAsync,
    writePendingWipe,
    applyPendingWipe
};
