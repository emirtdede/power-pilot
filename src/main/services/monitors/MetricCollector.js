/**
 * MetricCollector.js
 * WBS-1.1: Gerçek sistem ölçümü — placeholder YASAK.
 * CPU: os.cpus() delta (yerleşik, ek bağımlılıksız).
 * Network/Disk/Battery: systeminformation@5.31.0 (MIT, sıfır bağımlılık).
 *   - systeminformation dokümanı gereği per-second değerler (rx_sec, rIO_sec)
 *     İKİNCİ çağrıdan itibaren anlamlıdır; ilk 2 örnek `stale:true` işaretlenir
 *     ve SmartFinishEngine bu örneklerde tetikleme yapmaz (güvenlik için).
 * Process: ps-list (tek süreç, 2sn'de bir spawn yok; ESM lazy import).
 * Idle: Electron powerMonitor.getSystemIdleTime(); PowerShell probe YOK.
 *
 * WP-04: Süreç listesi boş/alınamazsa `processListStale=true`; koşul motoru
 * bu durumda "süreç kapandı" saymaz (fail-closed).
 */

const os = require('os');
const si = require('systeminformation');
const { canonicalProcessName } = require('../processNames');

class MetricCollector {
    constructor(options = {}) {
        this.sampleIntervalMs = options.sampleIntervalMs || 5000;
        this.sampleInterval = null;
        this.sampleCount = 0;
        this.currentMetrics = this.freshMetrics(true);
        // WP-13.T3: üst üste tick yok; ölçüm 4 sn'de kesilir.
        this._sampling = false;
        this.sampleTimeoutMs = options.sampleTimeoutMs || 4000;
        this.batteryIntervalMs = options.batteryIntervalMs || 30000;
        this._lastBatteryAt = 0;

        // Test/DI: sağlanmazsa üretim sağlayıcıları kullanılır.
        this.processProvider = typeof options.processProvider === 'function' ? options.processProvider : null;
        this.idleProvider = typeof options.idleProvider === 'function' ? options.idleProvider : null;
        this.powerMonitor = options.powerMonitor || null;
        // Test/DI: systeminformation okumaları enjekte edilebilir (üretimde gerçek modül).
        this.si = options.si || si;
        this.now = typeof options.now === 'function' ? options.now : Date.now;
        this.processListMaxAgeMs = options.processListMaxAgeMs || 15000;
        // WP-16: fastlist/ps-list yalnızca gerektiğinde ve daha seyrek çağrılır.
        this.processSampleIntervalMs = options.processSampleIntervalMs || 5000;
        this.needsProcessList = typeof options.needsProcessList === 'function'
            ? options.needsProcessList
            : null;
        this._lastProcessSampleAt = 0;
        this._processListInFlight = false;

        this.prevCpuTimes = this.getCpuTimes();
        this.startSampling();
    }

    freshMetrics(stale) {
        return {
            cpuUsagePercent: 0,
            networkDownloadKbps: 0,
            networkUploadKbps: 0,
            diskIops: 0,
            diskKbps: 0,
            userIdleSeconds: 0,
            batteryLevelPercent: null,
            isCharging: null,
            batterySupported: null,
            runningProcesses: [],
            processListStale: true,
            processListAt: 0,
            // WBS-1.1: İlk 2 örnek atılır; karar verici bu bayrağı kontrol eder.
            stale: stale === true,
            sampledAt: new Date().toISOString()
        };
    }

    getCpuTimes() {
        const cpus = os.cpus();
        let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
        for (const cpu of cpus) {
            user += cpu.times.user;
            nice += cpu.times.nice;
            sys += cpu.times.sys;
            idle += cpu.times.idle;
            irq += cpu.times.irq;
        }
        return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
    }

    startSampling() {
        if (this.sampleInterval) return;
        this.sampleInterval = setInterval(() => {
            this.sampleOnce().catch(() => { /* ölçüm hatası döngüyü durdurmaz */ });
        }, this.sampleIntervalMs);
        if (this.sampleInterval && typeof this.sampleInterval.unref === 'function') this.sampleInterval.unref();
    }

    stopSampling() {
        if (this.sampleInterval) {
            clearInterval(this.sampleInterval);
            this.sampleInterval = null;
        }
    }

    withTimeout(promise, ms = this.sampleTimeoutMs) {
        let timer = null;
        return new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('SAMPLE_TIMEOUT')), ms);
            if (timer && typeof timer.unref === 'function') timer.unref();
            Promise.resolve(promise).then(
                (value) => { if (timer) clearTimeout(timer); resolve(value); },
                (err) => { if (timer) clearTimeout(timer); reject(err); }
            );
        });
    }

    async sampleOnce() {
        // WP-13.T3: önceki ölçüm bitmeden yeni tick başlamaz.
        if (this._sampling) return false;
        this._sampling = true;
        const started = this.now();
        let failed = false;
        try {
            this.sampleCpu();
            const shouldSample = this.shouldSampleProcesses();
            const processTask = shouldSample ? this.sampleProcesses() : Promise.resolve();
            if (!shouldSample && (this.now() - this.currentMetrics.processListAt) > this.processListMaxAgeMs) {
                // Tüketici yokken eski liste "taze" görünmemeli: fail-closed.
                this.currentMetrics.processListStale = true;
            }
            // O-10: alt işler ayrı tutulur; timeout sonrası yeni tick başlamadan
            // önce hepsinin bitmesi beklenir (üst üste WMI/PowerShell çağrısı yok).
            const idleTask = this.sampleIdle();
            const networkTask = this.sampleNetwork();
            const disksTask = this.sampleDisks();
            const batteryTask = this.sampleBattery();
            const underlying = Promise.allSettled([processTask, idleTask, networkTask, disksTask, batteryTask]);
            const results = await Promise.allSettled([
                this.withTimeout(processTask),
                this.withTimeout(idleTask),
                this.withTimeout(networkTask),
                this.withTimeout(disksTask),
                this.withTimeout(batteryTask)
            ]);
            failed = results.some((r) => r.status === 'rejected');
            this.sampleCount += 1;
            const elapsed = this.now() - started;
            // İlk 2 örnek + başarısız/geciken örnek stale sayılır (fail-closed).
            this.currentMetrics.stale = this.sampleCount < 3 || failed || elapsed >= this.sampleTimeoutMs;
            this.currentMetrics.sampledAt = new Date().toISOString();
            await underlying.catch(() => {});
            return true;
        } finally {
            this._sampling = false;
        }
    }

    /**
     * Süreç örneklemesi iki kapıdan geçer:
     *  1. Tüketici var mı? (process_running koşulu taşıyan görev)
     *  2. Örnekleme aralığı doldu mu? (varsayılan 5 sn)
     * Böylece boşta 2 sn'de bir fastlist.exe spawn edilmez.
     */
    shouldSampleProcesses() {
        if (this.needsProcessList) {
            try {
                if (this.needsProcessList() !== true) return false;
            } catch (_) {
                return false; // tüketici durumu bilinmiyorsa spawn etme
            }
        }
        if (this._lastProcessSampleAt && (this.now() - this._lastProcessSampleAt) < this.processSampleIntervalMs) {
            return false;
        }
        return true;
    }

    sampleCpu() {
        const current = this.getCpuTimes();
        const idleDiff = current.idle - this.prevCpuTimes.idle;
        const totalDiff = current.total - this.prevCpuTimes.total;
        this.prevCpuTimes = current;

        if (totalDiff > 0) {
            const usage = 100 - Math.floor((100 * idleDiff) / totalDiff);
            this.currentMetrics.cpuUsagePercent = Math.max(0, Math.min(100, usage));
        }
    }

    async getProcessList() {
        if (this.processProvider) {
            const provided = await this.processProvider();
            return Array.isArray(provided) ? provided : null;
        }
        // ps-list@9 ESM'dir; CJS'ten yalnızca lazy dynamic import ile yüklenir.
        // Paketleme başarısız olursa null döner → fail-closed.
        try {
            const mod = await import('ps-list');
            const fn = mod.default || mod.psList;
            if (typeof fn !== 'function') return null;
            const list = await fn({ all: true });
            return Array.isArray(list) ? list : null;
        } catch (_) {
            return null;
        }
    }

    async sampleProcesses() {
        if (this._processListInFlight) return;
        this._processListInFlight = true;
        this._lastProcessSampleAt = this.now();
        try {
            const list = await this.getProcessList();
            const names = new Set();
            if (Array.isArray(list)) {
                for (const item of list) {
                    const name = canonicalProcessName(typeof item === 'string' ? item : item && item.name);
                    if (name) names.add(name);
                }
            }
            // Boş liste = sağlayıcı hatası. Eski liste korunur ve stale işaretlenir;
            // "süreç kapandı" yanlış tetiklemesi engellenir.
            if (names.size === 0) {
                this.currentMetrics.processListStale = true;
                this.currentMetrics.runningProcesses = [];
                return;
            }
            this.currentMetrics.runningProcesses = Array.from(names);
            this.currentMetrics.processListAt = this.now();
            this.currentMetrics.processListStale = false;
        } catch (_) {
            // Sağlayıcı hatası: koşul motoru fail-closed davranır.
            this.currentMetrics.processListStale = true;
            this.currentMetrics.runningProcesses = [];
        } finally {
            this._processListInFlight = false;
        }
    }

    async sampleIdle() {
        // WP-04: PowerShell GetLastInputInfo yerine Electron powerMonitor.
        // Sağlayıcı yoksa 0 = "kullanıcı aktif" (uzaktan kapatma için fail-closed).
        try {
            if (this.idleProvider) {
                const secs = Number(await this.idleProvider());
                this.currentMetrics.userIdleSeconds = Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : 0;
                return;
            }
            if (this.powerMonitor && typeof this.powerMonitor.getSystemIdleTime === 'function') {
                const secs = Number(this.powerMonitor.getSystemIdleTime());
                this.currentMetrics.userIdleSeconds = Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : 0;
                return;
            }
        } catch (_) { /* fail-closed: 0 */ }
        this.currentMetrics.userIdleSeconds = 0;
    }

    async sampleNetwork() {
        // Network: tüm fiziksel + sanal arayüzlerin toplamı (VPN dahil).
        try {
            const netStats = await this.si.networkStats('*');
            const list = Array.isArray(netStats) ? netStats : [netStats];
            let rxBytesSec = 0, txBytesSec = 0;
            for (const iface of list) {
                // İlk çağrıda kütüphane -1 döner → 0'a kelepçele.
                if (typeof iface.rx_sec === 'number' && iface.rx_sec > 0) rxBytesSec += iface.rx_sec;
                if (typeof iface.tx_sec === 'number' && iface.tx_sec > 0) txBytesSec += iface.tx_sec;
            }
            this.currentMetrics.networkDownloadKbps = Math.round((rxBytesSec * 8) / 1000);
            this.currentMetrics.networkUploadKbps = Math.round((txBytesSec * 8) / 1000);
        } catch (_) {
            // Ölçüm yoksa önceki değer korunur; sıfırlanmaz (yanlış tetikleme önlenir).
        }
    }

    async sampleDisks() {
        try {
            const disks = await this.si.disksIO();
            const rSec = typeof disks.rIO_sec === 'number' && disks.rIO_sec > 0 ? disks.rIO_sec : 0;
            const wSec = typeof disks.wIO_sec === 'number' && disks.wIO_sec > 0 ? disks.wIO_sec : 0;
            // WP-13.T3: `disksIO` saniyedeki IOPS döndürür; KB/sn değildir.
            this.currentMetrics.diskIops = Math.round(rSec + wSec);
        } catch (_) { /* önceki değer korunur */ }
        // P1-6: Ayrıca GERÇEK verim (KB/sn) ölçülür. Şablonlar `thresholdKbps`
        // gönderiyor; bu değeri IOPS ile kıyaslamak "disk tam yükteyken boş"
        // yanılgısına yol açıyordu. `fsStats` rx/wx_sec bayt/sn döndürür.
        try {
            const fs = await this.si.fsStats();
            const rx = typeof fs.rx_sec === 'number' && fs.rx_sec > 0 ? fs.rx_sec : 0;
            const wx = typeof fs.wx_sec === 'number' && fs.wx_sec > 0 ? fs.wx_sec : 0;
            this.currentMetrics.diskKbps = Math.round((rx + wx) / 1024);
        } catch (_) { /* önceki değer korunur */ }
    }

    async sampleBattery() {
        // WP-13.T3: pil 30 sn'de bir okunur (her 5 sn tick'te USB/batarya sorgusu yok).
        const now = this.now();
        if (this._lastBatteryAt && (now - this._lastBatteryAt) < this.batteryIntervalMs) return;
        this._lastBatteryAt = now;
        try {
            const battery = await this.si.battery();
            if (battery && battery.hasBattery === true) {
                this.currentMetrics.batterySupported = true;
                this.currentMetrics.batteryLevelPercent = typeof battery.percent === 'number' ? battery.percent : null;
                this.currentMetrics.isCharging = typeof battery.isCharging === 'boolean' ? battery.isCharging : null;
            } else if (battery && battery.hasBattery === false) {
                this.currentMetrics.batterySupported = false;
                this.currentMetrics.batteryLevelPercent = null;
                this.currentMetrics.isCharging = null;
            }
            // hasBattery tanımsızsa (bazı Windows sürücüleri) önceki değer korunur.
        } catch (_) { /* önceki değer korunur */ }
    }

    async sampleSystemInformation() {
        // Geriye uyumlu yardımcı: üç alt ölçümü birlikte çalıştırır.
        await Promise.allSettled([this.sampleNetwork(), this.sampleDisks(), this.sampleBattery()]);
    }

    getMetrics() {
        return this.currentMetrics;
    }
}

module.exports = MetricCollector;
