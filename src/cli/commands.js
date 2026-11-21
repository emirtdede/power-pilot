/**
 * cli/commands.js
 *
 * CLI komut kataloğu — SAF modül (ağ yok, çıktı yok).
 * `powerpilot.js` bin'i bu katalogu HTTP istemcisine bağlar. Ayrıştırma ve
 * yol kurma burada olduğu için birim testlerinde gerçek API gerekmez.
 *
 * B2: CLI, yerel REST API'nin tüm kullanıcı uçlarını kapsar.
 */

const POWER_ACTIONS = ['lock', 'signout', 'restart', 'sleep', 'hibernate', 'shutdown'];

/**
 * Komut tanımı:
 *  - path(i): istek yolu ('/api/v1' ÖNEKİ OLMADAN)
 *  - method: HTTP metodu
 *  - body(i): istek gövdesi veya null
 *  - format(res): konsola yazılacak metin
 *  - usage: tek satır yardım
 */
const COMMANDS = {
    status: {
        method: 'GET',
        path: () => '/status',
        body: () => null,
        format: (r) => r.body,
        usage: 'Durum ve sürüm bilgisi'
    },
    tasks: {
        method: 'GET',
        path: (i) => {
            const params = new URLSearchParams();
            if (i.flags.limit !== undefined) params.set('limit', String(i.flags.limit));
            if (i.flags.offset !== undefined) params.set('offset', String(i.flags.offset));
            const qs = params.toString();
            return qs ? `/tasks?${qs}` : '/tasks';
        },
        body: () => null,
        format: (r) => r.body,
        usage: 'Görevleri listeler (--limit, --offset)'
    },
    inventory: {
        method: 'GET',
        path: () => '/inventory',
        body: () => null,
        format: (r) => r.body,
        usage: 'Cihaz envanteri (yalnızca Pro)'
    },
    exemptions: {
        method: 'GET',
        path: () => '/exemptions',
        body: () => null,
        format: (r) => r.body,
        usage: 'Güvenlik muafiyetlerini listeler (yalnızca Pro)'
    },
    'maintenance-windows': {
        method: 'GET',
        path: () => '/maintenance-windows',
        body: () => null,
        format: (r) => r.body,
        usage: 'Bakım pencerelerini listeler (yalnızca Pro)'
    },
    audit: {
        method: 'GET',
        path: (i) => {
            const params = new URLSearchParams();
            if (i.flags.limit !== undefined) params.set('limit', String(i.flags.limit));
            if (i.flags.beforeSeq !== undefined) params.set('beforeSeq', String(i.flags.beforeSeq));
            if (i.flags.verify) params.set('verify', '1');
            const qs = params.toString();
            return qs ? `/audit?${qs}` : '/audit';
        },
        body: () => null,
        format: (r) => r.body,
        usage: 'Denetim günlüğü (--limit, --beforeSeq, --verify)'
    },
    'audit-verify': {
        method: 'GET',
        path: () => '/audit/verify',
        body: () => null,
        format: (r) => r.body,
        usage: 'Denetim zinciri bütünlüğünü doğrular'
    },
    timer: {
        method: 'POST',
        path: () => '/tasks/timer',
        body: (i) => {
            // P0-4: Local API `durationMs`'i TAM SAYI bekler. Eski kod `String(...)`
            // gönderdiği için `Number.isInteger("2700000") === false` → her istek 400.
            const raw = i.flags.durationMs !== undefined
                ? i.flags.durationMs
                : (i.flags.minutes !== undefined ? Number(i.flags.minutes) * 60000 : undefined);
            const durationMs = raw === undefined || raw === null || raw === '' ? undefined : Number(raw);
            return {
                action: i.flags.action || 'shutdown',
                ...(Number.isFinite(durationMs) ? { durationMs } : {}),
                ...(i.flags.name ? { name: i.flags.name } : {})
            };
        },
        format: (r) => r.body,
        usage: 'Süreli görev: --action <shutdown|restart|sleep|hibernate|lock|signout> --durationMs <ms> | --minutes <dk> [--name <ad>]'
    },
    cancel: {
        method: 'POST',
        path: (i) => `/tasks/${encodeURIComponent(i.flags.id || '')}/cancel`,
        body: () => null,
        format: (r) => r.body,
        usage: 'Görevi iptal eder: --id <taskId>'
    },
    orders: {
        method: 'GET',
        path: () => '/orders/pending',
        body: () => null,
        format: (r) => r.body,
        usage: 'Bekleyen konsol emirleri (yalnızca Pro)'
    }
};

const FLAG_WITH_VALUE = new Set(['limit', 'offset', 'beforeSeq', 'action', 'durationMs', 'minutes', 'name', 'id']);
const BOOLEAN_FLAGS = new Set(['verify', 'help', 'json']);

/**
 * Ham argv → { command, flags, errors }.
 * Ağ yok; yalnızca sözdizimi. Bilinmeyen bayrak sessizce yutulmaz.
 */
function parseArgs(argv) {
    const args = Array.isArray(argv) ? argv.slice() : [];
    const flags = {};
    const errors = [];
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];
        if (typeof token !== 'string' || token.length === 0) continue;
        if (token === '--help' || token === '-h') { flags.help = true; continue; }
        if (token.startsWith('--')) {
            const eq = token.indexOf('=');
            const rawName = eq === -1 ? token.slice(2) : token.slice(2, eq);
            const name = rawName;
            if (FLAG_WITH_VALUE.has(name)) {
                let value;
                if (eq !== -1) {
                    value = token.slice(eq + 1);
                } else {
                    const next = args[i + 1];
                    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
                        errors.push(`--${name} için değer gerekli`);
                        continue;
                    }
                    value = next;
                    i += 1;
                }
                if (value === '') { errors.push(`--${name} boş olamaz`); continue; }
                flags[name] = value;
            } else if (BOOLEAN_FLAGS.has(name)) {
                flags[name] = eq === -1 ? true : token.slice(eq + 1) !== 'false';
            } else {
                // Gelecekteki bayraklar sessizce yutulmaz: kullanıcı yazım hatasını görür.
                errors.push(`bilinmeyen bayrak: --${name}`);
            }
            continue;
        }
        positional.push(token);
    }

    const command = positional[0] || 'status';
    if (positional.length > 1) errors.push(`fazla argüman: ${positional.slice(1).join(' ')}`);
    return { command, flags, errors };
}

/** Komut → istek tanımı. Bilinmeyen komut null döner. */
function buildRequest(parsed) {
    const { command, flags } = parsed || {};
    if (POWER_ACTIONS.includes(command)) {
        return {
            method: 'POST',
            path: `/power/${command}`,
            body: null,
            format: (r) => r.body
        };
    }
    const def = COMMANDS[command];
    if (!def) return null;
    const input = { command, flags: flags || {} };
    return {
        method: def.method,
        path: def.path(input),
        body: def.body(input),
        format: def.format
    };
}

/**
 * İstek öncesi doğrulama — kullanıcıya ağ beklemeden net hata.
 * @returns {{ok: boolean, error?: string}}
 */
function validate(parsed) {
    if (!parsed) return { ok: false, error: 'Komut tanımsız.' };
    const { command, flags } = parsed;
    if (!POWER_ACTIONS.includes(command) && !COMMANDS[command]) {
        return { ok: false, error: `Bilinmeyen komut: ${command}` };
    }
    if (command === 'timer') {
        if (!POWER_ACTIONS.includes(flags.action || 'shutdown')) {
            return { ok: false, error: `Geçersiz --action: ${flags.action}` };
        }
        const ms = flags.durationMs !== undefined
            ? Number(flags.durationMs)
            : (flags.minutes !== undefined ? Number(flags.minutes) * 60000 : NaN);
        if (!Number.isInteger(ms) || ms <= 0) {
            return { ok: false, error: '--durationMs veya --minutes pozitif tam sayı olmalı (ms / dk)' };
        }
    }
    if (command === 'cancel' && !flags.id) {
        return { ok: false, error: '--id <taskId> gerekli' };
    }
    return { ok: true };
}

function usageText() {
    const lines = [
        'Kullanım: powerpilot <komut> [bayraklar]',
        '',
        'Komutlar:'
    ];
    for (const action of POWER_ACTIONS) {
        lines.push(`  ${action.padEnd(20)} Anında güç eylemi (görev hattından geçer)`);
    }
    for (const [name, def] of Object.entries(COMMANDS)) {
        lines.push(`  ${name.padEnd(20)} ${def.usage}`);
    }
    lines.push('', 'Genel bayraklar: --json (ham JSON), --help');
    return lines.join('\n');
}

/** Yanıtı insan-okur metne çevirir; --json verildiyse ham gövde. */
function renderResponse(req, res, flags = {}) {
    if (flags.json) return JSON.stringify(res.body, null, 2);
    if (res.body && typeof res.body === 'object' && typeof res.body.error === 'string') {
        return `Hata (${res.status}): ${res.body.error}${res.body.code ? ` [${res.body.code}]` : ''}`;
    }
    if (req && typeof req.format === 'function') {
        const out = req.format(res);
        return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    }
    return JSON.stringify(res.body, null, 2);
}

module.exports = {
    POWER_ACTIONS,
    COMMANDS,
    parseArgs,
    buildRequest,
    validate,
    usageText,
    renderResponse
};
