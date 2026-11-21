/**
 * SmartFinishEngine.js
 * Evaluates Smart Finish conditions (Process, CPU, Network, Disk, File, Directory, Idle, Battery)
 * with AND/OR logic and stability duration verification.
 */

const fs = require('fs');
const path = require('path');
const { CONDITION_TYPE, LOGIC_OPERATOR } = require('./models/AutomationTask');
const { canonicalProcessName } = require('./processNames');
const { scanDirectory, scanDirectoryAsync, isPartialFile } = require('./conditions/DirectoryIdle');

class SmartFinishEngine {
    constructor(metricCollector) {
        this.collector = metricCollector;
        this.stabilityTrackers = new Map(); // taskId -> timestamp of when condition first became true
        // WP-07: dosya/klasör sabitliği örnek tabanlıdır (iki örnek aynı imza).
        this.fileSamples = new Map(); // taskId -> { signature, since }
        this.directorySamples = new Map(); // taskId -> { signature, since }
        // Y-11: aynı klasör 1 sn'lik tick'te tekrar tekrar taranmaz.
        this.directoryScanCache = new Map(); // taskId -> { at, scan }
        this.directoryScanIntervalMs = 5000;
    }

    /**
     * Evaluates whether a task's condition group is satisfied and stable.
     * @param {AutomationTask} task
     * @returns {{ satisfied: boolean, progressMessage: string }}
     */
    evaluateTask(task) {
        const group = task.conditionGroup;
        if (!group || !group.conditions || group.conditions.length === 0) {
            return { satisfied: false, progressMessage: 'Koşul tanımlanmamış' };
        }

        const metrics = this.collector.getMetrics();
        // WBS-1.1: systeminformation ilk 2 örnekte per-second değer üretemez.
        // Stale metrikle ASLA tetikleme yapılmaz (yanlış shutdown önlenir).
        if (metrics.stale === true) {
            return { satisfied: false, progressMessage: 'Metrikler ısınıyor (ilk örnekler atlanıyor)' };
        }
        // O-09: örnek anahtarı koşul başına benzersiz; aynı görevdeki iki
        // file_stable/directory_idle koşulu birbirinin örneğini ezmez.
        const results = group.conditions.map((cond, index) =>
            this.evaluateSingleCondition(cond, metrics, `${task.id}:${index}`)
        );

        let groupSatisfied = false;
        if (group.operator === LOGIC_OPERATOR.OR) {
            groupSatisfied = results.some(r => r.satisfied);
        } else {
            // Default AND
            groupSatisfied = results.every(r => r.satisfied);
        }

        const messages = results.map(r => r.message).join(' | ');

        if (!groupSatisfied) {
            this.stabilityTrackers.delete(task.id);
            return { satisfied: false, progressMessage: messages };
        }

        // Apply Stability Check (e.g. condition must stay true for X seconds)
        // ?? kullanılır: açıkça verilen 0 "hemen tetikle" demektir (|| 15 yazmak 0'ı yutardı).
        const requiredStabilitySec = (group.stabilitySeconds ?? 15);
        const now = Date.now();

        if (!this.stabilityTrackers.has(task.id)) {
            this.stabilityTrackers.set(task.id, now);
            return { satisfied: false, progressMessage: `Koşul sağlandı, kararlılık süresi bekleniyor (${requiredStabilitySec} sn)` };
        }

        const firstTrueTime = this.stabilityTrackers.get(task.id);
        const elapsedSec = Math.floor((now - firstTrueTime) / 1000);

        if (elapsedSec >= requiredStabilitySec) {
            return { satisfied: true, progressMessage: 'Smart Finish koşulları tam olarak sağlandı!' };
        } else {
            const remaining = requiredStabilitySec - elapsedSec;
            return { satisfied: false, progressMessage: `Kararlılık doğrulanıyor: ${remaining} sn kaldı` };
        }
    }

    /**
     * O-09: silinen görevlerin örnek/tracker kayıtlarını temizler.
     * @param {Set<string>} taskIds yaşayan görev kimlikleri
     */
    prune(taskIds) {
        const alive = taskIds instanceof Set ? taskIds : new Set(taskIds || []);
        const belongsToAliveTask = (key) => alive.has(String(key).split(':')[0]);
        for (const key of this.stabilityTrackers.keys()) {
            if (!alive.has(key)) this.stabilityTrackers.delete(key);
        }
        for (const map of [this.fileSamples, this.directorySamples, this.directoryScanCache]) {
            for (const key of map.keys()) {
                if (!belongsToAliveTask(key)) map.delete(key);
            }
        }
    }

    /**
     * P1-8: Klasör taramalarını ASENKRON önden yükler.
     *
     * Ölçülen kusur: `scanDirectory` senkron FS çağrıları yapıyordu ve
     * TaskManager'ın 1 sn'lik döngüsünün içinden çağrıldığı için yavaş/ağ
     * disklerinde ana süreci (UI + tüm zamanlayıcılar) kilitliyordu.
     * Bu yöntem yalnızca önbelleği ısıtır; sonuç `evaluateSingleCondition`
     * tarafından önbellekten okunur. Hata durumunda sessizce geçilir ve
     * değerlendirme yolu fail-closed davranışını korur.
     * @param {Array<object>} tasks
     * @returns {Promise<void>}
     */
    async prefetchDirectoryScans(tasks) {
        if (!Array.isArray(tasks) || tasks.length === 0) return;
        const now = Date.now();
        const jobs = [];
        for (const task of tasks) {
            if (!task || !task.enabled) continue;
            const conditions = (task.conditionGroup && Array.isArray(task.conditionGroup.conditions))
                ? task.conditionGroup.conditions
                : [];
            for (let index = 0; index < conditions.length; index += 1) {
                const cond = conditions[index];
                if (!cond || cond.type !== CONDITION_TYPE.DIRECTORY_IDLE) continue;
                const key = `${task.id}:${index}`;
                const cached = this.directoryScanCache.get(key);
                if (cached && now - cached.at < this.directoryScanIntervalMs) continue;
                const dirPath = cond.dirPath || cond.filePath;
                if (typeof dirPath !== 'string' || dirPath.length === 0) continue;
                jobs.push(
                    scanDirectoryAsync(dirPath, {
                        maxDepth: Number.isInteger(cond.maxDepth) ? cond.maxDepth : 2,
                        maxEntries: Number.isInteger(cond.maxEntries) ? cond.maxEntries : 5000
                    })
                        .then((scan) => { this.directoryScanCache.set(key, { at: Date.now(), scan }); })
                        .catch(() => { /* önbellek ısıtılamadı: değerlendirme kendi yolunu izler */ })
                );
            }
        }
        if (jobs.length > 0) await Promise.all(jobs);
    }

    evaluateSingleCondition(cond, metrics, taskId = null) {
        switch (cond.type) {
            case CONDITION_TYPE.PROCESS_RUNNING: {
                const procName = canonicalProcessName(cond.processName);
                // WP-03: Boş süreç adı "kapandı" sayılamaz; yapılandırma hatasıdır.
                if (!procName) {
                    return { satisfied: false, message: 'Geçersiz süreç adı (processName boş)' };
                }
                // WP-04: Süreç listesi alınamadıysa fail-closed. "Kapandı" varsayımı
                // yanlış shutdown üretir.
                if (metrics.processListStale === true || !Array.isArray(metrics.runningProcesses)) {
                    return { satisfied: false, message: 'Süreç listesi alınamadı; koşul değerlendirilemedi' };
                }
                const isRunning = metrics.runningProcesses.some((p) => canonicalProcessName(p) === procName);
                // If expected mode is "when process closes"
                if (cond.triggerOnClose) {
                    return {
                        satisfied: !isRunning,
                        message: !isRunning ? `İşlem kapandı: ${procName}` : `İşlem çalışıyor: ${procName}`
                    };
                }
                return {
                    satisfied: isRunning,
                    message: isRunning ? `İşlem aktif: ${procName}` : `İşlem kapalı: ${procName}`
                };
            }

            case CONDITION_TYPE.CPU_USAGE: {
                const threshold = Number.isFinite(cond.thresholdPercent) ? cond.thresholdPercent : 10;
                const satisfied = metrics.cpuUsagePercent <= threshold;
                return {
                    satisfied,
                    message: `CPU %${metrics.cpuUsagePercent} (Eşik: %${threshold})`
                };
            }

            case CONDITION_TYPE.USER_IDLE: {
                const requiredIdleSec = Number.isFinite(cond.idleSeconds) ? cond.idleSeconds : 300;
                const satisfied = metrics.userIdleSeconds >= requiredIdleSec;
                return {
                    satisfied,
                    message: `Kullanıcı Boşta: ${metrics.userIdleSeconds} sn (Hedef: ${requiredIdleSec} sn)`
                };
            }

            case CONDITION_TYPE.FILE_STABLE: {
                // WP-07.T1 (K-05): YALNIZCA düzenli dosya. Klasör, symlink ve
                // reparse noktası reddedilir; kısmi indirme dosyası sabit sayılmaz.
                const filePath = cond.filePath;
                if (typeof filePath !== 'string' || filePath.length === 0) {
                    return { satisfied: false, message: 'Geçersiz dosya yolu' };
                }
                let stats;
                try {
                    stats = fs.lstatSync(filePath);
                } catch (_) {
                    this.fileSamples.delete(taskId);
                    return { satisfied: false, message: `Dosya bulunamadı: ${filePath}` };
                }
                if (stats.isSymbolicLink()) {
                    this.fileSamples.delete(taskId);
                    return { satisfied: false, message: 'Symlink/reparse izlenmez' };
                }
                if (!stats.isFile()) {
                    this.fileSamples.delete(taskId);
                    return { satisfied: false, message: 'NOT_A_FILE: yol bir klasör (directory_idle kullanın)' };
                }
                if (isPartialFile(path.basename(filePath))) {
                    this.fileSamples.delete(taskId);
                    return { satisfied: false, message: 'Kısmi indirme dosyası sabit sayılmaz' };
                }
                const signature = `${Math.round(stats.mtimeMs)}:${stats.size}`;
                const requiredSec = Number.isInteger(cond.stableSeconds) && cond.stableSeconds > 0 ? cond.stableSeconds : 60;
                const now = Date.now();
                const sample = this.fileSamples.get(taskId);
                if (!sample || sample.signature !== signature) {
                    this.fileSamples.set(taskId, { signature, since: now });
                    return { satisfied: false, message: `Dosya izleniyor (0/${requiredSec} sn)` };
                }
                const elapsedSec = Math.floor((now - sample.since) / 1000);
                if (elapsedSec >= requiredSec) {
                    return { satisfied: true, message: `Dosya ${requiredSec} sn boyunca değişmedi` };
                }
                return {
                    satisfied: false,
                    message: `Dosya sabit: ${elapsedSec}/${requiredSec} sn`
                };
            }

            case CONDITION_TYPE.DIRECTORY_IDLE: {
                // WP-07.T2 (K-05): klasör içeriği sabit mi?
                const dirPath = cond.dirPath || cond.filePath;
                const scanNow = Date.now();
                const cachedScan = this.directoryScanCache.get(taskId);
                let scan;
                if (cachedScan && scanNow - cachedScan.at < this.directoryScanIntervalMs) {
                    scan = cachedScan.scan;
                } else {
                    scan = scanDirectory(dirPath, {
                        maxDepth: Number.isInteger(cond.maxDepth) ? cond.maxDepth : 2,
                        maxEntries: Number.isInteger(cond.maxEntries) ? cond.maxEntries : 5000
                    });
                    this.directoryScanCache.set(taskId, { at: scanNow, scan });
                }
                if (!scan.ok) {
                    this.directorySamples.delete(taskId);
                    return { satisfied: false, message: `Klasör taranamadı (${scan.code})` };
                }
                if (scan.hasPartial) {
                    this.directorySamples.delete(taskId);
                    return { satisfied: false, message: 'Kısmi indirme dosyası var (.crdownload/.part)' };
                }
                if (scan.fileCount === 0) {
                    this.directorySamples.delete(taskId);
                    return { satisfied: false, message: 'Klasör boş; sabit sayılmaz' };
                }
                const requiredSec = Number.isInteger(cond.stableSeconds) && cond.stableSeconds > 0 ? cond.stableSeconds : 300;
                const now = Date.now();
                const sample = this.directorySamples.get(taskId);
                if (!sample || sample.signature !== scan.signature) {
                    this.directorySamples.set(taskId, { signature: scan.signature, since: now });
                    return {
                        satisfied: false,
                        message: `Klasör izleniyor: ${scan.fileCount} dosya (0/${requiredSec} sn)`
                    };
                }
                const elapsedSec = Math.floor((now - sample.since) / 1000);
                if (elapsedSec >= requiredSec) {
                    return {
                        satisfied: true,
                        message: `Klasör ${requiredSec} sn boyunca değişmedi (${scan.fileCount} dosya)`
                    };
                }
                return {
                    satisfied: false,
                    message: `Klasör sabit: ${elapsedSec}/${requiredSec} sn (${scan.fileCount} dosya)`
                };
            }

            case CONDITION_TYPE.NETWORK_SPEED: {
                // WBS-1.2: Ağ durağanlığı — indirme/render bitiş dedektörünün çekirdeği.
                // Toplam (rx+tx) eşik altında kalırsa satisfied. Eşik Kbps, varsayılan 50.
                const thresholdKbps = cond.thresholdKbps != null ? cond.thresholdKbps : 50;
                const totalKbps = (metrics.networkDownloadKbps || 0) + (metrics.networkUploadKbps || 0);
                const satisfied = totalKbps <= thresholdKbps;
                return {
                    satisfied,
                    message: `Ağ ${Math.round(totalKbps)} Kbps (Eşik: ${thresholdKbps} Kbps)`
                };
            }

            case CONDITION_TYPE.DISK_ACTIVITY: {
                // P1-6: Şablonlar `thresholdKbps` (KB/sn) gönderir; motor bunu
                // IOPS sanıp kıyaslıyordu (HDD ~150 IOPS'ta doyuma ulaşır, yani
                // disk tam yükteyken "boş" sayılabiliyordu). Artık gerçek verim
                // (KB/sn) kullanılır. Geriye uyum: açıkça `thresholdIops`
                // verilmişse IOPS metriği ile kıyaslanır.
                const useIops = cond.thresholdIops != null;
                if (useIops) {
                    const thresholdIops = cond.thresholdIops;
                    const iops = metrics.diskIops || 0;
                    return {
                        satisfied: iops <= thresholdIops,
                        message: `Disk ${Math.round(iops)} IOPS (Eşik: ${thresholdIops})`
                    };
                }
                const thresholdKbps = cond.thresholdKbps != null ? cond.thresholdKbps : 100;
                // `diskKbps` ölçülemiyorsa (eski örnek/ARA bellek) güvenli taraf:
                // "meşgul" kabul et — erken kapatma yapma.
                if (typeof metrics.diskKbps !== 'number') {
                    return { satisfied: false, message: 'Disk verimi ölçülemedi; bekleniyor' };
                }
                const kbps = metrics.diskKbps;
                return {
                    satisfied: kbps <= thresholdKbps,
                    message: `Disk ${Math.round(kbps)} KB/sn (Eşik: ${thresholdKbps} KB/sn)`
                };
            }

            case CONDITION_TYPE.BATTERY_LEVEL: {
                // WBS-1.2: Batarya seviyesi. Desteklenmeyen donanımda asla satisfied dönmez.
                if (metrics.batterySupported === false) {
                    return { satisfied: false, message: 'Batarya sensörü yok' };
                }
                const level = metrics.batteryLevelPercent;
                if (typeof level !== 'number') {
                    return { satisfied: false, message: 'Batarya verisi yok' };
                }
                if (cond.belowPercent != null) {
                    const satisfied = level <= cond.belowPercent;
                    return { satisfied, message: `Batarya %${level} (Hedef: %${cond.belowPercent} altı)` };
                }
                if (cond.abovePercent != null) {
                    const satisfied = level >= cond.abovePercent;
                    return { satisfied, message: `Batarya %${level} (Hedef: %${cond.abovePercent} üstü)` };
                }
                return { satisfied: false, message: `Batarya %${level} (eşik tanımsız)` };
            }

            default:
                // WBS-1.2: Sessiz "Bilinmeyen koşul" yasaktır — createTask zaten reddeder.
                // Savunma amaçlı throw: evaluateTasks bunu FAILED + CONDITION_INVALID olarak loglar.
                throw new Error(`Desteklenmeyen koşul tipi: ${cond.type}`);
        }
    }
}

module.exports = SmartFinishEngine;
