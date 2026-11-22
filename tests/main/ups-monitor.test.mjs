/**
 * ups-monitor.test.mjs - FAZ D + WP-12.T8
 * Tek TCP bağlantısı, LIST VAR parse, 55 sn cache, erişilemezlik.
 */
import { describe, it, expect } from 'vitest';
import { UpsMonitor, parseVarLine, parseListVars } from '../../src/main/services/UpsMonitor.js';

function fakeNet(lines) {
    let created = 0;
    const net = {
        createConnection: (_opts, onConnect) => {
            created++;
            const handlers = {};
            const sock = {
                destroyed: false,
                write: (cmd) => {
                    if (!cmd.includes('LIST VAR')) return;
                    setTimeout(() => handlers.data && handlers.data(Buffer.from(lines.join('\n'))), 0);
                },
                destroy: () => {
                    sock.destroyed = true;
                    if (handlers.close) handlers.close();
                },
                removeListener: (ev, fn) => {
                    if (handlers[ev] === fn) delete handlers[ev];
                },
                on: (ev, fn) => { handlers[ev] = fn; }
            };
            setTimeout(onConnect, 0);
            return sock;
        }
    };
    net.created = () => created;
    return net;
}

const LIST = [
    'BEGIN LIST VAR ups',
    'VAR ups battery.charge "87"',
    'VAR ups ups.status "OB LB"',
    'VAR ups battery.runtime "240"',
    'VAR ups ups.model "Smart-UPS 750"',
    'END LIST VAR ups',
    ''
];

describe('parseVarLine / parseListVars', () => {
    it('VAR satırını çözer, uyumsuz satırı eler', () => {
        expect(parseVarLine('VAR ups battery.charge "87"', 'ups', 'battery.charge')).toBe('87');
        expect(parseVarLine('VAR ups ups.status "OL"', 'ups', 'battery.charge')).toBeNull();
        expect(parseVarLine('ERR UNKNOWN-UPS', 'ups', 'battery.charge')).toBeNull();
    });

    it('LIST VAR bloğunu tek bağlantıda çözer', () => {
        const vars = parseListVars(LIST.join('\n'), 'ups');
        expect(vars.get('ups.model')).toBe('Smart-UPS 750');
        expect(vars.get('battery.charge')).toBe('87');
    });
});

describe('UpsMonitor.query (T-NET-07)', () => {
    it('tek TCP bağlantısı + 4 değişken', async () => {
        const net = fakeNet(LIST);
        const m = new UpsMonitor({ netModule: net, timeoutMs: 1000 });
        const r = await m.query();
        expect(net.created()).toBe(1);
        expect(r).toMatchObject({
            reachable: true,
            charge: 87,
            status: 'OB LB',
            onBattery: true,
            lowBattery: true,
            runtimeSec: 240,
            model: 'Smart-UPS 750'
        });
        m.close();
    });

    it('55 sn cache aynı sonucu döndürür, yeni bağlantı açmaz', async () => {
        const net = fakeNet(LIST);
        let now = 1000;
        const m = new UpsMonitor({ netModule: net, timeoutMs: 1000, nowFn: () => now });
        await m.query();
        now += 54000;
        const second = await m.query();
        expect(second.charge).toBe(87);
        expect(net.created()).toBe(1);
        now += 2000;
        await m.query();
        expect(net.created()).toBe(1); // aynı soket yeniden kullanılır
        m.close();
    });

    it('erişilemez UPS reachable:false', async () => {
        const dead = { createConnection: () => { throw new Error('down'); } };
        const m = new UpsMonitor({ netModule: dead, timeoutMs: 200 });
        expect((await m.query()).reachable).toBe(false);
    });

    it('timeout bağlantıyı kapatır ve reachable:false döner', async () => {
        const net = {
            createConnection: (_opts, onConnect) => {
                const handlers = {};
                const sock = {
                    destroyed: false,
                    write: () => {},
                    destroy: () => { sock.destroyed = true; },
                    removeListener: (ev, fn) => { if (handlers[ev] === fn) delete handlers[ev]; },
                    on: (ev, fn) => { handlers[ev] = fn; }
                };
                setTimeout(onConnect, 0);
                return sock;
            }
        };
        const m = new UpsMonitor({ netModule: net, timeoutMs: 50 });
        expect((await m.query()).reachable).toBe(false);
    });
});
