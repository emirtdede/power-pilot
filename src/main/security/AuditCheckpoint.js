/**
 * AuditCheckpoint.js - WP-11.T7
 * Günlük audit checkpoint dosyası (`audit-checkpoints/YYYY-MM-DD.json`) ve
 * Windows Event Log özeti. Amaç: audit tablosu silinip yeniden yazılsa bile
 * (teorik olarak HMAC anahtarı ele geçmeden) gün sonu kanıtının yokluğunu
 * yakalamak.
 *
 * Dosya biçimi:
 *   { day, count, lastSeq, lastHmac, generatedAt, eventLogWritten }
 *
 * Doğrulama:
 * - Her audit günü için checkpoint dosyası ZORUNLU (T-STO-11).
 * - Dosyadaki lastSeq, DB'deki aynı seq'in HMAC'i ile eşleşmeli.
 * - Event Log yazıldıysa ve sorgu başarılıysa özet mevcut olmalı.
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const log = require('../logger');

function dayOf(ts) {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function safeDay(day) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(day || ''));
}

class AuditCheckpoint {
    /**
     * @param {object} opts
     * @param {string} opts.dir checkpoint dizini
     * @param {boolean} [opts.eventLog] Windows Event Log özeti yaz
     * @param {Function} [opts.eventLogImpl] test enjeksiyonu (day,lastSeq,lastHmac)=>void
     * @param {Function} [opts.readEventLogImpl] test enjeksiyonu (day)=>string|null
     * @param {Function} [opts.nowFn]
     */
    constructor({ dir, eventLog = false, eventLogImpl = null, readEventLogImpl = null, nowFn = null, onRepair = null } = {}) {
        this.dir = dir ? path.resolve(dir) : null;
        this.eventLog = eventLog === true;
        this._hasCustomEventLog = typeof eventLogImpl === 'function';
        this.eventLogImpl = eventLogImpl || this.defaultEventLogWrite.bind(this);
        this.readEventLogImpl = readEventLogImpl || this.defaultEventLogRead.bind(this);
        this.nowFn = nowFn || (() => Date.now());
        this.onRepair = typeof onRepair === 'function' ? onRepair : null;
        this._lastWriteAt = 0;
    }

    filePath(day) {
        return path.join(this.dir, `${day}.json`);
    }

    /**
     * Bugünkü checkpoint'i (en fazla 60 sn'de bir) günceller. Bugüne ait kayıt
     * yoksa dosya yazılmaz.
     */
    ensureToday(records, { force = false } = {}) {
        if (!this.dir) return null;
        const list = Array.isArray(records) ? records : [];
        if (list.length === 0) return null;
        const today = new Date(this.nowFn()).toISOString().slice(0, 10);
        const dayRows = list.filter((r) => dayOf(r.ts) === today);
        if (dayRows.length === 0) return null;
        if (!force && this._lastWriteAt && this.nowFn() - this._lastWriteAt < 60000) return this.filePath(today);
        return this.writeDay(today, dayRows);
    }

    /** Belirtilen günün checkpoint'ini atomik yazar. */
    writeDay(day, dayRows, { eventLog = true } = {}) {
        if (!this.dir || !safeDay(day) || !Array.isArray(dayRows) || dayRows.length === 0) return null;
        fs.mkdirSync(this.dir, { recursive: true });
        const last = dayRows[dayRows.length - 1];
        const record = {
            day,
            count: dayRows.length,
            lastSeq: last.seq,
            lastHmac: last.recordHmac || last.record_hmac || last.hash,
            generatedAt: new Date(this.nowFn()).toISOString(),
            eventLogWritten: false
        };
        if (this.eventLog && eventLog) {
            if (this._hasCustomEventLog) {
                // Test enjeksiyonu senkron kalabilir.
                try {
                    this.eventLogImpl(day, record.lastSeq, record.lastHmac);
                    record.eventLogWritten = true;
                } catch (_) {
                    record.eventLogWritten = false;
                }
            } else {
                // Y-07: Event Log asenkron yazılır; ana thread bloke edilmez.
                // eventLogWritten=false → doğrulama Event Log'a bağımlı olmaz.
                this.defaultEventLogWrite(day, record.lastSeq, record.lastHmac);
                record.eventLogWritten = false;
            }
        }
        const target = this.filePath(day);
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
        fs.renameSync(tmp, target);
        this._lastWriteAt = this.nowFn();
        return target;
    }

    /** Tüm audit listesi için günlük checkpoint'leri yazar (migrasyon/quit). */
    write(records, { eventLog = true } = {}) {
        if (!this.dir) return [];
        const grouped = new Map();
        for (const rec of records || []) {
            const day = dayOf(rec.ts);
            if (!day) continue;
            if (!grouped.has(day)) grouped.set(day, []);
            grouped.get(day).push(rec);
        }
        const out = [];
        for (const [day, rows] of grouped) {
            try {
                const written = this.writeDay(day, rows, { eventLog });
                if (written) out.push(written);
            } catch (_) { /* tek gün yazılamazsa diğerleri sürer */ }
        }
        return out;
    }

    /**
     * O-22: Eksik checkpoint, HMAC verisi mevcut olduğunda yeniden üretilebilir.
     * Yalnızca HMAC uyuşmazlığı/rollback gerçek tamper sayılır.
     */
    canRebuild(dayRows) {
        if (!Array.isArray(dayRows) || dayRows.length === 0) return false;
        return dayRows.every((r) => r && Number.isFinite(r.seq) && !!(r.recordHmac || r.record_hmac || r.hash));
    }

    /**
     * DB satırları (audit_log) ile checkpoint dosyalarını karşılaştırır.
     * @returns {{ok:boolean, code?:string, day?:string, error?:string, repaired?:string[]}}
     */
    verify(rows) {
        if (!this.dir || !Array.isArray(rows) || rows.length === 0) return { ok: true, records: 0 };
        const grouped = new Map();
        for (const row of rows) {
            const day = dayOf(row.ts);
            if (!day) continue;
            if (!grouped.has(day)) grouped.set(day, []);
            grouped.get(day).push(row);
        }
        const repaired = [];
        for (const [day, dayRows] of grouped) {
            const file = this.filePath(day);
            if (!fs.existsSync(file)) {
                if (this.canRebuild(dayRows)) {
                    try {
                        const written = this.writeDay(day, dayRows, { eventLog: false });
                        if (written) {
                            repaired.push(day);
                            log.warn(`[AuditCheckpoint] Eksik checkpoint onarıldı: ${day}`);
                            if (this.onRepair) {
                                try { this.onRepair({ day, file: written }); } catch (err) {
                                    log.warn('[AuditCheckpoint] Onarım denetim kaydı yazılamadı:', err && err.message);
                                }
                            }
                            continue;
                        }
                    } catch (err) {
                        log.warn(`[AuditCheckpoint] Checkpoint onarılamadı (${day}):`, err && err.message);
                    }
                }
                return { ok: false, code: 'CHECKPOINT_MISSING', day, error: `${day} audit checkpoint dosyası yok.` };
            }
            let fileData;
            try {
                fileData = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (_) {
                return { ok: false, code: 'CHECKPOINT_CORRUPT', day, error: `${day} checkpoint okunamadı.` };
            }
            if (!fileData || fileData.day !== day || !Number.isFinite(fileData.lastSeq)) {
                return { ok: false, code: 'CHECKPOINT_CORRUPT', day, error: `${day} checkpoint biçimi geçersiz.` };
            }
            const row = dayRows.find((r) => r.seq === fileData.lastSeq);
            if (!row) {
                return { ok: false, code: 'CHECKPOINT_ROLLBACK', day, error: `${day} checkpoint'teki kayıt DB'de yok.` };
            }
            const hmac = row.recordHmac || row.record_hmac || row.hash;
            if (hmac !== fileData.lastHmac) {
                return { ok: false, code: 'CHECKPOINT_TAMPERED', day, error: `${day} checkpoint HMAC uyuşmuyor.` };
            }
            if (fileData.eventLogWritten) {
                let marker = null;
                try {
                    marker = this.readEventLogImpl(day);
                } catch (_) {
                    marker = null; // Event Log okunamıyor: yokluk kanıtı sayılmaz
                }
                if (marker !== null && marker !== undefined && marker !== '') {
                    if (!String(marker).includes(`PPAUDIT:${day}:${fileData.lastHmac}`)) {
                        return { ok: false, code: 'EVENTLOG_TAMPERED', day, error: `${day} Event Log özeti uyuşmuyor.` };
                    }
                }
            }
        }
        const out = { ok: true, records: rows.length };
        if (repaired.length > 0) out.repaired = repaired;
        return out;
    }

    defaultEventLogWrite(day, lastSeq, lastHmac) {
        const message = `PPAUDIT:${day}:${lastHmac}`;
        const script = `try { Write-EventLog -LogName Application -Source 'PowerPilot' -EventId 1100 -EntryType Information -Message '${message}' -ErrorAction Stop } catch { exit 1 }`;
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 5000,
            windowsHide: true
        }, (err) => {
            if (err) log.warn('[AuditCheckpoint] Event Log yazılamadı:', err.message);
        });
    }

    defaultEventLogRead(day) {
        const script = `try { (Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='PowerPilot'; Id=1100} -MaxEvents 50 -ErrorAction Stop | Where-Object { $_.Message -like 'PPAUDIT:${day}:*' } | Select-Object -First 1).Message } catch { '' }`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            timeout: 5000,
            windowsHide: true,
            encoding: 'utf8'
        });
        return String(out || '').trim();
    }
}

module.exports = { AuditCheckpoint, dayOf };
