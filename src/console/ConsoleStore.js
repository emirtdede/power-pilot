/**
 * ConsoleStore.js - WP-03.T1/T2/T3/T4/T7/T8
 * Şirket konsolunun SQLite deposu (`console.db`). Tek dosya yazımı yoktur;
 * heartbeat tek transaction'da ajan upsert + due select + delivered_at + audit
 * yapar. Kuyruk durum makinesi: pending → inflight → acked/expired.
 *
 * `storePath` yoksa (birim testi/gömülü kullanım) bellek modu kullanılır;
 * böylece konsol sunucusu aynı davranışı DB olmadan da korur. Üretimde
 * (`src/console/run.js`) her zaman SQLite açılır.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Db, StorageError, sha256 } = require('../main/storage/Database');

const CONSOLE_SCHEMA_PATH = path.join(__dirname, 'console-schema.sql');
const LEGACY_NAME = 'console-store.json';
const QUEUE_STATES = ['pending', 'inflight', 'acked', 'expired'];

function nowIso() {
    return new Date().toISOString();
}

function hashOf(rec) {
    const slim = { seq: rec.seq, ts: rec.ts, actor: rec.actor, action: rec.action, target: rec.target, detail: rec.detail, prevHash: rec.prevHash };
    return crypto.createHash('sha256').update(JSON.stringify(slim), 'utf8').digest('hex');
}

// Tek kaynak: src/main/util/stableStringify.js (ConsoleStore + MigrateV2 ortak).
const { stableStringify } = require('../main/util/stableStringify');

function defaultStore() {
    return {
        agents: {},
        queues: {},
        policies: [],
        audit: [],
        keypair: null,
        disabledAgents: [],
        agentKeys: []
    };
}

function sanitizeLegacy(store) {
    const copy = JSON.parse(JSON.stringify(store || {}));
    if (copy.keypair && typeof copy.keypair === 'object') delete copy.keypair.privateKey;
    return copy;
}

class ConsoleStore {
    /**
     * @param {object} opts
     * @param {string|null} [opts.storePath] eski JSON yolu (migrasyon kaynağı)
     * @param {string|null} [opts.dbPath] SQLite yolu; storePath'ten türetilir
     * @param {number} [opts.maxOrders]
     * @param {Function} [opts.nowFn]
     */
    constructor({ storePath = null, dbPath = null, maxOrders = 200, nowFn = null } = {}) {
        this.storePath = storePath ? path.resolve(storePath) : null;
        this.dbPath = dbPath
            ? path.resolve(dbPath)
            : (this.storePath
                ? (this.storePath.toLowerCase().endsWith('.db')
                    ? this.storePath
                    : path.join(path.dirname(this.storePath), 'console.db'))
                : null);
        this.maxOrders = maxOrders;
        this.nowFn = nowFn || (() => Date.now());
        this.db = null;
        this.memory = defaultStore();
        this.maintenanceMode = false;
        this.maintenanceReason = null;
        this.legacyPrivateKey = null;
        this._stmts = new Map();
        if (this.dbPath) this.init();
    }

    get enabled() {
        return !!this.db;
    }

    init() {
        try {
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
            this._cleanTemps();
            if (fs.existsSync(this.dbPath)) {
                this.db = new Db(this.dbPath, { fileMustExist: true });
                if (this.db.quickCheck() !== 'ok') {
                    this.db.close();
                    this.db = null;
                    this.enterMaintenance('Konsol veritabanı bozuk (quick_check). Yedekten geri yükleyin.');
                    return;
                }
                // O-08: mevcut DB'lere yeni indeksleri uygula (CREATE IF NOT EXISTS).
                try { this.db.sql(this._schemaSql()); } catch (_) { /* indeks hatası açılışı engellemez */ }
                return;
            }
            if (this.storePath && fs.existsSync(this.storePath)) {
                this.migrateLegacy();
                return;
            }
            this.db = new Db(this.dbPath);
            this.db.sql(this._schemaSql());
            this.db.write(() => {
                this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', '1');
                this.db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('created_at', nowIso());
            });
        } catch (err) {
            this.enterMaintenance(`Konsol deposu açılamadı: ${err.message}`, err);
        }
    }

    _schemaSql() {
        return fs.readFileSync(CONSOLE_SCHEMA_PATH, 'utf8');
    }

    _cleanTemps() {
        try {
            const dir = path.dirname(this.dbPath);
            const base = path.basename(this.dbPath);
            for (const entry of fs.readdirSync(dir)) {
                if (entry.startsWith(`${base}.migrating-`)) {
                    try { fs.rmSync(path.join(dir, entry), { force: true }); } catch (_) { /* yut */ }
                }
            }
        } catch (_) { /* yut */ }
    }

    enterMaintenance(reason, err = null) {
        this.maintenanceMode = true;
        this.maintenanceReason = reason;
        if (err) logFallback(reason, err);
        else logFallback(reason);
    }

    migrateLegacy() {
        const source = this.storePath;
        let raw;
        try {
            raw = fs.readFileSync(source, 'utf8');
        } catch (err) {
            this.enterMaintenance(`Konsol JSON okunamadı: ${err.message}`);
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('kök nesne değil');
        } catch (err) {
            // T-CON-01: bozuk dosya üzerine yazılmaz; kanıt için yedek alınır.
            try {
                const backupDir = path.join(path.dirname(source), 'backups');
                fs.mkdirSync(backupDir, { recursive: true });
                const stamp = nowIso().replace(/[:.]/g, '-');
                fs.copyFileSync(source, path.join(backupDir, `console-store_corrupted_${stamp}.json`));
            } catch (_) { /* yedek alınamasa da üzerine yazma yok */ }
            this.enterMaintenance(`Konsol JSON parse hatası: ${err.message}; dosya üzerine yazılmadı.`);
            return;
        }
        const data = { ...defaultStore(), ...parsed };
        const backupDir = path.join(path.dirname(source), 'backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const stamp = nowIso().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `console-store_pre_v3_${stamp}.json`);
        fs.copyFileSync(source, backupPath);
        const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');

        // Eski dosyada eksik/tekrarlı kayıtlar olabilir; yazıcı ile sayımı
        // aynı süzgeçten geçir (migrasyon yanlış pozitif vermesin).
        const disabled = new Set((data.disabledAgents || []).filter((id) => typeof id === 'string' && id));
        const agentIds = new Set([
            ...Object.keys(data.agents || {}).filter((id) => typeof id === 'string' && id),
            ...disabled
        ]);
        const queued = [];
        const seenNonces = new Set();
        for (const [agentId, list] of Object.entries(data.queues || {})) {
            for (const signed of Array.isArray(list) ? list : []) {
                const order = (signed && signed.order) || {};
                if (!order.nonce || seenNonces.has(order.nonce)) continue;
                seenNonces.add(order.nonce);
                queued.push([agentId, signed]);
            }
        }
        const policies = (data.policies || []).filter((p) => p && p.id);
        const keyRows = (data.agentKeys || []).filter((k) => k && k.hash);
        const auditRows = [];
        const seenSeq = new Set();
        (data.audit || []).forEach((rec, i) => {
            if (!rec || typeof rec !== 'object') return;
            const seq = Number.isFinite(rec.seq) ? rec.seq : i + 1;
            if (seenSeq.has(seq)) return;
            seenSeq.add(seq);
            auditRows.push({ ...rec, seq });
        });

        const tmpPath = `${this.dbPath}.migrating-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        let tmp = null;
        try {
            tmp = new Db(tmpPath);
            tmp.sql(this._schemaSql());
            const expected = {
                agents: agentIds.size,
                queues: queued.length,
                policies: policies.length,
                audit: auditRows.length,
                keys: keyRows.length,
                disabled: disabled.size
            };
            tmp.write(() => {
                const now = nowIso();
                const insMeta = tmp.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
                insMeta.run('schema_version', '1');
                insMeta.run('created_at', data.createdAt || now);
                insMeta.run('migrated_from', 'console-json-v2');
                insMeta.run('source_sha256', sourceSha);
                insMeta.run('content_checksum', sha256(stableStringify(sanitizeLegacy(data))));
                if (data.keypair && data.keypair.publicKey) insMeta.run('keypair_public', String(data.keypair.publicKey));
                const insAgent = tmp.prepare('INSERT OR REPLACE INTO agents(agent_id, inventory, last_heartbeat_at, disabled) VALUES (?, ?, ?, ?)');
                for (const id of agentIds) {
                    const agent = (data.agents || {})[id];
                    insAgent.run(id, JSON.stringify((agent && agent.inventory) || null), (agent && agent.lastHeartbeatAt) || now, disabled.has(id) ? 1 : 0);
                }
                const insQueue = tmp.prepare('INSERT OR IGNORE INTO queues(nonce, agent_id, state, signed, expires_at, delivered_at, acked_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
                for (const [agentId, signed] of queued) {
                    const order = (signed && signed.order) || {};
                    insQueue.run(order.nonce, agentId, 'pending', JSON.stringify(signed), Number.isFinite(order.expiresAt) ? order.expiresAt : nowIsoMs(this.nowFn()), null, null, 0, now);
                }
                const insPolicy = tmp.prepare('INSERT OR REPLACE INTO policies(id, type, data, dispatched_at) VALUES (?, ?, ?, ?)');
                for (const pol of policies) {
                    insPolicy.run(pol.id, pol.type || null, JSON.stringify(pol), pol.dispatchedAt || now);
                }
                const insAudit = tmp.prepare('INSERT OR REPLACE INTO audit(seq, ts, actor, action, target, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
                auditRows.forEach((rec) => {
                    insAudit.run(rec.seq, rec.ts || now, rec.actor || 'console', rec.action || 'unknown', rec.target === undefined ? null : rec.target, rec.detail === undefined ? null : rec.detail, rec.prevHash || 'GENESIS', rec.hash || '');
                });
                const insKey = tmp.prepare('INSERT OR REPLACE INTO keys(hash, role, key_id, agent_id, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?)');
                for (const k of keyRows) {
                    insKey.run(k.hash, k.role || 'agent', k.keyId || null, k.agentId || null, Number.isFinite(k.notAfter) ? k.notAfter : null, k.createdAt || now);
                }
                tmp.prepare('INSERT OR REPLACE INTO migrations(id, applied_at, detail) VALUES (?, ?, ?)')
                    .run('console-json-to-v3', now, JSON.stringify({ counts: expected, sha256: sourceSha }));
            });
            const actual = {
                agents: tmp.prepare('SELECT COUNT(*) AS n FROM agents').get().n,
                queues: tmp.prepare('SELECT COUNT(*) AS n FROM queues').get().n,
                policies: tmp.prepare('SELECT COUNT(*) AS n FROM policies').get().n,
                audit: tmp.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
                keys: tmp.prepare('SELECT COUNT(*) AS n FROM keys').get().n,
                disabled: tmp.prepare('SELECT COUNT(*) AS n FROM agents WHERE disabled = 1').get().n
            };
            for (const key of Object.keys(expected)) {
                if (actual[key] !== expected[key]) {
                    throw new StorageError(`Konsol migrasyon sayım uyuşmazlığı (${key}).`, 'MIGRATION_COUNT_MISMATCH');
                }
            }
            const checksum = tmp.prepare('SELECT value FROM meta WHERE key = ?').get('content_checksum');
            if (!checksum || checksum.value !== sha256(stableStringify(sanitizeLegacy(data)))) {
                throw new StorageError('Konsol migrasyon checksum uyuşmazlığı.', 'MIGRATION_CHECKSUM_MISMATCH');
            }
            if (tmp.quickCheck() !== 'ok') throw new StorageError('Konsol DB quick_check başarısız.', 'MIGRATION_DB_CORRUPT');
            tmp.close();
            tmp = null;
            if (fs.existsSync(this.dbPath)) {
                try { fs.rmSync(tmpPath, { force: true }); } catch (_) { /* yut */ }
            } else {
                fs.renameSync(tmpPath, this.dbPath);
            }
            this.legacyPrivateKey = data.keypair && typeof data.keypair.privateKey === 'string'
                ? data.keypair.privateKey
                : null;
            try {
                fs.writeFileSync(`${source}.migrated`, JSON.stringify(sanitizeLegacy(data), null, 2), { encoding: 'utf8', mode: 0o600 });
                fs.unlinkSync(source);
            } catch (_) { /* kilit: DB kullanılabilir */ }
            this.db = new Db(this.dbPath, { fileMustExist: true });
        } catch (err) {
            if (tmp) { try { tmp.close(); } catch (_) {} }
            try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
            this.enterMaintenance(`Konsol migrasyonu başarısız: ${err.message}`, err);
        }
    }

    _prepare(sql) {
        let stmt = this._stmts.get(sql);
        if (!stmt) {
            stmt = this.db.prepare(sql);
            this._stmts.set(sql, stmt);
        }
        return stmt;
    }

    // --- ajanlar -----------------------------------------------------------

    upsertAgent(agentId, inventory, at = nowIso()) {
        if (!this.db) {
            this.memory.agents[agentId] = { agentId, inventory: inventory || null, lastHeartbeatAt: at };
            return this.memory.agents[agentId];
        }
        this._prepare('INSERT INTO agents(agent_id, inventory, last_heartbeat_at, disabled) VALUES (?, ?, ?, 0) ON CONFLICT(agent_id) DO UPDATE SET inventory = excluded.inventory, last_heartbeat_at = excluded.last_heartbeat_at')
            .run(agentId, JSON.stringify(inventory || null), at);
        return { agentId, inventory: inventory || null, lastHeartbeatAt: at };
    }

    getAgent(agentId) {
        if (!this.db) return this.memory.agents[agentId] || null;
        const row = this._prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
        if (!row) return null;
        return { agentId: row.agent_id, inventory: safeParse(row.inventory), lastHeartbeatAt: row.last_heartbeat_at, disabled: row.disabled === 1 };
    }

    listAgents() {
        if (!this.db) {
            return Object.values(this.memory.agents).map((a) => ({
                ...a,
                disabled: this.memory.disabledAgents.includes(a.agentId)
            }));
        }
        return this._prepare('SELECT * FROM agents ORDER BY agent_id ASC').all().map((row) => ({
            agentId: row.agent_id,
            inventory: safeParse(row.inventory),
            lastHeartbeatAt: row.last_heartbeat_at,
            disabled: row.disabled === 1
        }));
    }

    setDisabled(agentId, disabled) {
        if (!this.db) {
            const set = new Set(this.memory.disabledAgents);
            if (disabled) set.add(agentId); else set.delete(agentId);
            this.memory.disabledAgents = [...set];
            return this.memory.disabledAgents;
        }
        this._prepare('INSERT INTO agents(agent_id, inventory, last_heartbeat_at, disabled) VALUES (?, NULL, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET disabled = excluded.disabled')
            .run(agentId, nowIso(), disabled ? 1 : 0);
        return this.listDisabled();
    }

    listDisabled() {
        if (!this.db) return [...this.memory.disabledAgents];
        return this._prepare('SELECT agent_id FROM agents WHERE disabled = 1 ORDER BY agent_id ASC').all().map((r) => r.agent_id);
    }

    // --- kuyruk ------------------------------------------------------------

    _activeCount(agentId) {
        if (!this.db) {
            const list = this.memory.queues[agentId] || [];
            return list.filter((s) => s._state !== 'acked' && s._state !== 'expired').length;
        }
        return this._prepare("SELECT COUNT(*) AS n FROM queues WHERE agent_id = ? AND state IN ('pending','inflight')").get(agentId).n;
    }

    enqueue(agentId, signed) {
        const order = signed && signed.order;
        if (!order || !order.nonce) throw Object.assign(new Error('Geçersiz emir.'), { code: 'INVALID_ORDER' });
        if (this._activeCount(agentId) >= this.maxOrders) {
            throw Object.assign(new Error(`Ajan kuyruğu dolu: ${agentId}.`), { code: 'QUEUE_FULL' });
        }
        if (!this.db) {
            const list = this.memory.queues[agentId] || (this.memory.queues[agentId] = []);
            if (list.some((s) => s.order && s.order.nonce === order.nonce)) return { duplicate: true };
            list.push({ ...signed, _state: 'pending', _deliveredAt: null, _attempts: 0, _queuedAt: nowIso(), _expiresAt: order.expiresAt });
            return { duplicate: false };
        }
        const res = this._prepare('INSERT OR IGNORE INTO queues(nonce, agent_id, state, signed, expires_at, delivered_at, acked_at, attempts, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?)')
            .run(order.nonce, agentId, 'pending', JSON.stringify(signed), Number.isFinite(order.expiresAt) ? order.expiresAt : nowIsoMs(this.nowFn()), nowIso());
        return { duplicate: res.changes === 0 };
    }

    /** WP-03.T3/T7: teslim eder, SİLMEZ; makbuz/süre bitirir. */
    dueOrders(agentId, nowMs = this.nowFn()) {
        if (!this.db) {
            const list = this.memory.queues[agentId] || [];
            const due = [];
            for (const signed of list) {
                if (signed._state === 'acked' || signed._state === 'expired') continue;
                const expires = Number.isFinite(signed._expiresAt) ? signed._expiresAt : (signed.order && signed.order.expiresAt);
                if (Number.isFinite(expires) && expires <= nowMs) {
                    signed._state = 'expired';
                    continue;
                }
                signed._state = 'inflight';
                signed._deliveredAt = new Date(nowMs).toISOString();
                signed._attempts = (signed._attempts || 0) + 1;
                due.push(signed);
            }
            return due;
        }
        this._prepare("UPDATE queues SET state = 'expired' WHERE agent_id = ? AND state IN ('pending','inflight') AND expires_at <= ?")
            .run(agentId, nowMs);
        const rows = this._prepare("SELECT * FROM queues WHERE agent_id = ? AND state IN ('pending','inflight') AND expires_at > ? ORDER BY created_at ASC, rowid ASC")
            .all(agentId, nowMs);
        const deliveredAt = new Date(nowMs).toISOString();
        const mark = this._prepare("UPDATE queues SET state = 'inflight', delivered_at = ?, attempts = attempts + 1 WHERE nonce = ?");
        for (const row of rows) mark.run(deliveredAt, row.nonce);
        return rows.map((row) => safeParse(row.signed));
    }

    ackReceipt(agentId, nonce, code = 'unknown', message = '') {
        if (typeof nonce !== 'string' || !nonce) return { ok: false, code: 'INVALID_NONCE' };
        if (!this.db) {
            const list = this.memory.queues[agentId] || [];
            const signed = list.find((s) => s.order && s.order.nonce === nonce);
            if (!signed) return { ok: false, code: 'NOT_FOUND' };
            const duplicate = signed._state === 'acked';
            signed._state = 'acked';
            signed._ackedAt = nowIso();
            signed._receipt = { code: String(code || 'unknown').slice(0, 40), message: String(message || '').slice(0, 200) };
            return { ok: true, duplicate };
        }
        let duplicate = false;
        let found = false;
        this.db.write(() => {
            const row = this._prepare('SELECT nonce FROM queues WHERE nonce = ? AND agent_id = ?').get(nonce, agentId);
            if (!row) return;
            found = true;
            const res = this._prepare('INSERT OR IGNORE INTO receipts(nonce, agent_id, code, message, received_at) VALUES (?, ?, ?, ?, ?)')
                .run(nonce, agentId, String(code || 'unknown').slice(0, 40), String(message || '').slice(0, 200), nowIso());
            duplicate = res.changes === 0;
            this._prepare("UPDATE queues SET state = 'acked', acked_at = ? WHERE nonce = ? AND agent_id = ?")
                .run(nowIso(), nonce, agentId);
        });
        if (!found) return { ok: false, code: 'NOT_FOUND' };
        return { ok: true, duplicate };
    }

    /** WP-03.T7: ajan upsert + makbuz + due select + delivered_at + audit tek transaction. */
    heartbeat(agentId, inventory, receipts = [], { disabled = false } = {}) {
        const now = this.nowFn();
        if (!this.db) {
            const agent = this.upsertAgent(agentId, inventory, new Date(now).toISOString());
            const results = [];
            for (const r of receipts || []) {
                const ack = this.ackReceipt(agentId, r && r.nonce, r && r.code, r && r.message);
                if (ack.ok && !ack.duplicate) this.addAudit({ actor: agentId, action: 'order_receipt', target: r.nonce, detail: r.code || '' });
                results.push(ack);
            }
            const due = disabled ? [] : this.dueOrders(agentId, now);
            if (!disabled) {
                for (const signed of due) {
                    this.addAudit({ actor: 'console', action: 'order_delivered', target: (signed.order && signed.order.action) || null, detail: (signed.order && signed.order.nonce) || '' });
                }
            }
            return { serverTime: new Date(now).toISOString(), orders: due, disabled, agent, receipts: results };
        }
        let due = [];
        let results = [];
        this.db.write(() => {
            const ts = new Date(now).toISOString();
            this._prepare('INSERT INTO agents(agent_id, inventory, last_heartbeat_at, disabled) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET inventory = excluded.inventory, last_heartbeat_at = excluded.last_heartbeat_at')
                .run(agentId, JSON.stringify(inventory || null), ts, disabled ? 1 : 0);
            for (const r of receipts || []) {
                const nonce = r && r.nonce;
                if (typeof nonce !== 'string' || !nonce) continue;
                const exists = this._prepare('SELECT nonce FROM queues WHERE nonce = ? AND agent_id = ?').get(nonce, agentId);
                if (!exists) {
                    results.push({ ok: false, nonce, code: 'NOT_FOUND' });
                    continue;
                }
                const res = this._prepare('INSERT OR IGNORE INTO receipts(nonce, agent_id, code, message, received_at) VALUES (?, ?, ?, ?, ?)')
                    .run(nonce, agentId, String((r && r.code) || 'unknown').slice(0, 40), String((r && r.message) || '').slice(0, 200), ts);
                const duplicate = res.changes === 0;
                this._prepare("UPDATE queues SET state = 'acked', acked_at = ? WHERE nonce = ? AND agent_id = ?")
                    .run(ts, nonce, agentId);
                results.push({ ok: true, nonce, duplicate });
                if (!duplicate) this._auditTx(agentId, 'order_receipt', nonce, (r && r.code) || '', ts);
            }
            this._prepare("UPDATE queues SET state = 'expired' WHERE agent_id = ? AND state IN ('pending','inflight') AND expires_at <= ?")
                .run(agentId, now);
            if (!disabled) {
                const rows = this._prepare("SELECT * FROM queues WHERE agent_id = ? AND state IN ('pending','inflight') AND expires_at > ? ORDER BY created_at ASC, rowid ASC")
                    .all(agentId, now);
                const mark = this._prepare("UPDATE queues SET state = 'inflight', delivered_at = ?, attempts = attempts + 1 WHERE nonce = ?");
                for (const row of rows) {
                    mark.run(ts, row.nonce);
                    const signed = safeParse(row.signed);
                    due.push(signed);
                    this._auditTx('console', 'order_delivered', (signed.order && signed.order.action) || null, (signed.order && signed.order.nonce) || '', ts);
                }
            }
        });
        return {
            serverTime: new Date(now).toISOString(),
            orders: due,
            disabled,
            agent: { agentId, inventory: inventory || null, lastHeartbeatAt: new Date(now).toISOString() },
            receipts: results
        };
    }

    counts(agentId = null) {
        const out = { pending: 0, inflight: 0, acked: 0, expired: 0 };
        if (!this.db) {
            const lists = agentId ? [this.memory.queues[agentId] || []] : Object.values(this.memory.queues);
            for (const list of lists) {
                for (const s of list) {
                    const state = s._state || 'pending';
                    if (out[state] !== undefined) out[state] += 1;
                }
            }
            return out;
        }
        const rows = agentId
            ? this._prepare('SELECT state, COUNT(*) AS n FROM queues WHERE agent_id = ? GROUP BY state').all(agentId)
            : this._prepare('SELECT state, COUNT(*) AS n FROM queues GROUP BY state').all();
        for (const row of rows) if (out[row.state] !== undefined) out[row.state] = row.n;
        return out;
    }

    /**
     * WP-03.T5: operasyonel görünürlük - emir geçmişi + hata nedeni.
     * Bellek modunda kuyruk nesnelerinden, DB modunda receipts JOIN'i ile.
     */
    orders({ limit = 200, agentId = null } = {}) {
        const max = Math.max(1, Math.min(1000, Number(limit) || 200));
        if (!this.db) {
            const out = [];
            const lists = agentId ? [[agentId, this.memory.queues[agentId] || []]] : Object.entries(this.memory.queues);
            for (const [id, list] of lists) {
                for (const s of list) {
                    out.push({
                        agentId: id,
                        nonce: (s.order && s.order.nonce) || null,
                        action: (s.order && s.order.action) || null,
                        state: s._state || 'pending',
                        expiresAt: s._expiresAt || (s.order && s.order.expiresAt) || null,
                        deliveredAt: s._deliveredAt || null,
                        ackedAt: s._ackedAt || null,
                        attempts: s._attempts || 0,
                        code: (s._receipt && s._receipt.code) || null,
                        message: (s._receipt && s._receipt.message) || null
                    });
                }
            }
            return out.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0)).slice(0, max);
        }
        const rows = agentId
            ? this._prepare(`SELECT q.*, r.code AS receipt_code, r.message AS receipt_message FROM queues q LEFT JOIN receipts r ON r.nonce = q.nonce AND r.agent_id = q.agent_id WHERE q.agent_id = ? ORDER BY q.created_at DESC, q.rowid DESC LIMIT ?`).all(agentId, max)
            : this._prepare(`SELECT q.*, r.code AS receipt_code, r.message AS receipt_message FROM queues q LEFT JOIN receipts r ON r.nonce = q.nonce AND r.agent_id = q.agent_id ORDER BY q.created_at DESC, q.rowid DESC LIMIT ?`).all(max);
        return rows.map((row) => {
            const signed = safeParse(row.signed) || {};
            const order = signed.order || {};
            return {
                agentId: row.agent_id,
                nonce: row.nonce,
                action: order.action || null,
                state: row.state,
                expiresAt: row.expires_at,
                deliveredAt: row.delivered_at,
                ackedAt: row.acked_at,
                attempts: row.attempts,
                code: row.receipt_code || null,
                message: row.receipt_message || null
            };
        });
    }

    // --- politika / audit / anahtarlar ------------------------------------

    savePolicy(policy) {
        if (!this.db) {
            this.memory.policies = this.memory.policies.filter((p) => p.id !== policy.id);
            this.memory.policies.push(policy);
            return policy;
        }
        this._prepare('INSERT OR REPLACE INTO policies(id, type, data, dispatched_at) VALUES (?, ?, ?, ?)')
            .run(policy.id, policy.type || null, JSON.stringify(policy), policy.dispatchedAt || nowIso());
        return policy;
    }

    listPolicies() {
        if (!this.db) return this.memory.policies;
        return this._prepare('SELECT data FROM policies ORDER BY dispatched_at ASC').all().map((r) => safeParse(r.data));
    }

    deletePolicy(id) {
        if (!this.db) {
            this.memory.policies = this.memory.policies.filter((p) => p.id !== id);
            return true;
        }
        this._prepare('DELETE FROM policies WHERE id = ?').run(id);
        return true;
    }

    addAudit({ actor = 'console', action = 'unknown', target = null, detail = '' } = {}) {
        if (!this.db) {
            const list = this.memory.audit;
            const prev = list.length > 0 ? list[list.length - 1] : null;
            const rec = {
                seq: prev ? prev.seq + 1 : 1,
                ts: nowIso(),
                actor: String(actor).slice(0, 128),
                action: String(action).slice(0, 64),
                target: target == null ? null : String(target).slice(0, 128),
                detail: String(detail || '').slice(0, 500),
                prevHash: prev ? prev.hash : 'GENESIS'
            };
            rec.hash = hashOf(rec);
            list.push(rec);
            return rec;
        }
        let rec = null;
        this.db.write(() => {
            rec = this._auditTx(actor, action, target, detail, nowIso());
        });
        return rec;
    }

    _auditTx(actor, action, target, detail, ts = nowIso()) {
        const last = this._prepare('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').get();
        const seq = last ? last.seq + 1 : 1;
        const prev = last ? last.hash : 'GENESIS';
        const rec = {
            seq,
            ts,
            actor: String(actor == null ? 'console' : actor).slice(0, 128),
            action: String(action == null ? 'unknown' : action).slice(0, 64),
            target: target == null ? null : String(target).slice(0, 128),
            detail: String(detail == null ? '' : detail).slice(0, 500),
            prevHash: prev
        };
        rec.hash = hashOf(rec);
        this._prepare('INSERT INTO audit(seq, ts, actor, action, target, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(rec.seq, rec.ts, rec.actor, rec.action, rec.target, rec.detail, rec.prevHash, rec.hash);
        return rec;
    }

    listAudit({ limit = null, beforeSeq = null } = {}) {
        const mapRow = (r) => ({
            seq: r.seq,
            ts: r.ts,
            actor: r.actor,
            action: r.action,
            target: r.target,
            detail: r.detail,
            prevHash: r.prev_hash,
            hash: r.hash
        });
        if (!this.db) {
            let list = this.memory.audit;
            if (Number.isFinite(beforeSeq)) list = list.filter((r) => r.seq < beforeSeq);
            if (Number.isFinite(limit) && limit > 0) list = list.slice(-limit);
            return list;
        }
        if (Number.isFinite(limit) && limit > 0) {
            const rows = Number.isFinite(beforeSeq)
                ? this._prepare('SELECT * FROM audit WHERE seq < ? ORDER BY seq DESC LIMIT ?').all(beforeSeq, limit)
                : this._prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit);
            return rows.reverse().map(mapRow);
        }
        return this._prepare('SELECT * FROM audit ORDER BY seq ASC').all().map(mapRow);
    }

    verifyAudit() {
        const list = this.listAudit();
        const archivedThrough = this.getMeta('audit_archived_through');
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (rec.hash !== hashOf(rec)) return { ok: false, code: 'TAMPERED', at: rec.seq };
            if (i === 0) {
                // O-08: arşivlenmiş eski zincir varsa ilk canlı kayıt ona bağlanır.
                if (rec.prevHash !== 'GENESIS' && rec.prevHash !== archivedThrough) {
                    return { ok: false, code: 'BROKEN_CHAIN', at: rec.seq };
                }
            } else if (rec.prevHash !== list[i - 1].hash) {
                return { ok: false, code: 'BROKEN_CHAIN', at: rec.seq };
            }
        }
        return { ok: true, records: list.length };
    }

    addKey(rec) {
        if (!this.db) {
            this.memory.agentKeys = this.memory.agentKeys || [];
            this.memory.agentKeys.push(rec);
            return rec;
        }
        this._prepare('INSERT OR REPLACE INTO keys(hash, role, key_id, agent_id, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(rec.hash, rec.role || 'agent', rec.keyId || null, rec.agentId || null, Number.isFinite(rec.notAfter) ? rec.notAfter : null, rec.createdAt || nowIso());
        return rec;
    }

    listKeys() {
        if (!this.db) return this.memory.agentKeys || [];
        return this._prepare('SELECT * FROM keys ORDER BY created_at ASC').all().map((r) => ({
            role: r.role,
            hash: r.hash,
            keyId: r.key_id,
            agentId: r.agent_id,
            notAfter: r.not_after,
            createdAt: r.created_at
        }));
    }

    /**
     * O-08: ack edilmiş kuyruk ve eski makbuzları temizler; audit'i silmeden
     * önce JSON arşivine yazar. Canlı zincir ilk kaydı arşiv hash'ine bağlanır.
     */
    retention({ queueDays = 30, receiptDays = 90, auditDays = 365, now = Date.now() } = {}) {
        if (!this.db) return { ok: true, skipped: true };
        const cutoff = (days) => new Date(now - days * 86400000).toISOString();
        let removedQueues = 0;
        let removedReceipts = 0;
        let archivedAudit = 0;
        this.db.write(() => {
            removedQueues = this._prepare("DELETE FROM queues WHERE state = 'acked' AND acked_at IS NOT NULL AND acked_at < ?")
                .run(cutoff(queueDays)).changes || 0;
            removedReceipts = this._prepare('DELETE FROM receipts WHERE received_at < ?')
                .run(cutoff(receiptDays)).changes || 0;
            if (Number.isFinite(auditDays) && auditDays > 0) {
                const rows = this._prepare('SELECT * FROM audit WHERE ts < ? ORDER BY seq ASC').all(cutoff(auditDays));
                if (rows.length > 0) {
                    const dir = path.dirname(this.dbPath);
                    fs.mkdirSync(dir, { recursive: true });
                    const stamp = nowIso().replace(/[:.]/g, '-');
                    const file = path.join(dir, `console-audit-archive-${stamp}.json`);
                    fs.writeFileSync(file, JSON.stringify(rows, null, 2), { encoding: 'utf8', mode: 0o600 });
                    const last = rows[rows.length - 1];
                    this._prepare('DELETE FROM audit WHERE seq <= ?').run(last.seq);
                    this.setMeta('audit_archived_through', last.hash);
                    archivedAudit = rows.length;
                }
            }
        });
        return { ok: true, removedQueues, removedReceipts, archivedAudit };
    }

    setMeta(key, value) {
        if (!this.db) {
            this.memory.meta = this.memory.meta || {};
            this.memory.meta[key] = value;
            return value;
        }
        this._prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
        return value;
    }

    getMeta(key) {
        if (!this.db) return (this.memory.meta || {})[key] || null;
        const row = this._prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    /** Sunucunun bellek görünümünü (test/uyumluluk) DB'den üretir. */
    snapshot({ includeAudit = false } = {}) {
        if (!this.db) return this.memory;
        const agents = {};
        for (const agent of this.listAgents()) agents[agent.agentId] = agent;
        const queues = {};
        const rows = this._prepare("SELECT * FROM queues WHERE state IN ('pending','inflight') ORDER BY created_at ASC, rowid ASC").all();
        for (const row of rows) {
            const signed = safeParse(row.signed);
            signed._state = row.state;
            signed._deliveredAt = row.delivered_at;
            signed._attempts = row.attempts;
            signed._queuedAt = row.created_at;
            signed._expiresAt = row.expires_at;
            if (!queues[row.agent_id]) queues[row.agent_id] = [];
            queues[row.agent_id].push(signed);
        }
        const publicKey = this.getMeta('keypair_public');
        return {
            agents,
            queues,
            policies: this.listPolicies(),
            ...(includeAudit ? { audit: this.listAudit({ limit: 200 }) } : {}),
            keypair: publicKey ? { publicKey } : null,
            disabledAgents: this.listDisabled(),
            agentKeys: this.listKeys()
        };
    }

    close() {
        try { if (this.db) this.db.close(); } catch (_) {}
        this.db = null;
        this._stmts.clear();
    }
}

function safeParse(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { return null; }
}

function nowIsoMs(ms) {
    return new Date(ms).toISOString();
}

function logFallback(reason, err = null) {
    // eslint-disable-next-line no-console
    if (err) console.error(`[ConsoleStore] ${reason}`, err.message || err);
    // eslint-disable-next-line no-console
    else console.error(`[ConsoleStore] ${reason}`);
}

module.exports = { ConsoleStore, QUEUE_STATES, defaultStore, hashOf };
