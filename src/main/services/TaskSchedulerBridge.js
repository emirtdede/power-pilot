/**
 * TaskSchedulerBridge.js - WP-05
 * Windows Görev Zamanlayıcı (schtasks.exe) yedeği: uygulama kapalıyken bile
 * koşulsuz zamanlanmış görevlerin kaçmamasını sağlar.
 *
 * İlke:
 * - Birincil tetikleyici her zaman TaskManager 1sn döngüsüdür; bu köprü SADECE
 *   uygulama kapalıysa devreye giren yedektir (fail-safe, best-effort).
 * - Kabuk YOKTUR: yalnızca execFile('schtasks.exe', args, ...) kullanılır.
 *   Kabuk yürütme ve string komut üretimi kaldırılmıştır (K-06).
 * - Görev kimliği istemciden kabul edilmez; sunucu üretir ve doğrular.
 * - Koşullu (monitoring) görevler Windows'a YAZILMAZ (K-04 ikinci savunma, ADR-09).
 * - Kayıt başarısız olursa sessizce atlanır (loglanır), uygulama akışı etkilenmez.
 * - Store (MSIX) sandbox'unda schtasks yasaktır → isStoreApp ise kayıt yapılmaz.
 * - Kayıt tek-seferliktir (ONCE); tüketilince silinir.
 * - 60sn'den yakın hedefler kaydedilmez (anlamsız + yarış riski).
 */

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../logger');
const { FLAGS } = require('../config/flags');

const TASK_NAME_PREFIX = 'PowerPilot';
const MIN_LEAD_TIME_MS = FLAGS.SCHEDULER_MIN_LEAD_MS;
const EXEC_TIMEOUT_MS = FLAGS.SCHEDULER_TIMEOUT_MS;
// Sunucu tarafı kimlik biçimi. İstemciden gelen serbest metin ASLA buraya girmez.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// schtasks çıkış kodları (yerelleştirilmiş metne güvenilmez; kod tek ölçüt).
const EXIT_CODES = {
    0: { code: 'OK', message: 'Görev işlemi başarılı.' },
    1: { code: 'SCHTASKS_FAILED', message: 'Görev Zamanlayıcı işlemi başarısız.' },
    2: { code: 'SCHTASKS_NOT_FOUND', message: 'Görev bulunamadı.' },
    5: { code: 'ACCESS_DENIED', message: 'Görev oluşturmak için izin yok.' },
    8: { code: 'SCHTASKS_BUSY', message: 'Görev Zamanlayıcı meşgul.' },
    267011: { code: 'SCHTASKS_INVALID_TRIGGER', message: 'Tetikleyici zamanı geçersiz.' }
};

class TaskSchedulerBridge {
    /**
     * @param {object} opts
     * @param {Function} [opts.execFileFn] test enjeksiyonu: (file,args,opts,cb) => ChildProcess
     * @param {string} [opts.exePath]
     * @param {boolean} [opts.isStoreApp]
     * @param {Function} [opts.nowFn]
     * @param {string} [opts.tempDir] XML tanım dosyaları için dizin (varsayılan os.tmpdir())
     */
    constructor({ execFileFn = null, exePath = '', isStoreApp = false, nowFn = null, tempDir = '' } = {}) {
        this.execFileFn = execFileFn || execFile;
        this.exePath = exePath;
        this.isStoreApp = isStoreApp === true;
        this.nowFn = nowFn || (() => Date.now());
        this.tempDir = tempDir;
    }

    /** ADR-08: istemci kimliği kabul edilmez; sunucu üretir. */
    static generateTaskId(nowMs = Date.now()) {
        const rand = crypto.randomBytes(6).toString('hex');
        return `task_${nowMs.toString(36)}_${rand}`;
    }

    static isValidTaskId(taskId) {
        return typeof taskId === 'string' && TASK_ID_RE.test(taskId);
    }

    static sanitizeTaskId(taskId) {
        return String(taskId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    }

    static taskName(taskId) {
        return `${TASK_NAME_PREFIX}\\${TaskSchedulerBridge.sanitizeTaskId(taskId)}`;
    }

    /**
     * Tetikleyici zamanını yerel saatle ISO 8601'e çevirir.
     *
     * P0 REGRESYON: eskiden `schtasks /sd MM/DD/YYYY` kullanılıyordu. `schtasks`,
     * `/sd` tarihini **sistem yereline** göre ayrıştırır; tr-TR gibi
     * gün.ay.yıl kullanan sistemlerde "11/17/2026" reddediliyor ve yedek görev
     * hiç oluşturulmuyordu ("ERROR: Incorrect Start Date"). Yani Türkçe
     * kullanıcıda uygulama kapalıyken görev çalışmıyordu. Artık görev
     * tanımı XML ile (ISO 8601, yerelden bağımsız) verilir.
     */
    static formatTriggerDate(targetTime) {
        const d = new Date(targetTime);
        // O-13: schtasks saniye taşımaz. Erken tetikleme yerine bir sonraki
        // dakikaya yukarı yuvarla (geç tetikleme güvenli taraftır).
        if (d.getSeconds() > 0 || d.getMilliseconds() > 0) {
            d.setMinutes(d.getMinutes() + 1, 0, 0);
        }
        const pad = (n) => String(n).padStart(2, '0');
        return {
            iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
                + `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
            time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
        };
    }

    static xmlEscape(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Windows Görev Zamanlayıcı XML tanımı.
     * - StartBoundary: yerel saat, ISO 8601 → yerel ayardan bağımsız.
     * - DisallowStartIfOnBatteries=false: dizüstü pille çalışırken de tetiklenir
     *   (aksi halde yedek görev sessizce atlanıyordu).
     * - StartWhenAvailable=true: makine uykuda/kapalıydıysa açılınca çalışır.
     * - MultipleInstancesPolicy=IgnoreNew: çift tetikleme güvenli.
     * @returns {string} XML
     */
    static buildXml(task, exePath) {
        if (!task || !TaskSchedulerBridge.isValidTaskId(task.id)) {
            const err = new Error('Geçersiz görev kimliği.');
            err.code = 'INVALID_TASK_ID';
            throw err;
        }
        const { iso } = TaskSchedulerBridge.formatTriggerDate(task.trigger.targetTime);
        const command = TaskSchedulerBridge.xmlEscape(exePath);
        const args = TaskSchedulerBridge.xmlEscape(`--run-task=${task.id}`);
        return '<?xml version="1.0" encoding="UTF-16"?>\n'
            + '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
            + '  <RegistrationInfo><Description>Power Pilot - uygulama kapaliyken yedek tetikleyici</Description></RegistrationInfo>\n'
            + '  <Triggers>\n'
            + `    <TimeTrigger><StartBoundary>${iso}</StartBoundary><Enabled>true</Enabled></TimeTrigger>\n`
            + '  </Triggers>\n'
            + '  <Principals>\n'
            + '    <Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>\n'
            + '  </Principals>\n'
            + '  <Settings>\n'
            + '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\n'
            + '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>\n'
            + '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>\n'
            + '    <StartWhenAvailable>true</StartWhenAvailable>\n'
            + '    <WakeToRun>false</WakeToRun>\n'
            + '    <Enabled>true</Enabled>\n'
            + '    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>\n'
            + '  </Settings>\n'
            + '  <Actions Context="Author">\n'
            + `    <Exec><Command>${command}</Command><Arguments>${args}</Arguments></Exec>\n`
            + '  </Actions>\n'
            + '</Task>\n';
    }

    // process.argv içinden --run-task=<id> bayrağını çözer.
    static parseRunTaskArgv(argv) {
        const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--run-task='));
        if (!arg) return null;
        const id = arg.slice('--run-task='.length).trim();
        return TaskSchedulerBridge.isValidTaskId(id) ? id : null;
    }

    // P0-2: İkinci örnek argv'sini birincil örneğe iletme.
    static forwardRunTask(commandLine, taskManager) {
        const taskId = TaskSchedulerBridge.parseRunTaskArgv(commandLine || []);
        if (!taskId || !taskManager || typeof taskManager.runTaskNow !== 'function') return null;
        try {
            taskManager.runTaskNow(taskId);
        } catch (_) { /* çalıştırma hatası pencere odağını engellemez */ }
        if (taskManager.schedulerBridge && typeof taskManager.schedulerBridge.removeTask === 'function') {
            Promise.resolve(taskManager.schedulerBridge.removeTask(taskId)).catch(() => {});
        }
        return taskId;
    }

    isSupported() {
        if (this.isStoreApp || typeof this.exePath !== 'string' || this.exePath.length === 0) {
            return false;
        }
        // Paketlenmemiş geliştirme / Playwright E2E koşularında exePath ham
        // `node_modules/electron/dist/electron.exe` olur; uygulama yolu argümanı
        // olmadan Windows Görev Zamanlayıcıya kaydedilirse testten dakikalar sonra
        // varsayılan boş Electron penceresi ("To run a local app...") açılır.
        if (path.basename(this.exePath).toLowerCase() === 'electron.exe') {
            return false;
        }
        return true;
    }

    /**
     * ADR-09: yalnızca koşulsuz `scheduled` görevler Windows'a yazılır.
     * `monitoring`, `waiting`, `snoozed` ve koşul grubu olan görevler yazılmaz.
     *
     * P1-6 (üçüncü tur): `snoozed` zamanlanmış bir görevdir (hedef ileri
     * alınmıştır) ve uygulama kapalıyken de tetiklenmelidir; bu yüzden
     * `scheduled` ile aynı şekilde Windows'a yazılır. `waiting` koşullu
     * ertelemedir, yazılmaz.
     */
    shouldSync(task) {
        if (!this.isSupported()) return false;
        if (!task || task.enabled === false) return false;
        if (task.status !== 'scheduled' && task.status !== 'snoozed') return false;
        if (!TaskSchedulerBridge.isValidTaskId(task.id)) return false;
        const conditions = task.conditionGroup && Array.isArray(task.conditionGroup.conditions)
            ? task.conditionGroup.conditions
            : [];
        if (conditions.length > 0) return false;
        const targetTime = task.trigger && task.trigger.targetTime;
        if (!Number.isInteger(targetTime)) return false;
        if (task.trigger.notBefore && Number.isInteger(task.trigger.notBefore) && this.nowFn() < task.trigger.notBefore) {
            // Erteleme penceresi Windows'a taşınmaz; uygulama döngüsü bekler.
            return false;
        }
        if (targetTime - this.nowFn() < MIN_LEAD_TIME_MS) return false;
        return true;
    }

    /**
     * ADR-08: argüman dizisi - kabuk yorumlaması yok.
     * Görev tanımı XML dosyasından verilir; `/sd` tarih biçimi (yerel ayara
     * bağımlı) artık kullanılmıyor.
     */
    buildCreateArgs(task, xmlPath) {
        if (!task || !TaskSchedulerBridge.isValidTaskId(task.id)) {
            const err = new Error('Geçersiz görev kimliği.');
            err.code = 'INVALID_TASK_ID';
            throw err;
        }
        if (typeof xmlPath !== 'string' || xmlPath.length === 0) {
            const err = new Error('Görev tanımı dosyası yok.');
            err.code = 'INVALID_XML_PATH';
            throw err;
        }
        return [
            '/create',
            '/tn', TaskSchedulerBridge.taskName(task.id),
            '/xml', xmlPath,
            '/f'
        ];
    }

    /**
     * XML tanımını geçici dosyaya yazar (UTF-16LE + BOM; schtasks beklediği
     * biçim). Çağıran taraf işi bitince silmelidir.
     * @returns {string} dosya yolu
     */
    writeTaskXml(task) {
        const xml = TaskSchedulerBridge.buildXml(task, this.exePath);
        const dir = this.tempDir || os.tmpdir();
        const file = path.join(dir, `pp-task-${TaskSchedulerBridge.sanitizeTaskId(task.id)}-${process.pid}.xml`);
        fs.writeFileSync(file, Buffer.from('\uFEFF' + xml, 'utf16le'));
        return file;
    }

    buildDeleteArgs(taskId) {
        if (!TaskSchedulerBridge.isValidTaskId(taskId)) {
            const err = new Error('Geçersiz görev kimliği.');
            err.code = 'INVALID_TASK_ID';
            throw err;
        }
        return ['/delete', '/tn', TaskSchedulerBridge.taskName(taskId), '/f'];
    }

    parseExit(code) {
        if (code === 0) return { success: true, code: 'OK' };
        const known = EXIT_CODES[code];
        return {
            success: false,
            code: known ? known.code : 'SCHTASKS_FAILED',
            error: known ? known.message : `schtasks çıkış kodu ${code}`
        };
    }

    execSchtasks(args) {
        return new Promise((resolve) => {
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            try {
                this.execFileFn('schtasks.exe', args, {
                    windowsHide: true,
                    timeout: EXEC_TIMEOUT_MS
                }, (err, stdout, stderr) => {
                    const code = err && typeof err.code === 'number' ? err.code : (err ? -1 : 0);
                    if (err && err.killed) {
                        return done({ success: false, code: 'SCHTASKS_TIMEOUT', error: 'schtasks zaman aşımı.', stdout, stderr });
                    }
                    const parsed = this.parseExit(code);
                    if (!parsed.success) {
                        log.warn(`[SchedulerBridge] ${parsed.code}: ${String(stderr || parsed.error).slice(0, 200)}`);
                    }
                    done({ ...parsed, stdout, stderr });
                });
            } catch (err) {
                done({ success: false, code: 'SCHTASKS_SPAWN_FAILED', error: err.message });
            }
        });
    }

    async syncTask(task) {
        let args;
        let xmlFile = null;
        try {
            if (!this.shouldSync(task)) return false;
            xmlFile = this.writeTaskXml(task);
            args = this.buildCreateArgs(task, xmlFile);
        } catch (err) {
            if (xmlFile) {
                try { fs.unlinkSync(xmlFile); } catch (_) { /* geçici dosya */ }
            }
            log.warn(`[SchedulerBridge] görev yazılmadı: ${err.code || err.message}`);
            return false;
        }
        const result = await this.execSchtasks(args);
        if (xmlFile) {
            try { fs.unlinkSync(xmlFile); } catch (_) { /* geçici dosya */ }
        }
        if (result.success) {
            log.info(`[SchedulerBridge] yedek kaydedildi: ${task.id}`);
        }
        return result.success;
    }

    async removeTask(taskId) {
        if (!this.isSupported() || !taskId) return false;
        let args;
        try {
            args = this.buildDeleteArgs(taskId);
        } catch (_) {
            return false;
        }
        const result = await this.execSchtasks(args);
        return result.success;
    }

    /**
     * `\PowerPilot` klasöründeki TÜM görevleri siler.
     *
     * Neden gerekli: Windows Görev Zamanlayıcı kayıtları uygulamanın veri
     * klasöründen bağımsızdır. Kullanıcı "tüm verileri sil" derse ya da bozuk
     * DB karantinaya alınıp temiz depoyla başlanırsa, veritabanında artık
     * olmayan görevlerin Windows kayıtları kalır; tetikleme saatinde Windows
     * uygulamayı `--run-task=<silinmiş id>` ile açar. Kullanıcı için bu,
     * "verilerimi sildim ama uygulama kendi kendine açıldı" davranışıdır.
     *
     * `schtasks /delete /tn \PowerPilot` klasörü **boş değilse** reddeder
     * (ölçüldü: "ERROR: Dizin boş değil."), bu yüzden görevler tek tek
     * listelenip silinir.
     */
    async removeAllTasks() {
        if (!this.isSupported()) return { removed: 0, failed: 0 };
        const list = await this.execSchtasks(['/query', '/fo', 'CSV', '/nh']);
        if (!list.success) return { removed: 0, failed: 0 };
        const names = [];
        // `schtasks /query` görev adlarını kök ters bölü ile döndürür: \PowerPilot\task_x
        const rootName = `\\${TASK_NAME_PREFIX}`;
        for (const line of String(list.stdout || '').split(/\r?\n/)) {
            const match = /^"([^"]*)"/.exec(line.trim());
            if (!match) continue;
            const name = match[1];
            // Yalnızca kendi klasörümüz; kullanıcının başka görevlerine dokunulmaz.
            if (name !== rootName && !name.startsWith(`${rootName}\\`)) continue;
            names.push(name);
        }
        let removed = 0;
        let failed = 0;
        for (const name of names) {
            const result = await this.execSchtasks(['/delete', '/tn', name, '/f']);
            if (result.success) removed += 1;
            else failed += 1;
        }
        if (removed > 0 || failed > 0) {
            log.info(`[SchedulerBridge] toplu temizlik: ${removed} silindi, ${failed} başarısız`);
        }
        return { removed, failed };
    }
}

TaskSchedulerBridge.TASK_ID_RE = TASK_ID_RE;
TaskSchedulerBridge.EXIT_CODES = EXIT_CODES;

module.exports = TaskSchedulerBridge;
