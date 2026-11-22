/**
 * run.js - FAZ B konsol sunucusu giriş noktası (şirket sunucusunda çalışır).
 *   set CONSOLE_ADMIN_KEY=... (gerekli)
 *   set CONSOLE_OPERATOR_KEY=... (opsiyonel)
 *   set CONSOLE_VIEWER_KEY=... (opsiyonel)
 *   set CONSOLE_AGENT_KEY=... (gerekli - ajan heartbeat anahtarı)
 *   set CONSOLE_PORT=8443 / CONSOLE_HOST=0.0.0.0 / CONSOLE_STORE=./data/console.json
 *   TLS (WP-02): CONSOLE_CERT_FILE + CONSOLE_KEY_FILE (veya CONSOLE_PFX_FILE) zorunlu.
 *   Yalnızca geliştirme: CONSOLE_HOST=127.0.0.1 + PP_ALLOW_INSECURE_CONSOLE=1.
 *   node src/console/run.js
 */
const path = require('path');
const { ConsoleServer, hashKey } = require('./ConsoleServer');
const { runBackup } = require('../main/storage/DbWorker');

function need(name) {
    const v = process.env[name];
    if (!v) {
        // eslint-disable-next-line no-console
        console.error(`[Console] ${name} tanımlı değil. Çıkılıyor.`);
        process.exit(1);
    }
    return v;
}

// K-02: ortak ajan anahtarı kaldırıldı. Ajanlar `POST /api/v1/keys` ile
// agentId'ye bağlı kendi anahtarlarını alır. Geçiş dönemi için eski ortam
// anahtarı yalnızca CONSOLE_AGENT_ID ile açıkça bağlanırsa kabul edilir.
const keys = { admin: hashKey(need('CONSOLE_ADMIN_KEY')) };
if (process.env.CONSOLE_OPERATOR_KEY) keys.operator = hashKey(process.env.CONSOLE_OPERATOR_KEY);
if (process.env.CONSOLE_VIEWER_KEY) keys.viewer = hashKey(process.env.CONSOLE_VIEWER_KEY);
if (process.env.CONSOLE_AGENT_KEY) {
    const agentId = process.env.CONSOLE_AGENT_ID;
    if (!agentId) {
        // eslint-disable-next-line no-console
        console.error('[Console] CONSOLE_AGENT_KEY artık CONSOLE_AGENT_ID olmadan kullanılamaz. Ajan başına anahtar üretin.');
        process.exit(1);
    }
    keys.agent = {
        hash: hashKey(process.env.CONSOLE_AGENT_KEY),
        role: 'agent',
        keyId: 'legacy-env-agent',
        agentId,
        notAfter: null
    };
    // eslint-disable-next-line no-console
    console.warn(`[Console] Geçiş modu: CONSOLE_AGENT_KEY yalnızca "${agentId}" ajanına bağlı.`);
}

const storePath = process.env.CONSOLE_STORE || path.join(__dirname, '..', '..', 'data', 'console.json');
const srv = new ConsoleServer({ storePath, keys });

const tlsSettings = {
    consoleTlsEnabled: process.env.CONSOLE_TLS_ENABLED !== 'false',
    consoleCertFile: process.env.CONSOLE_CERT_FILE || null,
    consoleKeyFile: process.env.CONSOLE_KEY_FILE || null,
    consoleCaFile: process.env.CONSOLE_CA_FILE || null,
    consolePfxFile: process.env.CONSOLE_PFX_FILE || null,
    consolePfxPassphrase: process.env.CONSOLE_PFX_PASSPHRASE || null,
    consoleRequireClientCert: process.env.CONSOLE_REQUIRE_CLIENT_CERT === '1',
    consoleTlsStrict: process.env.CONSOLE_TLS_STRICT === '1'
};

try {
    srv.start(
        Number(process.env.CONSOLE_PORT || 8443),
        process.env.CONSOLE_HOST || '0.0.0.0',
        tlsSettings
    );
} catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[Console] Başlatılamadı: ${(err && err.code) || ''} ${err && err.message}`);
    process.exit(1);
}

let stopping = false;
async function shutdown() {
    if (stopping) return;
    stopping = true;
    await srv.stop().catch(() => {});
    try { srv.close(); } catch (_) { /* yut */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// WP-03.T8: günlük VACUUM INTO + AES-256-GCM yedeği; anahtar SecretStore
// dışında yalnızca ortam değişkeninden alınır (komut satırına yazılmaz).
const backupKey = process.env.CONSOLE_BACKUP_KEY || process.env.PP_BACKUP_KEY || null;
if (!backupKey) {
    // eslint-disable-next-line no-console
    console.warn('[Console] CONSOLE_BACKUP_KEY tanımsız; otomatik yedek devre dışı.');
} else {
    const runBackupOnce = async () => {
        if (srv.maintenanceMode || !srv.consoleStore.enabled) return;
        try {
            const result = await runBackup({
                dbPath: srv.consoleStore.dbPath,
                backupDir: path.join(path.dirname(srv.consoleStore.dbPath), 'backups'),
                key: backupKey,
                prefix: 'console',
                keep: 7,
                keepDays: 7
            });
            // eslint-disable-next-line no-console
            console.log(`[Console] Yedek alındı: ${path.basename(result.path)}`);
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[Console] Yedek başarısız:', (err && err.message) || err);
        }
    };
    setTimeout(runBackupOnce, 5 * 60 * 1000).unref?.();
    setInterval(runBackupOnce, 24 * 60 * 60 * 1000).unref?.();
}
