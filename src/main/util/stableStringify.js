/**
 * stableStringify.js - deterministik JSON serileştirme (tek kaynak).
 *
 * Neden: nesne anahtarlarının sırası JavaScript motoruna ve oluşturulma
 * sırasına göre değişebilir. İmza (HMAC/Ed25519) ve idempotency anahtarı
 * hesaplanırken bu sıra sabitlenmezse aynı veri farklı imza üretir.
 *
 * Daha önce bu fonksiyon `src/console/ConsoleStore.js` ve
 * `src/main/storage/MigrateV2.js` içinde birebir kopyalanmıştı (DRY ihlali);
 * iki kopyadan biri değişirse imzalar sessizce uyuşmaz hale gelirdi.
 *
 * Davranış sözleşmesi (kopyalarla birebir aynı):
 *  - null / ilkel değer  → JSON.stringify
 *  - dizi                → öğeler sırayla (sıra korunur)
 *  - nesne               → anahtarlar sıralı, `"k":v` biçiminde
 */

'use strict';

/**
 * @param {unknown} value
 * @returns {string} deterministik JSON metni
 */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

module.exports = { stableStringify };
