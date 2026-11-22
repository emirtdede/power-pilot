/**
 * agents/energyAgent.js - F9.1 + WP-8
 * Deterministik enerji anlatıcısı (TR / EN): SAYILAR şablondan değişmez alınır.
 */
'use strict';

module.exports = {
    id: 'energy',
    version: '1.0.0',
    description: 'Tasarruf sayılarını aktif dilde cümleye döker, tek kural önerir.',
    async execute({ stats, language = 'tr' }) {
        const isTr = String(language || 'tr').toLowerCase().startsWith('tr');
        if (!stats || stats.enabled === false) {
            return {
                ok: true,
                summary: isTr ? 'İstatistikler kapalı.' : 'Statistics are disabled.',
                suggestion: null
            };
        }
        // WBS-E7: Eksik veri cümleye girmez, sayı uydurulmaz.
        const hours = stats.preventedUptimeHours || '0.0';
        const parts = [
            isTr
                ? `Şimdiye kadar ${hours} saat boşa çalışmayı önledin`
                : `You have prevented ${hours} hours of idle runtime so far`
        ];
        if (stats.kwhSaved != null) parts.push(`${stats.kwhSaved} kWh`);
        if (stats.costSavedFormatted) {
            parts.push(isTr ? `${stats.costSavedFormatted} tasarruf` : `${stats.costSavedFormatted} saved`);
        }
        const summary = parts.join(' - ') + '.';
        let suggestion = null;
        if (parseFloat(stats.preventedUptimeHours) >= 5) {
            suggestion = {
                templateId: 'tpl_nightly_sleep',
                text: isTr
                    ? 'Gece boştayken otomatik uyku kuralı kuralım mı? (Her gece 01:00)'
                    : 'Would you like to schedule an automatic nightly sleep rule? (Every night at 01:00)'
            };
        }
        return { ok: true, summary, suggestion };
    }
};
