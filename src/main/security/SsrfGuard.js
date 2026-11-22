'use strict';

/**
 * SsrfGuard.js - WP-12.T1/T2
 * Webhook hedeflerini yalnızca genel HTTPS + genel unicast IP ile sınırlar.
 * DNS sonucu pinlenir; `https.request` ikinci kez DNS çözmez.
 */

const dns = require('dns');
const net = require('net');
const { domainToASCII } = require('url');
const ipaddr = require('ipaddr.js');

const ALLOWED_PORTS = new Set(['443', '8443']);

function normalizeHostname (hostname) {
    let host = String(hostname || '').trim().toLowerCase();
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host.endsWith('.')) host = host.slice(0, -1);
    return host;
}

function isPublicIp (ip) {
    if (typeof ip !== 'string' || ip.length === 0) return false;
    if (net.isIPv4(ip) || net.isIPv6(ip)) {
        // devam
    } else {
        return false;
    }
    let addr;
    try {
        addr = ipaddr.parse(ip);
    } catch (_) {
        return false;
    }
    if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
        addr = addr.toIPv4Address();
    }
    // Yalnızca genel unicast. private/loopback/linkLocal/carrierGradeNat/
    // uniqueLocal/reserved/broadcast/unspecified/multicast hepsi reddedilir.
    return addr.range() === 'unicast';
}

function validateUrl (rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch (_) {
        return { ok: false, code: 'SSRF_BLOCKED', reason: 'INVALID_URL' };
    }
    if (url.protocol !== 'https:') {
        return { ok: false, code: 'SSRF_BLOCKED', reason: 'HTTPS_REQUIRED' };
    }
    if (url.username || url.password) {
        return { ok: false, code: 'SSRF_BLOCKED', reason: 'USERINFO_FORBIDDEN' };
    }
    const rawHost = normalizeHostname(url.hostname);
    if (!rawHost) return { ok: false, code: 'SSRF_BLOCKED', reason: 'HOST_REQUIRED' };
    const asciiHost = net.isIP(rawHost) ? rawHost : domainToASCII(rawHost);
    if (!asciiHost) return { ok: false, code: 'SSRF_BLOCKED', reason: 'INVALID_HOST' };
    const port = url.port || '443';
    if (!ALLOWED_PORTS.has(port)) {
        return { ok: false, code: 'SSRF_BLOCKED', reason: 'PORT_FORBIDDEN' };
    }
    return {
        ok: true,
        hostname: asciiHost,
        port: Number(port),
        path: url.pathname + url.search,
        hostHeader: port === '443' ? asciiHost : `${asciiHost}:${port}`
    };
}

class SsrfGuard {
    constructor ({ lookupFn = dns.promises.lookup } = {}) {
        this.lookupFn = lookupFn;
    }

    /**
     * Tüm DNS yanıtları genel unicast olmalıdır. İlk adres pinlenir.
     * @returns {Promise<{ok:true,address:string,family:number}|{ok:false,code:string}>}
     */
    async resolvePublicAddress (hostname) {
        const host = normalizeHostname(hostname);
        if (net.isIP(host)) {
            if (!isPublicIp(host)) return { ok: false, code: 'SSRF_BLOCKED', reason: 'PRIVATE_ADDRESS' };
            return { ok: true, address: host, family: net.isIPv6(host) ? 6 : 4 };
        }
        let records;
        try {
            records = await this.lookupFn(host, { all: true, verbatim: true });
        } catch (_) {
            return { ok: false, code: 'SSRF_BLOCKED', reason: 'DNS_FAILED' };
        }
        if (!Array.isArray(records)) {
            if (records && typeof records.address === 'string') records = [records];
            else return { ok: false, code: 'SSRF_BLOCKED', reason: 'DNS_FAILED' };
        }
        if (records.length === 0) return { ok: false, code: 'SSRF_BLOCKED', reason: 'DNS_EMPTY' };
        for (const rec of records) {
            if (!rec || !isPublicIp(rec.address)) {
                return { ok: false, code: 'SSRF_BLOCKED', reason: 'PRIVATE_ADDRESS' };
            }
        }
        const chosen = records[0];
        return { ok: true, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
    }

    /** `https.request` için sabit IP döndüren lookup. */
    static pinnedLookup (address, family) {
        return (_hostname, options, callback) => {
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }
            if (options && options.all) {
                callback(null, [{ address, family }]);
            } else {
                callback(null, address, family);
            }
        };
    }
}

module.exports = { SsrfGuard, validateUrl, isPublicIp, normalizeHostname, ALLOWED_PORTS };
