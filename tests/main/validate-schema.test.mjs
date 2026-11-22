/**
 * validate-schema.test.mjs - IPC doğrulama katmanı (saf fonksiyonlar)
 *
 * Kapsam hedefi: ayar şeması türleri, IP/CIDR normalizasyonu, görev/koşul/
 * zincir doğrulaması, webhook SSRF kapısı ve PIN biçimi. Electron gerekmez.
 */
import { describe, it, expect } from 'vitest';

import {
    validateSettings,
    validateSecuritySettings,
    validateTaskData,
    validateTaskId,
    validateSnooze,
    validateWol,
    validateScheduleAction,
    validateWebhooks,
    validateCancelPin,
    validateCondition,
    isValidIpOrCidr,
    normalizeIpOrCidr,
    canonicalProcessName,
    SECURITY_SETTING_KEYS,
    MAX_DURATION_MS
} from '../../src/main/ipc/validate.js';

describe('validateSettings - şema türleri', () => {
    it('boş / dizi / null gövde reddedilir', () => {
        expect(validateSettings({}).code).toBe('INVALID_BODY');
        expect(validateSettings([]).code).toBe('INVALID_BODY');
        expect(validateSettings(null).code).toBe('INVALID_BODY');
        expect(validateSettings('x').code).toBe('INVALID_BODY');
    });

    it('20+ alan reddedilir', () => {
        const patch = {};
        for (let i = 0; i < 21; i += 1) patch[`k${i}`] = true;
        expect(validateSettings(patch).code).toBe('INVALID_BODY');
    });

    it('bilinmeyen anahtar UNKNOWN_SETTING döner', () => {
        expect(validateSettings({ nope: 1 }).code).toBe('UNKNOWN_SETTING');
    });

    it('boolean kuralı', () => {
        expect(validateSettings({ notifications: true }).ok).toBe(true);
        expect(validateSettings({ notifications: 'yes' }).code).toBe('INVALID_SETTING');
    });

    it('enum kuralı (tema/dil/para birimi)', () => {
        expect(validateSettings({ theme: 'light' }).ok).toBe(true);
        expect(validateSettings({ theme: 'blue' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ themeId: 'obsidian' }).ok).toBe(true);
        expect(validateSettings({ themeId: 'emerald' }).ok).toBe(true);
        expect(validateSettings({ themeId: 'invalid-palette' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ sidebarCollapsed: true }).ok).toBe(true);
        expect(validateSettings({ sidebarCollapsed: 'yes' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ currency: 'EUR' }).ok).toBe(true);
        expect(validateSettings({ language: 'az' }).ok).toBe(true);
        expect(validateSettings({ language: 'he' }).ok).toBe(true);
        expect(validateSettings({ language: 'xx' }).code).toBe('INVALID_SETTING');
    });

    it('int aralığı (port, wattage, bootGuardSeconds)', () => {
        expect(validateSettings({ localApiPort: 18456 }).ok).toBe(true);
        expect(validateSettings({ localApiPort: 0 }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ localApiPort: 65536 }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ localApiPort: 1.5 }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ deviceWattage: 250 }).ok).toBe(true);
        expect(validateSettings({ bootGuardSeconds: 0 }).ok).toBe(true);
        expect(validateSettings({ bootGuardSeconds: 1801 }).code).toBe('INVALID_SETTING');
    });

    it('num aralığı (elektrik fiyatı, assumedOffHours)', () => {
        expect(validateSettings({ electricityCostPerKwh: 2.5 }).ok).toBe(true);
        expect(validateSettings({ electricityCostPerKwh: -1 }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ assumedOffHours: 8 }).ok).toBe(true);
        expect(validateSettings({ assumedOffHours: '8' }).code).toBe('INVALID_SETTING');
    });

    it('nullable alanlarda null geçerlidir', () => {
        expect(validateSettings({ deviceWattage: null }).ok).toBe(true);
        expect(validateSettings({ electricityCostPerKwh: null }).ok).toBe(true);
        expect(validateSettings({ assumedOffHours: null }).ok).toBe(true);
        expect(validateSettings({ aiSilencedUntil: null }).ok).toBe(true);
        expect(validateSettings({ agentId: null }).ok).toBe(true);
    });

    it('ipList: geçerli liste, fazla kayıt, geçersiz kayıt, yinelenen (IPv4-mapped)', () => {
        expect(validateSettings({ lanAllowedIps: ['192.168.1.0/24', '10.0.0.5'] }).ok).toBe(true);
        expect(validateSettings({ lanAllowedIps: ['10.0.0.1', '::ffff:10.0.0.1'] }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ lanAllowedIps: ['999.1.1.1'] }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ lanAllowedIps: 'x' }).code).toBe('INVALID_SETTING');
        const many = Array.from({ length: 17 }, (_, i) => `10.0.0.${i + 1}`);
        expect(validateSettings({ lanAllowedIps: many }).code).toBe('INVALID_SETTING');
    });

    it('fingerprintList: 64 hex (iki nokta kabul) ve sınır', () => {
        const fp = 'a'.repeat(64);
        expect(validateSettings({ localApiClientFingerprints: [fp] }).ok).toBe(true);
        expect(validateSettings({ localApiClientFingerprints: [fp.replace(/(.{2})/g, '$1:').slice(0, -1)] }).ok).toBe(true);
        expect(validateSettings({ localApiClientFingerprints: ['abc'] }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ localApiClientFingerprints: 'x' }).code).toBe('INVALID_SETTING');
    });

    it('month: YYYY-MM veya unset', () => {
        expect(validateSettings({ priceEffectiveFrom: '2026-03' }).ok).toBe(true);
        expect(validateSettings({ priceEffectiveFrom: 'unset' }).ok).toBe(true);
        expect(validateSettings({ priceEffectiveFrom: '2026-13' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ priceEffectiveFrom: '26-03' }).code).toBe('INVALID_SETTING');
    });

    it('str + pattern (upsHost/upsName satır enjeksiyonu)', () => {
        expect(validateSettings({ upsHost: '127.0.0.1' }).ok).toBe(true);
        expect(validateSettings({ upsHost: 'bad host' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ upsName: 'ups\nRUN' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ upsName: '' }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ upsName: 'a'.repeat(65) }).code).toBe('INVALID_SETTING');
    });

    it('str uzunluk sınırı (CA dosyası yolu)', () => {
        expect(validateSettings({ localApiCaFile: 'C:\\certs\\ca.crt' }).ok).toBe(true);
        expect(validateSettings({ localApiCaFile: 'x'.repeat(513) }).code).toBe('INVALID_SETTING');
        expect(validateSettings({ localApiCaFile: 42 }).code).toBe('INVALID_SETTING');
    });
});

describe('validateSettings - LAN / TLS çapraz kuralları', () => {
    // Güvenlik bayrakları normal şemada yazılamaz; çapraz kurallar MEVCUT
    // ayarlarla birleşik etki üzerinden çalışır (bu yüzden currentSettings kullanılır).
    const cert = { localApiCertFile: 'C:\\c\\a.crt', localApiKeyFile: 'C:\\c\\a.key' };

    it('LAN açıkken boş allowlist reddedilir', () => {
        const r = validateSettings({ lanAllowedIps: [] }, { lanModeEnabled: true, localApiTlsEnabled: true });
        expect(r.code).toBe('LAN_ALLOWLIST_REQUIRED');
    });

    it('LAN + allowlist ama TLS yok → LAN_REQUIRES_TLS', () => {
        const r = validateSettings({ lanAllowedIps: ['10.0.0.0/8'] }, { lanModeEnabled: true });
        expect(r.code).toBe('LAN_REQUIRES_TLS');
    });

    it('LAN + TLS ama sertifika/anahtar yok → TLS_MATERIAL_REQUIRED', () => {
        const r = validateSettings({ lanAllowedIps: ['10.0.0.0/8'] }, { lanModeEnabled: true, localApiTlsEnabled: true });
        expect(r.code).toBe('TLS_MATERIAL_REQUIRED');
    });

    it('LAN + TLS + materyal → geçerli', () => {
        const r = validateSettings({ lanAllowedIps: ['10.0.0.0/8'] }, { lanModeEnabled: true, localApiTlsEnabled: true, ...cert });
        expect(r.ok).toBe(true);
    });

    it('mTLS TLS olmadan reddedilir', () => {
        expect(validateSecuritySettings({ localApiRequireClientCert: true }, {}).code).toBe('MTLS_REQUIRES_TLS');
    });

    it('sıkı TLS, TLS olmadan reddedilir', () => {
        expect(validateSecuritySettings({ localApiTlsStrict: true }, {}).code).toBe('TLS_STRICT_REQUIRES_TLS');
    });

    it('TLS açıkken mTLS/sıkı TLS geçerlidir', () => {
        const r = validateSecuritySettings({ localApiRequireClientCert: true, localApiTlsStrict: true }, { localApiTlsEnabled: true });
        expect(r.ok).toBe(true);
    });

    it('mevcut ayarlardan devralınan TLS durumu dikkate alınır', () => {
        const r = validateSettings({ notifications: true }, { localApiTlsEnabled: true, localApiRequireClientCert: true });
        expect(r.ok).toBe(true);
    });
});

describe('validateSecuritySettings', () => {
    it('güvenlik anahtarlarını kabul eder', () => {
        expect(validateSecuritySettings({ autonomyMode: 'full', automationPaused: true }, {}).ok).toBe(true);
        expect(validateSecuritySettings({ localApiKeyRole: 'operator' }, {}).ok).toBe(true);
        expect(validateSecuritySettings({ localApiKeyRole: 'root' }, {}).code).toBe('INVALID_SETTING');
    });

    it('normal ayar anahtarı güvenlik şemasında UNKNOWN_SETTING olur', () => {
        expect(validateSecuritySettings({ theme: 'dark' }, {}).code).toBe('UNKNOWN_SETTING');
    });

    it('SECURITY_SETTING_KEYS sabit ve dondurulmuş', () => {
        expect(Array.isArray(SECURITY_SETTING_KEYS)).toBe(true);
        expect(SECURITY_SETTING_KEYS).toContain('localApiEnabled');
        expect(SECURITY_SETTING_KEYS).toContain('agentDisabled');
        expect(Object.isFrozen(SECURITY_SETTING_KEYS)).toBe(true);
    });

    it('consoleUrl http(s) ve uzunluk sınırı', () => {
        expect(validateSecuritySettings({ consoleUrl: 'https://console.local' }, {}).ok).toBe(true);
        expect(validateSecuritySettings({ consoleUrl: 'ftp://x' }, {}).code).toBe('INVALID_SETTING');
        expect(validateSecuritySettings({ consoleUrl: 'not a url' }, {}).code).toBe('INVALID_SETTING');
        expect(validateSecuritySettings({ consoleUrl: `https://${'a'.repeat(520)}` }, {}).code).toBe('INVALID_SETTING');
    });
});

describe('normalizeIpOrCidr / isValidIpOrCidr', () => {
    it('IPv4 ve CIDR kanonikleşir', () => {
        expect(normalizeIpOrCidr(' 10.0.0.1 ')).toBe('10.0.0.1');
        expect(normalizeIpOrCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
        expect(isValidIpOrCidr('10.0.0.1')).toBe(true);
    });

    it('IPv4-mapped IPv6 IPv4\'e indirgenir', () => {
        expect(normalizeIpOrCidr('::ffff:192.168.1.5')).toBe('192.168.1.5');
        expect(normalizeIpOrCidr('::ffff:192.168.1.0/120')).toBe('192.168.1.0/24');
    });

    it('mapped /96\'dan geniş blok reddedilir (fail-open değil)', () => {
        expect(normalizeIpOrCidr('::ffff:10.0.0.0/64')).toBeNull();
    });

    it('zone ID atılır', () => {
        expect(normalizeIpOrCidr('fe80::1%eth0/64')).toBe('fe80::1/64');
    });

    it('geçersiz girdiler null', () => {
        for (const v of ['', '   ', 'a'.repeat(65), 'hostname', '10.0.0.1/33', '10.0.0.1/x', null, 5, {}]) {
            expect(normalizeIpOrCidr(v)).toBeNull();
        }
        expect(isValidIpOrCidr('nope')).toBe(false);
    });

    it('IPv6 büyük prefix sınırı', () => {
        expect(normalizeIpOrCidr('fe80::/129')).toBeNull();
        expect(normalizeIpOrCidr('fe80::/64')).toBe('fe80::/64');
    });
});

describe('canonicalProcessName', () => {
    it('küçük harfe indirir ve kırpar', () => {
        expect(canonicalProcessName('  Code.EXE ')).toBe('code.exe');
    });

    it('yol/glob/iki nokta içeren değerleri reddeder', () => {
        for (const v of ['C:\\x\\a.exe', 'a/b', 'a*b', 'a?b', 'c:a']) {
            expect(canonicalProcessName(v)).toBeNull();
        }
    });

    it('geçersiz türler ve uzunluk', () => {
        expect(canonicalProcessName(null)).toBeNull();
        expect(canonicalProcessName(42)).toBeNull();
        expect(canonicalProcessName('')).toBeNull();
        expect(canonicalProcessName('a'.repeat(121))).toBeNull();
        expect(canonicalProcessName('-a')).toBeNull();
    });
});

describe('validateCondition', () => {
    it('tür yoksa reddedilir', () => {
        expect(validateCondition(null).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 5 }).code).toBe('INVALID_CONDITION');
    });

    it('process_running ad doğrulaması', () => {
        expect(validateCondition({ type: 'process_running', processName: 'code.exe' }).ok).toBe(true);
        expect(validateCondition({ type: 'process_running', processName: 'C:\\x' }).code).toBe('INVALID_PROCESS_NAME');
    });

    it('dosya/klasör yolu', () => {
        expect(validateCondition({ type: 'file_stable', filePath: 'C:\\a.txt' }).ok).toBe(true);
        expect(validateCondition({ type: 'file_stable', filePath: '  ' }).code).toBe('INVALID_FILE_PATH');
        expect(validateCondition({ type: 'file_stable', filePath: 'x'.repeat(1025) }).code).toBe('INVALID_FILE_PATH');
        expect(validateCondition({ type: 'directory_idle', dirPath: 'C:\\dir' }).ok).toBe(true);
        expect(validateCondition({ type: 'directory_idle', filePath: 'C:\\dir' }).ok).toBe(true);
        expect(validateCondition({ type: 'directory_idle' }).code).toBe('INVALID_DIRECTORY_PATH');
    });

    it('eşikler: cpu/network/disk', () => {
        expect(validateCondition({ type: 'cpu_usage', thresholdPercent: 50 }).ok).toBe(true);
        expect(validateCondition({ type: 'cpu_usage', thresholdPercent: 101 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'network_speed', thresholdKbps: 100 }).ok).toBe(true);
        expect(validateCondition({ type: 'disk_activity', thresholdKbps: -1 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'network_speed', thresholdKbps: 1000001 }).code).toBe('INVALID_CONDITION');
    });

    it('user_idle sınırları', () => {
        expect(validateCondition({ type: 'user_idle', idleSeconds: 300 }).ok).toBe(true);
        expect(validateCondition({ type: 'user_idle', idleSeconds: 0 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'user_idle', idleSeconds: 86401 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'user_idle', idleSeconds: 1.5 }).code).toBe('INVALID_CONDITION');
    });

    it('battery_level: aynı anda below+above yasak', () => {
        expect(validateCondition({ type: 'battery_level', belowPercent: 20 }).ok).toBe(true);
        expect(validateCondition({ type: 'battery_level', abovePercent: 80 }).ok).toBe(true);
        expect(validateCondition({ type: 'battery_level', belowPercent: 10, abovePercent: 90 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'battery_level', belowPercent: 101 }).code).toBe('INVALID_CONDITION');
    });

    it('stabilitySeconds 0..3600', () => {
        expect(validateCondition({ type: 'cpu_usage', stabilitySeconds: 30 }).ok).toBe(true);
        expect(validateCondition({ type: 'cpu_usage', stabilitySeconds: 3601 }).code).toBe('INVALID_CONDITION');
        expect(validateCondition({ type: 'cpu_usage', stabilitySeconds: 1.5 }).code).toBe('INVALID_CONDITION');
    });
});

describe('validateScheduleAction', () => {
    it('geçerli eylem + süre', () => {
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 1000 }).ok).toBe(true);
    });

    it('gövde/eylem/süre hataları', () => {
        expect(validateScheduleAction(null).code).toBe('INVALID_BODY');
        expect(validateScheduleAction({ action: 'format', durationMs: 1000 }).code).toBe('INVALID_ACTION');
        expect(validateScheduleAction({ action: 'shutdown', durationMs: '1000' }).code).toBe('INVALID_DURATION');
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 1.5 }).code).toBe('INVALID_DURATION');
        expect(validateScheduleAction({ action: 'shutdown', durationMs: 0 }).code).toBe('INVALID_DURATION');
        expect(validateScheduleAction({ action: 'shutdown', durationMs: MAX_DURATION_MS + 1 }).code).toBe('INVALID_DURATION');
        expect(validateScheduleAction({ action: 'shutdown', durationMs: MAX_DURATION_MS }).ok).toBe(true);
    });
});

describe('validateTaskId / validateSnooze / validateWol / validateCancelPin', () => {
    it('taskId deseni', () => {
        expect(validateTaskId('task_abc-123').ok).toBe(true);
        expect(validateTaskId('a'.repeat(65)).code).toBe('INVALID_TASK_ID');
        expect(validateTaskId('has space').code).toBe('INVALID_TASK_ID');
        expect(validateTaskId(5).code).toBe('INVALID_TASK_ID');
    });

    it('snooze varsayılan 10 dk ve aralık', () => {
        expect(validateSnooze({ taskId: 't1' })).toEqual({ ok: true, minutes: 10 });
        expect(validateSnooze({ taskId: 't1', minutes: 60 }).ok).toBe(true);
        expect(validateSnooze({ taskId: 't1', minutes: 0 }).code).toBe('INVALID_SNOOZE');
        expect(validateSnooze({ taskId: 't1', minutes: 1441 }).code).toBe('INVALID_SNOOZE');
        expect(validateSnooze(null).code).toBe('INVALID_BODY');
        expect(validateSnooze({ taskId: 'bad id' }).code).toBe('INVALID_TASK_ID');
    });

    it('WOL MAC/adres/port', () => {
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF' }).ok).toBe(true);
        expect(validateWol({ macAddress: 'AABBCCDDEEFF' }).ok).toBe(true);
        expect(validateWol({ macAddress: 'nope' }).code).toBe('INVALID_MAC');
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: '192.168.1.255', port: 9 }).ok).toBe(true);
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', broadcastIp: 'bad host!' }).code).toBe('INVALID_HOST');
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', port: 0 }).code).toBe('INVALID_PORT');
        expect(validateWol({ macAddress: 'AA:BB:CC:DD:EE:FF', port: 65536 }).code).toBe('INVALID_PORT');
        expect(validateWol(null).code).toBe('INVALID_BODY');
    });

    it('PIN 4-8 hane', () => {
        expect(validateCancelPin('1234').ok).toBe(true);
        expect(validateCancelPin('12345678').ok).toBe(true);
        expect(validateCancelPin('123').code).toBe('INVALID_PIN');
        expect(validateCancelPin('123456789').code).toBe('INVALID_PIN');
        expect(validateCancelPin('abcd').code).toBe('INVALID_PIN');
    });
});

describe('validateTaskData', () => {
    const base = { action: 'shutdown', trigger: { type: 'duration', durationMs: 60000 } };

    it('gövde/eylem/ad doğrulaması', () => {
        expect(validateTaskData(null).code).toBe('INVALID_BODY');
        expect(validateTaskData({}).code).toBe('INVALID_ACTION');
        expect(validateTaskData({ action: 'format' }).code).toBe('INVALID_ACTION');
        expect(validateTaskData({ ...base, name: 'x'.repeat(121) }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ ...base, name: '<img>' }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ ...base, name: 'Gece kapatma' }).ok).toBe(true);
    });

    it('boşluktan ibaret ad reddedilir (adsız görev satırı oluşmasın)', () => {
        // Regresyon: '   ' kabul ediliyordu ve görev listesinde adsız bir
        // satır olarak görünüyordu.
        expect(validateTaskData({ ...base, name: '   ' }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ ...base, name: '\t\n ' }).code).toBe('INVALID_NAME');
        expect(validateTaskData({ ...base, name: '' }).code).toBe('INVALID_NAME');
        // Baştaki/sondaki boşluklu GERÇEK ad hâlâ kabul.
        expect(validateTaskData({ ...base, name: '  Gece kapatma  ' }).ok).toBe(true);
    });

    it('istemci kimlik ve ayrıcalıklı alanları gönderemez', () => {
        expect(validateTaskData({ ...base, id: 'task_x' }).code).toBe('INVALID_TASK_ID');
        for (const field of ['source', 'mode', 'status', 'enabled', 'policyId', 'consoleOrderId', 'requiresMaintenanceWindow', 'createdAt', 'lastResult']) {
            expect(validateTaskData({ ...base, [field]: 1 }).code).toBe('INVALID_FIELD');
        }
    });

    it('trigger doğrulaması', () => {
        expect(validateTaskData({ ...base, trigger: null }).code).toBe('INVALID_TRIGGER');
        expect(validateTaskData({ ...base, trigger: [] }).code).toBe('INVALID_TRIGGER');
        expect(validateTaskData({ ...base, trigger: { type: 'nope' } }).code).toBe('INVALID_TRIGGER');
        expect(validateTaskData({ ...base, trigger: { durationMs: 0 } }).code).toBe('INVALID_DURATION');
        expect(validateTaskData({ ...base, trigger: { durationMs: 1.2 } }).code).toBe('INVALID_DURATION');
        expect(validateTaskData({ ...base, trigger: { targetTime: -1 } }).code).toBe('INVALID_TRIGGER');
        // P1-6 (üçüncü tur): hedefsiz `scheduled_time` hiç tetiklenmeyen bir
        // görev üretir; artık sessizce kabul edilmez. Tekrarlayan görevde hedef
        // sunucuda `calculateNextRecurrence` ile hesaplandığı için muaftır.
        expect(validateTaskData({ ...base, trigger: { targetTime: null, type: 'scheduled_time' } }).code).toBe('INVALID_TRIGGER');
        expect(validateTaskData({
            ...base,
            trigger: { targetTime: null, type: 'scheduled_time' },
            recurrence: { enabled: true, frequency: 'daily', timeOfDay: '09:00' }
        }).ok).toBe(true);
        expect(validateTaskData({ ...base, trigger: { notBefore: 0 } }).code).toBe('INVALID_TRIGGER');
        expect(validateTaskData({ ...base, trigger: { notBefore: 123 } }).ok).toBe(true);
    });

    it('conditionGroup doğrulaması', () => {
        expect(validateTaskData({ ...base, conditionGroup: { conditions: 'x' } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { operator: 'XOR' } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { conditions: Array.from({ length: 11 }, () => ({ type: 'cpu_usage' })) } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { conditions: [{ type: '' }] } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { conditions: [{ type: 'cpu_usage', thresholdPercent: 200 }] } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { stabilitySeconds: -1 } }).code).toBe('INVALID_CONDITION');
        expect(validateTaskData({ ...base, conditionGroup: { operator: 'OR', conditions: [{ type: 'cpu_usage' }], stabilitySeconds: 60 } }).ok).toBe(true);
    });

    it('koşullu görev targetTime taşıyamaz (ADR-09)', () => {
        const r = validateTaskData({
            action: 'shutdown',
            trigger: { type: 'scheduled_time', targetTime: Date.now() + 1000 },
            conditionGroup: { conditions: [{ type: 'cpu_usage' }] }
        });
        expect(r.code).toBe('INVALID_TRIGGER');
        expect(r.error).toMatch(/notBefore/);
    });

    it('warningConfig', () => {
        expect(validateTaskData({ ...base, warningConfig: 'x' }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ ...base, warningConfig: { enabled: 'yes' } }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ ...base, warningConfig: { silentMode: 1 } }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ ...base, warningConfig: { durationSeconds: 3601 } }).code).toBe('INVALID_WARNING');
        expect(validateTaskData({ ...base, warningConfig: { enabled: true, durationSeconds: 0 } }).ok).toBe(true);
    });

    it('safetyPolicy kısmi olamaz (boolean zorunlu)', () => {
        expect(validateTaskData({ ...base, safetyPolicy: [] }).code).toBe('INVALID_SAFETY_POLICY');
        expect(validateTaskData({ ...base, safetyPolicy: { checkSystemLoad: 'no' } }).code).toBe('INVALID_SAFETY_POLICY');
        expect(validateTaskData({ ...base, safetyPolicy: { checkSystemLoad: false } }).ok).toBe(true);
        expect(validateTaskData({ ...base, safetyPolicy: {} }).ok).toBe(true);
    });

    it('snoozeConfig', () => {
        expect(validateTaskData({ ...base, snoozeConfig: 5 }).code).toBe('INVALID_SNOOZE');
        expect(validateTaskData({ ...base, snoozeConfig: { allowed: 'yes' } }).code).toBe('INVALID_SNOOZE');
        expect(validateTaskData({ ...base, snoozeConfig: { maxCount: 101 } }).code).toBe('INVALID_SNOOZE');
        expect(validateTaskData({ ...base, snoozeConfig: { durationMinutes: 0 } }).code).toBe('INVALID_SNOOZE');
        expect(validateTaskData({ ...base, snoozeConfig: { currentCount: -1 } }).code).toBe('INVALID_SNOOZE');
        expect(validateTaskData({ ...base, snoozeConfig: { maxCount: 3 } }).ok).toBe(true);
    });

    it('recurrence', () => {
        expect(validateTaskData({ ...base, recurrence: 0 }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { enabled: 'x' } }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { frequency: 'hourly' } }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { daysOfWeek: [7] } }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { daysOfWeek: 'mon' } }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { timeOfDay: '24:00' } }).code).toBe('INVALID_RECURRENCE');
        expect(validateTaskData({ ...base, recurrence: { enabled: true, frequency: 'weekly', daysOfWeek: [1, 3], timeOfDay: '23:30' } }).ok).toBe(true);
    });

    it('chain en fazla 5 halka', () => {
        expect(validateTaskData({ ...base, chain: 'x' }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...base, chain: Array.from({ length: 6 }, () => ({ action: 'lock', delayMinutes: 1 })) }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...base, chain: [{ action: 'rm', delayMinutes: 1 }] }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...base, chain: [{ action: 'lock', delayMinutes: 0 }] }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...base, chain: [{ action: 'lock', delayMinutes: 43201 }] }).code).toBe('INVALID_CHAIN');
        expect(validateTaskData({ ...base, chain: [{ action: 'lock', delayMinutes: 30 }, { action: 'sleep', delayMinutes: 60 }] }).ok).toBe(true);
    });
});

describe('validateWebhooks', () => {
    it('liste değilse reddedilir', () => {
        expect(validateWebhooks('x').code).toBe('INVALID_BODY');
        expect(validateWebhooks(null).code).toBe('INVALID_BODY');
    });

    it('21 webhook reddedilir', () => {
        const list = Array.from({ length: 21 }, () => ({ url: 'https://example.com/hook' }));
        expect(validateWebhooks(list).code).toBe('INVALID_WEBHOOK');
    });

    it('URL doğrulaması (https/port/userinfo)', () => {
        expect(validateWebhooks([{ url: 'https://example.com/hook' }]).ok).toBe(true);
        expect(validateWebhooks([{ url: 'http://example.com/hook' }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 'https://user:pw@example.com/hook' }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 42 }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([null]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: `https://example.com/${'a'.repeat(2040)}` }]).code).toBe('INVALID_WEBHOOK');
    });

    it('olay/etkin/secret alanları', () => {
        expect(validateWebhooks([{ url: 'https://example.com/h', events: 'x' }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 'https://example.com/h', events: ['task_created'] }]).ok).toBe(true);
        expect(validateWebhooks([{ url: 'https://example.com/h', events: ['unknown_event'] }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 'https://example.com/h', enabled: 'yes' }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 'https://example.com/h', secret: 'x'.repeat(513) }]).code).toBe('INVALID_WEBHOOK');
        expect(validateWebhooks([{ url: 'https://example.com/h', secret: 'abc' }]).ok).toBe(true);
    });
});
