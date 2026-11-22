/**
 * data-integrity.test.mjs - WP-11.T12
 * T-STO-07..14: audit zinciri/checkpoint, enerji eşleştirme, muafiyet
 * penceresi, nonce, yedek şifreleme ve utilityProcess izolasyonu.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import StorageService from '../../src/main/services/StorageService.js';
import EnergyEstimateService from '../../src/main/services/EnergyEstimateService.js';
import { isInWindow, validateWindow } from '../../src/main/services/ExemptionService.js';
import { backupDatabase, decryptFile, quickCheck, restoreDatabase } from '../../src/main/storage/Backup.js';
import { runBackup } from '../../src/main/storage/DbWorker.js';

const dirs = [];
const services = [];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** perf_hooks gecikmesini ms'e çevirir (ns döner). */
const toMs = (ns) => ns / 1e6;

/**
 * Aynı makinede HİÇBİR iş yapmayan bir çocuk süreç açmanın ana süreçte
 * yarattığı en büyük event-loop gecikmesi (ms).
 *
 * `monitorEventLoopDelay`, tek bir uzun senkron bloğu da yakalar (setInterval
 * tabanlı örnekleme kaçırır). Bu taban, platformun süreç-açma fiyatıdır
 * (Windows'ta Defender/CreateProcess nedeniyle 77-285 ms olabilir) ve
 * yedeğin kendi ek yükünü bundan ayırmak için kullanılır.
 */
function measureSpawnBaseline() {
    return new Promise((resolve, reject) => {
        const h = monitorEventLoopDelay({ resolution: 10 });
        h.enable();
        execFile(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true }, (err) => {
            h.disable();
            if (err) { reject(err); return; }
            resolve(toMs(h.max));
        });
    });
}

/**
 * Yedeği çalıştırırken ana sürecin en büyük event-loop gecikmesini ölçer.
 * @returns {Promise<{maxDelayMs: number, result: any}>}
 */
async function measureBackup(args) {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    try {
        const result = await runBackup(args);
        return { maxDelayMs: toMs(h.max), result };
    } finally {
        h.disable();
    }
}

function freshDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-integrity-'));
    dirs.push(dir);
    return dir;
}
function open(dir) {
    const s = new StorageService(dir);
    services.push(s);
    return s;
}
function closeAll() {
    for (const s of services.splice(0)) {
        try { s.close(); } catch (_) { /* yut */ }
    }
}
function auditKey() {
    return crypto.createHash('sha256').update('test-audit-key').digest();
}

afterEach(() => {
    closeAll();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('WP-11 veri bütünlüğü', () => {
    it('T-STO-07: audit satırı değiştirilince verify başarısız + auditTampered', () => {
        const dir = freshDir();
        const s = open(dir);
        s.setAuditKey(auditKey(), { checkpointDir: path.join(dir, 'audit-checkpoints') });
        s.appendAudit({ actor: 'system', action: 'test', target: 'x', detail: 'ilk' });
        s.appendAudit({ actor: 'system', action: 'test', target: 'x', detail: 'ikinci' });
        expect(s.verifyAuditChain().ok).toBe(true);
        s.db.prepare("UPDATE audit_log SET detail = 'degistirildi' WHERE seq = 1").run();
        const res = s.verifyAuditChain();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('TAMPERED');
        expect(s.auditTampered).toBe(true);
    });

    it('O-22: checkpoint dosyası silinince onarılır; HMAC bozulursa tamper', () => {
        const dir = freshDir();
        const s = open(dir);
        s.setAuditKey(auditKey(), { checkpointDir: path.join(dir, 'audit-checkpoints') });
        const rec = s.appendAudit({ actor: 'system', action: 'test', target: null, detail: '' });
        const day = String(rec.ts).slice(0, 10);
        const checkpoint = path.join(dir, 'audit-checkpoints', `${day}.json`);
        expect(fs.existsSync(checkpoint)).toBe(true);
        fs.rmSync(checkpoint, { force: true });
        // O-22: HMAC'li gün satırları varsa eksik checkpoint onarılabilir.
        const repaired = s.verifyAuditChain();
        expect(repaired.ok).toBe(true);
        expect(s.auditTampered).toBe(false);
        expect(fs.existsSync(checkpoint)).toBe(true);
        expect(s.getAuditLog().some((r) => r.action === 'audit_checkpoint_repaired')).toBe(true);
        const rebuilt = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
        expect(rebuilt.lastHmac).toBe(rec.recordHmac);
        // Onarılan checkpoint sonraki doğrulamada da geçerli olmalı.
        expect(s.verifyAuditChain().ok).toBe(true);

        // Onarım sonrası checkpoint HMAC'i kurcalanırsa gerçek tamper sayılır.
        const data = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
        data.lastHmac = 'deadbeef';
        fs.writeFileSync(checkpoint, JSON.stringify(data), 'utf8');
        const res = s.verifyAuditChain();
        expect(res.ok).toBe(false);
        expect(res.code).toBe('CHECKPOINT_TAMPERED');
        expect(s.auditTampered).toBe(true);
    });

    it('T-STO-12: HMAC anahtarı yokken yeni audit yazılmaz, açılış anahtar üretmez', () => {
        const dir = freshDir();
        const s1 = open(dir);
        s1.setAuditKey(auditKey(), { checkpointDir: path.join(dir, 'audit-checkpoints') });
        s1.appendAudit({ actor: 'system', action: 'once', target: null, detail: '' });
        s1.close();

        const s2 = open(dir);
        expect(s2.hasAuditKey()).toBe(false);
        expect(() => s2.appendAudit({ actor: 'system', action: 'olmaz', target: null, detail: '' }))
            .toThrowError(/HMAC anahtarı yok/);
        const verify = s2.verifyAuditChain();
        expect(verify.ok).toBe(false);
        expect(verify.code).toBe('AUDIT_KEY_MISSING');
    });

    it('T-STO-08: 22:00 sleep + 23:00 hibernate + 08:00 boot = 9 saat, çift sayım yok', () => {
        const res = EnergyEstimateService.matchOffHours(
            ['2026-10-19T22:00:00.000Z', '2026-10-19T23:00:00.000Z'],
            ['2026-10-20T08:00:00.000Z']
        );
        expect(res.measuredHours).toBe(9);
        expect(res.unmatched).toBe(0);
        // 14 günü aşan eşleşme sayılmaz.
        const stale = EnergyEstimateService.matchOffHours(
            ['2026-10-01T00:00:00.000Z'],
            ['2026-10-20T00:00:00.000Z']
        );
        expect(stale.measuredHours).toBe(0);
        expect(stale.unmatched).toBe(1);
    });

    it('T-STO-09: gece yarısını aşan pencere Salı 01:00’de eşleşir; start===end reddedilir', () => {
        const monday = new Date(2026, 9, 19, 23, 0, 0, 0);
        expect(monday.getDay()).toBe(1);
        const tuesday = new Date(2026, 9, 20, 1, 0, 0, 0);
        expect(tuesday.getDay()).toBe(2);
        const window = { id: 'm1', days: [1], start: '23:00', end: '02:00' };
        expect(isInWindow(window, monday.getTime())).toBe(true);
        expect(isInWindow(window, tuesday.getTime())).toBe(true);
        expect(isInWindow(window, new Date(2026, 9, 20, 3, 0).getTime())).toBe(false);
        expect(validateWindow({ id: 'bad', days: [1], start: '23:00', end: '23:00' }))
            .toMatchObject({ ok: false, code: 'INVALID_WINDOW' });
    });

    it('T-STO-10: aynı nonce iki kez → tek satır, ikinci REPLAY', () => {
        const s = open(freshDir());
        const exp = Date.now() + 60000;
        expect(s.consumeNonce('nonce-1', exp)).toBe(true);
        expect(s.consumeNonce('nonce-1', exp)).toBe(false);
        expect(s.db.prepare('SELECT COUNT(*) AS n FROM seen_nonces WHERE nonce = ?').get('nonce-1').n).toBe(1);
        expect(s.purgeExpiredNonces(exp + 1)).toBe(1);
        expect(s.consumeNonce('nonce-1', Date.now() + 60000)).toBe(true);
    });

    /**
     * T-STO-13 - yedeğin ANA SÜREÇTE yapılmadığını kanıtlar.
     *
     * ESKİ ÖLÇÜM KUSURLUYDU: `event loop lag < 100 ms` mutlak eşiği, Windows'ta
     * `CreateProcess` maliyetinin altında kalıyordu. Ölçümle kanıtlandı: işi
     * hiç yapmayan boş bir `node -e "process.exit(0)"` çocuk süreci bile aynı
     * makinede ana süreçte 77-285 ms gecikme üretiyor (Defender/CreateProcess).
     * Yani 100 ms eşiği, DOĞRU bir uygulamada bile rastgele kırılıyordu;
     * koruduğu şeyi (izolasyon) değil, işletim sisteminin süreç açma fiyatını
     * ölçüyordu.
     *
     * Yerine iki kesin değişmez kondu:
     *  A) YAPISAL: ana-süreç işçisi (`DbWorker`) yedeği kendisi yapamaz -
     *     `backupDatabase`'i içe aktaramaz/çağıramaz, yalnızca süreç açar.
     *     Bu deterministiktir ve asıl kusuru (işi ana iş parçacığına almak)
     *     doğrudan yakalar.
     *  B) DAVRANIŞSAL: gerçek yedek çocuk süreçte TAMAMLANIR, şifreli dosya
     *     üretir (`quickCheck` çocuktan gelir).
     *  C) YANIT VEREBİLİRLİK: ana sürecin ek bloklaması, aynı makinede
     *     ölçülen süreç-açma tabanına göre sınırlanır - platform maliyeti
     *     ölçümden çıkarılır, bizim kodumuzun ek yükü kalır.
     */
    it('T-STO-13: 10k görev yedeği ana süreçte yapılmaz (izolasyon)', async () => {
        // A) Yapısal değişmez: işçi yalnızca süreç açar, yedek işini kendisi
        //    yapmaz. (`require('./Backup')` yalnızca `runRestore`'un
        //    utilityProcess bulunamadığında kullandığı test/CLI yedeğidir;
        //    yedek ALMA yolu her zaman süreç açar.)
        const workerSrc = fs.readFileSync(
            path.join(rootDir, 'src/main/storage/DbWorker.js'), 'utf8'
        );
        expect(workerSrc, 'ana-süreç işçisi bir süreç açmalı').toMatch(/execFile|utilityProcess\.fork/);
        expect(workerSrc, 'ana-süreç işçisi yedeği KENDİSİ yapmamalı')
            .not.toMatch(/backupDatabase/);
        const runBackupBody = workerSrc.slice(
            workerSrc.indexOf('async function runBackup'),
            workerSrc.indexOf('async function runRestore')
        );
        expect(runBackupBody, 'runBackup doğrudan kütüphaneyi çağırmamalı')
            .not.toMatch(/require\(|backupDatabase/);

        const dir = freshDir();
        const s = open(dir);
        const tasks = Array.from({ length: 10000 }, (_, i) => ({ id: `t${i}`, name: `gorev-${i}`, cmd: 'shutdown' }));
        expect(s.saveTasks(tasks)).toBe(true);
        s.close();

        // C-tabanı: aynı makinede boş bir çocuk süreç açmanın maliyeti.
        const baseline = await measureSpawnBaseline();

        const { maxDelayMs, result } = await measureBackup({
            dbPath: path.join(dir, 'powerpilot.db'),
            backupDir: path.join(dir, 'backups'),
            key: crypto.randomBytes(32),
            forceCli: true,
            timeoutMs: 60000
        });

        // B) Davranışsal: yedek çocukta tamamlandı ve dosya gerçek.
        expect(result.ok).toBe(true);
        expect(result.quickCheck).toBe('ok');
        expect(fs.existsSync(result.path)).toBe(true);

        // C) Kendi kodumuzun ek bloklaması, süreç-açma tabanının üstünde
        //    makul bir marjı aşmamalı (marj: süreç açma + IPC + GC).
        expect(
            maxDelayMs,
            `yedek sırasında ana süreç gecikmesi ${maxDelayMs.toFixed(0)}ms, ` +
            `süreç-açma tabanı ${baseline.toFixed(0)}ms`
        ).toBeLessThanOrEqual(baseline + 250);
    }, 120000);

    it('T-STO-14: yedek AES-256-GCM; düz metin yok; yanlış anahtar açmaz; geri yükleme çalışır', () => {
        const dir = freshDir();
        const s = open(dir);
        s.saveTasks([{ id: 'gizli', name: 'GIZLI-GOREV-ADU-123' }]);
        s.close();
        const dbPath = path.join(dir, 'powerpilot.db');
        const key = crypto.randomBytes(32);
        const backupDir = path.join(dir, 'backups');
        const res = backupDatabase({ dbPath, backupDir, key });
        expect(res.quickCheck).toBe('ok');
        const raw = fs.readFileSync(res.path);
        expect(raw.includes(Buffer.from('GIZLI-GOREV-ADU-123', 'utf8'))).toBe(false);
        expect(raw.includes(Buffer.from('SQLite format 3', 'utf8'))).toBe(false);

        expect(() => decryptFile(res.path, path.join(dir, 'yanlis.db'), crypto.randomBytes(32)))
            .toThrowError(/çözülemedi/);
        expect(fs.existsSync(path.join(dir, 'yanlis.db'))).toBe(false);

        const plain = path.join(dir, 'acik.db');
        decryptFile(res.path, plain, key);
        expect(quickCheck(plain)).toBe('ok');

        // Geri yükleme: mevcut DB karantinaya alınır, yedek yerine geçer.
        fs.writeFileSync(path.join(dir, 'powerpilot.db'), 'bozuk');
        const restored = restoreDatabase({ inputPath: res.path, dbPath, key, quarantineDir: path.join(dir, 'q') });
        expect(restored.ok).toBe(true);
        expect(quickCheck(dbPath)).toBe('ok');
        const s2 = open(dir);
        expect(s2.getTasks()[0].name).toBe('GIZLI-GOREV-ADU-123');
    });

    it('Y-09: yanlış anahtar/bozuk yedek canlı DB’yi değiştirmez', () => {
        const dir = freshDir();
        const s = open(dir);
        s.saveTasks([{ id: 'canli', name: 'CANLI-VERI' }]);
        s.close();
        services.splice(services.indexOf(s), 1);

        const dbPath = path.join(dir, 'powerpilot.db');
        const key = crypto.randomBytes(32);
        const backupDir = path.join(dir, 'backups');
        const res = backupDatabase({ dbPath, backupDir, key });
        const before = fs.readFileSync(dbPath);

        // Yanlış anahtar: çözme aşamasında durur; karantina/rename yapılmaz.
        expect(() => restoreDatabase({
            inputPath: res.path,
            dbPath,
            key: crypto.randomBytes(32),
            quarantineDir: path.join(dir, 'q')
        })).toThrowError(/çözülemedi/);
        expect(fs.existsSync(path.join(dir, 'q'))).toBe(false);
        expect(fs.readFileSync(dbPath).equals(before)).toBe(true);

        // Bozuk yedek: aynı şekilde canlı DB'ye dokunulmaz.
        const corrupt = path.join(dir, 'bozuk.db.enc');
        fs.writeFileSync(corrupt, 'bozuk');
        expect(() => restoreDatabase({
            inputPath: corrupt,
            dbPath,
            key,
            quarantineDir: path.join(dir, 'q')
        })).toThrowError(/çok kısa/);
        expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
        expect(fs.readdirSync(dir).filter((name) => name.includes('.restoring-'))).toHaveLength(0);

        const s2 = open(dir);
        expect(s2.getTasks()[0].name).toBe('CANLI-VERI');
    });
});
