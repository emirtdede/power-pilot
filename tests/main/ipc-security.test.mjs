/**
 * ipc-security.test.mjs - WP-10.T1/T2/T4/T9
 * app:// yol çözümü, IPC gönderici denetimi, AI girdi sınırı ve
 * güvenlik ayarlarının normal yoldan yazılamaması.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveAppPath, isAllowedAppUrl, contentTypeFor, APP_ORIGIN } from '../../src/main/security/AppPaths.js';
import { isTrustedSender, guardIpcHandler } from '../../src/main/ipc/SenderGuard.js';
import { normalizeAiInput, MAX_AI_INPUT } from '../../src/main/ai/input.js';
import { validateSettings, validateSecuritySettings, SECURITY_SETTING_KEYS } from '../../src/main/ipc/validate.js';

const ROOT = path.resolve('src');
const eventFrom = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

describe('WP-10 app:// protokolü', () => {
    it('T-IPC-07: geçerli app yolu kök altında çözülür', () => {
        const r = resolveAppPath(ROOT, `${APP_ORIGIN}/index.html`);
        expect(r.ok).toBe(true);
        expect(r.filePath).toBe(path.join(ROOT, 'index.html'));
        expect(contentTypeFor(r.filePath)).toContain('text/html');
    });

    it('T-IPC-07: file:// ve yabancı origin reddedilir', () => {
        expect(resolveAppPath(ROOT, 'file:///C:/Windows/win.ini').ok).toBe(false);
        expect(resolveAppPath(ROOT, 'app://evil/index.html').ok).toBe(false);
    });

    it('T-IPC-07: path traversal ve ters bölü reddedilir', () => {
        expect(resolveAppPath(ROOT, `${APP_ORIGIN}/../main.js`).code).toBe('INVALID_PATH');
        expect(resolveAppPath(ROOT, `${APP_ORIGIN}/%2e%2e/main.js`).code).toBe('INVALID_PATH');
        expect(resolveAppPath(ROOT, `${APP_ORIGIN}/..%5cmain.js`).code).toBe('INVALID_PATH');
        expect(resolveAppPath(ROOT, `${APP_ORIGIN}/%00index.html`).code).toBe('INVALID_PATH');
    });

    it('T-IPC-08: IPC yalnızca app://powerpilot göndericisini kabul eder', async () => {
        expect(isTrustedSender(eventFrom(`${APP_ORIGIN}/index.html`))).toBe(true);
        expect(isTrustedSender(eventFrom('file:///C:/PowerPilot/src/index.html'))).toBe(false);
        expect(isTrustedSender(eventFrom('https://evil.example/'))).toBe(false);
        expect(isTrustedSender({})).toBe(false);

        const handler = guardIpcHandler(() => ({ ok: true }));
        await expect(handler(eventFrom('file:///x'))).rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' });
        await expect(handler(eventFrom(`${APP_ORIGIN}/index.html`))).resolves.toEqual({ ok: true });
    });
});

describe('WP-10 AI girdisi', () => {
    it('T-IPC-09: normalize eder ve 4000 karakterde reddeder', () => {
        expect(normalizeAiInput('  kapat\r\n  ')).toEqual({ ok: true, text: 'kapat' });
        expect(normalizeAiInput('x'.repeat(MAX_AI_INPUT)).ok).toBe(true);
        expect(normalizeAiInput('x'.repeat(MAX_AI_INPUT + 1)).code).toBe('INPUT_TOO_LONG');
        expect(normalizeAiInput(42).code).toBe('INVALID_INPUT');
        expect(normalizeAiInput('   ', { allowEmpty: false }).code).toBe('EMPTY_INPUT');
    });
});

describe('WP-10 güvenlik ayarları', () => {
    it('T-IPC-10: güvenlik anahtarları save-settings şemasında yok', () => {
        expect(SECURITY_SETTING_KEYS.length).toBeGreaterThan(0);
        const valid = {
            agentDisabled: true,
            autonomyMode: 'full',
            automationPaused: true,
            localApiEnabled: true,
            lanModeEnabled: true,
            localApiTlsEnabled: true,
            localApiTlsStrict: true,
            localApiRequireClientCert: true,
            localApiCertFile: 'C:/certs/server.pem',
            localApiKeyFile: 'C:/certs/server-key.pem',
            localApiKeyRole: 'operator',
            consoleAgentKey: 'agent-key-123',
            consoleUrl: 'https://console.example.com'
        };
        const current = {
            lanAllowedIps: ['192.168.1.0/24'],
            localApiTlsEnabled: true,
            localApiCertFile: 'C:/certs/server.pem',
            localApiKeyFile: 'C:/certs/server-key.pem'
        };
        for (const key of SECURITY_SETTING_KEYS) {
            expect(validateSettings({ [key]: valid[key] }).code).toBe('UNKNOWN_SETTING');
            expect(validateSecuritySettings({ [key]: valid[key] }, current).ok).toBe(true);
        }
    });

    it('T-IPC-10: güvenlik yaması çapraz-alan kurallarını korur', () => {
        const tls = {
            lanAllowedIps: ['192.168.1.0/24'],
            localApiCertFile: 'C:/certs/server.pem',
            localApiKeyFile: 'C:/certs/server-key.pem'
        };
        expect(validateSecuritySettings({ lanModeEnabled: true }, { ...tls, localApiTlsEnabled: true, lanAllowedIps: [] }).ok).toBe(false);
        expect(validateSecuritySettings({ lanModeEnabled: true, localApiTlsEnabled: true }, tls).ok).toBe(true);
        expect(validateSecuritySettings({ lanModeEnabled: true, localApiTlsEnabled: false }, tls).ok).toBe(false);
    });
});

describe('WP-10 origin yardımcıları', () => {
    it('isAllowedAppUrl yalnızca tam origin + yol kabul eder', () => {
        expect(isAllowedAppUrl(`${APP_ORIGIN}/mini.html`)).toBe(true);
        expect(isAllowedAppUrl('app://powerpilot.evil/index.html')).toBe(false);
        expect(isAllowedAppUrl('app://powerpilot@evil/index.html')).toBe(false);
        expect(isAllowedAppUrl(undefined)).toBe(false);
    });
});
