/**
 * cli-commands.test.mjs — B2 CLI paritesi
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
        // timer/cancel zorunlu bayrak ister; diğerleri bayraksız geçerli olmalı.
        const minimal = {
            timer: ['timer', '--action', 'sleep', '--durationMs', '60000'],
            cancel: ['cancel', '--id', 'task_1']
        };
        for (const name of Object.keys(COMMANDS)) {
            const argv = minimal[name] || [name];
            const v = validate(parseArgs(argv));
            expect(v.ok, `${name} reddedilmemeli: ${v.error}`).toBe(true);
        }
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
