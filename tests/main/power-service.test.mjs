/**
 * power-service.test.mjs - PowerService güvenlik kapısı
 *
 * GÜVENLİK: hiçbir OS güç komutu çalıştırılmaz. `execute()` yalnızca
 * (a) guard reddi, (b) geçersiz eylem dallarında test edilir; bu iki dal
 * `execFile` çağrısından ÖNCE döner.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { PowerService, POWER_ACTIONS, POWER_ERROR, classifyExecError } from '../../src/main/services/PowerService.js';
import TaskManager from '../../src/main/services/TaskManager.js';

afterEach(() => {
    PowerService.setExecutionGuard(null);
});

describe('PowerService', () => {
    it('POWER_ACTIONS altı eylemi tanımlar', () => {
        expect(Object.values(POWER_ACTIONS).sort()).toEqual(['hibernate', 'lock', 'restart', 'shutdown', 'signout', 'sleep']);
    });

    it('isValidAction altı eylemde true, diğerlerinde false', () => {
        for (const action of Object.values(POWER_ACTIONS)) expect(PowerService.isValidAction(action)).toBe(true);
        expect(PowerService.isValidAction('format')).toBe(false);
        expect(PowerService.isValidAction(null)).toBe(false);
        expect(PowerService.isValidAction('SHUTDOWN')).toBe(false);
    });

    it('guard yoksa executionAllowed izin verir', () => {
        expect(PowerService.executionAllowed()).toEqual({ ok: true });
    });

    it('guard reddi eylemi OS çağrısından önce durdurur', async () => {
        PowerService.setExecutionGuard(() => ({ ok: false, code: 'AUDIT_TAMPERED', error: 'Denetim zinciri kurcalanmış.' }));
        expect(PowerService.executionAllowed()).toEqual({ ok: false, code: 'AUDIT_TAMPERED', error: 'Denetim zinciri kurcalanmış.' });
        const res = await PowerService.execute(POWER_ACTIONS.SHUTDOWN);
        expect(res.success).toBe(false);
        expect(res.code).toBe('AUDIT_TAMPERED');
    });

    it('guard kodu yoksa BLOCKED kodu döner', async () => {
        PowerService.setExecutionGuard(() => ({ ok: false }));
        const res = await PowerService.execute(POWER_ACTIONS.RESTART);
        expect(res).toMatchObject({ success: false, code: 'BLOCKED' });
    });

    it('geçersiz eylem exec çağrısı olmadan reddedilir', async () => {
        const res = await PowerService.execute('rm-rf');
        // P1-6 (üçüncü tur): hata nedeni artık kararlı bir kod taşır.
        expect(res).toEqual({
            success: false,
            error: 'Invalid power action: rm-rf',
            code: 'POWER_INVALID_ACTION'
        });
    });

    it('guard hatası fırlatan fonksiyon çağrıyı engellemez (fail-safe değil, açık hata)', () => {
        // Guard fırlatırsa hata senkron yukarı çıkar; sessizce eylem çalıştırılmaz.
        PowerService.setExecutionGuard(() => { throw new Error('guard patladı'); });
        expect(() => PowerService.execute(POWER_ACTIONS.SLEEP)).toThrow('guard patladı');
    });

    it('setExecutionGuard fonksiyon olmayan değeri temizler', () => {
        PowerService.setExecutionGuard('nope');
        expect(PowerService.executionAllowed()).toEqual({ ok: true });
    });

    // P1-6 (üçüncü tur): hata nedeni sınıflandırması.
    // Eskiden her başarısızlık `os_execution_failed` oluyordu; `timeout` ve
    // `authorization_error` kodları hiç üretilmiyordu.
    it('classifyExecError: zaman aşımı', () => {
        expect(classifyExecError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(POWER_ERROR.TIMEOUT);
        expect(classifyExecError({ message: 'kill', killed: true })).toBe(POWER_ERROR.TIMEOUT);
        expect(classifyExecError({ message: 'term', signal: 'SIGTERM' })).toBe(POWER_ERROR.TIMEOUT);
    });

    it('classifyExecError: yetki reddi', () => {
        expect(classifyExecError(Object.assign(new Error('denied'), { code: 'EPERM' }))).toBe(POWER_ERROR.AUTHORIZATION);
        expect(classifyExecError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(POWER_ERROR.AUTHORIZATION);
        expect(classifyExecError(new Error('Access is denied.'))).toBe(POWER_ERROR.AUTHORIZATION);
        expect(classifyExecError(new Error('Bu işlem için yönetici hakları gerekli.'))).toBe(POWER_ERROR.AUTHORIZATION);
    });

    it('classifyExecError: bilinmeyen hata genel yürütme hatası', () => {
        expect(classifyExecError(new Error('spawn shutdown.exe ENOENT'))).toBe(POWER_ERROR.EXEC_FAILED);
        expect(classifyExecError(null)).toBe(POWER_ERROR.EXEC_FAILED);
    });

    it('hata kodları yürütme sonuç kodlarına eşlenir', () => {
        const tm = TaskManager.prototype;
        expect(tm.mapPowerFailureCode(POWER_ERROR.TIMEOUT)).toBe('timeout');
        expect(tm.mapPowerFailureCode(POWER_ERROR.AUTHORIZATION)).toBe('authorization_error');
        expect(tm.mapPowerFailureCode(POWER_ERROR.BLOCKED)).toBe('blocked_by_policy');
        expect(tm.mapPowerFailureCode(POWER_ERROR.EXEC_FAILED)).toBe('os_execution_failed');
        expect(tm.mapPowerFailureCode(undefined)).toBe('os_execution_failed');
    });
});
