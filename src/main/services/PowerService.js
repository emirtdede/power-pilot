/**
 * PowerService.js
 * Centralized Power Management Service for Power Pilot.
 * Safe OS command execution for power operations:
 * - shutdown
 * - restart
 * - sleep
 * - hibernate
 * - lock
 * - signout
 */

const { execFile } = require('child_process');
const log = require('../logger');

const POWER_ACTIONS = {
    SHUTDOWN: 'shutdown',
    RESTART: 'restart',
    SLEEP: 'sleep',
    HIBERNATE: 'hibernate',
    LOCK: 'lock',
    SIGNOUT: 'signout'
};

/**
 * P1-6 (üçüncü tur): hata NEDENİ ayrımı.
 *
 * Eskiden her başarısızlık `os_execution_failed` olarak raporlanıyordu.
 * Oysa `EXECUTION_RESULT_CODE` içinde `timeout` ve `authorization_error`
 * tanımlıydı, 17 dilde etiketleri vardı ve `HealthMetrics` bunları
 * "otomasyon çalışmadı" sayıyordu — ama HİÇBİR kod yolu bu değerleri
 * üretmiyordu. Kullanıcı "OS reddetti" görüyor, zaman aşımı ile yetki
 * reddini ayırt edemiyordu.
 *
 * Artık `execFile` hatası sınıflandırılır:
 *  - ETIMEDOUT / SIGTERM(15 sn timeout)  → POWER_TIMEOUT
 *  - EPERM / EACCES / ELEVATION_REQUIRED → POWER_AUTHORIZATION
 *  - Aksi halde                          → POWER_EXEC_FAILED
 */
const POWER_ERROR = Object.freeze({
    TIMEOUT: 'POWER_TIMEOUT',
    AUTHORIZATION: 'POWER_AUTHORIZATION',
    INVALID_ACTION: 'POWER_INVALID_ACTION',
    BLOCKED: 'POWER_BLOCKED',
    EXEC_FAILED: 'POWER_EXEC_FAILED'
});

const AUTHORIZATION_ERRNOS = new Set(['EPERM', 'EACCES', 'ELEVATION_REQUIRED', 'ERROR_ELEVATION_REQUIRED']);
const TIMEOUT_ERRNOS = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

/**
 * execFile hatasını kararlı bir sınıfa çevirir. Saf fonksiyon (test edilebilir).
 * @param {NodeJS.ErrnoException|null} err
 * @returns {string} POWER_ERROR değerlerinden biri
 */
function classifyExecError(err) {
    if (!err) return POWER_ERROR.EXEC_FAILED;
    const code = typeof err.code === 'string' ? err.code : '';
    if (TIMEOUT_ERRNOS.has(code) || err.killed === true || err.signal === 'SIGTERM') {
        return POWER_ERROR.TIMEOUT;
    }
    if (AUTHORIZATION_ERRNOS.has(code)) return POWER_ERROR.AUTHORIZATION;
    // Windows yerelleştirilmiş mesajları: "Access is denied" / "Erişim engellendi".
    const msg = String(err.message || '');
    if (/access is denied|erişim engellendi|requires elevation|yönetici/i.test(msg)) {
        return POWER_ERROR.AUTHORIZATION;
    }
    return POWER_ERROR.EXEC_FAILED;
}

class PowerService {
    /**
     * WP-11.T7: audit zinciri kurcalanmışsa veya depo bakım modundaysa
     * yıkıcı eylemler durdurulur. Guard main.js tarafından takılır.
     */
    static setExecutionGuard(fn) {
        PowerService._guard = typeof fn === 'function' ? fn : null;
    }

    static executionAllowed() {
        if (typeof PowerService._guard !== 'function') return { ok: true };
        return PowerService._guard();
    }

    /**
     * Executes a power action safely via OS utilities.
     * @param {string} action - One of POWER_ACTIONS
     * @param {{forceClose?: boolean, graceSeconds?: number}} [options]
     *        `forceClose`: shutdown/restart/signout'a `/f` ekler (açık
     *        uygulamaları zorla kapat).
     *        `graceSeconds`: P1-6 — Windows'un YEREL gecikmesi (`/t n`) kullanılır.
     *        Bu, Ayarlar'daki "Açık Uygulamalar İçin Bekleme Süresi"nin gerçek
     *        karşılığıdır: kullanıcıya açık uygulamaları kaydetmesi için süre
     *        tanınır ve `shutdown /a` ile GERÇEKTEN iptal edilebilir.
     * @returns {Promise<{success: boolean, error?: string, graceSeconds?: number}>}
     */
    static execute(action, options = {}) {
        const guard = PowerService.executionAllowed();
        if (!guard.ok) {
            log.error(`[PowerService] Eylem bloke edildi (${action}): ${guard.code || 'GUARD'}`);
            return Promise.resolve({ success: false, error: guard.error || 'Güvenlik denetimi eylemi engelledi.', code: guard.code || 'BLOCKED' });
        }
        const force = options && options.forceClose === true;
        // P1-6: 0..600 sn aralığı; geçersiz/negatif değer 0'a düşer.
        const rawGrace = Number(options && options.graceSeconds);
        const grace = Number.isFinite(rawGrace) && rawGrace > 0 ? Math.min(Math.round(rawGrace), 600) : 0;
        return new Promise((resolve) => {
            log.info(`[PowerService] Executing action: ${action}${force ? ' (forceClose)' : ''}${grace > 0 ? ` (grace ${grace}s)` : ''}`);

            let file = null;
            let args = [];

            switch (action) {
                case POWER_ACTIONS.SHUTDOWN:
                    file = 'shutdown.exe';
                    args = force ? ['/s', '/f', '/t', String(grace)] : ['/s', '/t', String(grace)];
                    break;
                case POWER_ACTIONS.RESTART:
                    file = 'shutdown.exe';
                    args = force ? ['/r', '/f', '/t', String(grace)] : ['/r', '/t', String(grace)];
                    break;
                case POWER_ACTIONS.SLEEP:
                    // L-09: rundll32 parametre yorumu hibernation ayarına göre
                    // değişebiliyor. Doğrudan SetSuspendState(FALSE, TRUE, FALSE)
                    // çağrısı uyku/hibernate ayrımını netleştirir.
                    file = 'powershell.exe';
                    args = [
                        '-NoProfile', '-NonInteractive', '-Command',
                        "Add-Type -MemberDefinition '[DllImport(\"powrprof.dll\", SetLastError=true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);' -Name PowrProf -Namespace Win32; if (-not [Win32.PowrProf]::SetSuspendState($false, $true, $false)) { exit 1 }"
                    ];
                    break;
                case POWER_ACTIONS.HIBERNATE:
                    file = 'shutdown.exe';
                    args = ['/h'];
                    break;
                case POWER_ACTIONS.LOCK:
                    file = 'rundll32.exe';
                    args = ['user32.dll,LockWorkStation'];
                    break;
                case POWER_ACTIONS.SIGNOUT:
                    file = 'shutdown.exe';
                    args = force ? ['/l', '/f'] : ['/l'];
                    break;
                default:
                    return resolve({ success: false, error: `Invalid power action: ${action}`, code: POWER_ERROR.INVALID_ACTION });
            }

            execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
                if (err) {
                    log.error(`[PowerService] Action execution failed (${action}):`, err);
                    return resolve({
                        success: false,
                        error: err.message || stderr,
                        code: classifyExecError(err)
                    });
                }
                return resolve({ success: true });
            });
        });
    }

    /**
     * P1-6: `graceSeconds` penceresi içinde planlanmış kapatmayı iptal eder.
     *
     * `shutdown /t n` ile başlatılan kapatma, Windows'un kendi zamanlayıcısında
     * bekler; `shutdown /a` onu GERÇEKTEN durdurur. Bu yalnızca yerel gecikme
     * penceresinde anlamlıdır (süre 0 ise Windows komutu anında uygular).
     * @returns {Promise<{success: boolean, error?: string}>}
     */
    static abortScheduledShutdown() {
        const guard = PowerService.executionAllowed();
        if (!guard.ok) {
            return Promise.resolve({ success: false, error: guard.error || 'Güvenlik denetimi eylemi engelledi.', code: guard.code || 'BLOCKED' });
        }
        return new Promise((resolve) => {
            execFile('shutdown.exe', ['/a'], { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
                if (err) {
                    log.warn('[PowerService] Kapatma iptali başarısız:', err && err.message);
                    return resolve({ success: false, error: (err && err.message) || stderr });
                }
                log.info('[PowerService] Planlanmış kapatma iptal edildi (shutdown /a)');
                return resolve({ success: true });
            });
        });
    }

    /**
     * Validates if action string is supported
     */
    static isValidAction(action) {
        return Object.values(POWER_ACTIONS).includes(action);
    }
}

module.exports = {
    PowerService,
    POWER_ACTIONS,
    POWER_ERROR,
    classifyExecError
};
