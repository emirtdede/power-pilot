/**
 * inventory-service-core.test.mjs - envanter toplama + saf ayrıştırıcılar
 * Tüm alt süreçler ve os çağrıları enjekte edilir (spawn yok).
 */
import { describe, it, expect, vi } from 'vitest';
import { InventoryService as InventoryServiceClass } from '../../src/main/services/InventoryService.js';

const InventoryService = InventoryServiceClass;

const POWERCFG_A = [
    'The following sleep states are available on this system:',
    '    Standby (S3)',
    '    Hibernate',
    '    Fast Startup',
    '',
    'The following sleep states are not available on this system:',
    '    Standby (S0 Low Power Idle)'
].join('\n');

function fakeOs(over = {}) {
    return Object.assign({
        hostname: () => 'PC-ONE',
        userInfo: () => ({ username: 'emir' }),
        version: () => 'Windows 11 Pro',
        platform: () => 'win32',
        release: () => '10.0.26100',
        arch: () => 'x64',
        uptime: () => 3600,
        cpus: () => [{ model: 'Test CPU' }],
        networkInterfaces: () => ({
            Ethernet: [
                { family: 'IPv4', internal: false, address: '192.168.1.20', netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:ff' },
                { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff:ffff::', mac: 'aa:bb:cc:dd:ee:ff' },
                { family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00' }
            ],
            Empty: null
        })
    }, over);
}

function fakeExec(map = {}) {
    return vi.fn((file, args, opts, cb) => {
        const key = String(file).toLowerCase();
        const handler = map[key];
        if (handler) return handler(args, cb);
        return cb(new Error('yok'), '');
    });
}

const defaultMap = () => ({
    'powercfg.exe': (args, cb) => cb(null, args[0] === '-a' ? POWERCFG_A : 'Intel(R) Ethernet\nUSB Root Hub'),
    'powershell.exe': (args, cb) => cb(null, 'Name : Ethernet\nWakeOnMagicPacket : Enabled\nWakeOnPattern : Enabled\n'),
    'reg.exe': (args, cb) => cb(null, '    ScreenSaveTimeOut    REG_SZ    600')
});

describe('InventoryService - saf yardımcılar', () => {
    it('parseSleepStates', () => {
        const s = InventoryService.parseSleepStates(POWERCFG_A);
        expect(s).toMatchObject({ standbyS3: true, hibernate: true, fastStartup: true, standbyS0: true, rawAvailable: true });
        expect(InventoryService.parseSleepStates('')).toEqual({ standbyS0: false, standbyS3: false, hibernate: false, fastStartup: false, rawAvailable: false });
        expect(InventoryService.parseSleepStates('Hibernate has not been enabled.').hibernate).toBe(false);
    });

    it('maskToCidr / subnetOf', () => {
        expect(InventoryService.maskToCidr('255.255.255.0')).toBe(24);
        expect(InventoryService.maskToCidr('255.255.0.0')).toBe(16);
        expect(InventoryService.maskToCidr('bozuk')).toBeNull();
        expect(InventoryService.maskToCidr(null)).toBeNull();
        expect(InventoryService.subnetOf('192.168.1.20', '255.255.255.0')).toBe('192.168.1.0/24');
        expect(InventoryService.subnetOf('192.168.1.20', 'bozuk')).not.toBe('192.168.1.0/24');
        expect(InventoryService.subnetOf('x', 'y')).toBeNull();
    });

    it('parseNics yalnız harici IPv4', () => {
        const nics = InventoryService.parseNics(fakeOs().networkInterfaces());
        expect(nics).toHaveLength(1);
        expect(nics[0]).toMatchObject({ name: 'Ethernet', ip: '192.168.1.20', subnet: '192.168.1.0/24' });
        expect(InventoryService.parseNics(null)).toEqual([]);
    });

    it('parseNicWol / parseWakeArmed', () => {
        const wol = InventoryService.parseNicWol('Name : Eth0\r\nWakeOnMagicPacket : Enabled\r\nWakeOnPattern : Disabled\r\nWakeOnMagicPacket : Disabled\r\n');
        expect(wol).toEqual([{ name: 'Eth0', wakeOnMagicPacket: 'Disabled', wakeOnPattern: 'Disabled' }]);
        expect(InventoryService.parseNicWol('')).toEqual([]);
        expect(InventoryService.parseWakeArmed('a\r\n\r\nb\n')).toEqual(['a', 'b']);
    });

    it('wolReadiness seviyeleri', () => {
        expect(InventoryService.wolReadiness({ sleepStates: { unknown: true } })).toMatchObject({ level: 'unknown' });
        expect(InventoryService.wolReadiness({ sleepStates: { standbyS0: true, hibernate: false }, nicWol: [], wakeArmed: ['a'] })).toMatchObject({ level: 'blocked' });
        expect(InventoryService.wolReadiness({ sleepStates: { standbyS3: true }, nicWol: [{ wakeOnMagicPacket: 'Enabled' }], wakeArmed: ['a'] })).toMatchObject({ level: 'ready' });
        expect(InventoryService.wolReadiness({ sleepStates: { standbyS3: true }, nicWol: [], wakeArmed: [] })).toMatchObject({ level: 'degraded' });
        expect(InventoryService.wolReadiness({ sleepStates: { standbyS3: true }, nicWol: [{ wakeOnMagicPacket: 'Disabled' }], wakeArmed: ['a'] })).toMatchObject({ level: 'blocked' });
        expect(InventoryService.wolReadiness({ sleepStates: { standbyS3: true }, nicWol: [{ wakeOnMagicPacket: 'Enabled' }], wakeArmed: ['a'], lastWolResult: { success: false } })).toMatchObject({ level: 'degraded' });
        const none = InventoryService.wolReadiness({ sleepStates: {}, nicWol: [{ wakeOnMagicPacket: 'Enabled' }], wakeArmed: ['a'] });
        expect(none.reasons).toContain('uyku-durumu-yok');
    });

    it('parseRegTimeout / directedBroadcast / isOffline', () => {
        expect(InventoryService.parseRegTimeout('    ScreenSaveTimeOut    REG_SZ    900')).toBe(900);
        expect(InventoryService.parseRegTimeout('yok')).toBeNull();
        expect(InventoryService.directedBroadcast('192.168.1.0/24')).toBe('192.168.1.255');
        expect(InventoryService.directedBroadcast('10.0.0.0/8')).toBe('10.255.255.255');
        expect(InventoryService.directedBroadcast('bozuk')).toBeNull();
        expect(InventoryService.directedBroadcast('999.1.1.0/24')).toBeNull();
        expect(InventoryService.directedBroadcast('1.2.3.4/33')).toBeNull();
        expect(InventoryService.directedBroadcast('0.0.0.0/0')).toBe('255.255.255.255');

        expect(InventoryService.isOffline(null)).toBe(true);
        expect(InventoryService.isOffline('bozuk')).toBe(true);
        expect(InventoryService.isOffline(new Date().toISOString())).toBe(false);
        expect(InventoryService.isOffline(new Date(Date.now() - 3600000).toISOString())).toBe(true);
    });
});

describe('InventoryService - toplama', () => {
    it('getSleepStates hata durumunda unknown', async () => {
        const svc = new InventoryService({ execFn: (file, args, opts, cb) => cb(new Error('x'), ''), osModule: fakeOs() });
        await expect(svc.getSleepStates()).resolves.toEqual({ unknown: true });
        const ok = new InventoryService({ execFn: fakeExec(defaultMap()), osModule: fakeOs() });
        await expect(ok.getSleepStates()).resolves.toMatchObject({ standbyS3: true });
    });

    it('getWolDetails hata durumunda boş listeler', async () => {
        const svc = new InventoryService({ execFn: fakeExec({}), osModule: fakeOs() });
        await expect(svc.getWolDetails()).resolves.toEqual({ nicWol: [], wakeArmed: [] });
        const ok = new InventoryService({ execFn: fakeExec(defaultMap()), osModule: fakeOs() });
        const wol = await ok.getWolDetails();
        expect(wol.nicWol[0].name).toBe('Ethernet');
        expect(wol.wakeArmed).toEqual(['Intel(R) Ethernet', 'USB Root Hub']);
    });

    it('getLockPolicy: GPO kullanıcı ayarını ezer', async () => {
        const gpo = new InventoryService({
            osModule: fakeOs(),
            execFn: fakeExec({
                'reg.exe': (args, cb) => cb(null, String(args[1]).startsWith('HKLM')
                    ? 'ScreenSaveTimeOut REG_SZ 60'
                    : 'ScreenSaveTimeOut REG_SZ 600')
            })
        });
        await expect(gpo.getLockPolicy()).resolves.toEqual({ timeoutSec: 60, enforcedByGpo: true });

        const user = new InventoryService({
            osModule: fakeOs(),
            execFn: fakeExec({
                'reg.exe': (args, cb) => cb(null, String(args[1]).startsWith('HKLM') ? '' : 'ScreenSaveTimeOut REG_SZ 300')
            })
        });
        await expect(user.getLockPolicy()).resolves.toEqual({ timeoutSec: 300, enforcedByGpo: false });

        const none = new InventoryService({ osModule: fakeOs(), execFn: fakeExec({ 'reg.exe': (a, cb) => cb(null, '') }) });
        await expect(none.getLockPolicy()).resolves.toBeNull();
    });

    it('getBootAt uptime\'tan hesaplar; hata/geçersizde null', () => {
        expect(new InventoryService({ osModule: fakeOs() }).getBootAt()).toMatch(/^\d{4}-/);
        expect(new InventoryService({ osModule: fakeOs({ uptime: () => Number.NaN }) }).getBootAt()).toBeNull();
        expect(new InventoryService({ osModule: fakeOs({ uptime: () => { throw new Error('x'); } }) }).getBootAt()).toBeNull();
    });

    it('resolveAgentId ayar → hostname türevi → unknown', () => {
        const svc = new InventoryService({ osModule: fakeOs() });
        expect(svc.resolveAgentId({ agentId: 'agent-7' })).toBe('agent-7');
        expect(svc.resolveAgentId({})).toBe('agent-pc-one');
        expect(svc.resolveAgentId(null)).toBe('agent-pc-one');
        const broken = new InventoryService({ osModule: fakeOs({ hostname: () => { throw new Error('x'); } }) });
        expect(broken.resolveAgentId({})).toBe('agent-unknown');
    });

    it('collect tam envanter üretir, kaydeder ve cache\'ler', async () => {
        const saveInventory = vi.fn();
        const storage = { getSettings: () => ({ agentId: 'agent-1', deviceRole: 'server', upsEnabled: false, deviceWattage: 120 }), saveInventory };
        const svc = new InventoryService({ storageService: storage, execFn: fakeExec(defaultMap()), osModule: fakeOs(), agentVersion: '1.1.0' });
        const inv = await svc.collect();
        expect(inv).toMatchObject({
            agentId: 'agent-1', hostname: 'PC-ONE', username: 'emir', platform: 'win32',
            cpu: 'Test CPU', deviceRole: 'server', watt: 120, agentVersion: '1.1.0', ups: null
        });
        expect(inv.nics).toHaveLength(1);
        expect(inv.wolReadiness.level).toBeTruthy();
        expect(saveInventory).toHaveBeenCalledTimes(1);

        // cache: ikinci çağrı exec yapmaz
        const callsAfterFirst = svc.exec.mock.calls.length;
        await svc.collect();
        expect(svc.exec.mock.calls.length).toBe(callsAfterFirst);

        // force: yeniden toplar
        await svc.collect({ force: true });
        expect(svc.exec.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });

    it('collect UPS hatasında reachable:false, depo yoksa sessiz', async () => {
        const upsMonitor = { query: async () => { throw new Error('ups yok'); } };
        const svc = new InventoryService({
            storageService: { getSettings: () => ({ upsEnabled: true }) },
            execFn: fakeExec(defaultMap()),
            osModule: fakeOs(),
            upsMonitor
        });
        const inv = await svc.collect();
        expect(inv.ups).toEqual({ reachable: false });

        const noStorage = new InventoryService({ execFn: fakeExec(defaultMap()), osModule: fakeOs() });
        await expect(noStorage.collect()).resolves.toMatchObject({ agentId: expect.stringContaining('agent-') });
    });

    it('collect os hatalarında null alanlarla devam eder', async () => {
        const brokenOs = {
            hostname: () => { throw new Error('x'); },
            userInfo: () => { throw new Error('x'); },
            version: () => { throw new Error('x'); },
            platform: () => { throw new Error('x'); },
            release: () => { throw new Error('x'); },
            arch: () => { throw new Error('x'); },
            uptime: () => { throw new Error('x'); },
            cpus: () => { throw new Error('x'); },
            networkInterfaces: () => { throw new Error('x'); }
        };
        const svc = new InventoryService({ execFn: fakeExec(defaultMap()), osModule: brokenOs });
        const inv = await svc.collect();
        expect(inv.hostname).toBeNull();
        expect(inv.cpu).toBeNull();
        expect(inv.nics).toEqual([]);
        expect(inv.agentId).toBe('agent-unknown');
    });
});
