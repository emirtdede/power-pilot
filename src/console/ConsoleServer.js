/**
 * ConsoleServer.js - FAZ B (şirket sunucusu).
 * Tek-şirket pilot konsolu: ajan kayıt defteri (heartbeat), politika dağıtımı,
 * imzalı emir kuyruğu (ajan başına), dalgalı WoL işleri, denetim günlüğü.
 * Bağımsız Node çalıştırma: `node src/console/run.js` (şirket sunucusunda).
 * Ajanlar outbound bağlanır (heartbeat POST); konsol ajana ASLA doğrudan bağlanmaz.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const { URL } = require('url');
const { validatePolicy, materializeWakeJobs } = require('../main/services/EnterprisePolicies');
const { generateKeyPair, sign } = require('../main/services/SignedOrderService');
const Nonce = require('../main/order/Nonce');
const { ORDER_VERSION, ISSUER } = require('../main/order/OrderSchema');
const { AuditLog } = require('../main/services/AuditLog');
const { OFFLINE_THRESHOLD_MS, InventoryService } = require('../main/services/InventoryService');
const { POWER_ACTIONS } = require('../main/services/PowerService');
const { MAX_ORDERS } = require('../main/services/OrderQueue');
const { safeCompare } = require('../main/security/safeCompare');
const log = require('../main/logger');
const TlsConfig = require('../main/security/TlsConfig');
const Acl = require('../main/security/Acl');
const { ConsoleStore } = require('./ConsoleStore');

const POWER_SET = new Set(Object.values(POWER_ACTIONS));

// WP-02.T2: konsol istek sınırları (slowloris/başlık taşması koruması).
const CONSOLE_REQUEST_TIMEOUT_MS = 15000;
const CONSOLE_HEADERS_TIMEOUT_MS = 10000;
const CONSOLE_KEEPALIVE_TIMEOUT_MS = 5000;
const CONSOLE_MAX_HEADERS = 100;
const CONSOLE_MAX_BODY_BYTES = 1024 * 1024;
// O-07: tek istekte kabul edilen receipt sayısı ve kimlik başına istek limiti.
const MAX_RECEIPTS_PER_REQUEST = 100;
const CONSOLE_RATE_WINDOW_MS = 60_000;
const CONSOLE_RATE_MAX_REQUESTS = 300;

// WP-01.T6: açık yetki matrisi - varsayılan reddet. Sıralı rol hiyerarşisi yok.
const PERMISSIONS = {
    agent: new Set(['heartbeat', 'receipts']),
    viewer: new Set(['agents.read', 'gpo.read', 'policies.read', 'subnets.read']),
    operator: new Set([
        'agents.read', 'gpo.read', 'policies.read', 'subnets.read',
        'orders.create', 'orders.cancel', 'policies.create'
    ]),
    admin: new Set([
        'agents.read', 'gpo.read', 'policies.read', 'subnets.read',
        'orders.create', 'orders.cancel', 'policies.create',
        'agents.disable', 'agents.enable', 'policies.delete',
        'audit.read', 'console-key.read', 'keys.create', 'settings.read'
    ])
};

function hashKey(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

class ConsoleServer {
    /**
     * @param {object} opts - { storePath, keys: {viewer?, operator?, admin?, agent?} (hash'ler),
     *   keyDir, secureKey } - Ed25519 özel anahtarı keyDir/console-signing-key.pem
     *   dosyasında ACL+EFS ile tutulur; JSON'da yalnızca publicKey kalır.
     */
    constructor({ storePath = null, keys = {}, localSubnets = null, keyDir = null, secureKey = null, heartbeatSeconds = 60 } = {}) {
        this.storePath = storePath;
        this.keys = keys;
        // L-05: heartbeat aralığı istemcilere sabit 60 yerine yapılandırmadan bildirilir.
        const hb = Number(heartbeatSeconds);
        this.heartbeatSeconds = Number.isFinite(hb) ? Math.max(5, Math.min(3600, Math.round(hb))) : 60;
        this.rateBuckets = new Map();
        this.retentionTimer = null;
        this.localSubnetsOverride = localSubnets; // test enjeksiyonu
        this.keyDir = keyDir ? path.resolve(keyDir) : (storePath
            ? path.dirname(path.resolve(storePath))
            : path.join(__dirname, '..', '..', 'data', 'console'));
        this.secureKey = secureKey === true
            ? true
            : (secureKey === false ? false : !(process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'));
        this.privateKeyPem = null;
        this.server = null;
        this.transport = 'disabled';
        this.waitingLoggedAt = {}; // Denetim: rolling-bekleme logu politika başına kısılır
        this.consoleStore = new ConsoleStore({
            storePath,
            dbPath: storePath
                ? (String(storePath).toLowerCase().endsWith('.db')
                    ? storePath
                    : path.join(path.dirname(path.resolve(storePath)), 'console.db'))
                : null,
            maxOrders: MAX_ORDERS
        });
        this.maintenanceMode = this.consoleStore.maintenanceMode;
        this.maintenanceReason = this.consoleStore.maintenanceReason || null;
        this.store = this.consoleStore.snapshot({ includeAudit: false });
        // WP-04.T1: özel anahtar JSON'dan çıkarılır; yoksa üretilir, varsa asla
        // sessizce yeniden üretilmez (imza güven kökü değişmesin).
        if (!this.maintenanceMode) {
            try {
                this.initKeypair();
            } catch (err) {
                // Anahtar yoksa DB bağlantısını açık bırakma; çağıran fail-closed.
                try { this.consoleStore.close(); } catch (_) { /* yut */ }
                throw err;
            }
        }
        this.initAudit();
    }

    initAudit() {
        if (this.consoleStore.enabled) {
            this.audit = {
                append: (e) => this.consoleStore.addAudit(e),
                load: (opts) => this.consoleStore.listAudit(opts),
                verify: () => this.consoleStore.verifyAudit()
            };
            return;
        }
        const memory = this.consoleStore.memory;
        this.auditStorage = {
            getAuditLog: () => memory.audit,
            saveAuditLog: (list) => { memory.audit = list; }
        };
        this.audit = new AuditLog(this.auditStorage);
    }

    /** DB modunda bellek görünümünü tazeler; bellek modunda aynı nesnedir. */
    refresh() {
        if (!this.consoleStore.enabled) return this.store;
        this.store = this.consoleStore.snapshot({ includeAudit: false });
        this.maintenanceMode = this.consoleStore.maintenanceMode;
        this.maintenanceReason = this.consoleStore.maintenanceReason || this.maintenanceReason;
        return this.store;
    }

    /** Konsol DB bağlantısını kapatır (shutdown/test). */
    close() {
        try { this.consoleStore.close(); } catch (_) { /* yut */ }
    }

    signingKeyPath() {
        return path.join(this.keyDir, 'console-signing-key.pem');
    }

    writeSigningKey(pem) {
        fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
        const file = this.signingKeyPath();
        fs.writeFileSync(file, pem, { encoding: 'utf8', mode: 0o600 });
        if (this.secureKey) {
            // L-08: ACL asenkron uygulanır; anahtar yazımı UI'yı bloke etmez.
            Acl.secureDirectoryAsync(this.keyDir).then((acl) => {
                if (!acl.ok) log.warn(`[Console] Anahtar dizini ACL uygulanamadı: ${acl.code}`);
            }).catch((err) => log.warn('[Console] Anahtar dizini ACL hatası:', err && err.message));
            Acl.secureFileAsync(file).then((fileAcl) => {
                if (!fileAcl.ok) log.warn(`[Console] Anahtar dosyası ACL uygulanamadı: ${fileAcl.code}`);
            }).catch((err) => log.warn('[Console] Anahtar dosyası ACL hatası:', err && err.message));
            Acl.encryptFileEfs(file); // EFS desteklenmiyorsa sessiz no-op
        }
    }

    initKeypair() {
        if (!this.storePath) {
            // Birim testi / gömülü kullanım: diske anahtar yazılmaz.
            const kp = generateKeyPair();
            this.privateKeyPem = kp.privateKey;
            this.store.keypair = { publicKey: kp.publicKey };
            return;
        }
        const keyFile = this.signingKeyPath();
        const inline = this.consoleStore.legacyPrivateKey
            || (this.store.keypair && typeof this.store.keypair.privateKey === 'string'
                ? this.store.keypair.privateKey
                : null);

        if (inline) {
            // Eski sürüm: JSON içindeki özel anahtarı dosyaya taşı.
            this.writeSigningKey(inline);
            this.privateKeyPem = inline;
            const publicKey = crypto.createPublicKey(inline).export({ type: 'spki', format: 'pem' });
            this.store.keypair = { publicKey };
            this.consoleStore.setMeta('keypair_public', publicKey);
            this.refresh();
            return;
        }
        if (fs.existsSync(keyFile)) {
            const pem = fs.readFileSync(keyFile, 'utf8');
            this.privateKeyPem = pem;
            const publicKey = crypto.createPublicKey(pem).export({ type: 'spki', format: 'pem' });
            this.store.keypair = { publicKey };
            this.consoleStore.setMeta('keypair_public', publicKey);
            return;
        }
        if (this.store.keypair && this.store.keypair.publicKey) {
            throw Object.assign(
                new Error(`Konsol imza anahtarı bulunamadı: ${keyFile}. Sessiz yeniden üretim yapılmaz; yedekten geri yükleyin.`),
                { code: 'CONSOLE_KEY_MISSING' }
            );
        }
        const kp = generateKeyPair();
        this.writeSigningKey(kp.privateKey);
        this.privateKeyPem = kp.privateKey;
        this.store.keypair = { publicKey: kp.publicKey };
        this.consoleStore.setMeta('keypair_public', kp.publicKey);
        this.refresh();
    }

    get publicKey() {
        return this.store.keypair.publicKey;
    }

    // --- kalıcılık ---

    /**
     * WP-03.T1: kalıcılık SQLite'ta. `save()` geriye uyum için korunur;
     * DB modunda tam dosya yazımı YOKTUR (yazmalar işlem içinde yapılır).
     */
    load() {
        return this.refresh();
    }

    save() {
        if (!this.consoleStore.enabled) return;
        this.refresh();
    }

    // --- auth ---

    /**
     * Anahtar kaydı: düz hash string (legacy) veya
     * { hash, keyId, agentId, notAfter } nesnesi olabilir.
     */
    keyRecord(value, role) {
        if (typeof value === 'string') return { role, hash: value, keyId: null, agentId: null, notAfter: null };
        if (value && typeof value.hash === 'string') {
            return {
                role: value.role || role,
                hash: value.hash,
                keyId: typeof value.keyId === 'string' ? value.keyId : null,
                agentId: typeof value.agentId === 'string' ? value.agentId : null,
                notAfter: Number.isFinite(value.notAfter) ? value.notAfter : null
            };
        }
        return null;
    }

    allKeyRecords() {
        const out = [];
        for (const [role, value] of Object.entries(this.keys || {})) {
            const rec = this.keyRecord(value, role);
            if (rec) out.push(rec);
        }
        for (const rec of this.store.agentKeys || []) out.push(rec);
        return out;
    }

    /** O-07: kimlik/anahtar başına dakikalık istek limiti (token bucket). */
    checkRateLimit(identity, now = Date.now()) {
        if (!identity) return true;
        const key = identity.keyId || identity.hash;
        if (!key) return true;
        let bucket = this.rateBuckets.get(key);
        if (!bucket || now - bucket.start >= CONSOLE_RATE_WINDOW_MS) {
            bucket = { start: now, count: 0 };
            this.rateBuckets.set(key, bucket);
            if (this.rateBuckets.size > 2000) {
                for (const [k, b] of this.rateBuckets) {
                    if (now - b.start >= CONSOLE_RATE_WINDOW_MS) this.rateBuckets.delete(k);
                }
            }
        }
        bucket.count += 1;
        return bucket.count <= CONSOLE_RATE_MAX_REQUESTS;
    }

    identityOf(req) {
        const key = req && req.headers ? req.headers['x-api-key'] : null;
        if (!key) return null;
        const presented = hashKey(key);
        const wantedId = req.headers['x-key-id'];
        const now = Date.now();
        let found = null;
        // Sabit zamanlı tarama: eşleşme bulunsa bile tüm kayıtlar gezilir.
        for (const rec of this.allKeyRecords()) {
            if (rec.notAfter !== null && now > rec.notAfter) continue;
            if (typeof wantedId === 'string' && wantedId.length > 0 && rec.keyId !== wantedId) continue;
            if (safeCompare(presented, rec.hash)) found = rec;
        }
        return found;
    }

    roleOf(req) {
        const identity = this.identityOf(req);
        return identity ? identity.role : null;
    }

    /**
     * WP-01.T5: sunucu ajan kimliği + 32 bayt anahtar üretir; yalnızca
     * SHA-256 özeti ve keyId saklanır. Düz anahtar yalnızca bir kez döner.
     */
    registerAgent({ agentId = null } = {}) {
        const id = typeof agentId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId)
            ? agentId
            : `agent_${crypto.randomBytes(8).toString('hex')}`;
        const apiKey = crypto.randomBytes(32).toString('base64url');
        const keyId = `key_${crypto.randomBytes(8).toString('hex')}`;
        const record = {
            role: 'agent',
            hash: hashKey(apiKey),
            keyId,
            agentId: id,
            notAfter: null,
            createdAt: new Date().toISOString()
        };
        this.consoleStore.addKey(record);
        this.audit.append({ actor: 'console', action: 'agent_registered', target: id, detail: keyId });
        this.refresh();
        return { agentId: id, keyId, apiKey };
    }

    // --- çekirdek işlemler (HTTP'siz, test edilebilir) ---

    /**
     * WP-03.T3/T7: heartbeat emri TESLİM eder, SİLMEZ. Emir, ajan makbuz
     * gönderene veya `expiresAt` geçene kadar yeniden teslim edilir.
     * DB modunda ajan upsert + makbuz + due select + delivered_at + audit
     * tek transaction'dır.
     */
    heartbeat(agentId, inventory, receipts = []) {
        if (typeof agentId !== 'string' || !agentId || agentId.length > 128) {
            throw Object.assign(new Error('agentId geçersiz.'), { code: 'INVALID_AGENT' });
        }
        const disabled = this.isDisabled(agentId);
        // Rolling-restart ilerlemesi ayrı politika yazımıdır; heartbeat
        // transaction'ından önce tamamlanır (tek yönlü bağımlılık).
        this.advanceRolling(agentId, inventory);
        const out = this.consoleStore.heartbeat(agentId, inventory, receipts, { disabled });
        // WP-15.T4: heartbeat sıcak yolu tüm DB snapshot'ını yeniden yüklemez;
        // yalnızca etkilenen ajan kaydı bellekte güncellenir.
        if (this.consoleStore.enabled) {
            const agent = this.consoleStore.getAgent(agentId);
            if (agent) {
                if (!this.store.agents) this.store.agents = {};
                this.store.agents[agentId] = agent;
            }
            this.maintenanceMode = this.consoleStore.maintenanceMode;
        } else {
            this.refresh();
        }
        return out;
    }

    isDisabled(agentId) {
        return (this.store.disabledAgents || []).includes(agentId);
    }

    // Denetim (kill-switch): admin ajanı uzaktan durdurur/açar.
    setAgentDisabled(agentId, disabled) {
        this.consoleStore.setDisabled(agentId, disabled);
        this.audit.append({ actor: 'console', action: disabled ? 'agent_disabled' : 'agent_enabled', target: agentId, detail: '' });
        this.refresh();
        return this.store.disabledAgents;
    }

    /**
     * Denetim: GPO-kilit çatışması - GPO zorunlu kilit süresi, politika
     * idle-süresinden kısaysa GPO kazanır; konsol rozet gösterir.
     */
    gpoConflicts(idleMinutes) {
        const limit = Number(idleMinutes);
        if (!Number.isFinite(limit) || limit <= 0) {
            throw Object.assign(new Error('idleMinutes gerekli.'), { code: 'INVALID_PARAMS' });
        }
        const out = [];
        for (const a of this.agentRecords()) {
            const lp = a.inventory && a.inventory.lockPolicy;
            if (lp && lp.enforcedByGpo && typeof lp.timeoutSec === 'number' && (lp.timeoutSec / 60) < limit) {
                out.push({ agentId: a.agentId, gpoTimeoutMin: Math.floor(lp.timeoutSec / 60), policyIdleMin: limit });
            }
        }
        return out;
    }

    /**
     * FAZ D: sıralı yeniden başlatma - biri dönmeden (taze bootAt) diğeri başlamaz.
     * Zaman-aşımında hedef atlanır (denetimde işaretli), kuyruk tıkanmaz.
     */
    advanceRolling(agentId, inventory) {
        const nowMs = Date.now();
        const ids = this.store.policies
            .filter((p) => p.type === 'rolling-restart' && p.progress)
            .map((p) => p.id);
        for (const id of ids) {
            const pol = this.store.policies.find((p) => p.id === id);
            if (!pol || !pol.progress) continue;
            const prog = pol.progress;
            let changed = false;
            if (prog.awaiting === agentId) {
                const bootAt = inventory && inventory.bootAt ? new Date(inventory.bootAt).getTime() : NaN;
                const restarted = Number.isFinite(bootAt) && bootAt > prog.awaitingSince;
                const timeoutMs = (pol.params.rebootTimeoutSec || 900) * 1000;
                if (restarted) {
                    prog.done.push(agentId);
                    this.audit.append({ actor: agentId, action: 'rolling_rebooted', target: pol.id, detail: '' });
                    prog.awaiting = null;
                    changed = true;
                } else if (nowMs - prog.awaitingSince > timeoutMs) {
                    prog.done.push(`${agentId}(timeout)`);
                    this.audit.append({ actor: 'console', action: 'rolling_timeout', target: pol.id, detail: agentId });
                    prog.awaiting = null;
                    changed = true;
                }
            }
            // Önce ilerlemeyi kalıcılaştır, sonra sıradaki hedefi dağıt;
            // aksi halde dispatch'in yazdığı `awaiting` eski nesneyle ezilir.
            if (changed) {
                this.consoleStore.savePolicy(pol);
                this.store.policies = this.consoleStore.listPolicies();
            }
            this.dispatchNextRolling(pol.id);
        }
    }

    dispatchNextRolling(policyId) {
        const pol = this.store.policies.find((p) => p.id === policyId);
        if (!pol || pol.type !== 'rolling-restart' || !pol.progress) return null;
        const prog = pol.progress;
        if (prog.awaiting) return prog.awaiting; // kanıt bekleniyor
        const next = prog.pending.find((id) => !prog.done.some((d) => String(d).replace(/\(timeout\)$/, '') === id) && this.isOnline(id));
        if (!next) {
            if (prog.pending.length > prog.done.length) {
                // Denetim: bekleme kaydı politika başına 10dk'da bir (log selini önler).
                const last = this.waitingLoggedAt[pol.id] || 0;
                if (Date.now() - last > 600000) {
                    this.waitingLoggedAt[pol.id] = Date.now();
                    this.audit.append({ actor: 'console', action: 'rolling_waiting', target: pol.id, detail: 'çevrimiçi sunucu yok' });
                    this.refresh();
                }
            }
            return null;
        }
        prog.pending = prog.pending.filter((id) => id !== next);
        prog.awaiting = next;
        prog.awaitingSince = Date.now();
        this.consoleStore.savePolicy(pol);
        // L-14: kuyruk hatası rolling restart'ı kilitlemesin; awaiting geri alınır.
        try {
            this.queueOrder(next, 'restart', { requiresMaintenanceWindow: true, policyId: pol.id });
        } catch (err) {
            prog.awaiting = null;
            prog.awaitingSince = null;
            this.consoleStore.savePolicy(pol);
            this.audit.append({
                actor: 'console',
                action: 'rolling_dispatch_failed',
                target: pol.id,
                detail: (err && err.message) || 'kuyruk hatası'
            });
            this.refresh();
            return null;
        }
        this.audit.append({ actor: 'console', action: 'rolling_dispatched', target: pol.id, detail: next });
        this.refresh();
        return next;
    }

    agentRecords() {
        if (this.consoleStore.enabled) return this.consoleStore.listAgents();
        return Object.values(this.store.agents || {}).map((a) => ({
            ...a,
            disabled: (this.store.disabledAgents || []).includes(a.agentId)
        }));
    }

    agents() {
        const now = Date.now();
        return this.agentRecords().map((a) => {
            const t = new Date(a.lastHeartbeatAt).getTime();
            const counts = this.consoleStore.counts(a.agentId);
            return {
                agentId: a.agentId,
                online: Number.isFinite(t) && (now - t) <= OFFLINE_THRESHOLD_MS,
                lastHeartbeatAt: a.lastHeartbeatAt,
                hostname: (a.inventory && a.inventory.hostname) || null,
                username: (a.inventory && a.inventory.username) || null,
                sleepStates: (a.inventory && a.inventory.sleepStates) || null,
                wolReadiness: (a.inventory && a.inventory.wolReadiness) || null,
                deviceRole: (a.inventory && a.inventory.deviceRole) || 'workstation',
                bootAt: (a.inventory && a.inventory.bootAt) || null,
                lockPolicy: (a.inventory && a.inventory.lockPolicy) || null,
                ups: (a.inventory && a.inventory.ups) || null,
                disabled: !!a.disabled,
                pendingOrders: counts.pending + counts.inflight,
                queue: counts
            };
        });
    }

    isOnline(agentId, now = Date.now()) {
        const a = this.consoleStore.enabled
            ? this.consoleStore.getAgent(agentId)
            : this.store.agents[agentId];
        if (!a) return false;
        const t = new Date(a.lastHeartbeatAt).getTime();
        return Number.isFinite(t) && (now - t) <= OFFLINE_THRESHOLD_MS;
    }

    agentSubnets(agentId) {
        const a = this.consoleStore.enabled ? this.consoleStore.getAgent(agentId) : this.store.agents[agentId];
        const inv = (a && a.inventory) || {};
        return (inv.nics || []).map((n) => n.subnet).filter(Boolean);
    }

    localSubnets() {
        if (Array.isArray(this.localSubnetsOverride)) return this.localSubnetsOverride;
        try {
            return InventoryService.parseNics(os.networkInterfaces()).map((n) => n.subnet).filter(Boolean);
        } catch (_) {
            return [];
        }
    }

    /**
     * FAZ C: alt-ağ sınıflandırması - her subnet için hazır ajan sayısı + röle adayı.
     * Röle = çevrimiçi + readiness blocked-olmayan + (hedef değil) ilk ajan (deterministik).
     */
    subnets() {
        const records = this.agentRecords();
        const byId = new Map(records.map((a) => [a.agentId, a]));
        const map = {};
        for (const a of records) {
            const inv = a.inventory || {};
            for (const nic of inv.nics || []) {
                if (!nic.subnet) continue;
                if (!map[nic.subnet]) map[nic.subnet] = { subnet: nic.subnet, agents: [], ready: 0, relay: null };
                map[nic.subnet].agents.push(a.agentId);
                const level = (inv.wolReadiness && inv.wolReadiness.level) || 'unknown';
                if (level === 'ready' || level === 'degraded') map[nic.subnet].ready++;
            }
        }
        for (const entry of Object.values(map)) {
            const candidates = [...new Set(entry.agents)].sort().filter((id) => {
                if (!this.isOnline(id)) return false;
                const inv = (byId.get(id) || {}).inventory || {};
                const level = (inv.wolReadiness && inv.wolReadiness.level) || 'unknown';
                return level !== 'blocked';
            });
            entry.relay = candidates[0] || null;
            entry.status = entry.relay ? 'ready' : 'no-relay';
        }
        return Object.values(map);
    }

    findRelay(subnet, excludeId = null) {
        const entry = this.subnets().find((s) => s.subnet === subnet);
        if (!entry || !entry.relay) return null;
        if (entry.relay === excludeId) {
            // Hedefin kendisi röleyse sıradaki adayı dene.
            const others = [...new Set(entry.agents)].sort().filter((id) => id !== excludeId && this.isOnline(id));
            return others[0] || null;
        }
        return entry.relay;
    }

    sendWolDirect(mac, broadcastIp = '255.255.255.255', port = 9) {
        return new Promise((resolve) => {
            let sock = null;
            let settled = false;
            const done = (result) => {
                if (settled) return;
                settled = true;
                try { if (sock) sock.close(); } catch (_) {}
                resolve(result);
            };
            try {
                const cleanMac = String(mac).replace(/[^a-fA-F0-9]/g, '');
                if (cleanMac.length !== 12) return done({ success: false, error: 'MAC geçersiz.' });
                const macBuf = Buffer.from(cleanMac, 'hex');
                const pkt = Buffer.alloc(102);
                pkt.fill(0xFF, 0, 6);
                for (let i = 0; i < 16; i++) macBuf.copy(pkt, 6 + i * 6);
                sock = dgram.createSocket('udp4');
                // Y-08: error event'i dinlenmezse süreç çöker.
                sock.once('error', (err) => done({ success: false, error: err.message }));
                sock.once('listening', () => { try { sock.setBroadcast(true); } catch (_) {} });
                sock.send(pkt, 0, pkt.length, port, broadcastIp, (err) => {
                    done(err ? { success: false, error: err.message } : { success: true });
                });
            } catch (err) {
                done({ success: false, error: (err && err.message) || 'WoL hatası.' });
            }
        });
    }

    queueOrder(agentId, action, params = {}) {
        if (!POWER_SET.has(action) && !['apply-policy', 'revoke-policy', 'wake', 'relay-wake'].includes(action)) {
            throw Object.assign(new Error(`Geçersiz emir eylemi: ${action}.`), { code: 'INVALID_ACTION' });
        }
        const now = Date.now();
        const order = {
            version: ORDER_VERSION,
            action,
            params,
            targets: [agentId],
            nonce: Nonce.generate(now),
            issuedAt: now,
            expiresAt: now + 10 * 60000,
            issuer: ISSUER,
            keyId: 'default'
        };
        if (!this._signingKeyObject || this._signingKeyPem !== this.privateKeyPem) {
            this._signingKeyObject = crypto.createPrivateKey(this.privateKeyPem);
            this._signingKeyPem = this.privateKeyPem;
        }
        const signed = sign(order, this._signingKeyObject);
        // K6/WP-03: karşı basınç ConsoleStore'da; dolu kuyrukta QUEUE_FULL.
        try {
            this.consoleStore.enqueue(agentId, signed);
        } catch (err) {
            if (err && err.code === 'QUEUE_FULL') {
                this.audit.append({ actor: 'console', action: 'order_queue_full', target: agentId, detail: action });
            }
            throw err;
        }
        this.audit.append({ actor: 'console', action: 'order_queued', target: action, detail: `${agentId}:${order.nonce}` });
        this.refresh();
        return signed;
    }

    /**
     * Politika dağıtımı: doğrula → kaydet → hedef başına imzalı emir kuyrukla.
     * FAZ C: wake emirleri ÇEVRİMİÇİ röleye gider (hedefe değil - hedef kapalı olabilir);
     * röle yoksa ve hedef konsolla aynı alt-ağdaysa konsol doğrudan gönderir,
     * aksi halde hedef 'röle-yok' diye atlanır.
     */
    async dispatchPolicy(policy) {
        const check = validatePolicy(policy);
        if (!check.ok) throw Object.assign(new Error(check.error), { code: check.code });
        const stored = {
            id: policy.id,
            type: policy.type,
            targets: [...policy.targets],
            params: { ...(policy.params || {}) },
            dispatchedAt: new Date().toISOString()
        };
        this.consoleStore.savePolicy(stored);
        this.store.policies = this.consoleStore.listPolicies();
        let queued = 0;
        if (policy.type === 'rolling-restart') {
            stored.progress = { pending: [...policy.targets], awaiting: null, awaitingSince: null, done: [] };
            this.consoleStore.savePolicy(stored);
            this.store.policies = this.consoleStore.listPolicies();
            const first = this.dispatchNextRolling(stored.id);
            this.audit.append({ actor: 'console', action: 'policy_dispatched', target: policy.id, detail: `rolling-restart: ilk hedef ${first || 'yok (çevrimdışı bekleniyor)'}` });
            this.refresh();
            return { policy: stored, queued: first ? 1 : 0 };
        }
        if (policy.type === 'pre-patch-wake') {
            const targets = policy.targets.map((id) => {
                const rec = this.consoleStore.enabled ? this.consoleStore.getAgent(id) : this.store.agents[id];
                const inv = (rec && rec.inventory) || {};
                const nic = (inv.nics || [])[0] || {};
                return { agentId: id, mac: nic.mac || null, broadcastIp: '255.255.255.255', port: 9, subnet: nic.subnet || null };
            });
            const withMac = targets.filter((t) => t.mac);
            const skipped = targets.filter((t) => !t.mac).map((t) => `${t.agentId}(mac-yok)`);
            if (withMac.length === 0) {
                this.audit.append({ actor: 'console', action: 'policy_dispatched', target: policy.id, detail: `wake: MAC bulunamadı, atlanan: ${skipped.join(',')}` });
                this.refresh();
                return { policy: stored, queued: 0, sent: 0, skipped };
            }
            const { jobs } = materializeWakeJobs(policy, withMac, { baseTimeMs: Date.now() });
            const mine = this.localSubnets();
            let sent = 0;
            for (const job of jobs) {
                const target = withMac.find((t) => t.agentId === job.agentId);
                const subnet = target && target.subnet;
                const bcast = (subnet && InventoryService.directedBroadcast(subnet)) || job.broadcastIp;
                const relay = subnet ? this.findRelay(subnet, job.agentId) : null;
                if (relay) {
                    this.queueOrder(relay, 'relay-wake', { mac: job.mac, broadcastIp: bcast, port: job.port, notBefore: job.notBefore, wave: job.wave, finalTarget: job.agentId });
                    queued++;
                } else if (subnet && mine.includes(subnet)) {
                    const r = await this.sendWolDirect(job.mac, bcast, job.port);
                    sent++;
                    this.audit.append({ actor: 'console', action: r.success ? 'wol_sent_direct' : 'wol_failed', target: job.agentId, detail: `${job.mac} via ${bcast}` });
                } else {
                    skipped.push(`${job.agentId}(röle-yok)`);
                }
            }
            this.audit.append({ actor: 'console', action: 'policy_dispatched', target: policy.id, detail: `wake: ${queued} röle-emri, ${sent} doğrudan, atlanan: ${skipped.join(',') || '-'}` });
            this.refresh();
            return { policy: stored, queued, sent, skipped };
        }
        for (const id of policy.targets) {
            this.queueOrder(id, 'apply-policy', { policy: stored });
            queued++;
        }
        this.audit.append({ actor: 'console', action: 'policy_dispatched', target: policy.id, detail: `${policy.type}: ${queued} ajan` });
        this.refresh();
        return { policy: stored, queued };
    }

    revokePolicy(policyId) {
        const found = this.store.policies.find((p) => p.id === policyId);
        if (!found) throw Object.assign(new Error('Politika bulunamadı.'), { code: 'NOT_FOUND' });
        this.consoleStore.deletePolicy(policyId);
        this.store.policies = this.consoleStore.listPolicies();
        for (const id of found.targets) {
            try { this.queueOrder(id, 'revoke-policy', { policyId }); } catch (_) { /* hedef kayıtsız olabilir */ }
        }
        this.audit.append({ actor: 'console', action: 'policy_revoked', target: policyId, detail: '' });
        this.refresh();
        return true;
    }

    // --- HTTP ---

    start(port = 8443, host = '0.0.0.0', tlsSettings = {}) {
        if (this.server) {
            const err = Object.assign(new Error('Konsol sunucusu zaten çalışıyor.'), { code: 'ALREADY_RUNNING' });
            throw err;
        }
        const insecureAllowed = process.env.PP_ALLOW_INSECURE_CONSOLE === '1';
        const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
        const tlsOpts = TlsConfig.buildConsoleServerOptions(tlsSettings);
        const handler = (req, res) => this.handleRequest(req, res);

        if (tlsOpts) {
            this.server = https.createServer(tlsOpts, handler);
            this.transport = 'https';
        } else {
            // WP-02.T2 / T-TLS-01: düz HTTP yalnızca loopback + açık env kaçış kapısı.
            if (!(insecureAllowed && loopback)) {
                throw Object.assign(
                    new Error('Konsol TLS olmadan başlatılamaz (CONSOLE_TLS_REQUIRED). Sertifika tanımlayın veya yalnızca loopback + PP_ALLOW_INSECURE_CONSOLE=1 kullanın.'),
                    { code: 'CONSOLE_TLS_REQUIRED' }
                );
            }
            host = '127.0.0.1';
            this.server = http.createServer(handler);
            this.transport = 'http';
        }

        this.server.requestTimeout = CONSOLE_REQUEST_TIMEOUT_MS;
        this.server.headersTimeout = CONSOLE_HEADERS_TIMEOUT_MS;
        this.server.keepAliveTimeout = CONSOLE_KEEPALIVE_TIMEOUT_MS;
        this.server.maxHeadersCount = CONSOLE_MAX_HEADERS;

        // Y-08: EADDRINUSE/EACCES gibi hatalar yakalanmazsa süreç düşer.
        this.server.on('error', (err) => {
            log.error('[Console] Sunucu hatası:', err && err.message);
            this.server = null;
            this.transport = 'disabled';
        });

        this.server.listen(port, host, () => {
            log.info(`[Console] ${this.transport}://${host}:${port} (ajanlar outbound bağlanır)`);
        });

        // O-08: günlük retention (ack kuyrukları, eski makbuzlar, arşivli audit).
        if (this.consoleStore.enabled && !this.retentionTimer) {
            const runRetention = () => {
                try {
                    const out = this.consoleStore.retention();
                    if (out && (out.removedQueues || out.removedReceipts || out.archivedAudit)) {
                        log.info('[Console] Retention:', out);
                    }
                } catch (err) {
                    log.warn('[Console] Retention hatası:', err && err.message);
                }
            };
            runRetention();
            this.retentionTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
            this.retentionTimer.unref?.();
        }
        return this.server;
    }

    /**
     * WP-02.T6: async durdurma - idle bağlantılar hemen, aktifler 5 sn sonra.
     */
    async stop() {
        if (this.retentionTimer) {
            try { clearInterval(this.retentionTimer); } catch (_) { /* yut */ }
            this.retentionTimer = null;
        }
        const server = this.server;
        if (!server) {
            this.transport = 'disabled';
            return { ok: true };
        }
        // L-10: this.server close callback'inde null'lanır; hata olursa korunur.
        await new Promise((resolve) => {
            let settled = false;
            const done = (ok = true) => {
                if (settled) return;
                settled = true;
                if (ok) {
                    this.server = null;
                    this.transport = 'disabled';
                }
                resolve();
            };
            try {
                if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
                server.close((err) => done(!err));
                setTimeout(() => {
                    try {
                        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    } catch (_) { /* yut */ }
                    done(false);
                }, 5000).unref?.();
            } catch (_) {
                done(false);
            }
        });
        return { ok: true };
    }

    sendJson(res, code, data) {
        // Y-08: 413 sonrası ikinci yanıt denemesi ERR_HTTP_HEADERS_SENT üretmesin.
        if (!res || res.headersSent || res.writableEnded) return;
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    needPermission(res, role, permission) {
        if (!role) {
            this.sendJson(res, 401, { error: 'API anahtarı gerekli (X-API-Key).' });
            return false;
        }
        const allowed = PERMISSIONS[role];
        if (!allowed || !allowed.has(permission)) {
            this.sendJson(res, 403, { error: `Rol '${role}' bu işlem için yetkili değil.`, code: 'FORBIDDEN' });
            return false;
        }
        return true;
    }

    handleRequest(req, res) {
        // Y-08: istemci bağlantısı aniden kapanırsa unhandled error olmasın.
        req.on('error', () => { try { res.destroy(); } catch (_) {} });
        let parsed;
        try {
            parsed = new URL(req.url, 'http://x');
        } catch (_) {
            return this.sendJson(res, 400, { error: 'Geçersiz URL.', code: 'BAD_URL' });
        }
        const identity = this.identityOf(req);
        const role = identity ? identity.role : null;
        if (!this.checkRateLimit(identity)) {
            try { res.setHeader('Retry-After', '60'); } catch (_) { /* yut */ }
            return this.sendJson(res, 429, { error: 'İstek limiti aşıldı.', code: 'RATE_LIMITED' });
        }
        const p = parsed.pathname;
        const method = String(req.method || 'GET').toUpperCase();

        let raw = '';
        let tooLarge = false;
        req.on('data', (c) => {
            if (tooLarge) return;
            raw += c;
            if (raw.length > CONSOLE_MAX_BODY_BYTES) {
                tooLarge = true;
                this.sendJson(res, 413, { error: 'Gövde çok büyük.', code: 'PAYLOAD_TOO_LARGE', limit: CONSOLE_MAX_BODY_BYTES });
                try { req.destroy(); } catch (_) { /* yut */ }
            }
        });
        req.on('end', () => {
            if (tooLarge) return;
            let body = {};
            if (raw) {
                try { body = JSON.parse(raw); } catch (_) { return this.sendJson(res, 400, { error: 'JSON geçersiz.' }); }
            }
            // L-05: iç hata ayrıntısı istemciye sızmaz; requestId ile logda eşlenir.
            const requestId = crypto.randomBytes(8).toString('hex');
            Promise.resolve(this.route(method, p, body, res, role, parsed, identity)).catch((err) => {
                log.error(`[Console] istek hatası (${requestId}):`, err && err.message);
                try {
                    this.sendJson(res, 400, {
                        error: 'İstek işlenemedi.',
                        code: 'BAD_REQUEST',
                        requestId
                    });
                } catch (_) { /* yut */ }
            });
        });
    }

    async route(method, p, body, res, role, parsed = null, identity = null) {
        if (!parsed) parsed = new URL(String(p), 'http://x');
        p = parsed.pathname;
        // WP-03.T2: bakım modunda yazma yok - bellek moduna sessiz düşüş olmaz.
        if (this.maintenanceMode && method !== 'GET') {
            this.sendJson(res, 503, {
                error: this.maintenanceReason || 'Konsol depo bakım modunda; yazma reddedildi.',
                code: 'CONSOLE_MAINTENANCE'
            });
            return;
        }
        if (method === 'POST' && p === '/api/v1/heartbeat') {
            if (!this.needPermission(res, role, 'heartbeat')) return;
            // K-02: ajan anahtarı mutlaka bir agentId'ye bağlı olmalı; gövde
            // kimliği asla kimlik kaynağı değildir.
            if (!identity || !identity.agentId) {
                return this.sendJson(res, 403, { error: 'Ajan anahtarı bir agentId ile bağlı değil.', code: 'AGENT_KEY_UNBOUND' });
            }
            if (body.agentId !== identity.agentId) {
                return this.sendJson(res, 403, { error: 'Kimlik uyuşmazlığı.', code: 'IDENTITY_MISMATCH' });
            }
            const out = this.heartbeat(identity.agentId, body.inventory, body.receipts);
            return this.sendJson(res, 200, out);
        }
        if (method === 'POST' && p === '/api/v1/receipts') {
            if (!this.needPermission(res, role, 'receipts')) return;
            const agentId = identity && identity.agentId;
            if (!agentId) {
                return this.sendJson(res, 403, { error: 'Ajan anahtarı bir agentId ile bağlı değil.', code: 'AGENT_KEY_UNBOUND' });
            }
            if (body.agentId !== undefined && body.agentId !== agentId) {
                return this.sendJson(res, 403, { error: 'Kimlik uyuşmazlığı.', code: 'IDENTITY_MISMATCH' });
            }
            const receipts = Array.isArray(body.receipts) ? body.receipts : [body];
            if (receipts.length > MAX_RECEIPTS_PER_REQUEST) {
                return this.sendJson(res, 413, {
                    error: `En fazla ${MAX_RECEIPTS_PER_REQUEST} receipt gönderilebilir.`,
                    code: 'TOO_MANY_RECEIPTS'
                });
            }
            let accepted = 0;
            let duplicates = 0;
            for (const r of receipts) {
                const out = this.consoleStore.ackReceipt(agentId, r && r.nonce, r && r.code, r && r.message);
                if (!out.ok) continue;
                accepted += 1;
                if (out.duplicate) duplicates += 1;
                else {
                    this.audit.append({
                        actor: agentId,
                        action: 'order_receipt',
                        target: (r && r.nonce) || null,
                        detail: (r && r.code) || ''
                    });
                }
            }
            this.refresh();
            return this.sendJson(res, 200, { success: true, accepted, duplicates });
        }
        if (method === 'GET' && p === '/api/v1/agents') {
            if (!this.needPermission(res, role, 'agents.read')) return;
            return this.sendJson(res, 200, { agents: this.agents() });
        }
        if (method === 'GET' && p === '/api/v1/queues') {
            if (!this.needPermission(res, role, 'agents.read')) return;
            const q = parsed && parsed.searchParams ? parsed.searchParams.get('agentId') : null;
            return this.sendJson(res, 200, {
                counts: this.consoleStore.counts(q || null),
                orders: this.consoleStore.orders({ limit: 200, agentId: q || null })
            });
        }
        if (method === 'GET' && p === '/api/v1/policies') {
            if (!this.needPermission(res, role, 'policies.read')) return;
            return this.sendJson(res, 200, { policies: this.store.policies });
        }
        if (method === 'POST' && p === '/api/v1/policies') {
            if (!this.needPermission(res, role, 'policies.create')) return;
            try {
                const out = await this.dispatchPolicy(body);
                return this.sendJson(res, 201, out);
            } catch (err) {
                const code = err.code === 'QUEUE_FULL' ? 429 : 400;
                return this.sendJson(res, code, { error: err.message, code: err.code || 'BAD_REQUEST' });
            }
        }
        if (method === 'GET' && p === '/api/v1/subnets') {
            if (!this.needPermission(res, role, 'subnets.read')) return;
            return this.sendJson(res, 200, { subnets: this.subnets() });
        }
        const revoke = p.match(/^\/api\/v1\/policies\/([^\/]+)$/);
        if (method === 'DELETE' && revoke) {
            if (!this.needPermission(res, role, 'policies.delete')) return;
            this.revokePolicy(decodeURIComponent(revoke[1]));
            return this.sendJson(res, 200, { success: true });
        }
        const orderFor = p.match(/^\/api\/v1\/agents\/([^\/]+)\/orders$/);
        if (method === 'POST' && orderFor) {
            if (!this.needPermission(res, role, 'orders.create')) return;
            try {
                const signed = this.queueOrder(decodeURIComponent(orderFor[1]), body.action, body.params || {});
                return this.sendJson(res, 201, { success: true, nonce: signed.order.nonce });
            } catch (err) {
                const code = err.code === 'QUEUE_FULL' ? 429 : 400;
                return this.sendJson(res, code, { error: err.message, code: err.code || 'BAD_REQUEST' });
            }
        }
        // Denetim (kill-switch): admin ajanı uzaktan durdurur/açar.
        const disableM = p.match(/^\/api\/v1\/agents\/([^\/]+)\/(disable|enable)$/);
        if (method === 'POST' && disableM) {
            if (!this.needPermission(res, role, disableM[2] === 'disable' ? 'agents.disable' : 'agents.enable')) return;
            const list = this.setAgentDisabled(decodeURIComponent(disableM[1]), disableM[2] === 'disable');
            return this.sendJson(res, 200, { success: true, disabledAgents: list });
        }
        if (method === 'GET' && p === '/api/v1/agents/gpo-conflicts') {
            if (!this.needPermission(res, role, 'gpo.read')) return;
            const q = parsed && parsed.searchParams ? parsed.searchParams.get('idleMinutes') : null;
            try {
                return this.sendJson(res, 200, { conflicts: this.gpoConflicts(q === null ? 10 : Number(q)) });
            } catch (err) {
                return this.sendJson(res, 400, { error: err.message, code: err.code || 'BAD_REQUEST' });
            }
        }
        if (method === 'GET' && p === '/api/v1/audit') {
            if (!this.needPermission(res, role, 'audit.read')) return;
            // O-06: sayfalama + isteğe bağlı zincir doğrulama (varsayılan kapalı).
            const limit = Math.min(500, Math.max(1, Number(parsed.searchParams.get('limit')) || 100));
            const beforeSeq = Number(parsed.searchParams.get('beforeSeq')) || null;
            const out = { audit: this.audit.load({ limit, beforeSeq }), limit };
            if (parsed.searchParams.get('verify') === '1') out.verify = this.audit.verify();
            return this.sendJson(res, 200, out);
        }
        if (method === 'GET' && p === '/api/v1/audit/verify') {
            if (!this.needPermission(res, role, 'audit.read')) return;
            return this.sendJson(res, 200, { verify: this.audit.verify() });
        }
        if (method === 'GET' && p === '/api/v1/console-key') {
            if (!this.needPermission(res, role, 'console-key.read')) return;
            return this.sendJson(res, 200, { publicKey: this.publicKey });
        }
        if (method === 'POST' && p === '/api/v1/keys') {
            if (!this.needPermission(res, role, 'keys.create')) return;
            const out = this.registerAgent({ agentId: body && body.agentId });
            return this.sendJson(res, 201, out);
        }
        if (method === 'GET' && p === '/api/v1/settings') {
            if (!this.needPermission(res, role, 'settings.read')) return;
            return this.sendJson(res, 200, { settings: this.publicSettings() });
        }
        return this.sendJson(res, 404, { error: 'Bulunamadı.' });
    }

    publicSettings() {
        // Sır içermeyen konsol ayarları.
        return {
            orderProtocol: ORDER_VERSION,
            tlsRequired: true,
            heartbeatSeconds: this.heartbeatSeconds,
            maxOrders: MAX_ORDERS
        };
    }
}

module.exports = { ConsoleServer, hashKey };
