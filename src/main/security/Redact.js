/**
 * Redact.js - WP-04.T6
 * Log/denetim kayıtlarında sır alanlarını ve gömülü kimlik bilgilerini maskeler.
 * Kural: bilinmeyen nesnelerde derin kopya; hassas anahtar adları ve
 * "authorization: ...", "pin=...", PEM blokları metin içinde de maskelenir.
 */

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(^|[_.-])(key|secret|token|pem|pin|password|passphrase|authorization|bearer|hmac|apikey|api_key|credential|private)([_.-]|$)/i;
const MAX_DEPTH = 8;
const MAX_ARRAY = 200;

function redactText(value) {
    let s = String(value);
    s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PEM]');
    s = s.replace(/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, (_m, prefix) => `${prefix}${REDACTED}`);
    s = s.replace(/\b(pin|token|secret|password|passphrase|api[_-]?key|hmac)\b(\s*[:=]\s*)([^\s,;"']+)/gi, (_m, name, sep) => `${name}${sep}${REDACTED}`);
    return s;
}

function shouldMaskKey(key) {
    if (typeof key !== 'string') return false;
    if (key === 'hasSecret') return false;
    if (SENSITIVE_KEY.test(key)) return true;
    // camelCase: privateKey -> private_key, clientSecret -> client_secret.
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return normalized !== key && SENSITIVE_KEY.test(normalized);
}

function redact(value, depth = 0) {
    if (value == null) return value;
    if (typeof value === 'string') return redactText(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
    if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
    if (value instanceof Error) {
        return { name: value.name, message: redactText(value.message), code: value.code || null };
    }
    if (Buffer.isBuffer(value)) return `[Buffer ${value.length}B]`;
    if (depth >= MAX_DEPTH) return '[DEPTH_LIMIT]';
    if (Array.isArray(value)) {
        return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (shouldMaskKey(k)) {
            out[k] = v == null || v === '' ? v : REDACTED;
        } else {
            out[k] = redact(v, depth + 1);
        }
    }
    return out;
}

module.exports = { redact, redactText, shouldMaskKey, REDACTED };
