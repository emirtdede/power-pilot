/**
 * device-profiler.test.mjs - WBS-E3 / TS-E3
 * Kasa sınıflandırma, katman tahmini, deşarj ölçümü, profil karar ağacı,
 * arka-plan kalibrasyonu. Donanım yok - sahte exec/bilgi.
 */
import { describe, it, expect, vi } from 'vitest';
import { DeviceProfiler } from '../../src/main/services/DeviceProfiler.js';

function execWith(routes) {
    // routes: [[anahtarKelime, stdout], ...] - ilk eşleşme kazanır.
    return vi.fn((file, args, opts, cb) => {
        const cmd = [file, ...(args || [])].join(' ');
        for (const [key, out] of routes) {
            if (String(cmd).includes(key)) return cb(null, out);
        }
        return cb(new Error('bilinmeyen komut'), '');
    });
}

const HW_JSON = (chassis, manu = 'LENOVO', model = 'ThinkPad', cpu = 'Intel Core i5-1235U', gpus = ['Intel Iris Xe']) =>
    JSON.stringify({ chassis, manu, model, cpu, gpus });

describe('DeviceProfiler sınıflandırma (TS-E3)', () => {
    it('kasa kodları doğru sınıfa gider', () => {
        expect(DeviceProfiler.classifyChassis([9])).toBe('laptop');
        expect(DeviceProfiler.classifyChassis([10])).toBe('laptop');
        expect(DeviceProfiler.classifyChassis([8, 14])).toBe('laptop');
        expect(DeviceProfiler.classifyChassis([3])).toBe('desktop');
        expect(DeviceProfiler.classifyChassis([6])).toBe('desktop');
        expect(DeviceProfiler.classifyChassis([23])).toBe('server');
        expect(DeviceProfiler.classifyChassis([])).toBe('unknown');
        expect(DeviceProfiler.classifyChassis(null)).toBe('unknown');
    });

    it('VM imalatçıdan yakalanır', () => {
        expect(DeviceProfiler.isVirtualMachine('VMware, Inc.', 'VMware7,1')).toBe(true);
        expect(DeviceProfiler.isVirtualMachine('Microsoft', 'Virtual Machine')).toBe(true);
        expect(DeviceProfiler.isVirtualMachine('LENOVO', 'ThinkPad')).toBe(false);
    });

    it('katman tahmini donanım ibarelerine uyar', () => {
        expect(DeviceProfiler.estimateTier({ deviceClass: 'laptop', cpuBrand: 'Intel i9-14900HX', gpus: ['NVIDIA RTX 4070'] }))
            .toEqual({ watt: 150, tier: 'gaming-laptop' });
        expect(DeviceProfiler.estimateTier({ deviceClass: 'laptop', cpuBrand: 'Intel i5-1235U', gpus: [] }).watt).toBe(45);
        expect(DeviceProfiler.estimateTier({ deviceClass: 'desktop', cpuBrand: 'Ryzen 9 7950X', gpus: ['RTX 4080'] }).watt).toBe(250);
        expect(DeviceProfiler.estimateTier({ deviceClass: 'desktop', cpuBrand: 'i3-12100', gpus: [] }).watt).toBe(120);
        expect(DeviceProfiler.estimateTier({ deviceClass: 'unknown', cpuBrand: '', gpus: [] }).watt).toBe(100);
    });
});

describe('DeviceProfiler ölçüm (TS-E3)', () => {
    it('deşarj medyanı alınır, akıl-dışı elenir', async () => {
        let calls = 0;
        const execFn = vi.fn((file, args, opts, cb) => {
            calls += 1;
            cb(null, String([38000, 41000, 39000][calls - 1]));
        });
        const p = new DeviceProfiler({ execFn });
        expect(await p.measureDischargeMw()).toEqual({ ok: true, mw: 39000 });
        expect(calls).toBe(3);
    });

    it('sürücü sıfırı/bozuk → NO_READING', async () => {
        const p = new DeviceProfiler({ execFn: vi.fn((file, args, opts, cb) => cb(null, '0')) });
        expect(await p.measureDischargeMw()).toEqual({ ok: false, code: 'NO_READING' });
        const p2 = new DeviceProfiler({ execFn: vi.fn((file, args, opts, cb) => cb(new Error('x'), '')) });
        expect(await p2.measureDischargeMw()).toEqual({ ok: false, code: 'NO_READING' });
    });

    it('pilde profil measured döner', async () => {
        const execFn = execWith([
            ['Win32_SystemEnclosure', HW_JSON([9])],
            ['BatteryStatus', '38000']
        ]);
        const p = new DeviceProfiler({ execFn });
        const r = await p.profile({ isCharging: false, hasBattery: true });
        expect(r.deviceClass).toBe('laptop');
        expect(r.wattSource).toBe('measured');
        expect(r.confidence).toBe('high');
        expect(r.wattW).toBe(38);
    });

    it('takılıyken ölçüm denenmez, katman tahmini döner', async () => {
        const seen = [];
        const execFn = vi.fn((file, args, opts, cb) => {
            const cmd = [file, ...(args || [])].join(' ');
            seen.push(cmd);
            if (String(cmd).includes('Win32_SystemEnclosure')) return cb(null, HW_JSON([3], 'ASUS', 'ROG', 'i9-14900HX', ['RTX 4070']));
            return cb(new Error('yok'), '');
        });
        const p = new DeviceProfiler({ execFn });
        const r = await p.profile({ isCharging: true, hasBattery: true });
        expect(r.wattSource).toBe('estimated');
        expect(r.wattW).toBe(250);
        expect(seen.some((c) => String(c).includes('BatteryStatus'))).toBe(false);
    });

    it('pil yoksa masaüstü katmanı + pil sorgusu yok', async () => {
        const execFn = execWith([['Win32_SystemEnclosure', HW_JSON([3])]]);
        const p = new DeviceProfiler({ execFn });
        const r = await p.profile({ isCharging: null, hasBattery: false });
        expect(r.deviceClass).toBe('desktop');
        expect(r.wattW).toBe(120);
    });

    it('chassis bilinmiyorsa pil varlığı dizüstü sayar', async () => {
        const execFn = execWith([['Win32_SystemEnclosure', HW_JSON([])]]);
        const p = new DeviceProfiler({ execFn });
        const r = await p.profile({ isCharging: true, hasBattery: true });
        expect(r.deviceClass).toBe('laptop');
    });

    it('T-SAF-04: VM algılanan cihaz deviceClass=vm; başka sınıf ezmez', async () => {
        const p = new DeviceProfiler({
            systemInfo: { chassisTypes: [3], manufacturer: 'VMware, Inc.', model: 'VMware7,1', cpuBrand: 'Xeon', gpus: [] }
        });
        const r = await p.profile({ isCharging: false, hasBattery: true });
        expect(r.vm).toBe(true);
        expect(r.deviceClass).toBe('vm');
        expect(r.wattSource).toBe('estimated');
    });
});

describe('DeviceProfiler arka-plan kalibrasyonu (TS-E3)', () => {
    function storageWith(settings) {
        return {
            getSettings: () => ({ ...settings }),
            updateSettings: vi.fn(function (patch) { Object.assign(settings, patch); })
        };
    }

    it('ölçülmüş + taze ise dokunmaz (FRESH)', async () => {
        const storage = storageWith({ wattSource: 'measured', wattMeasuredAt: Date.now() });
        const p = new DeviceProfiler({ execFn: vi.fn() });
        const r = await p.calibrateIfNeeded(storage, { isCharging: false, hasBattery: true });
        expect(r).toEqual({ measured: false, reason: 'FRESH' });
        expect(storage.updateSettings).not.toHaveBeenCalled();
    });

    it('pilde değilse ölçmez (NOT_ON_BATTERY)', async () => {
        const storage = storageWith({ wattSource: 'unset' });
        const execFn = vi.fn();
        const p = new DeviceProfiler({ execFn });
        expect(await p.calibrateIfNeeded(storage, { isCharging: true, hasBattery: true }))
            .toEqual({ measured: false, reason: 'NOT_ON_BATTERY' });
        expect(execFn).not.toHaveBeenCalled();
    });

    it('pilde ölçer + kaydeder + ilk başarı bayrağı', async () => {
        const storage = storageWith({ wattSource: 'estimated' });
        const p = new DeviceProfiler({ execFn: vi.fn((file, args, opts, cb) => cb(null, '42000')) });
        const r = await p.calibrateIfNeeded(storage, { isCharging: false, hasBattery: true });
        expect(r).toEqual({ measured: true, wattW: 42 });
        expect(storage.updateSettings).toHaveBeenCalledWith(
            expect.objectContaining({ deviceWattage: 42, wattSource: 'measured' })
        );
        expect(typeof storage.getSettings().wattMeasuredAt).toBe('number');
    });

    it('30+ günlük ölçüm tazelenir', async () => {
        const storage = storageWith({ wattSource: 'measured', wattMeasuredAt: Date.now() - 31 * 86400000 });
        const p = new DeviceProfiler({ execFn: vi.fn((file, args, opts, cb) => cb(null, '50000')) });
        const r = await p.calibrateIfNeeded(storage, { isCharging: false, hasBattery: true });
        expect(r.measured).toBe(true);
        expect(r.wattW).toBe(50);
    });
});

describe('DeviceProfiler.recommendAiTier - 3 Kademeli Yerel AI Donanım Önerisi (TS-2.1)', () => {
    const GB = 1073741824;

    it('6 GB RAM -> lite (LOW_RAM) önerir ve balanced/powerful için uyarı üretir', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 6 * GB,
            cpuCores: 4,
            freeDiskBytes: 50 * GB,
            hw: { manufacturer: 'LENOVO', model: 'IdeaPad', cpuBrand: 'Intel Core i3', gpus: ['Intel UHD Graphics'] }
        });
        expect(r.recommendedTier).toBe('lite');
        expect(r.reasonCode).toBe('LOW_RAM');
        expect(r.tierWarnings.balanced).toBe('LOW_RAM_FOR_BALANCED');
        expect(r.tierWarnings.powerful).toBe('LOW_RAM_FOR_POWERFUL');
    });

    it('32 GB RAM + RTX 4080 olsa bile boş disk < 1.6 GB ise lite (LOW_DISK) önerir', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 32 * GB,
            cpuCores: 16,
            freeDiskBytes: 1.2 * GB,
            hw: { manufacturer: 'ASUS', model: 'ROG', cpuBrand: 'Intel i9', gpus: ['NVIDIA GeForce RTX 4080'] }
        });
        expect(r.recommendedTier).toBe('lite');
        expect(r.reasonCode).toBe('LOW_DISK');
    });

    it('Sanal makine (VMware/Hyper-V) -> lite (VM_DETECTED) önerir', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 16 * GB,
            cpuCores: 8,
            freeDiskBytes: 80 * GB,
            hw: { manufacturer: 'VMware, Inc.', model: 'VMware7,1', cpuBrand: 'Xeon', gpus: ['VMware SVGA 3D'] }
        });
        expect(r.recommendedTier).toBe('lite');
        expect(r.reasonCode).toBe('VM_DETECTED');
        expect(r.isVm).toBe(true);
    });

    it('16 GB RAM + Entegre GPU (Intel Iris Xe) -> balanced (STANDARD_HW) önerir (paylaşımlı VRAM koruması)', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 16 * GB,
            cpuCores: 8,
            freeDiskBytes: 60 * GB,
            hw: { manufacturer: 'LENOVO', model: 'ThinkPad', cpuBrand: 'Intel Core i7-1355U', gpus: ['Intel Iris Xe Graphics'] }
        });
        expect(r.hasDiscreteGpu).toBe(false);
        expect(r.recommendedTier).toBe('balanced');
        expect(r.reasonCode).toBe('STANDARD_HW');
        expect(r.tierWarnings.powerful).toBe('INTEGRATED_GPU_HEAVY');
    });

    it('16 GB RAM + Harici GPU (NVIDIA RTX 4070) -> powerful (HIGH_END_HW) önerir', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 16 * GB,
            cpuCores: 8,
            freeDiskBytes: 60 * GB,
            hw: { manufacturer: 'MSI', model: 'Katana', cpuBrand: 'Intel Core i7-13620H', gpus: ['Intel UHD', 'NVIDIA GeForce RTX 4070 Laptop GPU'] }
        });
        expect(r.hasDiscreteGpu).toBe(true);
        expect(r.recommendedTier).toBe('powerful');
        expect(r.reasonCode).toBe('HIGH_END_HW');
        expect(r.tierWarnings.powerful).toBeNull();
    });

    it('32 GB RAM + 12 Çekirdek CPU (harici GPU olmasa bile) -> powerful (HIGH_END_HW) önerir', () => {
        const r = DeviceProfiler.recommendAiTier({
            totalRamBytes: 32 * GB,
            cpuCores: 12,
            freeDiskBytes: 100 * GB,
            hw: { manufacturer: 'DELL', model: 'OptiPlex', cpuBrand: 'Intel Core i7-14700', gpus: ['Intel UHD Graphics 770'] }
        });
        expect(r.recommendedTier).toBe('powerful');
        expect(r.reasonCode).toBe('HIGH_END_HW');
    });
});
