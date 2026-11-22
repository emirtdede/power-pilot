/**
 * AuditLog.js - FAZ B + WP-11.T7
 * Değişmez (append-only) denetim günlüğü. İki uyumlu mod:
 * - HMAC zinciri (üretim): depo `appendAudit` + `verifyAuditChain` sunar ve
 *   SecretStore'dan gelen `auditHmacKey` hazırdır. Kayıt kendi HMAC alanı
 *   hariç kanonikleştirilip HMAC-SHA256 ile imzalanır; günlük checkpoint
 *   dosyası + Event Log özeti AuditCheckpoint tarafından yazılır.
 * - Legacy SHA-256 zinciri (anahtarsız gömülü/test kullanımı): eski davranış
 *   korunur; üretimde anahtar yoksa StorageService yeni audit yazımını
 *   fail-closed reddeder.
 */

const crypto = require('crypto');
const { redactText } = require('../security/Redact');

const MAX_RECORDS = 5000;

function hashOf(rec) {
    // L-07: rotasyon meta verisi de hash kapsamına girer.
    const slim = {
        seq: rec.seq,
        ts: rec.ts,
        actor: rec.actor,
        action: rec.action,
        target: rec.target,
        detail: rec.detail,
        prevHash: rec.prevHash,
        rotatedFrom: rec.rotatedFrom || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(slim), 'utf8').digest('hex');
}

function cleanInput({ actor = 'system', action = 'unknown', target = null, detail = '' } = {}) {
    return {
        actor: redactText(actor).slice(0, 128),
        action: String(action).slice(0, 64),
        target: target == null ? null : redactText(target).slice(0, 128),
        detail: redactText(detail).slice(0, 500)
    };
}

class AuditLog {
    constructor(storageService = null, { hmacKey = null } = {}) {
        this.storage = storageService;
        this.memory = [];
        this.hmacKey = hmacKey;
    }

    useHmac() {
        return !!(
            this.storage &&
            typeof this.storage.appendAudit === 'function' &&
            typeof this.storage.verifyAuditChain === 'function' &&
            (
                (typeof this.storage.hasAuditKey === 'function' && this.storage.hasAuditKey()) ||
                (this.hmacKey && this.hmacKey.length > 0)
            )
        );
    }

    load({ limit = null, beforeSeq = null } = {}) {
        if (this.storage && typeof this.storage.getAuditLog === 'function') {
            const list = this.storage.getAuditLog({ limit, beforeSeq });
            return Array.isArray(list) ? list : [];
        }
        let list = this.memory;
        if (Number.isFinite(beforeSeq)) list = list.filter((r) => r.seq < beforeSeq);
        if (Number.isFinite(limit) && limit > 0) list = list.slice(-limit);
        return list;
    }

    persist(list) {
        if (this.storage && typeof this.storage.saveAuditLog === 'function') {
            this.storage.saveAuditLog(list);
        } else {
            this.memory = list;
        }
    }

    append(input = {}) {
        const clean = cleanInput(input);
        if (this.useHmac()) {
            if (this.hmacKey && typeof this.storage.setAuditKey === 'function' && !this.storage.hasAuditKey()) {
                this.storage.setAuditKey(this.hmacKey);
            }
            return this.storage.appendAudit(clean);
        }
        const list = this.load();
        const prev = list.length > 0 ? list[list.length - 1] : null;
        const rec = {
            seq: prev ? prev.seq + 1 : 1,
            ts: new Date().toISOString(),
            ...clean,
            prevHash: prev ? prev.hash : 'GENESIS'
        };
        rec.hash = hashOf(rec);
        list.push(rec);
        let rotatedFrom = null;
        while (list.length > MAX_RECORDS) {
            const dropped = list.shift();
            rotatedFrom = dropped.hash;
        }
        if (rotatedFrom) {
            list[0].rotatedFrom = rotatedFrom;
            // L-07: rotatedFrom hash'e dahil; zincir bağlarını tutarlı tut.
            for (let i = 0; i < list.length; i++) {
                if (i > 0) list[i].prevHash = list[i - 1].hash;
                list[i].hash = hashOf(list[i]);
            }
        }
        this.persist(list);
        return rec;
    }

    /**
     * Zincir bütünlüğünü doğrular: hash'ler + prevHash bağları + sıra.
     */
    verify() {
        if (this.useHmac()) return this.storage.verifyAuditChain();
        const list = this.load();
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (rec.hash !== hashOf(rec)) {
                return { ok: false, code: 'TAMPERED', at: rec.seq, error: `${rec.seq}. kayıtta hash uyuşmazlığı.` };
            }
            if (i === 0) {
                if (rec.prevHash !== 'GENESIS' && !rec.rotatedFrom) {
                    return { ok: false, code: 'BROKEN_CHAIN', at: rec.seq, error: 'Zincir başı geçersiz.' };
                }
            } else if (rec.prevHash !== list[i - 1].hash) {
                return { ok: false, code: 'BROKEN_CHAIN', at: rec.seq, error: `${rec.seq}. kayıtta bağ kopuk.` };
            }
            if (i > 0 && rec.seq !== list[i - 1].seq + 1) {
                return { ok: false, code: 'BROKEN_CHAIN', at: rec.seq, error: 'Sıra numarası atlamalı.' };
            }
        }
        return { ok: true, records: list.length };
    }
}

module.exports = { AuditLog, MAX_RECORDS };
