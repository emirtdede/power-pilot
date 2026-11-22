/**
 * ups-monitor-core.test.mjs - NUT UPS istemcisi (sahte socket ile)
 * Gerçek TCP bağlantısı YOK; net modülü enjekte edilir.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { UpsMonitor, parseVarLine, parseListVars, DEFAULT_PORT, CACHE_TTL_MS } from '../../src/main/services/UpsMonitor.js';

function fakeNet(behavior) {
    const created = [];
    const netModule = {
        createConnection: vi.fn((opts, onConnect) => {
            const sock = new EventEmitter();
            sock.destroyed = false;
            sock.destroy = vi.fn(() => { sock.destroyed = true; });
            sock.write = vi.fn((data) => { sock.written = data; });
            created.push(sock);
            behavior({ sock, onConnect, opts });
            return sock;
        })
    };
    return { netModule, created };
}

const responder = (payload) => ({ sock, onConnect }) => {
    setImmediate(() => onConnect());
    // Her komuta yanıt ver (bağlantı yeniden kullanılabilir).
    sock.write = vi.fn((data) => {
        sock.written = data;
        setTimeout(() => sock.emit('data', Buffer.from(payload)), 5);
    });
};

describe('UpsMonitor - ayrıştırıcılar ve doğrulama', () => {
    it('parseVarLine / parseListVars', () => {
        expect(parseVarLine('VAR ups battery.charge "100"', 'ups', 'battery.charge')).toBe('100');
        expect(parseVarLine('VAR ups battery.charge "100"', 'baska', 'battery.charge')).toBeNull();
        expect(parseVarLine('VAR ups ups.status "OL"', 'ups', 'battery.charge')).toBeNull();
        expect(parseVarLine(null, 'ups', 'x')).toBeNull();

        const vars = parseListVars('BEGIN LIST VAR ups\nVAR ups battery.charge "95"\nVAR diger battery.charge "1"\nEND LIST VAR ups\n', 'ups');
        expect(vars.get('battery.charge')).toBe('95');
        expect(vars.size).toBe(1);
        expect(parseListVars('', 'ups').size).toBe(0);
    });

    it('sabitler', () => {
        expect(DEFAULT_PORT).toBe(3493);
        expect(CACHE_TTL_MS).toBe(55000);
    });

    it('host/ups adı enjeksiyonu reddedilir', () => {
        expect(() => new UpsMonitor({ host: 'a b' })).toThrow();
        expect(() => new UpsMonitor({ host: 'a\nb' })).toThrow();
        expect(() => new UpsMonitor({ ups: 'ups\nLIST' })).toThrow();
        expect(() => new UpsMonitor({ ups: 'boş luk' })).toThrow();
        expect(new UpsMonitor({ host: '10.0.0.2', ups: 'my-ups' }).host).toBe('10.0.0.2');
    });
});

describe('UpsMonitor - sorgu akışı', () => {
    const PAYLOAD = [
        'BEGIN LIST VAR ups',
        'VAR ups battery.charge "87"',
        'VAR ups battery.runtime "1800"',
        'VAR ups ups.status "OL CHRG"',
        'VAR ups ups.model "Test UPS"',
        'END LIST VAR ups',
        ''
    ].join('\n');

    it('başarılı sorgu alanları çözer', async () => {
        const { netModule } = fakeNet(responder(PAYLOAD));
        const ups = new UpsMonitor({ netModule, nowFn: () => 1000 });
        const res = await ups.query();
        expect(res).toMatchObject({ reachable: true, charge: 87, runtimeSec: 1800, model: 'Test UPS', onBattery: false, lowBattery: false });
        expect(res.status).toBe('OL CHRG');
        expect(res.checkedAt).toBeTruthy();
    });

    it('OB/LB durum bayrakları', async () => {
        const payload = 'VAR ups ups.status "OB LB"\nEND LIST VAR\n';
        const { netModule } = fakeNet(responder(payload));
        const res = await new UpsMonitor({ netModule }).query();
        expect(res).toMatchObject({ onBattery: true, lowBattery: true, charge: null, runtimeSec: null, model: null });
    });

    it('55 sn cache ve eşzamanlı birleştirme', async () => {
        let now = 0;
        const { netModule } = fakeNet(responder(PAYLOAD));
        const ups = new UpsMonitor({ netModule, nowFn: () => now });
        const a = await ups.query();
        now = 1000;
        const b = await ups.query();
        expect(b).toEqual(a);
        expect(netModule.createConnection).toHaveBeenCalledTimes(1);

        now = 60000;
        await ups.query();
        // Soket yeniden kullanılır; yeni istek yazılır ama yeni bağlantı açılmaz.
        expect(netModule.createConnection).toHaveBeenCalledTimes(1);
    });

    it('eşzamanlı çağrılar tek uçuşa birleşir', async () => {
        const { netModule } = fakeNet(({ sock, onConnect }) => {
            setImmediate(() => {
                onConnect();
                setTimeout(() => sock.emit('data', Buffer.from(PAYLOAD)), 5);
            });
        });
        const ups = new UpsMonitor({ netModule });
        const [a, b] = await Promise.all([ups.query(), ups.query()]);
        expect(a).toEqual(b);
        expect(netModule.createConnection).toHaveBeenCalledTimes(1);
    });

    it('boş yanıt reachable:false', async () => {
        const { netModule } = fakeNet(responder('BEGIN LIST VAR ups\nEND LIST VAR ups\n'));
        await expect(new UpsMonitor({ netModule }).query()).resolves.toEqual({ reachable: false });
    });

    it('protokol hatası / bağlantı kapanması / timeout reachable:false', async () => {
        const errProto = fakeNet(responder('ERR INVALID\n'));
        await expect(new UpsMonitor({ netModule: errProto.netModule }).query()).resolves.toEqual({ reachable: false });

        const closed = fakeNet(({ sock, onConnect }) => setImmediate(() => {
            onConnect();
            setTimeout(() => sock.emit('close'), 5);
        }));
        await expect(new UpsMonitor({ netModule: closed.netModule, timeoutMs: 200 }).query()).resolves.toEqual({ reachable: false });

        const timedOut = fakeNet(({ onConnect }) => setImmediate(() => onConnect()));
        await expect(new UpsMonitor({ netModule: timedOut.netModule, timeoutMs: 20 }).query()).resolves.toEqual({ reachable: false });
    });

    it('createConnection fırlatırsa reachable:false', async () => {
        const netModule = { createConnection: () => { throw new Error('bağlantı yok'); } };
        await expect(new UpsMonitor({ netModule }).query()).resolves.toEqual({ reachable: false });
    });

    it('çok büyük yanıt kesilir', async () => {
        const { netModule } = fakeNet(({ sock, onConnect }) => {
            setImmediate(() => {
                onConnect();
                setTimeout(() => sock.emit('data', Buffer.alloc(70 * 1024, 0x41)), 5);
            });
        });
        await expect(new UpsMonitor({ netModule, timeoutMs: 200 }).query()).resolves.toEqual({ reachable: false });
    });

    it('kullanıcı/parola komutları yazılır; close soketi kapatır', async () => {
        const { netModule, created } = fakeNet(responder(PAYLOAD));
        const ups = new UpsMonitor({ netModule, username: 'u', password: 'p', ups: 'myups' });
        await ups.query();
        expect(created[0].written).toContain('USERNAME u');
        expect(created[0].written).toContain('PASSWORD p');
        expect(created[0].written).toContain('LIST VAR myups');
        ups.close();
        expect(created[0].destroy).toHaveBeenCalled();
    });

    it('bağlantı hatası (connect fail) reachable:false', async () => {
        const { netModule } = fakeNet(({ sock }) => {
            setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
        });
        await expect(new UpsMonitor({ netModule, timeoutMs: 20 }).query()).resolves.toEqual({ reachable: false });
    });
});
