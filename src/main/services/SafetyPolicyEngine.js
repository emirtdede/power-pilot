/**
 * SafetyPolicyEngine.js
 * Validates safety rules (protected apps, user activity, fullscreen mode, remote command security)
 * before any power action is executed.
 */

const { execFile } = require('child_process');
const os = require('os');
const log = require('../logger');
const { ExemptionService } = require('./ExemptionService');
const { canonicalProcessName } = require('./processNames');

// Y-05: kısmi `safetyPolicy` varsayılanları EZMEMELİ; eksik alanlar güvenli
// varsayılana döner. Aksi halde `{ safetyPolicy: {} }` tüm kontrolleri atlar.
const SAFE_POLICY_DEFAULTS = Object.freeze({
    checkUserActivity: true,
    checkProtectedApps: true,
    checkFullscreen: true,
    checkSystemLoad: true,
    forceCloseApps: false,
    remoteApprovalRequired: false
});

// P0/BLOCKER-001: `powercfg /requests` yükseltilmiş yetki ister; paketlenmiş
// uygulama `asInvoker` çalışır. Yetenek sondası bu farkı ölçer ve ölçülemeyen
// kapıyı sessizce değil, GÖRÜNÜR biçimde atlar (audit + status + UI).
const CAPABILITY_TTL_OK_MS = 10 * 60 * 1000;
const CAPABILITY_TTL_FAIL_MS = 60 * 1000;
const CAPABILITY_PROBE_TIMEOUT_MS = 3000;
const CAPABILITY_LOG_THROTTLE_MS = 60 * 60 * 1000;

// P0-3: Korunan uygulama listesi artık KODA ÇAKILI DEĞİL, ayarlardan gelir.
// Bu liste yalnızca varsayılandır; kullanıcı Ayarlar'dan ekleyip çıkarabilir.
// Oyun başlatıcıları (steam/epic/discord) varsayılandan ÇIKARILDI: indirme
// bitince kapatma şablonları bu süreçler çalışırken tetiklenir ve kendi
// kendini engelliyordu.
const DEFAULT_PROTECTED_APPS = Object.freeze([
    'code.exe', 'devenv.exe', 'idea64.exe', 'photoshop.exe',
    'premiere.exe', 'afterfx.exe', 'handbrake.exe', 'obs64.exe',
    'blender.exe', 'zoom.exe', 'teams.exe', 'powerpnt.exe'
]);

const PROCESS_NAME_RE = /^[A-Za-z0-9._-]{1,64}\.exe$/i;

class SafetyPolicyEngine {
    // execFn/uptimeFn: yalnızca test izolasyonu için. Açık DI.
    // options: processProvider/idleProvider/powerMonitor (WP-04/WP-05).
    constructor(storageService, execFn = null, uptimeFn = null, options = {}) {
        this.storage = storageService;
        this.execFile = execFn || execFile;
        this.uptimeFn = uptimeFn || (() => os.uptime());
        this.processProvider = typeof options.processProvider === 'function' ? options.processProvider : null;
        this.idleProvider = typeof options.idleProvider === 'function' ? options.idleProvider : null;
        this.powerMonitor = options.powerMonitor || null;
        // P0-3: varsayılan liste; gerçek liste `getProtectedAppSet()` ile ayarlardan okunur.
        this.protectedApps = [...DEFAULT_PROTECTED_APPS];
        this.protectedAppSet = new Set(this.protectedApps.map(canonicalProcessName));
        // P0/BLOCKER-001: yetenek sondası durumu (tek uçuş + TTL).
        this._capability = { available: null, checkedAt: null, code: null, value: null, inFlight: null };
        this._capabilityLogAt = 0;
    }

    /**
     * P0-3: Kullanıcının düzenleyebildiği korunan uygulama listesi.
     * Ayar yoksa/bozuksa güvenli varsayılana döner; `.exe` olmayan ve
     * yol içeren girdiler sessizce atılır (komut enjeksiyonu yok).
     * @param {object} [settings]
     * @returns {Set<string>} kanonik süreç adları
     */
    static resolveProtectedApps(settings) {
        const raw = settings && Array.isArray(settings.protectedApps) ? settings.protectedApps : null;
        const source = raw || DEFAULT_PROTECTED_APPS;
        const out = new Set();
        for (const item of source) {
            if (typeof item !== 'string') continue;
            const name = item.trim().toLowerCase();
            if (!PROCESS_NAME_RE.test(name)) continue;
            out.add(canonicalProcessName(name));
        }
        return out;
    }

    /**
     * Görevin KENDİ izlediği süreç korunan-listede olsa bile muaftır.
     * Örn. `tpl_steam_download` görevi `steam.exe` çalışırken kapatmayı
     * hedefler; steam'i korunan saymak görevi kendi kendine engellemek olur.
     * @param {AutomationTask} task
     * @returns {Set<string>} muaf süreç adları
     */
    static taskWatchedProcesses(task) {
        const exempt = new Set();
        const group = task && task.conditionGroup;
        const conditions = (group && Array.isArray(group.conditions)) ? group.conditions : [];
        for (const cond of conditions) {
            if (!cond || cond.type !== 'process_running') continue;
            if (typeof cond.processName === 'string' && cond.processName.trim()) {
                exempt.add(canonicalProcessName(cond.processName.trim()));
            }
        }
        return exempt;
    }

    /**
     * P1-6: görev düzeyi politika alanı kullanıcı tarafından AÇIKÇA seçildi mi?
     *
     * `AutomationTask` her zaman tam bir `safetyPolicy` nesnesi üretir (toJSON
     * sözleşmesi). Bu yüzden "alan undefined mı?" kontrolü kalıcı ayarları
     * gölgeliyordu. Karar `safetyPolicyExplicit` işaretinden verilir; işaret
     * yoksa (eski kayıt) güvenli varsayılandan farklı değer gerçek tercihtir.
     * @param {object} task
     * @param {string} key
     * @returns {boolean}
     */
    static isExplicitPolicy(task, key) {
        if (!task || !task.safetyPolicy || task.safetyPolicy[key] === undefined) return false;
        const explicit = task.safetyPolicyExplicit;
        if (explicit && typeof explicit === 'object') return explicit[key] === true;
        return task.safetyPolicy[key] !== SAFE_POLICY_DEFAULTS[key];
    }

    /**
     * Evaluates whether a power action is safe to execute for the given task.
     * @param {AutomationTask} task
     * @returns {Promise<{ allowed: boolean, reason?: string }>}
     */
    async evaluate(task) {
        // Y-05: eksik politika alanları güvenli varsayılanla doldurulur.
        const policy = { ...SAFE_POLICY_DEFAULTS, ...((task && task.safetyPolicy) || {}) };
        const deny = (reasonCode, detail, extra = null) => ({ allowed: false, reasonCode, detail, reason: detail, ...(extra || {}) });

        // 0. Denetim (kill-switch): konsol ajanı devre-dışı bıraktıysa TÜM güç
        // eylemleri durur (kaynak fark etmez). İptal/izleme etkilenmez.
        // Y-05: ayarlar okunamazsa yıkıcı eylem fail-closed engellenir.
        let baseSettings;
        try {
            baseSettings = this.storage && typeof this.storage.getSettings === 'function'
                ? this.storage.getSettings()
                : {};
        } catch (err) {
            log.error('[SafetyPolicyEngine] Güvenlik ayarları okunamadı:', err && err.message);
            return deny('POLICY_UNAVAILABLE', 'Güvenlik ayarları okunamadı; eylem engellendi.');
        }
        if (baseSettings && baseSettings.agentDisabled === true) {
            log.warn('[SafetyPolicyEngine] Kill-switch devrede; eylem engellendi.');
            return deny('AGENT_DISABLED', 'Konsol kill-switch devrede; ajan devre-dışı.');
        }

        // WP-9: Kullanıcı ayarlarından tam ekran ve aktif I/O / güç isteği korumasını uygula
        // (yalnızca görev kendi safetyPolicy'sinde AÇIKÇA override etmediyse).
        // P1-6: `AutomationTask` her zaman tam politika nesnesi üretir; bu yüzden
        // "undefined mı?" kontrolü hiçbir zaman doğru olmuyordu ve kalıcı ayarlar
        // (protectFullscreen / protectActiveIo) hiç uygulanmıyordu. Karar explicit
        // işaretten verilir.
        if (baseSettings && baseSettings.protectFullscreen === false && !SafetyPolicyEngine.isExplicitPolicy(task, 'checkFullscreen')) {
            policy.checkFullscreen = false;
        }
        if (baseSettings && baseSettings.protectActiveIo === false && !SafetyPolicyEngine.isExplicitPolicy(task, 'checkSystemLoad')) {
            policy.checkSystemLoad = false;
        }

        // O-12: ağır alt süreç kontrolleri paralel başlatılır; sonuçlar sırayla
        // değerlendirilir. Böylece toplam gecikme tek tek toplam yerine en yavaşı olur.
        const processesPromise = policy.checkProtectedApps
            ? this.getRunningProcessList().then((value) => ({ ok: true, value })).catch((error) => ({ ok: false, error }))
            : null;
        const requestsPromise = (policy.checkSystemLoad || policy.checkFullscreen)
            ? this.getPowerRequests()
            : null;
        const fullscreenPromise = policy.checkFullscreen
            ? this.getFullscreenState()
            : null;

        // 1. Protected Applications Check — ölçüm hatası fail-closed.
        if (policy.checkProtectedApps) {
            const procResult = await processesPromise;
            if (!procResult.ok) {
                log.error('[SafetyPolicyEngine] Süreç listesi alınamadı:', procResult.error && procResult.error.message);
                return deny('PROCESS_LIST_UNAVAILABLE', 'Çalışan süreçler doğrulanamadı; güç eylemi engellendi.');
            }
            // P0-3: liste kullanıcı ayarlarından; görevin kendi izlediği süreç muaf.
            const protectedSet = SafetyPolicyEngine.resolveProtectedApps(baseSettings);
            const exemptSet = SafetyPolicyEngine.taskWatchedProcesses(task);
            const runningProcs = procResult.value;
            const foundProtected = (runningProcs || []).filter((p) => {
                const canon = canonicalProcessName(p);
                return protectedSet.has(canon) && !exemptSet.has(canon);
            });

            if (foundProtected.length > 0) {
                log.info(`[SafetyPolicyEngine] Action blocked due to protected apps: ${foundProtected.join(', ')}`);
                return deny('PROTECTED_APP_RUNNING', `Korunan uygulama(lar) çalışıyor: ${foundProtected.join(', ')}`);
            }
        }

        // 2. Remote Command Security Rules
        if (task.source === 'local_api' || task.source === 'n8n' || task.source === 'console') {
            if (baseSettings.blockRemoteShutdownWhenActive) {
                // If user idle time is less than 60 seconds, block remote shutdown
                const idleSec = await this.getUserIdleSeconds();
                if (idleSec < 60 && (task.action === 'shutdown' || task.action === 'restart')) {
                    return deny('USER_ACTIVE', 'Kullanıcı aktif olduğu için uzaktan kapatma engellendi.');
                }
            }
        }

        // 3. WBS-11.5: Aktif güç isteği (indirme/sunum/yazdırma sürerken kapatmayı engelle).
        // WP-09.T2: yetenek VAR + ölçüm hatası → fail-closed.
        // P0/BLOCKER-001: yetenek YOK (yükseltilmemiş kurulum, `powercfg` admin
        // ister) → kapı sessizce değil, `loadCheck:'unavailable'` ile görünür
        // biçimde atlanır; diğer tüm güvenlik kapıları aynen çalışır.
        let loadStatus = 'skipped';
        if (policy.checkSystemLoad) {
            const requests = await requestsPromise;
            if (!requests.ok) {
                if (requests.unavailable === true) {
                    loadStatus = 'unavailable';
                    this._logCapabilitySkip();
                } else {
                    log.error('[SafetyPolicyEngine] Güç istekleri doğrulanamadı:', requests.code);
                    return deny('POWER_REQUESTS_UNAVAILABLE', 'Aktif güç istekleri doğrulanamadı; güç eylemi engellendi.', { loadCheck: 'ok' });
                }
            } else if (requests.hasActiveRequest) {
                log.info(`[SafetyPolicyEngine] Action blocked due to power requests: ${requests.categories.join(', ')}`);
                return deny('POWER_REQUEST_ACTIVE', `Aktif güç isteği var (${requests.categories.join(', ')}); işlem sürüyor olabilir.`, { loadCheck: 'active' });
            } else {
                loadStatus = 'ok';
            }
        }

        // 4. WBS-11.5: Tam ekran + aktif güç isteği BİRLİKTE ise engelle
        // (örn. sunum/izleme sırasında). Tek başına tam ekran engellemez.
        if (policy.checkFullscreen) {
            const [fullscreen, requests] = await Promise.all([fullscreenPromise, requestsPromise]);
            if (!fullscreen.ok) {
                log.error('[SafetyPolicyEngine] Tam ekran durumu doğrulanamadı:', fullscreen.code);
                return deny('FULLSCREEN_STATE_UNAVAILABLE', 'Tam ekran durumu doğrulanamadı; güç eylemi engellendi.', { loadCheck: loadStatus });
            }
            if (requests.ok) {
                if (loadStatus === 'skipped') loadStatus = requests.hasActiveRequest ? 'active' : 'ok';
                if (fullscreen.fullscreen && requests.hasActiveRequest) {
                    return deny('FULLSCREEN_POWER_ACTIVE', 'Tam ekran uygulama + aktif güç isteği var; işlem bitene kadar bekleniyor.', { loadCheck: loadStatus });
                }
            } else if (requests.unavailable === true) {
                // Ölçülemeyen kapı kombinasyon kuralını da devre dışı bırakır;
                // tam ekran tek başına engellemez (dokümante niyet korunur).
                loadStatus = 'unavailable';
                this._logCapabilitySkip();
            } else {
                return deny('POWER_REQUESTS_UNAVAILABLE', 'Aktif güç istekleri doğrulanamadı; güç eylemi engellendi.', { loadCheck: loadStatus });
            }
        }

        // 5. FAZ B: Kurumsal muafiyet — YALNIZCA konsol görevleri (yerel görevler etkilenmez).
        if ((task.source === 'console' || task.policyId) && this.storage) {
            try {
                const svc = new ExemptionService(this.storage);
                const settings = typeof this.storage.getSettings === 'function' ? this.storage.getSettings() : {};
                const hit = svc.findExemption({
                    deviceId: settings.agentId || null,
                    user: this.getCurrentUser(),
                    policyId: task.policyId || null
                });
                if (hit) {
                    log.info(`[SafetyPolicyEngine] Konsol görevi muafiyetle engellendi: ${hit.id}`);
                    return deny('EXEMPTION_ACTIVE', `Muafiyet devrede (${hit.reason} — onay: ${hit.approvedBy}).`);
                }
            } catch (err) {
                log.error('[SafetyPolicyEngine] muafiyet kontrolü yapılamadı:', err && err.message);
                return deny('POLICY_UNAVAILABLE', 'Muafiyet durumu doğrulanamadı; eylem engellendi.');
            }
        }

        // 6. FAZ B: Bakım-penceresi gerektiren görev (örn. yama-yeniden-başlatma)
        // pencere dışında çalışmaz. Bayrak konsol tarafından vurulur.
        if (task.requiresMaintenanceWindow && this.storage) {
            try {
                const svc = new ExemptionService(this.storage);
                if (!svc.inMaintenanceWindow()) {
                    return deny('OUTSIDE_MAINTENANCE_WINDOW', 'Bakım penceresi dışında; yama penceresi bekleniyor.');
                }
            } catch (err) {
                log.error('[SafetyPolicyEngine] bakım-penceresi kontrolü yapılamadı:', err && err.message);
                return deny('POLICY_UNAVAILABLE', 'Bakım penceresi doğrulanamadı; eylem engellendi.');
            }
        }

        // 7. FAZ D: Sunucu profili — konsoldan uyku/hazırda-beklet/kapatma YASAK.
        // Yeniden başlatma yalnızca bakım-penceresi bayrağıyla + pencere içinde.
        if (task.source === 'console' && this.storage && typeof this.storage.getSettings === 'function') {
            try {
                const settings = this.storage.getSettings();
                if (settings.deviceRole === 'server') {
                    if (['sleep', 'hibernate', 'shutdown'].includes(task.action)) {
                        log.info(`[SafetyPolicyEngine] Sunucu profilinde yasak eylem engellendi: ${task.action}`);
                        return deny('SERVER_PROFILE_FORBIDDEN', 'Sunucu profili: uyku/hazırda-beklet/kapatma yasak eylemler.');
                    }
                    if (task.action === 'restart' && (!task.requiresMaintenanceWindow || !new ExemptionService(this.storage).inMaintenanceWindow())) {
                        return deny('SERVER_RESTART_OUTSIDE_WINDOW', 'Sunucu yeniden başlatması yalnızca bakım penceresinde.');
                    }
                }
            } catch (err) {
                log.error('[SafetyPolicyEngine] sunucu-profil kontrolü yapılamadı:', err && err.message);
                return deny('POLICY_UNAVAILABLE', 'Sunucu profili doğrulanamadı; eylem engellendi.');
            }
        }

        return { allowed: true, loadCheck: loadStatus };
    }

    /** P0/BLOCKER-001: ölçülemeyen kapı saatte bir kez loglanır (görev başına spam yok). */
    _logCapabilitySkip() {
        const now = Date.now();
        if (now - this._capabilityLogAt < CAPABILITY_LOG_THROTTLE_MS) return;
        this._capabilityLogAt = now;
        log.warn('[SafetyPolicyEngine] Güç isteği ölçümü bu kurulumda kullanılamıyor (yükseltme gerekli); checkSystemLoad kapısı atlandı. Diğer güvenlik kapıları etkin.');
    }

    /**
     * P0/BLOCKER-001: `powercfg.exe /requests` yeteneğini ölçer.
     * Yükseltilmiş oturumda çalışır; `asInvoker` pakette hata döner.
     * @returns {Promise<{available:boolean, code:string|null, checkedAt:number}>}
     */
    async probePowerRequestCapability({ force = false } = {}) {
        const cap = this._capability;
        const now = Date.now();
        const ttl = cap.available === true ? CAPABILITY_TTL_OK_MS : CAPABILITY_TTL_FAIL_MS;
        if (!force && cap.available !== null && Number.isFinite(cap.checkedAt) && now - cap.checkedAt < ttl) {
            return { available: cap.available, code: cap.code, checkedAt: cap.checkedAt };
        }
        if (cap.inFlight) return cap.inFlight;

        const probe = new Promise((resolve) => {
            let settled = false;
            const finish = (available, code, value) => {
                if (settled) return;
                settled = true;
                cap.available = available;
                cap.code = code;
                cap.value = value || null;
                cap.checkedAt = Date.now();
                if (value) this._powerCache = { at: cap.checkedAt, value };
                resolve({ available, code, checkedAt: cap.checkedAt });
            };
            try {
                this.execFile('powercfg.exe', ['/requests'], { windowsHide: true, timeout: CAPABILITY_PROBE_TIMEOUT_MS }, (err, stdout) => {
                    if (err || !stdout || !String(stdout).trim()) {
                        return finish(false, 'POWER_REQUESTS_UNAVAILABLE', null);
                    }
                    const text = String(stdout);
                    const recognized = /^(DISPLAY|SYSTEM|AWAYMODE|PERFBOOST|ACTIVELOCKSCREEN):\s*$/im.test(text);
                    const parsed = SafetyPolicyEngine.parsePowerRequests(text);
                    if (!recognized && !parsed.hasActiveRequest) {
                        // Komut yetkili ama çıktı çözülemedi → ölçüm hatası (fail-closed).
                        return finish(true, null, { ok: false, code: 'POWER_REQUESTS_UNAVAILABLE', hasActiveRequest: false, categories: [] });
                    }
                    return finish(true, null, { ok: true, hasActiveRequest: parsed.hasActiveRequest, categories: parsed.categories });
                });
            } catch (_) {
                finish(false, 'POWER_REQUESTS_UNAVAILABLE', null);
            }
        });
        cap.inFlight = probe;
        // Exec geri çağrısı senkron olabildiği için temizlik ATAMA SONRASI yapılır.
        const clear = () => { if (cap.inFlight === probe) cap.inFlight = null; };
        probe.then(clear, clear);
        return probe;
    }

    /** Senkron okuma (sonda tetiklemez): UI/status için yetenek durumu. */
    getPowerRequestCapability() {
        const cap = this._capability;
        return { available: cap.available, checkedAt: cap.checkedAt, code: cap.code };
    }

    // WBS-11.5: Açılış koruması — uptime eşik altındaysa idle-tetikleme atlanır.
    isBootGuardActive() {
        let guardSec = 120;
        try {
            const s = this.storage ? this.storage.getSettings() : {};
            if (Number.isInteger(s.bootGuardSeconds)) guardSec = s.bootGuardSeconds;
        } catch (_) {}
        if (guardSec <= 0) return false;
        try {
            return this.uptimeFn() < guardSec;
        } catch (_) {
            return false;
        }
    }

    // FAZ D (KVKK): konsola giden gerekçelerde ham işlem adı taşınmaz.
    // Yerel logda tam ad durur; konsol makbuzunda kategori yazılır.
    static sanitizeForConsole(reason) {
        return String(reason || '').replace(/\b[\w.-]+\.exe\b/gi, 'korunan-uygulama');
    }

    // Saf ayrıştırıcı: `powercfg /requests` çıktısı → aktif kategori listesi.
    // WP-09.T2: tanınmayan ama `.exe` içeren satır da aktif istek sayılır
    // (yerelleştirilmiş Windows çıktısı için güvenli taraf).
    static parsePowerRequests(stdout) {
        const categories = [];
        let current = null;
        for (const rawLine of String(stdout || '').split('\n')) {
            const line = rawLine.trim().replace(/\r$/, '');
            const section = line.match(/^(DISPLAY|SYSTEM|AWAYMODE|PERFBOOST|ACTIVELOCKSCREEN):\s*$/i);
            if (section) {
                current = section[1].toUpperCase();
                continue;
            }
            if (line === '') continue;
            if (/^none\.?$/i.test(line)) continue;
            const category = current || (/\.exe\b/i.test(line) ? 'UNKNOWN' : null);
            if (!category) continue;
            if (!categories.includes(category)) categories.push(category);
        }
        return { hasActiveRequest: categories.length > 0, categories };
    }

    /**
     * WP-09.T2: 3 sn timeout, 5 sn cache; yetenek VAR + hata/boş/çözülemeyen
     * çıktı → fail-closed. P0/BLOCKER-001: yetenek YOK ise exec çalıştırılmaz,
     * `unavailable:true` döner ve çağıran kapıyı görünür biçimde atlar.
     */
    async getPowerRequests() {
        if (this._capability.available === null) {
            await this.probePowerRequestCapability();
        }
        const now = Date.now();
        if (this._capability.available !== true) {
            return { ok: false, unavailable: true, code: 'POWER_REQUESTS_UNAVAILABLE', hasActiveRequest: false, categories: [] };
        }
        if (this._powerCache && now - this._powerCache.at < 5000) return this._powerCache.value;
        return new Promise((resolve) => {
            this.execFile('powercfg.exe', ['/requests'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
                if (err || !stdout || !String(stdout).trim()) {
                    return resolve({ ok: false, code: 'POWER_REQUESTS_UNAVAILABLE', hasActiveRequest: false, categories: [] });
                }
                const text = String(stdout);
                const recognized = /^(DISPLAY|SYSTEM|AWAYMODE|PERFBOOST|ACTIVELOCKSCREEN):\s*$/im.test(text);
                const parsed = SafetyPolicyEngine.parsePowerRequests(text);
                if (!recognized && !parsed.hasActiveRequest) {
                    return resolve({ ok: false, code: 'POWER_REQUESTS_UNAVAILABLE', hasActiveRequest: false, categories: [] });
                }
                const value = { ok: true, hasActiveRequest: parsed.hasActiveRequest, categories: parsed.categories };
                this._powerCache = { at: now, value };
                resolve(value);
            });
        });
    }

    /** WP-09.T3: false varsayımı yok; hata ayrı `ok:false` olarak döner. */
    getFullscreenState() {
        return new Promise((resolve) => {
            const psCmd = "Add-Type -AssemblyName System.Windows.Forms; Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern System.IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern bool GetWindowRect(System.IntPtr h, ref RECT r); public struct RECT { public int L; public int T; public int R; public int B; }' -Name 'FgWin' -Namespace FgWinNS; $h=[FgWinNS.FgWin]::GetForegroundWindow(); $r=New-Object FgWinNS.FgWin+RECT; [void][FgWinNS.FgWin]::GetWindowRect($h, [ref]$r); $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; if (($r.R-$r.L) -ge $s.Width -and ($r.B-$r.T) -ge $s.Height) {'FULLSCREEN'} else {'windowed'}";
            this.execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true, timeout: 15000 }, (err, stdout) => {
                if (err || !stdout || !String(stdout).trim()) {
                    return resolve({ ok: false, code: 'FULLSCREEN_STATE_UNAVAILABLE', fullscreen: false });
                }
                const text = String(stdout).trim();
                if (text !== 'FULLSCREEN' && text !== 'windowed') {
                    return resolve({ ok: false, code: 'FULLSCREEN_STATE_UNAVAILABLE', fullscreen: false });
                }
                resolve({ ok: true, fullscreen: text === 'FULLSCREEN' });
            });
        });
    }

    static rawProcessNames(list) {
        const out = [];
        for (const item of (Array.isArray(list) ? list : [])) {
            let name = typeof item === 'string' ? item : (item && (item.name || item.processName));
            if (typeof name !== 'string') continue;
            name = name.trim().toLowerCase();
            if (!name) continue;
            const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
            if (slash >= 0) name = name.slice(slash + 1);
            out.push(name);
        }
        return out;
    }

    async getRunningProcessList() {
        // WP-09.T1: ölçüm hatası boş liste değildir; çağıran fail-closed uygular.
        if (this.processProvider) {
            const list = await this.processProvider();
            if (!Array.isArray(list)) throw Object.assign(new Error('Süreç sağlayıcısı dizi döndürmedi.'), { code: 'PROCESS_LIST_UNAVAILABLE' });
            return SafetyPolicyEngine.rawProcessNames(list);
        }
        const mod = await import('ps-list');
        const list = await (mod.default || mod.psList)({ all: true });
        if (!Array.isArray(list)) throw Object.assign(new Error('ps-list dizi döndürmedi.'), { code: 'PROCESS_LIST_UNAVAILABLE' });
        return SafetyPolicyEngine.rawProcessNames(list);
    }

    getCurrentUser() {
        try {
            const info = os.userInfo();
            return (info && info.username) || null;
        } catch (_) {
            return null;
        }
    }

    async getUserIdleSeconds() {
        // WP-05: PowerShell GetLastInputInfo yerine Electron powerMonitor.
        // Sağlayıcı yoksa 0 döner = "kullanıcı aktif"; uzaktan kapatma fail-closed.
        try {
            if (this.idleProvider) {
                const secs = Number(await this.idleProvider());
                return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : 0;
            }
            if (this.powerMonitor && typeof this.powerMonitor.getSystemIdleTime === 'function') {
                const secs = Number(this.powerMonitor.getSystemIdleTime());
                return Number.isFinite(secs) && secs >= 0 ? Math.floor(secs) : 0;
            }
        } catch (_) { /* fail-closed */ }
        return 0;
    }
}

module.exports = SafetyPolicyEngine;
