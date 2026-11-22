/**
 * InventoryService.js - FAZ B.
 * Cihaz envanteri toplar: kimlik, OS/build, uyku tipleri (powercfg -a),
 * ağ arayüzleri (MAC/IP/subnet), ajan sürümü, toplama zamanı.
 * Konsol heartbeat gövdesi de budur. exec/os DI ile test edilir.
 */

const os = require('os');
const { execFile } = require('child_process');
const log = require('../logger');

const OFFLINE_THRESHOLD_MS = 15 * 60 * 1000; // 15dk heartbeat yoksa gri

class InventoryService {
    constructor({ storageService = null, execFn = null, osModule = null, agentVersion = '1.0.0', upsMonitor = null } = {}) {
        this.storage = storageService;
        // execFn test enjeksiyonu; imza (file, args, options, cb). Üretimde kabuk yok.
        this.exec = execFn || execFile;
        this.os = osModule || os;
        this.agentVersion = agentVersion;
        this.upsMonitor = upsMonitor; // FAZ D: UpsMonitor örneği (ayar upsEnabled ise sorgulanır)
        // O-14: ağır donanım sorguları cache'lenir; heartbeat her 60 sn'de
        // powercfg/PowerShell spawn etmez.
        this._cache = null;
        this._cacheTtlMs = 5 * 60 * 1000;
    }

    // --- saf ayrıştırıcılar (test edilebilir) ---

    /**
     * `powercfg -a` çıktısı → kullanılabilir uyku durumları.
     * Örn. S0 cihaz: "Standby (S0 Low Power Idle)" satırı geçer.
     */
    static parseSleepStates(stdout) {
        const text = String(stdout || '');
        const has = (re) => re.test(text);
        return {
            standbyS0: has(/standby\s*\(s0/i),
            standbyS3: has(/standby\s*\(s3/i),
            hibernate: has(/hibernate/i) && !has(/hibernate\s+has\s+not\s+been\s+enabled/i),
            fastStartup: has(/fast\s*startup/i),
            rawAvailable: has(/available/i)
        };
    }

    static maskToCidr(mask) {
        try {
            const bits = String(mask || '').split('.').map(Number);
            if (bits.length !== 4 || bits.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
            let n = 0;
            for (const b of bits) {
                let v = b;
                while (v) { n += v & 1; v >>= 1; }
            }
            return n;
        } catch (_) {
            return null;
        }
    }

    static subnetOf(ip, mask) {
        try {
            const a = String(ip || '').split('.').map(Number);
            const m = String(mask || '').split('.').map(Number);
            if (a.length !== 4 || m.length !== 4) return null;
            const net = a.map((v, i) => v & m[i]).join('.');
            const cidr = InventoryService.maskToCidr(mask);
            return cidr == null ? net : `${net}/${cidr}`;
        } catch (_) {
            return null;
        }
    }

    static parseNics(interfaces) {
        const out = [];
        for (const [name, addrs] of Object.entries(interfaces || {})) {
            for (const a of addrs || []) {
                if (a.family !== 'IPv4' || a.internal) continue;
                out.push({
                    name,
                    ip: a.address,
                    netmask: a.netmask,
                    subnet: InventoryService.subnetOf(a.address, a.netmask),
                    mac: a.mac
                });
            }
        }
        return out;
    }

    /**
     * FAZ C: `Get-NetAdapterPowerManagement` çıktısı → adaptör başına WoL bayrakları.
     * Name satırı + WakeOnMagicPacket satırı eşleştirilir (saf ayrıştırıcı).
     */
    static parseNicWol(stdout) {
        const text = String(stdout || '');
        const adapters = [];
        let current = null;
        for (const raw of text.split('\n')) {
            const line = raw.replace(/\r$/, '');
            let m = line.match(/^\s*Name\s*:\s*(.+?)\s*$/i);
            if (m) {
                current = { name: m[1], wakeOnMagicPacket: 'unknown', wakeOnPattern: 'unknown' };
                adapters.push(current);
                continue;
            }
            if (!current) continue;
            m = line.match(/^\s*WakeOnMagicPacket\s*:\s*(\S+)/i);
            if (m) current.wakeOnMagicPacket = m[1];
            m = line.match(/^\s*WakeOnPattern\s*:\s*(\S+)/i);
            if (m) current.wakeOnPattern = m[1];
        }
        return adapters;
    }

    /**
     * FAZ C: `powercfg /devicequery wake_armed` çıktısı → uyandırabilen cihaz adları.
     */
    static parseWakeArmed(stdout) {
        return String(stdout || '')
            .split('\n')
            .map((l) => l.replace(/\r$/, '').trim())
            .filter((l) => l.length > 0);
    }

    /**
     * FAZ C: WoL-hazırlık hükmü (ajan + konsol ortak kullanır, saf fonksiyon).
     * S0 Modern Standby + hibernate kapalı = WoL kırık → 'blocked'.
     */
    static wolReadiness({ sleepStates = {}, nicWol = [], wakeArmed = [], lastWolResult = null } = {}) {
        const reasons = [];
        if (sleepStates.unknown) {
            return { level: 'unknown', reasons: ['uyku-durumu-okunamadı'], recommendation: 'powercfg -a çıktısını kontrol edin' };
        }
        if (sleepStates.standbyS0 && !sleepStates.hibernate) {
            reasons.push('s0-modern-standby');
            return { level: 'blocked', reasons, recommendation: 'Uyku-yerine-hazırda-beklet politikası önerilir' };
        }
        const states = [sleepStates.standbyS0, sleepStates.standbyS3, sleepStates.hibernate].filter(Boolean);
        if (states.length === 0) reasons.push('uyku-durumu-yok');
        const enabled = nicWol.filter((n) => /enabled/i.test(n.wakeOnMagicPacket || ''));
        const disabled = nicWol.filter((n) => /disabled/i.test(n.wakeOnMagicPacket || ''));
        if (disabled.length > 0 || (nicWol.length > 0 && enabled.length === 0)) reasons.push('nic-wol-kapalı');
        if (wakeArmed.length === 0) reasons.push('wake-armed-boş');
        if (lastWolResult && lastWolResult.success === false) reasons.push('son-wol-başarısız');
        if (reasons.length === 0) {
            return { level: 'ready', reasons: [], recommendation: null };
        }
        if (reasons.includes('nic-wol-kapalı') || reasons.includes('uyku-durumu-yok')) {
            return { level: 'blocked', reasons, recommendation: 'BIOS WoL + OS aygıt-yöneticisi wake bayraklarını açın' };
        }
        return { level: 'degraded', reasons, recommendation: 'Ağ bağdaştırıcısı güç-yönetimi ayarlarını gözden geçirin' };
    }

    /**
     * FAZ D: `reg query` çıktısından ScreenSaveTimeOut (saniye) okur.
     * GPO yolu (HKLM\...\Policies) varsa kullanıcı ayarını ezer → enforcedByGpo.
     */
    static parseRegTimeout(stdout) {
        const m = String(stdout || '').match(/ScreenSaveTimeOut\s+REG_\w+\s+(\d+)/i);
        if (!m) return null;
        const v = Number(m[1]);
        return Number.isFinite(v) ? v : null;
    }

    getLockPolicy() {
        const q = (key) => new Promise((resolve) => {
            this.exec('reg.exe', ['query', key, '/v', 'ScreenSaveTimeOut'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err || !stdout) return resolve(null);
                resolve(InventoryService.parseRegTimeout(stdout));
            });
        });
        return Promise.all([
            q('HKCU\\Control Panel\\Desktop'),
            q('HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop')
        ]).then(([user, gpo]) => {
            if (gpo !== null) return { timeoutSec: gpo, enforcedByGpo: true };
            if (user !== null) return { timeoutSec: user, enforcedByGpo: false };
            return null;
        });
    }

    getBootAt() {
        try {
            const up = this.os.uptime();
            if (!Number.isFinite(up) || up < 0) return null;
            return new Date(Date.now() - Math.floor(up) * 1000).toISOString();
        } catch (_) {
            return null;
        }
    }
    /**
     * FAZ C: subnet → yönlendirilmiş broadcast (röle gönderimi için).
     * '192.168.1.0/24' → '192.168.1.255'
     */
    static directedBroadcast(subnet) {
        try {
            const m = String(subnet || '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
            if (!m) return null;
            const ip = m.slice(1, 5).map(Number);
            const cidr = Number(m[5]);
            if (cidr < 0 || cidr > 32 || ip.some((b) => b < 0 || b > 255)) return null;
            const mask = cidr === 0 ? 0 : (~0 << (32 - cidr)) >>> 0;
            const addr = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
            const bcast = (addr | (~mask >>> 0)) >>> 0;
            return [(bcast >>> 24) & 255, (bcast >>> 16) & 255, (bcast >>> 8) & 255, bcast & 255].join('.');
        } catch (_) {
            return null;
        }
    }

    static isOffline(lastHeartbeatAt, now = Date.now(), thresholdMs = OFFLINE_THRESHOLD_MS) {
        if (!lastHeartbeatAt) return true;
        const t = new Date(lastHeartbeatAt).getTime();
        if (!Number.isFinite(t)) return true;
        return (now - t) > thresholdMs;
    }

    // --- toplama ---

    getSleepStates() {
        return new Promise((resolve) => {
            this.exec('powercfg.exe', ['-a'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
                if (err || !stdout) return resolve({ unknown: true });
                try {
                    resolve(InventoryService.parseSleepStates(stdout));
                } catch (_) {
                    resolve({ unknown: true });
                }
            });
        });
    }

    // FAZ C: NIC WoL bayrakları + uyandırabilen cihazlar (best-effort, hata gizlenir).
    getWolDetails() {
        const run = (file, args, parse) => new Promise((resolve) => {
            this.exec(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
                if (err || !stdout) return resolve([]);
                try {
                    resolve(parse(stdout));
                } catch (_) {
                    resolve([]);
                }
            });
        });
        return Promise.all([
            run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapterPowerManagement | Format-List Name,WakeOnMagicPacket,WakeOnPattern'], InventoryService.parseNicWol),
            run('powercfg.exe', ['/devicequery', 'wake_armed'], InventoryService.parseWakeArmed)
        ]).then(([nicWol, wakeArmed]) => ({ nicWol, wakeArmed }));
    }

    resolveAgentId(settings) {
        if (settings && typeof settings.agentId === 'string' && settings.agentId) {
            return settings.agentId;
        }
        try {
            return `agent-${String(this.os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
        } catch (_) {
            return 'agent-unknown';
        }
    }

    async collect({ force = false } = {}) {
        const settings = this.storage && typeof this.storage.getSettings === 'function'
            ? this.storage.getSettings()
            : {};
        // Ayar değişikliği cache'i geçersiz kılar (rol, agentId, UPS, watt).
        const fingerprint = JSON.stringify({
            agentId: settings.agentId || null,
            deviceRole: settings.deviceRole || null,
            upsEnabled: settings.upsEnabled === true,
            deviceWattage: settings.deviceWattage ?? null
        });
        if (!force && this._cache && this._cache.fingerprint === fingerprint &&
            (Date.now() - this._cache.at) < this._cacheTtlMs) {
            return this._cache.value;
        }
        let username = null;
        try {
            username = this.os.userInfo().username || null;
        } catch (_) { /* hizmet hesabında okunamayabilir */ }
        let osVersion = null;
        try {
            osVersion = typeof this.os.version === 'function' ? this.os.version() : null;
        } catch (_) { /* eski Node */ }
        let cpus = [];
        try {
            cpus = (this.os.cpus() || []).slice(0, 1).map((c) => c.model);
        } catch (_) { /* yok */ }

        const [sleepStates, wol, lockPolicy] = await Promise.all([
            this.getSleepStates(),
            this.getWolDetails(),
            this.getLockPolicy().catch(() => null)
        ]);
        const readiness = InventoryService.wolReadiness({ sleepStates, nicWol: wol.nicWol, wakeArmed: wol.wakeArmed });
        const bootAt = this.getBootAt();
        let ups = null;
        if (settings.upsEnabled && this.upsMonitor && typeof this.upsMonitor.query === 'function') {
            try {
                ups = await this.upsMonitor.query();
            } catch (_) {
                ups = { reachable: false };
            }
        }
        const inv = {
            agentId: this.resolveAgentId(settings),
            hostname: (() => { try { return this.os.hostname(); } catch (_) { return null; } })(),
            username,
            platform: (() => { try { return this.os.platform(); } catch (_) { return null; } })(),
            release: (() => { try { return this.os.release(); } catch (_) { return null; } })(),
            osVersion,
            arch: (() => { try { return this.os.arch(); } catch (_) { return null; } })(),
            cpu: cpus[0] || null,
            deviceRole: settings.deviceRole === 'server' ? 'server' : 'workstation', // FAZ D
            bootAt, // FAZ D: enerji gerçek-ölçümü için açılış damgası
            lockPolicy, // FAZ D: GPO kilit-çatışma rozeti için
            ups, // FAZ D: null = izleme kapalı
            sleepStates,
            nicWol: wol.nicWol,
            wakeArmed: wol.wakeArmed,
            wolReadiness: readiness,
            nics: InventoryService.parseNics((() => { try { return this.os.networkInterfaces(); } catch (_) { return {}; } })()),
            watt: typeof settings.deviceWattage === 'number' ? settings.deviceWattage : null,
            agentVersion: this.agentVersion,
            collectedAt: new Date().toISOString()
        };
        if (this.storage && typeof this.storage.saveInventory === 'function') {
            try { this.storage.saveInventory(inv); } catch (err) { log.warn('[InventoryService] kayıt başarısız:', err && err.message); }
        }
        // FAZ D: açılış geçmişi (enerji gerçek-ölçümü; tekrar kaydı yok).
        if (bootAt && this.storage && typeof this.storage.appendBoot === 'function') {
            try { this.storage.appendBoot(bootAt); } catch (_) { /* best-effort */ }
        }
        // FAZ D: UPS düşük-batarya denetimi (yerel log; konsol rozeti heartbeat ile gider).
        if (ups && (ups.lowBattery || ups.onBattery)) {
            log.warn(`[InventoryService] UPS uyarısı: ${ups.status || 'bilinmiyor'} (şarj %${ups.charge !== null && ups.charge !== undefined ? ups.charge : '?'})`);
        }
        this._cache = { at: Date.now(), fingerprint, value: inv };
        return inv;
    }
}

module.exports = { InventoryService, OFFLINE_THRESHOLD_MS };
