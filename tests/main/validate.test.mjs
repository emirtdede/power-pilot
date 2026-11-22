/**
 * validate.test.mjs - WBS-2.1 / TS-2.1
 * IPC doğrulama katmanı birim testleri (saf fonksiyonlar, mock yok).
 */
import { describe, it, expect } from 'vitest';
import {
    validateScheduleAction, validateTaskId, validateTaskData,
    validateSnooze, validateWol, validateSettings, validateSecuritySettings,
    validateWebhooks, validateCancelPin, SECURITY_SETTING_KEYS
} from '../../src/main/ipc/validate.js';

describe('validateScheduleAction', () => {
    it('geçerli shutdown + süre kabul edilir', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 900000 })).toEqual({ ok: true });
    });
    it('6 eylemin tamamı kabul edilir', () => {
        for (const action of ['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout']) {
            expect(validateScheduleAction({ action, durationMs: 60000 }).ok).toBe(true);
        }
    });
    it('negatif süre reddedilir (TS-2.1)', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: -5 }).ok).toBe(false);
    });
    it('string süre reddedilir (TS-2.1)', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: '15dk' }).ok).toBe(false);
    });
    it('bilinmeyen eylem reddedilir (TS-2.1)', () => {
        const r = validateScheduleAction({ action: 'format C:', durationMs: 60000 });
        expect(r.ok).toBe(false);
        expect(r.code).toBe('INVALID_ACTION');
    });
    it('üst sınır aşımı reddedilir', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 2500000001 }).ok).toBe(false);
    });
    it('üst sınırın kendisi kabul edilir', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 2500000000 }).ok).toBe(true);
    });
    it('boş gövde reddedilir', () => {
        expect(validateScheduleAction(null).ok).toBe(false);
        expect(validateScheduleAction(undefined).ok).toBe(false);
    });
});

describe('validateTaskId', () => {
    it('geçerli id kabul edilir', () => {
        expect(validateTaskId('task_123').ok).toBe(true);
    });
    it('boş/uzun id reddedilir', () => {
        expect(validateTaskId('').ok).toBe(false);
        expect(validateTaskId('x'.repeat(65)).ok).toBe(false);
        expect(validateTaskId(123).ok).toBe(false);
    });
});

describe('validateTaskData', () => {
    it('koşullu görev kabul edilir', () => {
        const r = validateTaskData({
            name: 'Smart Finish (cpu_usage)', action: 'shutdown',
            conditionGroup: { operator: 'AND', stabilitySeconds: 15, conditions: [{ type: 'cpu_usage' }] }
        });
        expect(r.ok).toBe(true);
    });
    it('geçersiz eylem reddedilir', () => {
        expect(validateTaskData({ action: 'rm -rf' }).code).toBe('INVALID_ACTION');
    });
    it('HTML içeren görev adı reddedilir (K2 depolanmış XSS kapısı)', () => {
        expect(validateTaskData({ action: 'sleep', name: '<img src=x onerror=alert(1)>' }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ action: 'sleep', name: 'a>b' }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ action: 'sleep', name: 'Gece kapatma' }).ok).toBe(true);
    });
    it('11 koşul reddedilir (limit 10)', () => {
        const conditions = Array.from({ length: 11 }, () => ({ type: 'cpu_usage' }));
        expect(validateTaskData({ conditionGroup: { conditions } }).ok).toBe(false);
    });
    it('stabilitySeconds üst sınırı reddedilir', () => {
        expect(validateTaskData({ conditionGroup: { conditions: [{ type: 'cpu_usage' }], stabilitySeconds: 9999 } }).ok).toBe(false);
    });
    it('uyarı süresi üst sınırı reddedilir', () => {
        expect(validateTaskData({ warningConfig: { durationSeconds: 9999 } }).ok).toBe(false);
    });
    it('K-03: action zorunlu; ayrıcalıklı alanlar istemciden kabul edilmez', () => {
        expect(validateTaskData({}).code).toBe('INVALID_ACTION');
        for (const field of ['source', 'mode', 'status', 'enabled', 'policyId', 'consoleOrderId', 'requiresMaintenanceWindow']) {
            expect(validateTaskData({
                action: 'sleep',
                [field]: field === 'enabled' ? false : 'istemci'
            }).code).toBe('INVALID_FIELD');
        }
    });
    it('K-03: warningConfig ve safetyPolicy tipleri doğrulanır', () => {
        expect(validateTaskData({ action: 'sleep', warningConfig: { enabled: 'false' } }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ action: 'sleep', warningConfig: { silentMode: 1 } }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ action: 'sleep', warningConfig: { durationSeconds: 0 } }).ok).toBe(true);
        expect(validateTaskData({ action: 'sleep', safetyPolicy: 'all' }).code).toBe('INVALID_SAFETY_POLICY');
        expect(validateTaskData({ action: 'sleep', safetyPolicy: { checkUserActivity: 'evet' } }).code).toBe('INVALID_SAFETY_POLICY');
        expect(validateTaskData({ action: 'sleep', safetyPolicy: {} }).ok).toBe(true);
    });
});

describe('validateSnooze', () => {
    it('varsayılan 10dk kabul edilir', () => {
        expect(validateSnooze({ taskId: 'task_1' })).toEqual({ ok: true, minutes: 10 });
    });
    it('0 ve 1441 reddedilir', () => {
        expect(validateSnooze({ taskId: 'task_1', minutes: 0 }).ok).toBe(false);
        expect(validateSnooze({ taskId: 'task_1', minutes: 1441 }).ok).toBe(false);
    });
});

describe('validateWol', () => {
    it('çift noktalı MAC kabul edilir', () => {
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '192.168.1.255', port: 9 }).ok).toBe(true);
    });
    it('tireli ve düz MAC kabul edilir', () => {
        expect(validateWol({ macAddress: 'AA-BB-CC-DD-EE-FF' }).ok).toBe(true);
        expect(validateWol({ macAddress: 'AABBCCDDEEFF' }).ok).toBe(true);
    });
    it('bozuk MAC reddedilir', () => {
        expect(validateWol({ macAddress: 'not-a-mac' }).code).toBe('INVALID_MAC');
    });
    it('port aralığı denetlenir', () => {
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', port: 70000 }).ok).toBe(false);
    });
    it('komut enjeksiyonu içeren host reddedilir', () => {
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '1.1.1.1; shutdown /s' }).ok).toBe(false);
    });
});

describe('validateSettings', () => {
    it('geçerli yama kabul edilir', () => {
        expect(validateSettings({ theme: 'light', deviceWattage: 65 }).ok).toBe(true);
    });
    it('bilinmeyen anahtar reddedilir', () => {
        expect(validateSettings({ localApiKeyHash: 'x' }).code).toBe('UNKNOWN_SETTING');
    });
    it('tip ihlali reddedilir', () => {
        expect(validateSettings({ theme: 'neon' }).ok).toBe(false);
        expect(validateSettings({ localApiPort: 99999 }).ok).toBe(false);
    });
    it('boş yama reddedilir', () => {
        expect(validateSettings({}).ok).toBe(false);
    });
    it('WP-10.T4: güvenlik bayrakları normal ayar yolundan yazılamaz', () => {
        for (const key of SECURITY_SETTING_KEYS) {
            expect(validateSettings({ [key]: key === 'autonomyMode' ? 'full' : true }).code).toBe('UNKNOWN_SETTING');
        }
    });
    it('WP-10.T4: security-settings-update doğrulaması tipleri denetler', () => {
        expect(validateSecuritySettings({ automationPaused: true }).ok).toBe(true);
        expect(validateSecuritySettings({ automationPaused: 'evet' }).ok).toBe(false);
        expect(validateSecuritySettings({ autonomyMode: 'classic' }).ok).toBe(true);
        expect(validateSecuritySettings({ autonomyMode: 'full' }).ok).toBe(true);
        expect(validateSecuritySettings({ autonomyMode: 'god' }).ok).toBe(false);
        expect(validateSecuritySettings({ localApiEnabled: true, lanModeEnabled: true }).ok).toBe(false);
    });
    it('chain halkaları denetlenir (WBS-11.1)', () => {
        const good = { action: 'shutdown', trigger: { type: 'duration', durationMs: 1000 }, chain: [{ action: 'sleep', delayMinutes: 30 }] };
        expect(validateTaskData(good).ok).toBe(true);
        expect(validateTaskData({ ...good, chain: [{ action: 'format', delayMinutes: 5 }] }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...good, chain: [{ action: 'sleep', delayMinutes: 0 }] }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...good, chain: Array.from({ length: 6 }, () => ({ action: 'sleep', delayMinutes: 1 })) }).code).toBe('INVALID_CHAIN');
    });
    it('lanAllowedIps listesi denetlenir (WBS-5.1)', () => {
        expect(validateSettings({ lanAllowedIps: ['192.168.1.10', '127.0.0.1'] }).ok).toBe(true);
        expect(validateSettings({ lanAllowedIps: [] }).ok).toBe(true);
        expect(validateSettings({ lanAllowedIps: ['1.1.1.1; shutdown'] }).ok).toBe(false);
        expect(validateSettings({ lanAllowedIps: '192.168.1.1' }).ok).toBe(false);
        expect(validateSettings({ lanAllowedIps: Array.from({ length: 17 }, (_, i) => `10.0.0.${i}`) }).ok).toBe(false);
    });
    it('cancel PIN biçimi denetlenir (WBS-11.2)', () => {
        expect(validateCancelPin('1234').ok).toBe(true);
        expect(validateCancelPin('123').code).toBe('INVALID_PIN');
        expect(validateCancelPin('abcd').code).toBe('INVALID_PIN');
        expect(validateCancelPin('').code).toBe('INVALID_PIN');
    });
    it('watt/fiyat null kabul edilir, kaynak enumları denetlenir (WBS-E1)', () => {
        expect(validateSettings({ deviceWattage: null }).ok).toBe(true);
        expect(validateSettings({ electricityCostPerKwh: null }).ok).toBe(true);
        expect(validateSettings({ wattSource: 'measured' }).ok).toBe(true);
        expect(validateSettings({ wattSource: 'uydurma' }).ok).toBe(false);
        expect(validateSettings({ priceSource: 'default' }).ok).toBe(true);
        expect(validateSettings({ deviceWattage: 'yüz' }).ok).toBe(false);
    });
});

describe('validateWebhooks', () => {
    it('geçerli liste kabul edilir', () => {
        const r = validateWebhooks([{ url: 'https://n8n.local/hook', events: ['task_created'], enabled: true }]);
        expect(r.ok).toBe(true);
    });
    it('ftp protokolü reddedilir', () => {
        expect(validateWebhooks([{ url: 'ftp://x/y' }]).ok).toBe(false);
    });
    it('bilinmeyen olay reddedilir', () => {
        expect(validateWebhooks([{ url: 'https://x/y', events: ['format_disk'] }]).ok).toBe(false);
    });
    it('21 kayıt reddedilir (limit 20)', () => {
        const list = Array.from({ length: 21 }, (_, i) => ({ url: `https://x/${i}` }));
        expect(validateWebhooks(list).ok).toBe(false);
    });
});
