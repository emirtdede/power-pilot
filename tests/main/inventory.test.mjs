/**
 * inventory.test.mjs - FAZ B
 * powercfg -a ayrıştırma, NIC/subnet hesabı, toplama, offline eşiği.
 */
import { describe, it, expect, vi } from 'vitest';
import { InventoryService, OFFLINE_THRESHOLD_MS } from '../../src/main/services/InventoryService.js';

const S0_OUT = `The following sleep states are available on this system:
    Standby (S0 Low Power Idle)
    Hibernate
    Fast Startup
The following sleep states are not available on this system:
    Standby (S3)`;

const S3_OUT = `The following sleep states are available on this system:
    Standby (S3)
    Hibernate`;

describe('InventoryService.parseSleepStates', () => {
    it('S0 cihazı ayırt eder', () => {
        const s = InventoryService.parseSleepStates(S0_OUT);
        expect(s.standbyS0).toBe(true);
        expect(s.hibernate).toBe(true);
    });

    it('S3 cihazı ayırt eder', () => {
        const s = InventoryService.parseSleepStates(S3_OUT);
        expect(s.standbyS3).toBe(true);
        expect(s.standbyS0).toBe(false);
    });
});

describe('InventoryService ağ yardımcıları', () => {
    it('subnet hesabı doğru', () => {
        expect(InventoryService.subnetOf('192.168.1.42', '255.255.255.0')).toBe('192.168.1.0/24');
        expect(InventoryService.subnetOf('10.0.5.7', '255.255.0.0')).toBe('10.0.0.0/16');
    });

    it('parseNics iç arayüzleri atlar', () => {
        const nics = InventoryService.parseNics({
            lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00' }],
            eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42', netmask: '255.255.255.0', mac: 'AA:BB:CC:DD:EE:FF' }]
        });
        expect(nics).toHaveLength(1);
        expect(nics[0].subnet).toBe('192.168.1.0/24');
        expect(nics[0].mac).toBe('AA:BB:CC:DD:EE:FF');
    });
});

describe('InventoryService.isOffline', () => {
    it('15dk eşiği', () => {
        expect(OFFLINE_THRESHOLD_MS).toBe(15 * 60 * 1000);
        expect(InventoryService.isOffline(null)).toBe(true);
        expect(InventoryService.isOffline(new Date().toISOString())).toBe(false);
        expect(InventoryService.isOffline(new Date(Date.now() - 16 * 60000).toISOString())).toBe(true);
    });
});

describe('InventoryService.collect', () => {
    function makeService(settings = {}) {
        const storage = {
            getSettings: () => Object.assign({ deviceWattage: null }, settings),
            saveInventory: vi.fn(),
            appendBoot: vi.fn()
        };
        const fakeOs = {
            hostname: () => 'PILOT-PC-01',
            userInfo: () => ({ username: 'operator' }),
            platform: () => 'win32',
            release: () => '10.0.22631',
            version: () => 'Windows 11 Pro',
            arch: () => 'x64',
            cpus: () => [{ model: 'Intel i7' }],
            uptime: () => 3600,
            networkInterfaces: () => ({})
        };
        const execFn = (file, args, opts, cb) => cb(null, S3_OUT);
        return { svc: new InventoryService({ storageService: storage, execFn, osModule: fakeOs, agentVersion: '1.0.0' }), storage };
    }

    it('envanteri toplar ve kaydeder', async () => {
        const { svc, storage } = makeService();
        const inv = await svc.collect();
        expect(inv.agentId).toBe('agent-pilot-pc-01');
        expect(inv.hostname).toBe('PILOT-PC-01');
        expect(inv.sleepStates.standbyS3).toBe(true);
        expect(inv.agentVersion).toBe('1.0.0');
        expect(inv.watt).toBeNull(); // bilinmiyorsa uydurulmaz
        expect(storage.saveInventory).toHaveBeenCalledTimes(1);
    });

    it('kayıtlı agentId önceliklidir', async () => {
        const { svc } = makeService({ agentId: 'agent-ozel-07' });
        const inv = await svc.collect();
        expect(inv.agentId).toBe('agent-ozel-07');
    });

    it('bootAt + deviceRole envanterde, açılış geçmişe işlenir', async () => {
        const { svc, storage } = makeService({ deviceRole: 'server' });
        const inv = await svc.collect();
        expect(typeof inv.bootAt).toBe('string');
        expect(inv.deviceRole).toBe('server');
        expect(storage.appendBoot).toHaveBeenCalledWith(inv.bootAt);
    });
});

describe('InventoryService FAZ D ayrıştırıcıları', () => {
    it('parseRegTimeout saniyeyi okur', () => {
        expect(InventoryService.parseRegTimeout('    ScreenSaveTimeOut    REG_SZ    600')).toBe(600);
        expect(InventoryService.parseRegTimeout('boş çıktı')).toBeNull();
    });

    it('getLockPolicy GPO önceliklidir', async () => {
        const svc = new InventoryService({
            execFn: (file, args, opts, cb) => {
                if (args.some((a) => String(a).includes('Policies'))) return cb(null, '    ScreenSaveTimeOut    REG_SZ    300');
                return cb(null, '    ScreenSaveTimeOut    REG_SZ    900');
            }
        });
        const lp = await svc.getLockPolicy();
        expect(lp).toEqual({ timeoutSec: 300, enforcedByGpo: true });
    });

    it('getLockPolicy kayıtsızsa null', async () => {
        const svc = new InventoryService({ execFn: (file, args, opts, cb) => cb(new Error('yok'), null) });
        expect(await svc.getLockPolicy()).toBeNull();
    });
});
