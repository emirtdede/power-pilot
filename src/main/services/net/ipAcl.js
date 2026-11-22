/**
 * ipAcl.js - LAN erişim kontrolü (WP-01).
 *
 * Kurallar:
 *  - Yalnızca IP ve CIDR kabul edilir (hostname yok; DNS rebinding riski).
 *  - Loopback her zaman açıktır (127.0.0.0/8, ::1).
 *  - LAN modunda boş liste = loopback dışındaki herkes reddedilir (fail-closed).
 *  - IPv4-mapped IPv6 (::ffff:192.168.1.10) IPv4'e normalize edilir.
 *  - Zone ID (fe80::1%eth0) güvenli biçimde ayrılır.
 */

const ipaddr = require('ipaddr.js');

function stripZone(raw) {
    const s = String(raw || '').trim();
    // Zone ID adres ile prefix arasındadır: fe80::1%eth0/64 → fe80::1/64.
    // Eski davranış '%' sonrasını tamamen atıp CIDR'ı IP'ye düşürüyordu.
    return s.replace(/%[^/]*/, '');
}

function normalizeAddress(raw) {
    const s = stripZone(raw);
    if (!s) return null;
    try {
        // process() IPv4-mapped IPv6 adreslerini IPv4'e çevirir.
        return ipaddr.process(s);
    } catch (_) {
        return null;
    }
}

function normalizeCidr(raw) {
    const s = stripZone(raw);
    if (!s || !s.includes('/')) return null;
    try {
        const [addr, prefix] = ipaddr.parseCIDR(s);
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
            // Yalnızca ::ffff:0:0/96 ve daha dar aralıklar IPv4'e indirgenebilir.
            // /96'dan geniş bir blok IPv4-mapped olmayan adresleri de kapsar;
            // 0.0.0.0/0'a çevirmek fail-open olurdu.
            if (prefix < 96) return null;
            const v4 = addr.toIPv4Address();
            return { addr: v4, prefix: prefix - 96 };
        }
        return { addr, prefix };
    } catch (_) {
        return null;
    }
}

function parseRule(rule) {
    if (typeof rule !== 'string') return null;
    const s = stripZone(rule);
    if (!s) return null;
    if (s.includes('/')) {
        const cidr = normalizeCidr(s);
        return cidr ? { kind: 'cidr', addr: cidr.addr, prefix: cidr.prefix } : null;
    }
    const addr = normalizeAddress(s);
    return addr ? { kind: 'ip', addr } : null;
}

function isLoopback(addr) {
    if (!addr) return false;
    try {
        return addr.range() === 'loopback';
    } catch (_) {
        return false;
    }
}

function isAllowed(rawRemote, rules) {
    const remote = normalizeAddress(rawRemote);
    if (!remote) return false;
    if (isLoopback(remote)) return true;
    if (!Array.isArray(rules)) return false;

    for (const rawRule of rules) {
        const rule = parseRule(rawRule);
        if (!rule) continue;
        if (rule.kind === 'ip') {
            if (rule.addr.kind() === remote.kind() &&
                rule.addr.toString() === remote.toString()) {
                return true;
            }
            continue;
        }
        if (rule.addr.kind() !== remote.kind()) continue;
        try {
            if (remote.match(rule.addr, rule.prefix)) return true;
        } catch (_) {
            // Bozuk kural tek başına isteği çökertmez.
        }
    }
    return false;
}

module.exports = {
    stripZone,
    normalizeAddress,
    normalizeCidr,
    parseRule,
    isLoopback,
    isAllowed
};
