/**
 * DeviceProfiler.js - WBS-E3
 * Cihaz sınıfı + watt tahmini/ölçümü. Tüm dış çağrılar enjekte edilebilir
 * (exec/si), böylece birim testler donanımsız koşar.
 *
 * Karar ağacı:
 *  1. Kasa sınıfı: ChassisTypes → laptop/desktop/server/unknown (+VM bayrağı),
 *     yedek: pil varlığı, en son: bilinmiyor.
 *  2. Watt: pilde + deşarj>0 ise 3 örnek medyanı (gerçek ölçüm);
 *     değilse donanım katmanı (tahmin); hiçbiri yoksa sınıf varsayılanı.
 * Ölçüm asla sihirbazda istenmez - arka-plan kalibrasyonu ayrı çalışır.
 */

const { execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const log = require('../logger');

// ChassisTypes → sınıf (Microsoft Learn dokümanlı kodlar).
const LAPTOP_CHASSIS = new Set([8, 9, 10, 11, 12, 14]);
const DESKTOP_CHASSIS = new Set([3, 4, 5, 6, 7, 15, 16]);
const SERVER_CHASSIS = new Set([17, 23]);

class DeviceProfiler {
    constructor({ execFn = null, systemInfo = null } = {}) {
        // execFn imzası execFile ile aynıdır: (file, args, options, callback).
        this.execFile = execFn || execFile;
        this._dischargeCache = null;
        this._hwCache = null;
        // systemInfo: { chassisTypes:number[], manufacturer, model, cpuBrand, gpus:string[], battery:{hasBattery} }
        // verilmezse donanım okunur (aşağıdaki gatherHardware).
        this.systemInfo = systemInfo || null;
    }

    static isDiscreteGpu(gpus = []) {
        const list = Array.isArray(gpus) ? gpus : [gpus];
        const joined = list.filter(Boolean).join(' ');
        if (!joined) return false;
        // Harici masaüstü / dizüstü GPU ailesi (NVIDIA RTX/GTX/Quadro, AMD Radeon RX, Intel Arc A/B serisi)
        return /\b(?:NVIDIA|GeForce\s+(?:RTX|GTX)|Quadro|RTX\s*\d{3,4}|GTX\s*\d{3,4}|Radeon\s+RX\s*\d{3,4}|Intel\s+Arc\s+[AB]\d{3})\b/i.test(joined);
    }

    /**
     * WP-2.1: Sistem özelliklerine göre deterministik yerel AI kademe önerisi.
     * Karar kuralları:
     *  1. Boş disk < 1.6 GB VEYA VM VEYA Toplam RAM < 7.5 GB -> 'lite' (536 MB)
     *  2. Boş disk >= 3.2 GB VE ((RAM >= 15.5 GB VE Harici GPU) VEYA (RAM >= 23.5 GB VE >= 8 Çekirdek)) -> 'powerful' (2.69 GB)
     *  3. Diğer tüm standart 8-23 GB sistemler -> 'balanced' (1.43 GB)
     */
    static recommendAiTier({ totalRamBytes = os.totalmem(), cpuCores = (os.cpus() || []).length || 4, freeDiskBytes = null, hw = null } = {}) {
        const ramGb = Math.round((Number(totalRamBytes || 0) / 1073741824) * 10) / 10;
        const cores = Math.max(1, Number(cpuCores) || 4);
        const freeDiskGb = Number.isFinite(freeDiskBytes) && freeDiskBytes !== null
            ? Math.round((freeDiskBytes / 1073741824) * 10) / 10
            : null;
        const gpus = (hw && Array.isArray(hw.gpus)) ? hw.gpus.filter(Boolean) : [];
        const cpuBrand = (hw && hw.cpuBrand) ? String(hw.cpuBrand).trim() : ((os.cpus() && os.cpus()[0] && os.cpus()[0].model) ? String(os.cpus()[0].model).trim() : '');
        const isVm = !!(hw && DeviceProfiler.isVirtualMachine(hw.manufacturer, hw.model));
        const hasDiscreteGpu = DeviceProfiler.isDiscreteGpu(gpus);
        const discreteGpuName = gpus.find((g) => DeviceProfiler.isDiscreteGpu([g])) || gpus[0] || '';

        let recommendedTier = 'balanced';
        let reasonCode = 'STANDARD_HW';

        if (freeDiskGb !== null && freeDiskGb < 1.6) {
            recommendedTier = 'lite';
            reasonCode = 'LOW_DISK';
        } else if (isVm) {
            recommendedTier = 'lite';
            reasonCode = 'VM_DETECTED';
        } else if (ramGb < 7.5) {
            recommendedTier = 'lite';
            reasonCode = 'LOW_RAM';
        } else if (
            (freeDiskGb === null || freeDiskGb >= 3.2) &&
            ((ramGb >= 15.5 && hasDiscreteGpu) || (ramGb >= 23.5 && cores >= 8))
        ) {
            recommendedTier = 'powerful';
            reasonCode = 'HIGH_END_HW';
        }

        const tierWarnings = {
            lite: null,
            balanced: ramGb < 7.5 ? 'LOW_RAM_FOR_BALANCED' : (freeDiskGb !== null && freeDiskGb < 1.6 ? 'LOW_DISK_FOR_BALANCED' : null),
            powerful: ramGb < 15.5 ? 'LOW_RAM_FOR_POWERFUL' : (freeDiskGb !== null && freeDiskGb < 3.2 ? 'LOW_DISK_FOR_POWERFUL' : (!hasDiscreteGpu && ramGb < 23.5 ? 'INTEGRATED_GPU_HEAVY' : null))
        };

        return {
            ramGb,
            cpuCores: cores,
            cpuBrand,
            gpuSummary: discreteGpuName,
            hasDiscreteGpu,
            isVm,
            freeDiskGb,
            recommendedTier,
            reasonCode,
            tierWarnings
        };
    }

    async getAiHardwareProfile(modelDir = null) {
        let freeDiskBytes = null;
        if (modelDir && typeof fs.promises.statfs === 'function') {
            try {
                const targetDir = fs.existsSync(modelDir) ? modelDir : require('path').dirname(modelDir);
                const st = await fs.promises.statfs(targetDir);
                const val = Number(st.bavail) * Number(st.bsize);
                if (Number.isFinite(val) && val >= 0) freeDiskBytes = val;
            } catch (_) { /* statfs desteklenmiyorsa null kalır */ }
        }
        let hw = this._hwCache;
        if (!hw) {
            hw = await this.gatherHardware();
            this._hwCache = hw;
        }
        return DeviceProfiler.recommendAiTier({
            totalRamBytes: os.totalmem(),
            cpuCores: (os.cpus() || []).length || 4,
            freeDiskBytes,
            hw
        });
    }

    static classifyChassis(types) {
        const list = Array.isArray(types) ? types : [];
        if (list.some((t) => LAPTOP_CHASSIS.has(t))) return 'laptop';
        if (list.some((t) => DESKTOP_CHASSIS.has(t))) return 'desktop';
        if (list.some((t) => SERVER_CHASSIS.has(t))) return 'server';
        return 'unknown';
    }

    static isVirtualMachine(manufacturer, model) {
        return /vmware|virtual|hyper-v|xen|kvm|parallels|amazon ec2|google compute|qemu/i
            .test(`${manufacturer || ''} ${model || ''}`);
    }

    // Donanım adlarından katman tahmini: {watt, tier}.
    // Aralıklar araştırma-temelli (ultrabook 25-45, ofis 45-65/60-100,
    // oyuncu dizüstü 100-200, oyuncu masaüstü 200-350); orta nokta alınır.
    static estimateTier({ deviceClass, cpuBrand, gpus }) {
        const cpu = String(cpuBrand || '');
        const gpuList = Array.isArray(gpus) ? gpus : [];
        const gpu = gpuList.join(' ');
        const gaming = /HX\b|HX$|RTX|RX 7\d00|Radeon 7\d+M/i.test(`${cpu} ${gpu}`);
        if (deviceClass === 'laptop') {
            return gaming ? { watt: 150, tier: 'gaming-laptop' } : { watt: 45, tier: 'office-laptop' };
        }
        if (deviceClass === 'desktop' || deviceClass === 'server') {
            return gaming ? { watt: 250, tier: 'gaming-desktop' } : { watt: 120, tier: 'office-desktop' };
        }
        return { watt: 100, tier: 'unknown' };
    }

    runPowerShell(script, timeoutMs = 15000) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => done(''), timeoutMs);
            timer.unref?.();
            this.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: timeoutMs }, (err, stdout) => {
                if (err || !stdout) return done('');
                done(String(stdout));
            });
        });
    }

    // Kasa + üretici + CPU/GPU adlarını tek PowerShell çağrısında toplar.
    async gatherHardware() {
        if (this.systemInfo) return this.systemInfo;
        if (this._hwCache) return this._hwCache;
        const psCmd = "$e=Get-CimInstance Win32_SystemEnclosure; $c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor | Select-Object -First 1; $g=Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name; @{chassis=@($e.ChassisTypes); manu=$c.Manufacturer; model=$c.Model; cpu=$p.Name; gpus=@($g)} | ConvertTo-Json -Compress -Depth 2";
        try {
            const out = await this.runPowerShell(psCmd);
            const parsed = JSON.parse(out.trim());
            const hw = {
                chassisTypes: Array.isArray(parsed.chassis) ? parsed.chassis.map(Number) : [],
                manufacturer: parsed.manu || '',
                model: parsed.model || '',
                cpuBrand: parsed.cpu || '',
                gpus: Array.isArray(parsed.gpus) ? parsed.gpus : (parsed.gpus ? [parsed.gpus] : []),
                battery: null // pil varlığı MetricCollector/systeminformation katmanından gelir
            };
            this._hwCache = hw;
            return hw;
        } catch (_) {
            return { chassisTypes: [], manufacturer: '', model: '', cpuBrand: '', gpus: [], battery: null };
        }
    }

    // Deşarj hızı (mW) medyanı; sürücü 0/saçma değerde {ok:false}.
    async measureDischargeMw(samples = 3) {
        // O-15: örnekler tek-uçuş (single-flight) kilidi ve sıralı toplamayla 5 sn bütçede alınır, sonuç cache'lenir.
        if (this._dischargeCache && (Date.now() - this._dischargeCache.at) < 5 * 60 * 1000) {
            return this._dischargeCache.value;
        }
        if (this._dischargeInFlight) return this._dischargeInFlight;
        const script = '(Get-CimInstance -Namespace root/wmi -ClassName BatteryStatus | Measure-Object -Property DischargeRate -Sum).Sum';
        this._dischargeInFlight = (async () => {
            const count = Math.max(1, samples);
            const outputs = [];
            for (let i = 0; i < count; i += 1) {
                outputs.push(await this.runPowerShell(script, 5000));
            }
            const readings = [];
            for (const out of outputs) {
                const val = parseInt(String(out).trim(), 10);
                // 5W altı ve 500W üstü dizüstü için akıl-dışı -> elenir.
                if (Number.isFinite(val) && val >= 5000 && val <= 500000) readings.push(val);
            }
            if (readings.length === 0) {
                return { ok: false, code: 'NO_READING' };
            }
            readings.sort((a, b) => a - b);
            const median = readings[Math.floor(readings.length / 2)];
            const result = { ok: true, mw: median };
            this._dischargeCache = { at: Date.now(), value: result };
            return result;
        })();
        try {
            return await this._dischargeInFlight;
        } finally {
            this._dischargeInFlight = null;
        }
    }

    /**
     * Tam profil: sınıf + watt + kaynak + güven.
     * @param {{isCharging:boolean|null, hasBattery:boolean}|null} battery - MetricCollector'dan
     */
    async profile(battery = null) {
        const hw = await this.gatherHardware();
        const vm = DeviceProfiler.isVirtualMachine(hw.manufacturer, hw.model);
        let deviceClass = DeviceProfiler.classifyChassis(hw.chassisTypes);
        if (deviceClass === 'unknown' && battery && battery.hasBattery) deviceClass = 'laptop';
        // WP-09.T5: VM algılandıysa sınıf 'vm' olur; sonraki tahmin onu ezmez.
        if (vm) deviceClass = 'vm';

        // Pilde + deşarj oluyorsa gerçek ölçüm denenir.
        const onBattery = battery && battery.hasBattery && battery.isCharging === false;
        if (onBattery && !vm) {
            const measured = await this.measureDischargeMw();
            if (measured.ok) {
                return {
                    deviceClass, vm,
                    wattW: Math.round(measured.mw / 1000),
                    wattSource: 'measured',
                    confidence: 'high',
                    note: 'Pilden ölçüldü (o anki kullanım)'
                };
            }
        }
        const tier = DeviceProfiler.estimateTier({ deviceClass, cpuBrand: hw.cpuBrand, gpus: hw.gpus });
        return {
            deviceClass, vm,
            wattW: tier.watt,
            wattSource: 'estimated',
            confidence: 'medium',
            tier: tier.tier,
            note: 'Donanımdan tahmin (ölçüm değil)'
        };
    }

    /**
     * Arka-plan kalibrasyonu (açılışta bir kez denetlenir, sessiz).
     * Koşullar: watt henüz ölçülmemiş + pilde + deşarj var + son ölçüm 30+ günlük değil.
     * @returns {Promise<{measured:boolean, wattW?:number, reason?:string}>}
     */
    async calibrateIfNeeded(storage, battery = null) {
        const settings = storage.getSettings();
        if (settings.wattSource === 'measured') {
            const age = settings.wattMeasuredAt ? Date.now() - settings.wattMeasuredAt : Infinity;
            if (age < 30 * 86400000) return { measured: false, reason: 'FRESH' };
        }
        const onBattery = battery && battery.hasBattery && battery.isCharging === false;
        if (!onBattery) return { measured: false, reason: 'NOT_ON_BATTERY' };
        const measured = await this.measureDischargeMw();
        if (!measured.ok) return { measured: false, reason: 'NO_READING' };
        const wattW = Math.round(measured.mw / 1000);
        storage.updateSettings({ deviceWattage: wattW, wattSource: 'measured', wattMeasuredAt: Date.now() });
        log.info(`[DeviceProfiler] arka-plan kalibrasyonu: ${wattW}W`);
        return { measured: true, wattW };
    }
}

module.exports = { DeviceProfiler };
