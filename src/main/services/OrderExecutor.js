/**
 * OrderExecutor.js - FAZ B (ajan tarafı).
 * Doğrulanmış + kuyruğa girmiş konsol emirlerini icra eder:
 *   apply-policy  → EnterprisePolicies.materializeToTask → TaskManager (tam boru hattı)
 *   revoke-policy → aynı policyId'li görevleri iptal et
 *   wake          → DeviceProfileService.sendWakeOnLan (notBefore dalgasına saygılı)
 *   güç eylemi    → 5sn gecikmeli konsol görevi (güvenlik+uyarı hattından geçer)
 * Her emir SONUÇLA ack'lenir (zehirli emir kuyruğu tıkamaz).
 */

const { materializeToTask } = require('./EnterprisePolicies');

const POWER_TO_TASK = new Set(['shutdown', 'restart', 'sleep', 'hibernate', 'lock', 'signout']);

class OrderExecutor {
    constructor({ taskManager = null, deviceService = null, audit = null, nowFn = null } = {}) {
        this.tasks = taskManager;
        this.devices = deviceService;
        this.audit = audit;
        this.nowFn = nowFn || (() => Date.now());
    }

    async executeRecord(record) {
        const order = record.order || {};
        const action = order.action;
        const params = order.params || {};
        // Y-10: crash sonrası aynı nonce yeniden işlenirse mevcut görev döner.
        if (order.nonce && this.tasks) {
            const existing = (this.tasks.tasks || []).find((t) => t && t.consoleOrderId === order.nonce);
            if (existing) {
                return { ok: true, code: 'duplicate', message: `Sipariş zaten işlendi: ${existing.id}` };
            }
        }
        try {
            if (action === 'apply-policy') {
                if (!this.tasks) throw new Error('TaskManager yok.');
                const taskData = materializeToTask(params.policy, { source: 'console' });
                const task = this.tasks.createTask({ ...taskData, consoleOrderId: order.nonce });
                return { ok: true, code: 'success', message: `Görev kuruldu: ${task.id}` };
            }
            if (action === 'revoke-policy') {
                if (!this.tasks) throw new Error('TaskManager yok.');
                const pid = params.policyId;
                const doomed = (this.tasks.tasks || []).filter((t) => t.policyId === pid);
                for (const t of doomed) {
                    try { this.tasks.cancelTask(t.id); } catch (_) { /* tekil hata durdurmaz */ }
                }
                return { ok: true, code: 'success', message: `${doomed.length} görev iptal edildi.` };
            }
            if (action === 'wake' || action === 'relay-wake') {
                if (!this.devices || typeof this.devices.sendWakeOnLan !== 'function') {
                    throw new Error('WoL servisi yok.');
                }
                if (params.notBefore && this.nowFn() < params.notBefore) {
                    return { ok: false, code: 'deferred', message: 'Dalga zamanı bekleniyor.' };
                }
                const r = await this.devices.sendWakeOnLan(params.mac, params.broadcastIp, params.port);
                if (this.audit) {
                    this.audit.append({
                        actor: action === 'relay-wake' ? 'relay' : 'console',
                        action: r && r.success ? 'wol_sent' : 'wol_failed',
                        target: params.finalTarget || null,
                        detail: `${params.mac} via ${params.broadcastIp}`
                    });
                }
                return r && r.success
                    ? { ok: true, code: 'success', message: 'WoL gönderildi.' }
                    : { ok: false, code: 'wol_failed', message: (r && r.error) || 'WoL başarısız.' };
            }
            if (POWER_TO_TASK.has(action)) {
                if (!this.tasks) throw new Error('TaskManager yok.');
                const task = this.tasks.createTask({
                    name: `Konsol emri (${action})`,
                    action,
                    source: 'console',
                    consoleOrderId: order.nonce,
                    // FAZ D: konsol bayrakları güvenlik motoruna taşınır (sunucu profili + bakım penceresi).
                    policyId: typeof params.policyId === 'string' ? params.policyId : null,
                    requiresMaintenanceWindow: params.requiresMaintenanceWindow === true,
                    warningConfig: { enabled: true, durationSeconds: 15, silentMode: false },
                    trigger: { type: 'duration', durationMs: 5000 }
                });
                return { ok: true, code: 'success', message: `Görev kuruldu: ${task.id}` };
            }
            return { ok: false, code: 'unknown_action', message: `Bilinmeyen emir: ${String(action)}` };
        } catch (err) {
            return { ok: false, code: (err && err.code) || 'executor_failed', message: (err && err.message) || 'İcra hatası.' };
        }
    }

    /**
     * Kuyruktaki bekleyenleri sırayla icra eder; deferred (dalga-bekleyen) hariç
     * hepsi ack'lenir. Dönen özet denetime yazılır.
     */
    async drain(queue) {
        const out = { executed: 0, failed: 0, deferred: 0 };
        for (const record of queue.pending()) {
            const r = await this.executeRecord(record);
            if (r.code === 'deferred') {
                out.deferred++;
                continue;
            }
            queue.ack(record.key, r);
            if (r.ok) out.executed++; else out.failed++;
            if (this.audit) {
                this.audit.append({
                    actor: 'console',
                    action: r.ok ? 'order_executed' : 'order_failed',
                    target: record.order && record.order.action,
                    detail: `${record.order && record.order.nonce}: ${r.message || r.code}`
                });
            }
        }
        if (typeof queue.purge === 'function') {
            try { queue.purge(this.nowFn()); } catch (_) { /* best-effort */ }
        }
        return out;
    }
}

module.exports = { OrderExecutor };
