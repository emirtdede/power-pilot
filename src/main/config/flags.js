/**
 * flags.js - WP-00.T4
 * Derleme zamanı sabitleri. Bunlar çalışma zamanında DEĞİŞTİRİLEMEZ ve
 * güvenlik davranışını eski (açık) kipe döndüren bir anahtar YOKTUR.
 *
 * İlke: eski davranışa dönüş yalnızca önceki ikili + yedek veri ile yapılır.
 */

const FLAGS = Object.freeze({
    ORDER_PROTOCOL: 2,
    STORAGE_ENGINE: 'sqlite',
    CONSOLE_STORAGE: 'sqlite',
    CSP_MODE: 'enforce',
    // Emir zarfı / TTL sınırları (ADR-01, ADR-12)
    ORDER_TTL_MS: 10 * 60 * 1000,
    ORDER_MAX_CLOCK_SKEW_MS: 120 * 1000,
    // Gövde sınırları
    LOCAL_API_MAX_BODY_BYTES: 100 * 1024,
    CONSOLE_MAX_BODY_BYTES: 1024 * 1024,
    AI_PARSE_MAX_CHARS: 4000,
    // Zamanlayıcı köprüsü
    SCHEDULER_MIN_LEAD_MS: 60000,
    SCHEDULER_TIMEOUT_MS: 15000
});

module.exports = { FLAGS };
