/**
 * wol-readiness.test.mjs - FAZ C
 * NIC WoL ayrıştırma, wake_armed, hazırlık hükmü, yönlendirilmiş broadcast.
 */
import { describe, it, expect, vi } from 'vitest';
import { InventoryService } from '../../src/main/services/InventoryService.js';

const NIC_OUT = `Name                   : Ethernet
InterfaceDescription   : Intel Ethernet Controller
WakeOnMagicPacket      : Enabled
WakeOnPattern          : Disabled

Name                   : Wi-Fi
InterfaceDescription   : Intel Wireless
WakeOnMagicPacket      : Disabled
WakeOnPattern          : Disabled`;

describe('parseNicWol', () => {
    it('adaptör başına bayrak çıkarır', () => {
        const list = InventoryService.parseNicWol(NIC_OUT);
        expect(list).toHaveLength(2);
        expect(list[0].wakeOnMagicPacket).toBe('Enabled');
        expect(list[1].wakeOnMagicPacket).toBe('Disabled');
    });
});

describe('parseWakeArmed', () => {
    it('boş satırları atlar', () => {
        expect(InventoryService.parseWakeArmed('Intel Ethernet\r\n\r\nHID Keyboard\r\n')).toEqual(['Intel Ethernet', 'HID Keyboard']);
        expect(InventoryService.parseWakeArmed('')).toEqual([]);
    });
});

describe('wolReadiness hükmü', () => {
    it('S0 + hibernate-yok = blocked (hazırda-beklet önerisi)', () => {
        const r = InventoryService.wolReadiness({ sleepStates: { standbyS0: true, hibernate: false } });
        expect(r.level).toBe('blocked');
        expect(r.reasons).toContain('s0-modern-standby');
        expect(r.recommendation).toContain('hazırda-beklet');
    });

    it('S3 + WoL-açık + armed = ready', () => {
        const r = InventoryService.wolReadiness({
            sleepStates: { standbyS3: true, hibernate: true },
            nicWol: [{ name: 'Ethernet', wakeOnMagicPacket: 'Enabled' }],
            wakeArmed: ['Intel Ethernet']
        });
        expect(r.level).toBe('ready');
    });

    it('NIC WoL kapalı = blocked', () => {
        const r = InventoryService.wolReadiness({
            sleepStates: { standbyS3: true },
            nicWol: [{ name: 'Wi-Fi', wakeOnMagicPacket: 'Disabled' }],
            wakeArmed: ['Intel Wireless']
        });
        expect(r.level).toBe('blocked');
        expect(r.reasons).toContain('nic-wol-kapalı');
    });

    it('yalnızca wake-armed-boş = degraded', () => {
        const r = InventoryService.wolReadiness({
            sleepStates: { standbyS3: true },
            nicWol: [{ name: 'Ethernet', wakeOnMagicPacket: 'Enabled' }],
            wakeArmed: []
        });
        expect(r.level).toBe('degraded');
    });

    it('okunamayan durum = unknown', () => {
        expect(InventoryService.wolReadiness({ sleepStates: { unknown: true } }).level).toBe('unknown');
    });
});

describe('directedBroadcast', () => {
    it('/24 ve /16 doğru', () => {
        expect(InventoryService.directedBroadcast('192.168.10.0/24')).toBe('192.168.10.255');
        expect(InventoryService.directedBroadcast('10.0.0.0/16')).toBe('10.0.255.255');
    });

    it('bozuk girdi null', () => {
        expect(InventoryService.directedBroadcast('bozuk')).toBeNull();
        expect(InventoryService.directedBroadcast(null)).toBeNull();
    });
});

describe('collect WoL detaylarını içerir', () => {
    it('readiness envantere gömülür', async () => {
        const nicAllEnabled = NIC_OUT.replace('WakeOnMagicPacket      : Disabled', 'WakeOnMagicPacket      : Enabled');
        const storage = { getSettings: () => ({}), saveInventory: vi.fn() };
        const fakeOs = {
            hostname: () => 'PC', userInfo: () => ({ username: 'u' }), platform: () => 'win32',
            release: () => '10.0', arch: () => 'x64', cpus: () => [], networkInterfaces: () => ({})
        };
        const execFn = (file, args, opts, cb) => {
            const cmd = [file, ...(args || [])].join(' ');
            if (cmd.includes('Get-NetAdapter')) return cb(null, nicAllEnabled);
            if (cmd.includes('devicequery')) return cb(null, 'Intel Ethernet');
            return cb(null, 'Standby (S3)\nHibernate');
        };
        const svc = new InventoryService({ storageService: storage, execFn, osModule: fakeOs });
        const inv = await svc.collect();
        expect(inv.wolReadiness.level).toBe('ready');
        expect(inv.nicWol).toHaveLength(2);
    });
});
