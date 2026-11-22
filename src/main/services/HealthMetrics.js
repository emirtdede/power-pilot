/**
 * HealthMetrics.js
 *
 * C5 - yerel sağlık özeti.
 *
 * ÖNEMLİ: Bu modül HİÇBİR veri toplamaz, göndermez veya ağa çıkarmaz.
 * Yalnızca zaten cihazda duran görev/geçmiş kayıtlarını toplayıp kullanıcıya
 * (ve destek görüşmesinde kullanıcının kendi ekranında) okunur bir özet
 * üretir. Ürünün "çevrimdışı, telemetri yok" vaadiyle çelişmez.
 *
 * Saf fonksiyonlar: depo ve saat enjekte edilir, testte gerçek zaman gerekmez.
 */

// Bu sonuçlar "kullanıcıya raporlanan sağlık" açısından başarısızlık değildir;
// ancak otomasyonun çalışmadığı durumlardır ve oran hesabına girer.
const FAILURE_CODES = new Set([
    'os_execution_failed',
    'authorization_error',
    'timeout',
    'blocked_by_policy',
    'condition_invalid'
]);

/**
 * @param {object} input
 * @param {Array} input.history geçmiş kayıtları (en yeni önce olabilir)
 * @param {number|null} input.installedAtMs ilk kurulum zamanı (ms)
 * @param {number} input.nowMs şimdi (ms)
 * @returns {object} kullanıcıya gösterilebilir özet (ham kodlar yok)
 */
function summarize({ history, installedAtMs, nowMs }) {
    const list = Array.isArray(history) ? history : [];
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();

    let success = 0;
    let failed = 0;
    let cancelled = 0;
    let other = 0;
    const lastFailure = { at: null, code: null };

    for (const record of list) {
        const code = record && record.resultCode;
        if (code === 'success') {
            success += 1;
        } else if (FAILURE_CODES.has(code)) {
            failed += 1;
            const ts = record && record.timestamp ? Date.parse(record.timestamp) : NaN;
            if (Number.isFinite(ts) && (lastFailure.at === null || ts > lastFailure.at)) {
                lastFailure.at = ts;
                lastFailure.code = code;
            }
        } else if (code === 'cancelled_by_user' || code === 'snoozed_by_user') {
            cancelled += 1;
        } else {
            other += 1;
        }
    }

    const attempted = success + failed;
    const successRatePercent = attempted === 0 ? null : Math.round((success / attempted) * 1000) / 10;

    const installed = Number.isFinite(installedAtMs) ? installedAtMs : null;
    const daysInstalled = installed === null ? null : Math.max(0, Math.floor((now - installed) / 86400000));

    return {
        totalRecords: list.length,
        successCount: success,
        failureCount: failed,
        cancelledCount: cancelled,
        otherCount: other,
        successRatePercent,
        daysInstalled,
        lastFailureAt: lastFailure.at === null ? null : new Date(lastFailure.at).toISOString(),
        // Ham sonuç kodu renderer'a gitmez; yalnızca evet/hayır sinyali.
        hasFailures: failed > 0
    };
}

module.exports = { summarize, FAILURE_CODES };
