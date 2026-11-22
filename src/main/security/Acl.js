/**
 * Acl.js - WP-04.T3
 * Windows ACL sıkılaştırması: kalıtımı kaldırır, yalnızca sahip + SYSTEM +
 * Administrators (SID ile) erişim bırakır. İsim yerine SID kullanılır
 * (Türkçe/yerelleştirilmiş Windows çıktısından etkilenmez).
 * EFS şifreleme (`cipher /E`) opsiyoneldir ve Windows dışında no-op'tur.
 */

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const SYSTEM_SID = 'S-1-5-18';
const ADMINS_SID = 'S-1-5-32-544';

let cachedSid = null;

function isWindows() {
    return process.platform === 'win32';
}

/**
 * Windows sistem araçlarını System32'den tam yolla çözer.
 * PATH'te daha önce gelen bir `whoami` (ör. Git Bash/MSYS) `/user` bayrağını
 * tanımaz; bu durumda SID bulunamıyor ve ACL sıkılaştırması sessizce
 * devre dışı kalıyordu. Tam yol aynı zamanda PATH'e bırakılmış bir
 * `icacls`/`cipher` ikamesinin çalıştırılmasını da engeller.
 */
function systemTool(name) {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const full = path.join(root, 'System32', `${name}.exe`);
    try {
        if (fs.existsSync(full)) return full;
    } catch (_) { /* yut - aşağıdaki yalın ada düşer */ }
    return name;
}

/**
 * Geçerli kullanıcının SID'i (`whoami /user`). Sonuç önbelleğe alınır.
 */
function currentUserSid() {
    if (!isWindows()) return null;
    if (cachedSid) return cachedSid;
    try {
        const out = execFileSync(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
        });
        const m = out.match(/(S-1-5-[\d-]+)/);
        if (m) cachedSid = m[1];
    } catch (_) {
        cachedSid = null;
    }
    return cachedSid;
}

function aclArgs(target, sid, isDirectory) {
    const perm = isDirectory ? '(OI)(CI)F' : 'F';
    const args = [
        target,
        '/inheritance:r',
        '/grant:r', `*${sid}:${perm}`,
        '/grant:r', `*${SYSTEM_SID}:${perm}`,
        '/grant:r', `*${ADMINS_SID}:${perm}`,
        '/C', '/Q'
    ];
    // P0 REGRESYON: buraya `/T` eklenmemeli. `/T` ile birlikte `(OI)(CI)F`
    // maskesi dosyalara uygulandığında OI/CI yalnızca *alt nesneler* için
    // geçerli olduğundan dosyanın kendisine hiçbir ACE yazılmıyor; dosya
    // sahibi için bile erişilemez hale geliyordu. Sonuç: ilk çalıştırmadan
    // sonra powerpilot.db açılamıyor, uygulama bakım moduna düşüyor ve
    // kullanıcının tüm görev/ayarları kayboluyordu.
    // Doğrusu: yalnızca dizini kısıtla; alt nesneler kalıtımla (OI)(CI)
    // izinlerini alır. Yeni oluşturulan dosyalar da otomatik kalıtır.
    return args;
}

/** Tek dosya için açık (kalıtımsız) tam erişim argümanları. */
function fileAclArgs(target, sid) {
    return [
        target,
        '/inheritance:r',
        '/grant:r', `*${sid}:F`,
        '/grant:r', `*${SYSTEM_SID}:F`,
        '/grant:r', `*${ADMINS_SID}:F`,
        '/C', '/Q'
    ];
}

/** Bozulmuş ACL'i Windows varsayılanlarına döndürür (onarım kapısı). */
function resetAclArgs(target, recursive) {
    const args = [target, '/reset', '/C', '/Q'];
    if (recursive) args.push('/T');
    return args;
}

/**
 * Eski sürümlerin bozduğu dosya erişimini tespit eder: dosya okunamıyorsa
 * ACL onarımı gerekir. `null` dönerse erişim sağlıklı.
 *
 * ÖNEMLİ: `fs.accessSync` bu durumda yanıltıcıdır - bozuk ACL'li dosyada
 * `OK` dönerken gerçek `open()` EPERM veriyor. Bu yüzden gerçek okuma
 * denenir; tespit neyi engelliyorsa onu ölçmelidir.
 */
function accessProblem(target) {
    let stat;
    try {
        stat = fs.statSync(target);
    } catch (err) {
        return (err && err.code) || 'ENOENT';
    }
    if (stat.isDirectory()) {
        try {
            fs.readdirSync(target);
            return null;
        } catch (err) {
            return (err && err.code) || 'EACCES';
        }
    }
    try {
        const fd = fs.openSync(target, 'r+');
        try {
            const probe = Buffer.alloc(1);
            fs.readSync(fd, probe, 0, 1, 0);
        } finally {
            fs.closeSync(fd);
        }
        return null;
    } catch (err) {
        // Çalışan süreç (ör. Chromium lockfile) dosyayı özel kilitle tutuyorsa
        // EBUSY döner; bu bozuk ACL (EPERM/EACCES) değildir.
        if (err && err.code === 'EBUSY') return null;
        return (err && err.code) || 'EACCES';
    }
}

/**
 * P0 ONARIM: v1.1.0 ve öncesi, dizini `/T` + `(OI)(CI)F` ile kısıtlıyordu.
 * Bu kombinasyon dosyaların kendisine hiç ACE yazmadığı için `powerpilot.db`,
 * `secrets.v1.json` ve yedekler sahibi için bile erişilemez hale geliyordu;
 * sonraki açılışta DB açılamıyor, uygulama bakım moduna düşüyor ve kullanıcı
 * tüm görev/ayarlarını kaybediyordu.
 *
 * Bu fonksiyon yalnızca erişim gerçekten bozuksa devreye girer:
 *   1. Dizin ağacını Windows varsayılanlarına döndürür (`/reset /T`).
 *   2. Dizini doğru biçimde kısıtlar (`/T` YOK; alt nesneler kalıtır).
 *   3. Mevcut dosyalara açık tam erişim yazar (kalıtım beklenmeden).
 * Sağlıklı kurulumlarda hiçbir şey değiştirmez (idempotent, fail-safe).
 *
 * @returns {{repaired:boolean, reason?:string, items?:string[]}}
 */
function repairInheritedAccess(dirPath) {
    if (!isWindows()) return { repaired: false, reason: 'UNSUPPORTED_PLATFORM' };
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
        return { repaired: false, reason: 'INVALID_PATH' };
    }
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved)) return { repaired: false, reason: 'NOT_FOUND' };

    // Hızlı yol: dizin ve içindeki dosyalar okunabiliyorsa onarım gerekmez.
    const problems = [];
    const dirProblem = accessProblem(resolved);
    if (dirProblem) problems.push(`${path.basename(resolved)}:${dirProblem}`);
    let entries = [];
    try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (err) {
        problems.push(`${path.basename(resolved)}:${(err && err.code) || 'EACCES'}`);
    }
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const problem = accessProblem(path.join(resolved, entry.name));
        if (problem) problems.push(`${entry.name}:${problem}`);
    }
    if (problems.length === 0) return { repaired: false, reason: 'HEALTHY' };

    const sid = currentUserSid();
    if (!sid) return { repaired: false, reason: 'SID_UNAVAILABLE', items: problems };

    try {
        // 1) Kalıtımı geri aç: bozuk ACE'ler temizlenir.
        execFileSync(systemTool('icacls'), resetAclArgs(resolved, true), {
            stdio: 'ignore', windowsHide: true, timeout: 60000
        });
        // 2) Dizini doğru kısıtla (/T yok).
        execFileSync(systemTool('icacls'), aclArgs(resolved, sid, true), {
            stdio: 'ignore', windowsHide: true, timeout: 60000
        });
        // 3) Mevcut dosyalara açık erişim (kalıtım gecikmesine güvenme).
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            try {
                execFileSync(systemTool('icacls'), fileAclArgs(path.join(resolved, entry.name), sid), {
                    stdio: 'ignore', windowsHide: true, timeout: 30000
                });
            } catch (_) { /* tek dosya onarılamazsa diğerleri sürer */ }
        }
    } catch (err) {
        return { repaired: false, reason: 'ICACLS_FAILED', error: err && err.message, items: problems };
    }

    const stillBroken = [];
    if (accessProblem(resolved)) stillBroken.push(path.basename(resolved));
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (accessProblem(path.join(resolved, entry.name))) stillBroken.push(entry.name);
    }
    return {
        repaired: stillBroken.length === 0,
        reason: stillBroken.length === 0 ? 'REPAIRED' : 'STILL_BLOCKED',
        items: stillBroken.length > 0 ? stillBroken : problems
    };
}

/**
 * Dizini/dosyayı sıkılaştırır.
 * @returns {{ok:boolean, code?:string, error?:string, sid?:string}}
 */
function securePath(target, { isDirectory = null } = {}) {
    if (!isWindows()) return { ok: false, code: 'UNSUPPORTED_PLATFORM' };
    if (typeof target !== 'string' || target.length === 0) {
        return { ok: false, code: 'INVALID_PATH' };
    }
    const resolved = path.resolve(target);
    let dir = isDirectory;
    try {
        if (dir === null) dir = fs.statSync(resolved).isDirectory();
    } catch (err) {
        return { ok: false, code: 'NOT_FOUND', error: err.message };
    }
    const sid = currentUserSid();
    if (!sid) return { ok: false, code: 'SID_UNAVAILABLE' };
    const args = dir ? aclArgs(resolved, sid, true) : fileAclArgs(resolved, sid);
    try {
        execFileSync(systemTool('icacls'), args, { stdio: 'ignore', windowsHide: true, timeout: 30000 });
        return { ok: true, sid };
    } catch (err) {
        return { ok: false, code: 'ICACLS_FAILED', error: (err && err.message) || 'icacls başarısız', sid };
    }
}

function secureDirectory(dir) {
    return securePath(dir, { isDirectory: true });
}

function secureFile(file) {
    return securePath(file, { isDirectory: false });
}

/**
 * L-08: async ACL - başlangıç/kapanışta ana thread'i bloke etmez.
 * @returns {Promise<{ok:boolean, code?:string, error?:string, sid?:string}>}
 */
function securePathAsync(target, { isDirectory = null } = {}) {
    if (!isWindows()) return Promise.resolve({ ok: false, code: 'UNSUPPORTED_PLATFORM' });
    if (typeof target !== 'string' || target.length === 0) {
        return Promise.resolve({ ok: false, code: 'INVALID_PATH' });
    }
    const resolved = path.resolve(target);
    let dir = isDirectory;
    try {
        if (dir === null) dir = fs.statSync(resolved).isDirectory();
    } catch (err) {
        return Promise.resolve({ ok: false, code: 'NOT_FOUND', error: err.message });
    }
    const sid = currentUserSid();
    if (!sid) return Promise.resolve({ ok: false, code: 'SID_UNAVAILABLE' });
    const args = dir ? aclArgs(resolved, sid, true) : fileAclArgs(resolved, sid);
    return new Promise((resolve) => {
        execFile(systemTool('icacls'), args, { windowsHide: true, timeout: 30000 }, (err) => {
            resolve(err
                ? { ok: false, code: 'ICACLS_FAILED', error: (err && err.message) || 'icacls başarısız', sid }
                : { ok: true, sid });
        });
    });
}

function secureDirectoryAsync(dir) {
    return securePathAsync(dir, { isDirectory: true });
}

function secureFileAsync(file) {
    return securePathAsync(file, { isDirectory: false });
}

/**
 * `icacls` çıktısını döner (test/denetim için).
 */
function listAces(target) {
    if (!isWindows()) return { ok: false, code: 'UNSUPPORTED_PLATFORM', output: '' };
    try {
        const output = execFileSync(systemTool('icacls'), [path.resolve(target)], {
            encoding: 'utf8',
            windowsHide: true,
            timeout: 10000
        });
        return { ok: true, output };
    } catch (err) {
        return { ok: false, code: 'ICACLS_FAILED', output: String((err && err.stdout) || ''), error: err.message };
    }
}

/**
 * EFS ile dosyayı şifreler (Windows). Desteklenmiyorsa sessizce false.
 */
function encryptFileEfs(file) {
    if (!isWindows()) return { ok: false, code: 'UNSUPPORTED_PLATFORM' };
    try {
        execFileSync(systemTool('cipher'), ['/E', '/A', path.resolve(file)], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 30000
        });
        return { ok: true };
    } catch (err) {
        return { ok: false, code: 'EFS_FAILED', error: (err && err.message) || 'cipher başarısız' };
    }
}

function ensurePrivateDir(dir, { apply = true } = {}) {
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const acl = apply ? secureDirectory(resolved) : { ok: false, code: 'SKIPPED' };
    return { dir: resolved, acl };
}

function ensurePrivateFile(file, { apply = true, efs = false } = {}) {
    const resolved = path.resolve(file);
    const acl = apply ? secureFile(resolved) : { ok: false, code: 'SKIPPED' };
    const encrypted = efs ? encryptFileEfs(resolved) : { ok: false, code: 'SKIPPED' };
    return { file: resolved, acl, encrypted };
}

module.exports = {
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
};
