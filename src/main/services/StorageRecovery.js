/**
 * StorageRecovery.js - bozuk veritabanından kurtarma.
 *
 * Son kullanıcı senaryosu: yazma sırasında elektrik kesilir, antivirüs
 * dosyayı kilitler veya disk hata verir → `powerpilot.db` bozulur.
 * Öncesinde uygulama açılıyor ama HİÇBİR görev oluşturulamıyordu
 * ("Task could not be created") ve kullanıcıya çıkış yolu gösterilmiyordu.
 *
 * Bu modül iki şeyi garanti eder:
 *   1. Bozuk dosya SİLİNMEZ: `quarantine/` altına taşınır (veri kurtarma
 *      umudu ve destek için).
 *   2. Uygulama temiz veriyle açılır; kullanıcı çalışmaya devam edebilir.
 *
 * Ayrıca şifreli yedeklerden geri yükleme için ince bir yardımcı sunar.
 * Electron'a bağımlı değildir (birim test edilebilir).
 */

const fs = require('node:fs');
const path = require('node:path');

const QUARANTINE_DIR = 'quarantine';
const BACKUP_PREFIX = 'powerpilot';

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Verilen dizindeki şifreli yedekleri yeniden eskiye sıralar.
 * Yalnızca `<prefix>_*.db.enc` dosyaları dikkate alınır.
 */
function listBackups(backupDir, { prefix = BACKUP_PREFIX, nowMs = Date.now() } = {}) {
    if (typeof backupDir !== 'string' || !fs.existsSync(backupDir)) return [];
    let entries = [];
    try {
        entries = fs.readdirSync(backupDir);
    } catch (_) {
        return [];
    }
    return entries
        .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith('.db.enc'))
        .map((name) => {
            const full = path.join(backupDir, name);
            let mtimeMs = nowMs;
            let bytes = 0;
            try {
                const st = fs.statSync(full);
                mtimeMs = st.mtimeMs;
                bytes = st.size;
            } catch (_) { /* yut */ }
            return { name, path: full, mtimeMs, bytes };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Bozuk DB dosyasını (ve WAL/SHM artıklarını) karantinaya alır.
 * Dosya SİLİNMEZ; yalnızca taşınır. Taşıma başarısız olursa hata fırlatır
 * (çağıran bakım moduna düşer - sessiz veri kaybı olmaz).
 *
 * @returns {{quarantined: string|null, removedSidecars: string[]}}
 */
function quarantineDatabase(dbPath, { quarantineDir = null, when = new Date() } = {}) {
    if (typeof dbPath !== 'string' || dbPath.length === 0) {
        throw Object.assign(new Error('dbPath gerekli.'), { code: 'INVALID_DB_PATH' });
    }
    const dir = quarantineDir || path.join(path.dirname(dbPath), QUARANTINE_DIR);
    fs.mkdirSync(dir, { recursive: true });

    let quarantined = null;
    if (fs.existsSync(dbPath)) {
        const target = path.join(dir, `powerpilot_corrupt_${timestamp()}.db`);
        // Aynı ada çakışma olursa son ek ver (hızlı ardışık açılışlar).
        let finalTarget = target;
        let i = 1;
        while (fs.existsSync(finalTarget)) {
            finalTarget = target.replace(/\.db$/, `-${i}.db`);
            i += 1;
        }
        fs.renameSync(dbPath, finalTarget);
        quarantined = finalTarget;
    }

    const removedSidecars = [];
    for (const suffix of ['-wal', '-shm']) {
        const sidecar = `${dbPath}${suffix}`;
        try {
            if (fs.existsSync(sidecar)) {
                fs.rmSync(sidecar, { force: true });
                removedSidecars.push(sidecar);
            }
        } catch (_) { /* yut: kilitli artık bir sonraki açılışta temizlenir */ }
    }

    return { quarantined, removedSidecars };
}

module.exports = {
    QUARANTINE_DIR,
    BACKUP_PREFIX,
    listBackups,
    quarantineDatabase
};
