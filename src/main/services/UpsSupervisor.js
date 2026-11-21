/**
 * UpsSupervisor.js — P1-9
 *
 * NUT `upsmon`'in kanıtlanmış davranışının sade karşılığı: UPS "LB" (low
 * battery) bayrağını görünce beklemeden kapatmak yerine KISA bir geri sayım
 * açar; süre dolduğunda hâlâ kritikse güç eylemi uygulanır. Kullanıcı bu
 * pencerede iptal edebilir.
 *
 * Ölçülen kusur: envanter toplama UPS uyarısını yalnızca `log.warn` ile
 * yazıyordu. Sunucu profili için "UPS izleme" ayarı açık olsa bile elektrik
 * kesintisinde makine pil bitene kadar çalışmaya devam ediyordu — yani ayar
 * görünürde vardı, davranışta yoktu.
 *
 * Tasarım kararları (hepsi test edilebilir, saf DI):
 * - Eylem ENJEKTE edilir (`powerService`), üretimde PowerService'tir; güvenlik
 *   kapısı (execution guard) aynen geçerlidir.
 * - Geri sayım sırasında durum normale dönerse (elektrik geldi) eylem iptal
 *   edilir. Bu, `upsmon`'in MINSUPPLIES geri dönüşüyle aynı niyettedir.
 * - Aynı kesinti için tekrar tekrar eylem denenmez: cooldown vardır.
 * - Ölçülemeyen durum (reachable:false) ASLA eylem üretmez; yalnızca bilgi
 *   olayı yayınlanır. Fail-closed burada "kapatmamak"tır.
 */

const DEFAULT_COUNTDOWN_MS = 30000;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

class UpsSupervisor {
    /**
     * @param {object} opts
     * @param {{execute: Function}} opts.powerService
     * @param {string} [opts.action] 'hibernate' | 'shutdown' | 'sleep' | 'lock' | 'restart'
     * @param {number} [opts.countdownMs] kritik durumdan sonra bekleme
     * @param {number} [opts.cooldownMs] aynı olay için tekrar deneme aralığı
     * @param {Function} [opts.onEvent] (type, payload) => void
     * @param {Function} [opts.setTimer] setTimeout benzeri
     * @param {Function} [opts.clearTimer] clearTimeout benzeri
     * @param {Function} [opts.nowFn] Date.now benzeri
     */
    constructor(opts = {}) {
        const o = opts || {};
        this.powerService = o.powerService || null;
        this.action = typeof o.action === 'string' && o.action ? o.action : 'hibernate';
        this.countdownMs = Number.isFinite(o.countdownMs) && o.countdownMs >= 0
            ? Math.floor(o.countdownMs)
            : DEFAULT_COUNTDOWN_MS;
        this.cooldownMs = Number.isFinite(o.cooldownMs) && o.cooldownMs >= 0
            ? Math.floor(o.cooldownMs)
            : DEFAULT_COOLDOWN_MS;
        this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
        this.setTimer = typeof o.setTimer === 'function' ? o.setTimer : setTimeout;
        this.clearTimer = typeof o.clearTimer === 'function' ? o.clearTimer : clearTimeout;
        this.nowFn = typeof o.nowFn === 'function' ? o.nowFn : Date.now;

        this.handle = null;
        this.critical = false;
        this.lastFiredAt = null;
        this.lastState = null;
    }

    /** NUT durumu kritik mi? `LB` bayrağı birincil sinyaldir. */
    static isCritical(ups) {
        if (!ups || ups.reachable !== true) return false;
        return ups.lowBattery === true && ups.onBattery === true;
    }

    _emit(type, payload) {
        if (!this.onEvent) return;
        try {
            this.onEvent(type, payload);
        } catch (_) {
            /* dinleyici hatası güç akışını bozmaz */
        }
    }

    /**
     * Yeni UPS durumunu işler. Aynı durumun tekrar gelmesi (60 sn'lik yoklama)
     * yeni sayaç başlatmaz.
     * @param {object|null} ups
     * @returns {{critical: boolean, armed: boolean, fired: boolean, skipped?: string}}
     */
    handleState(ups) {
        this.lastState = ups || null;
        if (!ups || ups.reachable !== true) {
            // Ölçüm yok: eylem yok. Bekleyen sayaç da düşer (yanlış kapatma olmaz).
            this.critical = false;
            this.disarm();
            return { critical: false, armed: false, fired: false, skipped: 'UNREACHABLE' };
        }

        const critical = UpsSupervisor.isCritical(ups);
        if (!critical) {
            const wasCritical = this.critical;
            this.critical = false;
            if (this.handle) {
                this.disarm();
                if (wasCritical) this._emit('recovered', { ups });
            }
            return { critical: false, armed: false, fired: false };
        }

        if (this.critical) {
            // Zaten kritik ve sayaç kurulu; tekrar başlatma.
            return { critical: true, armed: this.handle !== null, fired: false };
        }

        this.critical = true;
        // Aynı kesinti için cooldown içindeysek yeniden kurma.
        if (this.lastFiredAt !== null && (this.nowFn() - this.lastFiredAt) < this.cooldownMs) {
            this._emit('cooldown', { ups, action: this.action, lastFiredAt: this.lastFiredAt });
            return { critical: true, armed: false, fired: false, skipped: 'COOLDOWN' };
        }

        this._emit('critical', { ups, action: this.action, countdownMs: this.countdownMs });
        this.handle = this.setTimer(() => {
            this.handle = null;
            // Süre dolduğunda durum normale döndüyse eylem yok.
            if (!this.critical) return;
            const state = this.lastState;
            if (!UpsSupervisor.isCritical(state)) return;
            this.lastFiredAt = this.nowFn();
            this._emit('executing', { ups: state, action: this.action });
            this._execute(state);
        }, this.countdownMs);
        if (this.handle && typeof this.handle.unref === 'function') this.handle.unref();
        return { critical: true, armed: true, fired: false };
    }

    async _execute(ups) {
        try {
            const res = this.powerService && typeof this.powerService.execute === 'function'
                ? await this.powerService.execute(this.action)
                : { success: false, error: 'Güç servisi yok' };
            this._emit(res && res.success ? 'executed' : 'failed', {
                ups,
                action: this.action,
                result: res || null
            });
        } catch (err) {
            this._emit('failed', {
                ups,
                action: this.action,
                result: { success: false, error: err && err.message ? err.message : 'UPS eylemi hatası' }
            });
        }
    }

    /** Bekleyen geri sayımı iptal eder (kullanıcı iptali veya Ayarlar kapatma). */
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

module.exports = { UpsSupervisor, DEFAULT_COUNTDOWN_MS, DEFAULT_COOLDOWN_MS };
