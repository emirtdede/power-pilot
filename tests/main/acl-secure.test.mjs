/**
 * acl-secure.test.mjs - Windows ACL sıkılaştırması
 *
 * Yalnızca testin kendi oluşturduğu GEÇİCİ dizin/dosya üzerinde çalışır;
 * sistem dizinlerine dokunulmaz. Windows dışında testler atlanır.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
    isWindows,
    currentUserSid,
    securePath,
    secureDirectory,
    secureFile,
    securePathAsync,
    secureDirectoryAsync,
    secureFileAsync,
    listAces,
    accessProblem,
    repairInheritedAccess,
    encryptFileEfs,
    ensurePrivateDir,
    ensurePrivateFile,
    SYSTEM_SID,
    ADMINS_SID
} from '../../src/main/security/Acl.js';

// icacls'i System32'den tam yolla çöz (PATH'te ikame olabilir).
function icacls() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const full = path.join(root, 'System32', 'icacls.exe');
    return fs.existsSync(full) ? full : 'icacls.exe';
}

const isWin = process.platform === 'win32';
let tmpDir = null;
let tmpFile = null;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acl-'));
    tmpFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(tmpFile, 'x');
});
afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* yut */ }
});

describe('Acl - platform ve SID', () => {
    it('isWindows platformla tutarlı', () => {
        expect(isWindows()).toBe(process.platform === 'win32');
    });

    it('SID sabitleri doğru', () => {
        expect(SYSTEM_SID).toBe('S-1-5-18');
        expect(ADMINS_SID).toBe('S-1-5-32-544');
    });

    it('currentUserSid Windows\'ta S-1-5- deseni döner, aksi halde null', () => {
        const sid = currentUserSid();
        if (!isWin) {
            expect(sid).toBeNull();
        } else {
            expect(sid === null || /^S-1-5-[\d-]+$/.test(sid)).toBe(true);
        }
        // Önbellek: ikinci çağrı aynı değeri verir.
        expect(currentUserSid()).toBe(sid);
    });
});

describe('Acl - geçersiz girdiler (OS çağrısı yok)', () => {
    it('boş/geçersiz yol INVALID_PATH', async () => {
        expect(securePath('')).toMatchObject({ ok: false, code: 'INVALID_PATH' });
        expect(securePath(null)).toMatchObject({ ok: false, code: 'INVALID_PATH' });
        await expect(securePathAsync('')).resolves.toMatchObject({ ok: false, code: 'INVALID_PATH' });
    });

    it('var olmayan yol NOT_FOUND', async () => {
        const missing = path.join(os.tmpdir(), `pp-acl-missing-${Date.now()}`);
        expect(securePath(missing)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
        await expect(securePathAsync(missing)).resolves.toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('listAces geçersiz yolda ICACLS_FAILED (Windows) veya UNSUPPORTED', () => {
        if (!isWin) {
            expect(listAces('x')).toMatchObject({ ok: false, code: 'UNSUPPORTED_PLATFORM' });
            return;
        }
        const r = listAces(path.join(os.tmpdir(), `pp-acl-404-${Date.now()}`));
        expect(r.ok).toBe(false);
        expect(r.code).toBe('ICACLS_FAILED');
        expect(typeof r.output).toBe('string');
    });

    it('ensurePrivateDir/File apply:false → SKIPPED (OS çağrısı yok)', () => {
        const dir = ensurePrivateDir(tmpDir, { apply: false });
        expect(dir.dir).toBe(path.resolve(tmpDir));
        expect(dir.acl).toEqual({ ok: false, code: 'SKIPPED' });
        const file = ensurePrivateFile(tmpFile, { apply: false });
        expect(file.file).toBe(path.resolve(tmpFile));
        expect(file.acl).toEqual({ ok: false, code: 'SKIPPED' });
        expect(file.encrypted).toEqual({ ok: false, code: 'SKIPPED' });
    });

    it('ensurePrivateDir yeni dizini oluşturur', () => {
        const target = path.join(tmpDir, `nested-${Date.now()}`);
        const out = ensurePrivateDir(target, { apply: false });
        expect(fs.existsSync(out.dir)).toBe(true);
    });
});

describe.skipIf(!isWin)('Acl - Windows üzerinde geçici dizin', () => {
    it('secureDirectory geçici dizinde başarılı olur (sahip+SYSTEM+Administrators)', () => {
        const r = secureDirectory(tmpDir);
        expect(r.ok).toBe(true);
        expect(r.sid).toMatch(/^S-1-5-/);
    });

    it('secureFile geçici dosyada başarılı olur', () => {
        const r = secureFile(tmpFile);
        expect(r.ok).toBe(true);
    });

    it('securePathAsync / secureDirectoryAsync / secureFileAsync başarılı', async () => {
        await expect(secureDirectoryAsync(tmpDir)).resolves.toMatchObject({ ok: true });
        await expect(secureFileAsync(tmpFile)).resolves.toMatchObject({ ok: true });
        await expect(securePathAsync(tmpDir)).resolves.toMatchObject({ ok: true });
    });

    it('listAces icacls çıktısını döner (yol + erişim maskesi)', () => {
        const r = listAces(tmpDir);
        expect(r.ok).toBe(true);
        expect(r.output.toLowerCase()).toContain(path.basename(tmpDir).toLowerCase());
        expect(r.output).toContain('(OI)(CI)');
    });

    it('ensurePrivateDir/File apply:true ACL uygular', () => {
        const d = ensurePrivateDir(tmpDir);
        expect(d.acl.ok).toBe(true);
        const f = ensurePrivateFile(tmpFile);
        expect(f.acl.ok).toBe(true);
        expect(f.encrypted.code).toBe('SKIPPED');
    });

    it('encryptFileEfs sonuç şekli doğru (ok veya EFS_FAILED)', () => {
        const target = path.join(tmpDir, `efs-${Date.now()}.txt`);
        fs.writeFileSync(target, 'x');
        const r = encryptFileEfs(target);
        expect(typeof r.ok).toBe('boolean');
        if (r.ok === false) expect(r.code).toBe('EFS_FAILED');
        try { fs.rmSync(target, { force: true }); } catch (_) { /* yut */ }
    });
});

/**
 * P0 REGRESYON - v1.1.0 ve öncesi `icacls <dizin> ... /T` kullanıyordu.
 * `/T` + `(OI)(CI)F` kombinasyonu dosyalara hiç ACE yazmadığı için
 * `powerpilot.db` sahibi tarafından bile açılamıyor, uygulama bakım moduna
 * düşüyor ve kullanıcının tüm görev/ayarları kayboluyordu.
 * Bu testler o hatanın geri gelmesini engeller.
 */
describe.skipIf(!isWin)('Acl - P0 regresyon: dosya erişimi korunur', () => {
    let dir = null;
    const makeDir = () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acl-p0-'));
        fs.writeFileSync(path.join(d, 'powerpilot.db'), 'SQLite format 3.');
        return d;
    };

    beforeAll(() => { dir = makeDir(); });
    afterAll(() => {
        if (!dir) return;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* yut */ }
    });

    it('secureDirectory sonrası mevcut dosyalar okunabilir/yazılabilir kalır', () => {
        const dbPath = path.join(dir, 'powerpilot.db');
        expect(accessProblem(dbPath)).toBeNull();
        expect(secureDirectory(dir).ok).toBe(true);
        // Sahip dosyayı hâlâ açabilmeli (fs.accessSync yanıltıcı, gerçek açma).
        expect(accessProblem(dbPath)).toBeNull();
        expect(fs.readFileSync(dbPath, 'utf8')).toBe('SQLite format 3.');
    });

    it('secureDirectory sonrası sonradan oluşturulan dosya kalıtımla erişilebilir', () => {
        expect(secureDirectory(dir).ok).toBe(true);
        const fresh = path.join(dir, 'secrets.v1.json');
        fs.writeFileSync(fresh, '{"v":1}');
        expect(accessProblem(fresh)).toBeNull();
        expect(fs.readFileSync(fresh, 'utf8')).toBe('{"v":1}');
    });

    it('dizin sıkılaştırması icacls çağrısında /T KULLANMAZ', () => {
        // aclArgs dışa açık değil; davranışı icacls çıktısından doğrula:
        // /T + (OI)(CI) dosyalarda ACE bırakmaz, dosya okunamaz olurdu.
        expect(secureDirectory(dir).ok).toBe(true);
        const aces = listAces(dir);
        expect(aces.ok).toBe(true);
        expect(aces.output).toContain('(OI)(CI)');
        const dbAces = listAces(path.join(dir, 'powerpilot.db'));
        expect(dbAces.ok).toBe(true);
        // Dosyada gerçek bir ACE olmalı (yalnızca yol satırı yeterli değil).
        expect(dbAces.output).toMatch(/:(\([A-Z]+\)|[A-Z])/);
    });

    it('repairInheritedAccess bozulmuş (/T) dizini onarır, sağlıklıda değişiklik yapmaz', () => {
        const broken = makeDir();
        try {
            const sid = currentUserSid();
            expect(sid).toBeTruthy();
            // Eski sürümün hatasını birebir üret.
            execFileSync(icacls(), [
                broken, '/inheritance:r',
                '/grant:r', `*${sid}:(OI)(CI)F`, '/T', '/C', '/Q'
            ], { stdio: 'ignore', windowsHide: true });
            const dbPath = path.join(broken, 'powerpilot.db');
            // Bozulduğunu doğrula: sahibi bile açamıyor.
            expect(accessProblem(dbPath)).not.toBeNull();

            const fixed = repairInheritedAccess(broken);
            expect(fixed.repaired).toBe(true);
            expect(fixed.reason).toBe('REPAIRED');
            expect(accessProblem(dbPath)).toBeNull();
            expect(fs.readFileSync(dbPath, 'utf8')).toBe('SQLite format 3.');

            // İdempotent: ikinci çağrı hiçbir şeyi bozmaz.
            const again = repairInheritedAccess(broken);
            expect(again).toMatchObject({ repaired: false, reason: 'HEALTHY' });
        } finally {
            try {
                execFileSync(icacls(), [broken, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore', windowsHide: true });
            } catch (_) { /* yut */ }
            try { fs.rmSync(broken, { recursive: true, force: true }); } catch (_) { /* yut */ }
        }
    });

    it('accessProblem erişilebilir dosyada null, eksik dosyada ENOENT döner', () => {
        expect(accessProblem(path.join(dir, 'powerpilot.db'))).toBeNull();
        expect(accessProblem(path.join(dir, 'yok-' + Date.now() + '.db'))).toBe('ENOENT');
    });

    it('accessProblem çalışan süreç kilidini (EBUSY) ACL hatası saymaz', () => {
        const lockedPath = path.join(dir, 'lockfile-test');
        fs.writeFileSync(lockedPath, 'lock');
        const origOpen = fs.openSync;
        fs.openSync = (p, ...rest) => {
            if (p === lockedPath) {
                const err = new Error('EBUSY: resource busy or locked');
                err.code = 'EBUSY';
                throw err;
            }
            return origOpen.call(fs, p, ...rest);
        };
        try {
            expect(accessProblem(lockedPath)).toBeNull();
        } finally {
            fs.openSync = origOpen;
            try { fs.rmSync(lockedPath, { force: true }); } catch (_) { /* yut */ }
        }
    });
});
