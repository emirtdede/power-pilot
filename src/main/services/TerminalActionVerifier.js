/**
 * TerminalActionVerifier.js
 *
 * Windows'ta `shutdown /s /t 0` gibi bir komut "başarılı" dönse bile oturum
 * hemen kapanmayabilir: kaydedilmemiş işi olan uygulamalar kapatmayı veto eder
 * ve Windows kullanıcıya kendi onay penceresini gösterir. Bu durumda
 * Power Pilot süreci hâlâ ayaktadır.
 *
 * Bu modül, terminal eylemin ardından kısa bir doğrulama penceresi açar:
 * süreç hâlâ çalışıyorsa (timer tetiklendiyse) kapatmanın engellendiği
 * kesinleşir. Timer süreçle birlikte ölürse hiçbir şey yapılmaz — yani
 * "kapanmadı" sinyali yalnızca gerçekten kapanmadığında üretilir.
 *
 * Saf ve test edilebilir: timer fonksiyonları enjekte edilir.
 */

const TERMINAL_ACTIONS = new Set(['shutdown', 'restart', 'signout']);

// Windows, oturum sonlandırma isteğini uygulamalara iletir; veto eden
// uygulamalar kendi pencerelerini gösterir. 25 sn, kullanıcının onay
// penceresini görüp ilk saniyelerde tepki vermediği durumu yakalar.
const DEFAULT_GRACE_MS = 25000;

class TerminalActionVerifier {
    /**
     * @param {object} [opts]
     * @param {number} [opts.graceMs] doğrulama penceresi (ms)
     * @param {Function} [opts.setTimer] setTimeout benzeri
     * @param {Function} [opts.clearTimer] clearTimeout benzeri
     */
    constructor(opts = {}) {
        const o = opts || {};
        this.graceMs = Number.isFinite(o.graceMs) && o.graceMs >= 0 ? Math.floor(o.graceMs) : DEFAULT_GRACE_MS;
        this.setTimer = typeof o.setTimer === 'function' ? o.setTimer : setTimeout;
        this.clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : clearTimeout;
        this.handle = null;
    }

    /** Kapatma/oturum kapatma gibi süreç sonlandıran eylemler. */
    static isTerminalAction(action) {
        return TERMINAL_ACTIONS.has(String(action || ''));
    }

    /**
     * Terminal eylem sonrası doğrulamayı kurar.
     * @param {string} action eylem adı
     * @param {Function} onVetoed pencere dolduğunda çağrılır (süreç hâlâ ayakta)
     * @param {number} [extraMs] P1-6: OS'e verilen yerel gecikme (`shutdown /t n`).
     *        Doğrulama penceresi bu süre kadar ÖTELENİR; aksi hâlde meşru bir
     *        gecikme "kapatma engellendi" diye yanlış raporlanırdı. Gecikme
     *        dolduğunda Windows oturumu kapatır ve timer hiç çalışmaz.
     * @returns {boolean} doğrulama kuruldu mu
     */
    arm(action, onVetoed, extraMs = 0) {
        if (!TerminalActionVerifier.isTerminalAction(action)) return false;
        if (typeof onVetoed !== 'function') return false;
        this.disarm();
        const extra = Number.isFinite(extraMs) && extraMs > 0 ? Math.floor(extraMs) : 0;
        const windowMs = this.graceMs + extra;
        this.handle = this.setTimer(() => {
            this.handle = null;
            try {
                onVetoed(action);
            } catch (_) {
                /* geri çağırım hatası süreç akışını bozmaz */
            }
        }, windowMs);
        if (this.handle && typeof this.handle.unref === 'function') {
            // Doğrulama beklemesi uygulamanın kapanmasını geciktirmemeli.
            this.handle.unref();
        }
        return true;
    }

    /** Doğrulamayı iptal eder (kullanıcı görevi iptal ettiyse vb.). */
    disarm() {
        if (this.handle) {
            this.clearTimer(this.handle);
            this.handle = null;
        }
    }

    isArmed() {
        return this.handle !== null;
    }
}

module.exports = {
    TerminalActionVerifier,
    TERMINAL_ACTIONS,
    DEFAULT_GRACE_MS
};
