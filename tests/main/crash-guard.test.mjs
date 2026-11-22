/**
 * CrashGuard sözleşmesi - ana süreç çökme dayanıklılığı.
 *
 * Regresyon: main.js'te uncaughtException / unhandledRejection kancası yoktu;
 * yakalanmamış bir hata uygulamayı sessizce kapatıyor ve log bırakmıyordu.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installCrashGuard, describeError } from '../../src/main/util/CrashGuard.js';

const makeLogger = () => ({ error: vi.fn(), warn: vi.fn() });

describe('CrashGuard - ana süreç hata kancaları', () => {
    it('uncaughtException loglanır ve süreç ayakta kalır', () => {
        const proc = new EventEmitter();
        const logger = makeLogger();
        installCrashGuard({ processRef: proc, logger });

        expect(() => proc.emit('uncaughtException', new Error('boom'))).not.toThrow();
        expect(logger.error).toHaveBeenCalledTimes(1);
        const [line] = logger.error.mock.calls[0];
        expect(line).toContain('Yakalanmamış istisna');
        expect(line).toContain('boom');
    });

    it('unhandledRejection loglanır (sessiz yutulmaz)', () => {
        const proc = new EventEmitter();
        const logger = makeLogger();
        installCrashGuard({ processRef: proc, logger });

        proc.emit('unhandledRejection', new Error('async fail'));
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.error.mock.calls[0][0]).toContain('İşlenmemiş promise reddi');
        expect(logger.error.mock.calls[0][0]).toContain('async fail');
    });

    it('string ve nesne reddi de okunabilir mesaja çevrilir', () => {
        const proc = new EventEmitter();
        const logger = makeLogger();
        installCrashGuard({ processRef: proc, logger });

        proc.emit('unhandledRejection', 'plain string');
        proc.emit('unhandledRejection', { code: 'E_FAIL' });
        expect(logger.error.mock.calls[0][0]).toContain('plain string');
        expect(logger.error.mock.calls[1][0]).toContain('E_FAIL');
    });

    it('onCrash kancası hata türünü bildirir; kancanın kendisi patlarsa yutulur', () => {
        const proc = new EventEmitter();
        const logger = makeLogger();
        const seen = [];
        installCrashGuard({
            processRef: proc,
            logger,
            onCrash: (info) => {
                seen.push(info);
                throw new Error('kanca bozuk');
            }
        });

        expect(() => proc.emit('uncaughtException', new Error('x'))).not.toThrow();
        expect(seen).toEqual([{ kind: 'uncaughtException', message: 'x' }]);
        expect(logger.error).toHaveBeenCalled();
    });

    it('uninstall kancaları kaldırır (çift log yok)', () => {
        const proc = new EventEmitter();
        const logger = makeLogger();
        const uninstall = installCrashGuard({ processRef: proc, logger });
        uninstall();
        proc.emit('uncaughtException', new Error('after'));
        expect(logger.error).not.toHaveBeenCalled();
    });

    it('eksik bağımlılıkta anlaşılır TypeError fırlatır', () => {
        expect(() => installCrashGuard({})).toThrow(TypeError);
        expect(() => installCrashGuard({ processRef: new EventEmitter() })).toThrow(/logger\.error/);
    });

    it('describeError yığını 5 satırla sınırlar (log şişmesi yok)', () => {
        const err = new Error('deep');
        err.stack = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
        const info = describeError(err);
        expect(info.stack.split('\n')).toHaveLength(5);
        expect(info.message).toBe('deep');
    });
});
