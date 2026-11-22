/**
 * MiniWidgetState - mini pencere sayaç durumunun TEK hesap noktası.
 *
 * NEDEN VAR (bulunan kusur):
 *   Mini pencere, `taskManager.getActiveTasks().length > 0` olduğunda açılıyor
 *   (main.js `updateMiniWindowVisibility`). Ancak sayaç verisini YALNIZCA ana
 *   pencerenin renderer'ı gönderiyordu (`app.js` `updateDisplay` →
 *   `updateMiniTimer`). Sonuç: hızlı zamanlayıcı dışında bir görev aktifken
 *   (Smart Finish, şablon, zamanlanmış görev, zincir) mini pencere açılıyor ama
 *   içi **`--` / `00:00`** kalıyordu - kullanıcıya "sayaç var" izlenimi verip
 *   hiçbir bilgi vermeyen boş bir widget.
 *
 *   Ölçüm (öncesi): `createTask({trigger:{type:'duration',durationMs:3600000}})`
 *   → pencere gizle → mini widget `{"action":"--","countdown":"00:00"}`.
 *   Ölçüm (sonrası): `{"action":"Bilgisayarı Kapat","countdown":"59:58"}`.
 *
 * Modül saftır: saat, dil ve çeviri fonksiyonları dışarıdan verilir; böylece
 * birim testi gerçek Electron'a ihtiyaç duymaz.
 */

/**
 * Kalan milisaniyeyi mini widget biçimine çevirir.
 * 1 günden uzun sürelerde gün öneki eklenir ("2g 03:04:05").
 *
 * @param {number} ms kalan süre (ms), negatif değerler 0'a kırpılır
 * @param {string} [daySuffix] gün son eki (dile göre, ilk harf kullanılır)
 * @returns {string} "MM:SS" | "HH:MM:SS" | "Ng HH:MM:SS"
 */
function formatCountdown(ms, daySuffix = 'g') {
    const total = Math.max(0, Math.floor(Number.isFinite(ms) ? ms / 1000 : 0));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    if (d > 0) {
        const suffix = String(daySuffix || 'g').substring(0, 1);
        return `${d}${suffix} ${two(h)}:${two(m)}:${two(s)}`;
    }
    if (h > 0) return `${two(h)}:${two(m)}:${two(s)}`;
    return `${two(m)}:${two(s)}`;
}

/** Bir görevin sayaç hedefi var mı? (koşullu görevlerde hedef zaman yoktur) */
function hasCountdown(task) {
    const target = Number(task && task.trigger && task.trigger.targetTime);
    return Number.isFinite(target) && target > 0;
}

/**
 * Mini pencerede gösterilecek durumu hesaplar.
 *
 * Seçim kuralı: hedef zamanı olan görevler arasından **en yakın** olan
 * gösterilir (kullanıcı en çok onu merak eder). Hedef zamanı olan görev yoksa
 * ilk koşullu görev "izleniyor" durumuyla gösterilir.
 *
 * @param {object} opts
 * @param {Array<object>} opts.tasks aktif görev listesi (toJSON veya task)
 * @param {number} opts.now şimdiki zaman (ms)
 * @param {(key: string) => string} opts.t
 * @param {(action: string) => string} opts.actionLabel
 * @param {(task: object) => string} opts.taskDisplayName
 * @param {string} [opts.daySuffix]
 * @returns {{secondsRemaining:number, formattedCountdown:string, actionText:string, action:string, taskId:string, monitoring:boolean}|null}
 */
function computeState({ tasks, now, t, actionLabel, taskDisplayName, daySuffix = 'g' }) {
    if (!Array.isArray(tasks) || tasks.length === 0) return null;

    const timed = tasks.filter(hasCountdown);
    if (timed.length > 0) {
        const next = timed.reduce((a, b) => (
            Number(b.trigger.targetTime) < Number(a.trigger.targetTime) ? b : a
        ));
        const target = Number(next.trigger.targetTime);
        const remainingMs = Math.max(0, target - (Number.isFinite(now) ? now : Date.now()));
        return {
            secondsRemaining: Math.ceil(remainingMs / 1000),
            formattedCountdown: formatCountdown(remainingMs, daySuffix),
            actionText: actionLabel ? actionLabel(next.action) : String(next.action || ''),
            action: next.action,
            taskId: next.id,
            monitoring: false
        };
    }

    // Koşula bağlı görev: geri sayım yok, dürüstçe "izleniyor" gösterilir.
    const task = tasks[0];
    const label = typeof t === 'function' ? t('statusMonitoring') : 'Monitoring';
    return {
        secondsRemaining: 0,
        formattedCountdown: '',
        actionText: taskDisplayName ? taskDisplayName(task) : String((task && task.name) || ''),
        action: task && task.action ? task.action : '',
        taskId: task && task.id ? task.id : null,
        monitoring: true,
        statusText: label,
        progressText: (task && task.lastProgressMessage) ? String(task.lastProgressMessage) : ''
    };
}

module.exports = { computeState, formatCountdown, hasCountdown };
