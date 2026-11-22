/**
 * diagnostics.test.mjs - WP-5: DiagnosticsService, saf Node ZIP üretimi,
 * gizli veri/yol maskeleme, destek paketi ve sabit support@vellium.dev / GitHub URL'leri.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
    DiagnosticsService,
    createZipBuffer,
    sanitizePathsAndSecrets,
    SUPPORT_EMAIL,
    GITHUB_ISSUES_URL
} from '../../src/main/services/DiagnosticsService.js';

const tmpDirs = [];
function freshDir(prefix = 'pp-diag-test-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* yut */ }
    }
});

/** Üretilen ZIP buffer'ından dosya isimlerini ve açılmış içeriklerini çözer. */
function unzipEntries(buf) {
    const out = {};
    let offset = 0;
    while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
        const method = buf.readUInt16LE(offset + 8);
        const compSize = buf.readUInt32LE(offset + 18);
        const nameLen = buf.readUInt16LE(offset + 26);
        const extraLen = buf.readUInt16LE(offset + 28);
        const nameStart = offset + 30;
        const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
        const dataStart = nameStart + nameLen + extraLen;
        const rawData = buf.subarray(dataStart, dataStart + compSize);
        const content = method === 8 ? zlib.inflateRawSync(rawData).toString('utf8') : rawData.toString('utf8');
        out[name] = content;
        offset = dataStart + compSize;
    }
    return out;
}

describe('DiagnosticsService (WP-5)', () => {
    it('createZipBuffer geçerli PKZIP üretir ve zlib ile eksiksiz açılır', () => {
        const zip = createZipBuffer([
            { name: 'hello.txt', content: 'Merhaba Power Pilot! '.repeat(20) },
            { name: 'data.json', content: JSON.stringify({ ok: true, n: 42 }) }
        ]);
        expect(zip.readUInt32LE(0)).toBe(0x04034b50);
        const files = unzipEntries(zip);
        expect(Object.keys(files).sort()).toEqual(['data.json', 'hello.txt']);
        expect(files['hello.txt']).toBe('Merhaba Power Pilot! '.repeat(20));
        expect(JSON.parse(files['data.json'])).toEqual({ ok: true, n: 42 });
    });

    it('sanitizePathsAndSecrets kullanıcı dizini ve tokenları maskeler', () => {
        const raw = 'Error at C:\\Users\\emir\\AppData\\Local\\app.js Authorization: Bearer secret1234567890';
        const clean = sanitizePathsAndSecrets(raw);
        expect(clean).not.toContain('\\emir\\');
        expect(clean).toContain('<USER>');
        expect(clean).not.toContain('secret1234567890');
    });

    it('çökme/hata kaydı, ZIP destek paketi oluşturma ve sır temizliği çalışır', () => {
        const userData = freshDir('pp-ud-');
        const downloads = freshDir('pp-dl-');
        const fakeStorage = {
            getSettings: () => ({
                language: 'tr',
                appIcon: 'classic-cyan',
                cancelPinHash: 'SUPER_SECRET_HASH',
                localApiKeyHash: 'API_HASH',
                consoleAgentKey: 'CONSOLE_SECRET'
            }),
            verifyAuditChain: () => ({ ok: true }),
            getAuditLog: () => [{ seq: 1 }],
            isMaintenanceMode: () => false
        };

        const svc = new DiagnosticsService({
            userDataDir: userData,
            downloadsDir: downloads,
            storageService: fakeStorage,
            appVersion: '1.0.0',
            distributionChannel: 'direct',
            isPortable: true
        });

        svc.recordCrash({ kind: 'uncaughtException', message: 'Boom in C:\\Users\\alice\\file.js' });
        svc.recordRendererError({ kind: 'window_error', message: 'UI error', stack: 'at C:\\Users\\alice\\app.js:12' });

        const snap = svc.getDiagnosticsSnapshot();
        expect(snap.counts.crashes).toBe(1);
        expect(snap.counts.errors).toBe(1);
        expect(snap.errors[0].stack).not.toContain('alice');
        expect(snap.supportEmail).toBe(SUPPORT_EMAIL);

        const bundle = svc.createSupportBundle();
        expect(bundle.ok).toBe(true);
        expect(fs.existsSync(bundle.filePath)).toBe(true);

        const unzipped = unzipEntries(fs.readFileSync(bundle.filePath));
        expect(Object.keys(unzipped).sort()).toEqual([
            'audit-status.json',
            'backend-log.txt',
            'crash-log.txt',
            'error-log.txt',
            'report.txt',
            'settings-summary.json',
            'system-info.json',
            'system-log.txt'
        ]);
        expect(unzipped['settings-summary.json']).not.toContain('SUPER_SECRET_HASH');
        expect(unzipped['settings-summary.json']).not.toContain('CONSOLE_SECRET');
        expect(unzipped['crash-log.txt']).not.toContain('alice');

        const mailto = svc.buildSupportMailto({ bundleFileName: bundle.fileName });
        expect(mailto.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
        expect(decodeURIComponent(mailto)).toContain(bundle.fileName);

        const gh = svc.buildGithubIssueUrl();
        expect(gh.startsWith(`${GITHUB_ISSUES_URL}?`)).toBe(true);

        svc.clearLogs();
        expect(svc.getDiagnosticsSnapshot().counts.totalErrors).toBe(0);
    });
});
