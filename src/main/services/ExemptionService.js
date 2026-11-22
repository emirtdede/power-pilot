/**
 * ExemptionService.js - FAZ B.
 * Muafiyet listesi (PA-eyalet Exclusion Form deseninin dijitali) + bakım pencereleri.
 * - Muafiyet: {id, deviceId?, user?, policyId|null, from, to, reason, approvedBy, createdAt}
 *   deviceId VEYA user zorunlu; policyId null = tüm politikalardan muaf.
 * - Bakım penceresi: {id, name, days:[0-6], start:'HH:mm', end:'HH:mm'}
 *   Pencere içindeyse yıkıcı politika (shutdown/restart) çalışmaz - yama penceresi
 *   bunun İSTİSNASIDIR (yama penceresi görevleri pencere DIŞINDA da çalışabilir mi?
 *   Hayır: yama-öncesi-wake yalnızca bakım penceresinde anlamlıdır; muafiyet ise
 *   bakım penceresini de ezer).
 * Electron bağımlılığı yok.
 */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function fail(message, code) {
    return { ok: false, error: message, code: code || 'INVALID_EXEMPTION' };
}

function minutesOf(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
}

function validateExemption(ex) {
    if (!ex || typeof ex !== 'object') return fail('Geçersiz muafiyet gövdesi.', 'INVALID_BODY');
    if (typeof ex.id !== 'string' || !ex.id || ex.id.length > 64) {
        return fail('Muafiyet id gerekli (en fazla 64 karakter).', 'INVALID_ID');
    }
    const hasDevice = typeof ex.deviceId === 'string' && ex.deviceId.length > 0 && ex.deviceId.length <= 128;
    const hasUser = typeof ex.user === 'string' && ex.user.length > 0 && ex.user.length <= 128;
    if (!hasDevice && !hasUser) return fail('deviceId veya user gerekli.', 'INVALID_SUBJECT');
    if (ex.policyId !== undefined && ex.policyId !== null &&
        (typeof ex.policyId !== 'string' || !ex.policyId || ex.policyId.length > 64)) {
        return fail('policyId geçersiz (null = tüm politikalar).', 'INVALID_POLICY');
    }
    const from = new Date(ex.from).getTime();
    const to = new Date(ex.to).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
        return fail('from/to tarih aralığı geçersiz.', 'INVALID_RANGE');
    }
    if (typeof ex.reason !== 'string' || !ex.reason.trim() || ex.reason.length > 200) {
        return fail('Gerekçe zorunlu (en fazla 200 karakter).', 'INVALID_REASON');
    }
    if (typeof ex.approvedBy !== 'string' || !ex.approvedBy.trim() || ex.approvedBy.length > 128) {
        return fail('Onaylayan zorunlu.', 'INVALID_APPROVER');
    }
    return { ok: true };
}

function validateWindow(w) {
    if (!w || typeof w !== 'object') return fail('Geçersiz pencere gövdesi.', 'INVALID_BODY');
    if (typeof w.id !== 'string' || !w.id || w.id.length > 64) {
        return fail('Pencere id gerekli.', 'INVALID_ID');
    }
    if (!Array.isArray(w.days) || w.days.length === 0 ||
        w.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return fail('days 0..6 gün listesi olmalı.', 'INVALID_DAYS');
    }
    if (typeof w.start !== 'string' || !TIME_RE.test(w.start) ||
        typeof w.end !== 'string' || !TIME_RE.test(w.end)) {
        return fail('start/end HH:mm olmalı.', 'INVALID_TIME');
    }
    // WP-11.T9: start === end ölü penceredir (hiçbir zaman eşleşmez) → reddet.
    if (w.start === w.end) {
        return fail('Başlangıç ve bitiş aynı olamaz.', 'INVALID_WINDOW');
    }
    return { ok: true };
}

function isInWindow(w, nowMs = Date.now()) {
    const d = new Date(nowMs);
    const day = d.getDay();
    const cur = d.getHours() * 60 + d.getMinutes();
    const s = minutesOf(w.start);
    const e = minutesOf(w.end);
    if (s <= e) return w.days.includes(day) && cur >= s && cur < e;
    // Gece yarısını aşan pencere: 23:00-02:00, Salı 01:00 → Pazartesi kaydı.
    if (cur >= s) return w.days.includes(day);
    if (cur < e) return w.days.includes((day + 6) % 7);
    return false;
}

class ExemptionService {
    constructor(storageService = null) {
        this.storage = storageService;
    }

    list() {
        if (!this.storage || typeof this.storage.getExemptions !== 'function') return [];
        return this.storage.getExemptions();
    }

    windows() {
        if (!this.storage || typeof this.storage.getMaintenanceWindows !== 'function') return [];
        return this.storage.getMaintenanceWindows();
    }

    add(ex) {
        const check = validateExemption(ex);
        if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
        const record = {
            id: ex.id,
            deviceId: ex.deviceId || null,
            user: ex.user || null,
            policyId: ex.policyId === undefined ? null : ex.policyId,
            from: new Date(ex.from).toISOString(),
            to: new Date(ex.to).toISOString(),
            reason: ex.reason.trim(),
            approvedBy: ex.approvedBy.trim(),
            createdAt: new Date().toISOString()
        };
        const list = this.list().filter((e) => e.id !== record.id);
        list.push(record);
        this.storage.saveExemptions(list);
        return record;
    }

    remove(id) {
        const list = this.list().filter((e) => e.id !== id);
        this.storage.saveExemptions(list);
        return true;
    }

    addWindow(w) {
        const check = validateWindow(w);
        if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
        const record = { id: w.id, name: String(w.name || w.id).slice(0, 80), days: [...w.days], start: w.start, end: w.end };
        const list = this.windows().filter((x) => x.id !== record.id);
        list.push(record);
        this.storage.saveMaintenanceWindows(list);
        return record;
    }

    removeWindow(id) {
        this.storage.saveMaintenanceWindows(this.windows().filter((x) => x.id !== id));
        return true;
    }

    /**
     * Muafiyet eşleşmesi: cihaz/kullanıcı + politika (null=hepsi) + tarih aralığı.
     */
    findExemption({ deviceId = null, user = null, policyId = null, nowMs = Date.now() } = {}) {
        return this.list().find((e) => {
            const subjectOk = (e.deviceId && e.deviceId === deviceId) || (e.user && e.user === user);
            if (!subjectOk) return false;
            // O-04: politikaya özel muafiyet yalnızca aynı policyId ile eşleşir;
            // policyId:null yalnızca genel (policyId'siz) muafiyetleri kapsar.
            if (e.policyId !== null && e.policyId !== undefined) {
                if (!policyId || e.policyId !== policyId) return false;
            }
            const from = new Date(e.from).getTime();
            const to = new Date(e.to).getTime();
            return nowMs >= from && nowMs <= to;
        }) || null;
    }

    inMaintenanceWindow(nowMs = Date.now()) {
        return this.windows().some((w) => isInWindow(w, nowMs));
    }
}

module.exports = { ExemptionService, validateExemption, validateWindow, isInWindow };
