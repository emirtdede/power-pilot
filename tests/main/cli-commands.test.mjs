/**
 * cli-commands.test.mjs - B2 CLI paritesi
 *
 * SAF modül: ağ yok, OS yok. Argüman ayrıştırma, istek kurma ve doğrulama
 * doğrudan test edilir. HTTP taşıması `powerpilot.js` içinde ayrıdır.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    POWER_ACTIONS,
    COMMANDS,
    parseArgs,
    buildRequest,
    validate,
    usageText,
    renderResponse
} = require('../../src/cli/commands.js');

describe('CLI komut kataloğu', () => {
    it('altı güç eylemini içerir', () => {
        expect(POWER_ACTIONS.sort()).toEqual(['hibernate', 'lock', 'restart', 'shutdown', 'signout', 'sleep']);
    });

    it('her güç eylemi POST /power/<action> üretir', () => {
        for (const action of POWER_ACTIONS) {
            const req = buildRequest(parseArgs([action]));
            expect(req).toMatchObject({ method: 'POST', path: `/power/${action}` });
        }
    });

    it('status varsayılan komuttur', () => {
        const parsed = parseArgs([]);
        expect(parsed.command).toBe('status');
        expect(buildRequest(parsed)).toMatchObject({ method: 'GET', path: '/status' });
    });

    it('API yüzeyini kapsar (B2 parite)', () => {
        // Yerel API'nin kullanıcı uçları CLI\'da karşılık bulmalı.
        const paths = Object.keys(COMMANDS).map((name) => buildRequest(parseArgs([name])).path);
        expect(paths).toContain('/status');
        expect(paths).toContain('/tasks');
        expect(paths).toContain('/inventory');
        expect(paths).toContain('/exemptions');
        expect(paths).toContain('/maintenance-windows');
        expect(paths).toContain('/audit');
        expect(paths).toContain('/audit/verify');
        expect(paths).toContain('/tasks/timer');
        expect(paths).toContain('/orders/pending');
    });

    it('--limit/--offset tasks sorgusuna eklenir', () => {
        const req = buildRequest(parseArgs(['tasks', '--limit', '5', '--offset', '10']));
        expect(req.path).toBe('/tasks?limit=5&offset=10');
    });

    it('audit --verify=1 ve --beforeSeq sorgusu', () => {
        const req = buildRequest(parseArgs(['audit', '--limit', '20', '--beforeSeq', '100', '--verify']));
        expect(req.path).toBe('/audit?limit=20&beforeSeq=100&verify=1');
    });

    it('timer gövdesi action/durationMs/name taşır', () => {
        const req = buildRequest(parseArgs(['timer', '--action', 'sleep', '--durationMs', '60000', '--name', 'Test']));
        expect(req).toMatchObject({
            method: 'POST',
            path: '/tasks/timer',
            // P0-4: Local API `Number.isInteger` bekler; gönderilen değer sayı olmalı.
            body: { action: 'sleep', durationMs: 60000, name: 'Test' }
        });
        expect(typeof req.body.durationMs).toBe('number');
    });

    it('--minutes değeri tam sayı milisaniyeye çevrilir (400 hatası regresyonu)', () => {
        const req = buildRequest(parseArgs(['timer', '--minutes', '45']));
        expect(req.body.durationMs).toBe(2700000);
        expect(Number.isInteger(req.body.durationMs)).toBe(true);
    });

    it('cancel id yol parçasına kodlanır', () => {
        const req = buildRequest(parseArgs(['cancel', '--id', 'task_abc/../x']));
        expect(req.path).toBe('/tasks/task_abc%2F..%2Fx/cancel');
    });

    it('--flag=value biçimi desteklenir', () => {
        const parsed = parseArgs(['timer', '--action=restart', '--durationMs=1000']);
        expect(parsed.flags).toEqual({ action: 'restart', durationMs: '1000' });
        expect(parsed.errors).toEqual([]);
    });

    it('bilinmeyen bayrak sessizce yutulmaz', () => {
        const parsed = parseArgs(['status', '--nope']);
        expect(parsed.errors).toEqual(['bilinmeyen bayrak: --nope']);
    });

    it('değer bekleyen bayrakta eksik değer hata verir', () => {
        const parsed = parseArgs(['timer', '--durationMs']);
        expect(parsed.errors).toContain('--durationMs için değer gerekli');
    });

    it('fazla pozisyonel argüman hata verir', () => {
        const parsed = parseArgs(['status', 'extra']);
        expect(parsed.errors).toEqual(['fazla argüman: extra']);
    });

    it('--help tanınır', () => {
        expect(parseArgs(['--help']).flags.help).toBe(true);
        expect(parseArgs(['-h']).flags.help).toBe(true);
    });

    it('bilinmeyen komut doğrulamada reddedilir', () => {
        const v = validate(parseArgs(['format-disk']));
        expect(v.ok).toBe(false);
        expect(v.error).toContain('format-disk');
    });

    it('timer geçersiz action/süre reddedilir', () => {
        expect(validate(parseArgs(['timer', '--action', 'nuke', '--durationMs', '1000'])).ok).toBe(false);
        expect(validate(parseArgs(['timer', '--action', 'sleep', '--durationMs', '0'])).ok).toBe(false);
        expect(validate(parseArgs(['timer', '--action', 'sleep', '--durationMs', '-5'])).ok).toBe(false);
        expect(validate(parseArgs(['timer', '--action', 'sleep', '--durationMs', '1.5'])).ok).toBe(false);
        expect(validate(parseArgs(['timer', '--action', 'sleep', '--durationMs', '1000'])).ok).toBe(true);
    });

    it('cancel --id olmadan reddedilir', () => {
        expect(validate(parseArgs(['cancel'])).ok).toBe(false);
        expect(validate(parseArgs(['cancel', '--id', 'task_1'])).ok).toBe(true);
    });

    it('geçerli komutlar doğrulamadan geçer', () => {
        const minimal = {
            timer: ['timer', '--action', 'sleep', '--durationMs', '60000'],
            'task-create': ['task-create', '--action', 'sleep', '--minutes', '15'],
            cancel: ['cancel', '--id', 'task_1'],
            pause: ['pause', '--id', 'task_1'],
            resume: ['resume', '--id', 'task_1'],
            snooze: ['snooze', '--id', 'task_1', '--minutes', '5'],
            'run-now': ['run-now', '--id', 'task_1'],
            'delete-task': ['delete-task', '--id', 'task_1'],
            'template-save': ['template-save', '--name', 'Gece', '--action', 'sleep', '--minutes', '20'],
            'template-run': ['template-run', '--id', 'tpl_1'],
            'template-delete': ['template-delete', '--id', 'user_tpl_1'],
            'template-reset': ['template-reset', '--id', 'tpl_1'],
            'settings-set': ['settings-set', '--key', 'theme', '--value', 'dark'],
            'security-set': ['security-set', '--key', 'autonomyMode', '--value', 'classic'],
            'cancel-pin-set': ['cancel-pin-set', '--pin', '1234'],
            'import-settings': ['import-settings', '--json-body', '{"theme":"dark"}'],
            'import-templates': ['import-templates', '--json-body', '{"schema":1,"templates":[]}'],
            'wol-devices-save': ['wol-devices-save', '--mac', 'AA:BB:CC:DD:EE:FF'],
            'wol-send': ['wol-send', '--mac', 'AA:BB:CC:DD:EE:FF'],
            'webhooks-save': ['webhooks-save', '--url', 'https://example.com/hook'],
            'webhook-test': ['webhook-test', '--url', 'https://example.com/hook'],
            'cloud-provider': ['cloud-provider', '--provider', 'onedrive'],
            'cloud-autosync': ['cloud-autosync', '--on'],
            'cloud-folder': ['cloud-folder', '--dir', 'C:\\Temp\\PowerPilot'],
            'ai-parse': ['ai-parse', '--text', '30 dakika sonra uyut'],
            'ai-assist': ['ai-assist', '--text', 'MCP nasil baglanir?'],
            'ai-dismiss': ['ai-dismiss', '--topic', 'night_sleep'],
            'docs-search': ['docs-search', '--query', 'mcp'],
            'updates-install-on-quit': ['updates-install-on-quit', '--on'],
            'exemption-delete': ['exemption-delete', '--id', 'ex_1'],
            'window-delete': ['window-delete', '--id', 'mw_1'],
            'order-submit': ['order-submit', '--json-body', '{"order":{},"signature":"abc"}']
        };
        for (const name of Object.keys(COMMANDS)) {
            const argv = minimal[name] || [name];
            const v = validate(parseArgs(argv));
            expect(v.ok, `${name} reddedilmemeli: ${v.error}`).toBe(true);
        }
    });

    it('cancel ve pause-all --pin bayragini JSON govdesine tasir', () => {
        const c = buildRequest(parseArgs(['cancel', '--id', 'task_1', '--pin', '1234']));
        expect(c.body).toEqual({ pin: '1234' });
        const p = buildRequest(parseArgs(['pause-all', '--on', '--pin', '1234']));
        expect(p.body).toEqual({ paused: true, pin: '1234' });
    });

    it('status varsayilan olarak insan-okunabilir formatta, --json ile ham JSON doner', () => {
        const req = buildRequest(parseArgs(['status']));
        const body = { status: 'online', version: '1.0.0', headless: true, transport: 'http', boundHost: '127.0.0.1', port: 18456, keyRole: 'admin', activeTasksCount: 2, pausedAll: false };
        const human = renderResponse(req, { status: 200, body });
        expect(human).toContain('Power Pilot v1.0.0 (online)');
        expect(human).toContain('Headless Daemon');
        const raw = renderResponse(req, { status: 200, body }, { json: true });
        expect(JSON.parse(raw)).toEqual(body);
    });

    it('usageText tüm komutları listeler', () => {
        const text = usageText();
        for (const name of Object.keys(COMMANDS)) expect(text).toContain(name);
        for (const action of POWER_ACTIONS) expect(text).toContain(action);
    });

    it('renderResponse API hatasını okunur biçimde gösterir', () => {
        const req = buildRequest(parseArgs(['status']));
        const out = renderResponse(req, { status: 403, body: { error: 'Yetkisiz', code: 'FORBIDDEN' } });
        expect(out).toBe('Hata (403): Yetkisiz [FORBIDDEN]');
    });

    it('renderResponse --json ham gövde döner', () => {
        const req = buildRequest(parseArgs(['status']));
        const body = { status: 'online' };
        const out = renderResponse(req, { status: 200, body }, { json: true });
        expect(JSON.parse(out)).toEqual(body);
    });

    it('buildRequest bilinmeyen komutta null döner', () => {
        expect(buildRequest({ command: 'nope', flags: {} })).toBeNull();
    });
});
