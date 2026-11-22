/**
 * device.test.mjs - DeviceProfileService: MAC doğrulaması, WOL soket yaşam döngüsü.
 */
import { describe, it, expect, vi } from 'vitest';
import DeviceProfileService, {
    broadcastFromNetmask,
    defaultBroadcastAddress
} from '../../src/main/services/DeviceProfileService.js';

function fakeDgram({ bindError = null, sendError = null } = {}) {
    const calls = { broadcast: [], sent: [], closed: 0 };
    const dgramModule = {
        createSocket: () => {
            const handlers = {};
            const socket = {
                once: (ev, fn) => { handlers[ev] = fn; },
                bind: (cb) => {
                    if (bindError) {
                        handlers.error && handlers.error(bindError);
                        return;
                    }
                    cb();
                },
                setBroadcast: (value) => calls.broadcast.push(value),
                send: (_buf, _off, _len, port, host, cb) => {
                    calls.sent.push({ port, host });
                    cb(sendError || null);
                },
                close: () => { calls.closed++; }
            };
            return socket;
        }
    };
    return { dgramModule, calls };
}

describe('DeviceProfileService', () => {
    it('bozuk MAC ağa çıkmadan reddedilir', async () => {
        const svc = new DeviceProfileService(null);
        await expect(svc.sendWakeOnLan('not-a-mac')).resolves.toMatchObject({ success: false });
        await expect(svc.sendWakeOnLan('')).resolves.toMatchObject({ success: false });
        await expect(svc.sendWakeOnLan('AA:BB:CC')).resolves.toMatchObject({ success: false });
    });

    it('geçerli MAC loopback hedefine gönderilir (şekil garantisi)', async () => {
        const svc = new DeviceProfileService(null);
        const res = await svc.sendWakeOnLan('AA:BB:CC:DD:EE:FF', '127.0.0.1', 9);
        expect(typeof res.success).toBe('boolean');
        if (!res.success) expect(typeof res.error).toBe('string');
    }, 10000);

    it('bind callback içinde setBroadcast + tek resolve + close', async () => {
        const { dgramModule, calls } = fakeDgram();
        const svc = new DeviceProfileService(null, { dgramModule, timeoutMs: 1000 });
        const res = await svc.sendWakeOnLan('AA:BB:CC:DD:EE:FF', '192.168.1.255', 9);
        expect(res).toEqual({ success: true });
        expect(calls.broadcast).toEqual([true]);
        expect(calls.sent).toEqual([{ port: 9, host: '192.168.1.255' }]);
        expect(calls.closed).toBe(1);
    });

    it('bind hatası promise’i reddetmez, güvenli sonuç döner', async () => {
        const { dgramModule, calls } = fakeDgram({ bindError: new Error('bind failed') });
        const svc = new DeviceProfileService(null, { dgramModule, timeoutMs: 1000 });
        const res = await svc.sendWakeOnLan('AA:BB:CC:DD:EE:FF', '192.168.1.255', 9);
        expect(res.success).toBe(false);
        expect(res.error).toContain('bind failed');
        expect(calls.sent.length).toBe(0);
        expect(calls.closed).toBe(1);
    });

    it('netmask’ten yönlendirilmiş broadcast hesaplanır', () => {
        expect(broadcastFromNetmask('192.168.1.10', '255.255.255.0')).toBe('192.168.1.255');
        expect(broadcastFromNetmask('10.1.2.3', '255.255.0.0')).toBe('10.1.255.255');
        expect(defaultBroadcastAddress({
            eth0: [{ family: 'IPv4', internal: false, address: '172.16.5.4', netmask: '255.255.255.0' }]
        })).toBe('172.16.5.255');
    });

    it('L-15: sanal adaptörler atlanır; uygun arayüz yoksa global broadcast', () => {
        expect(defaultBroadcastAddress({
            'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.20.0.1', netmask: '255.255.240.0' }],
            'OpenVPN TAP-Windows6': [{ family: 'IPv4', internal: false, address: '10.8.0.2', netmask: '255.255.255.0' }],
            eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10', netmask: '255.255.255.0' }]
        })).toBe('192.168.1.255');

        expect(defaultBroadcastAddress({
            'VPN Client': [{ family: 'IPv4', internal: false, address: '172.20.0.1', netmask: '255.255.240.0' }],
            'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }]
        })).toBe('255.255.255.255');
    });
});
