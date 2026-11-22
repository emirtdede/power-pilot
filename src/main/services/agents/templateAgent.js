/**
 * agents/templateAgent.js - WP-8
 * Doğal dil (TR + EN) girdisinden doğrulanmış Power Pilot Otomasyon Şablonu
 * önerisi üretir. Sadece taslak öneri döndürür; kullanıcı onaylamadan diske yazmaz.
 */
'use strict';

const DeterministicParser = require('../DeterministicParser');
const TemplateService = require('../TemplateService');
const { isNegated } = require('../NegationGuard');

const EN_ACTION_PATTERNS = [
    { action: 'restart', re: /\b(restart|reboot)\b/i },
    { action: 'hibernate', re: /\bhibernate\b/i },
    { action: 'sleep', re: /\b(sleep|suspend)\b/i },
    { action: 'lock', re: /\block\b/i },
    { action: 'signout', re: /\b(sign\s*out|log\s*out|logout)\b/i },
    { action: 'shutdown', re: /\b(shut\s*down|shutdown|power\s*off|turn\s*off)\b/i }
];

function detectAction(text) {
    const lower = String(text || '').toLocaleLowerCase('tr');
    const tr = DeterministicParser.findAction(lower);
    if (tr) return tr;
    for (const { action, re } of EN_ACTION_PATTERNS) {
        if (re.test(lower)) return action;
    }
    return null;
}

function detectEnDurationMs(text) {
    const lower = String(text || '').toLowerCase();
    let total = 0;
    const patterns = [
        { mult: 3600000, re: /(\d+(?:[.,]\d+)?)\s*(?:hours?|hrs?|h)\b/gi },
        { mult: 60000, re: /(\d+(?:[.,]\d+)?)\s*(?:minutes?|mins?|m)\b/gi },
        { mult: 1000, re: /(\d+(?:[.,]\d+)?)\s*(?:seconds?|secs?|s)\b/gi }
    ];
    for (const { mult, re } of patterns) {
        let m;
        while ((m = re.exec(lower)) !== null) {
            const v = parseFloat(m[1].replace(',', '.'));
            if (Number.isFinite(v) && v > 0) total += Math.round(v * mult);
        }
    }
    return total > 0 && total <= 2500000000 ? total : null;
}

function detectCondition(text) {
    const lower = String(text || '').toLocaleLowerCase('tr');
    const trCond = DeterministicParser.parseCondition(lower);
    if (trCond) return trCond;

    // Disk / kopyalama / yedek
    if (/(disk|kopyalama|copy|i\/o|io\b)/.test(lower) && /(bitince|durunca|d[üu][şs][üu]nce|below|finish|idle|drops)/.test(lower)) {
        const kbps = lower.match(/(\d+)\s*(kb\/s|kbps|mb\/s|mbps)/i);
        let thresholdKbps = 500;
        if (kbps) {
            const v = parseInt(kbps[1], 10);
            thresholdKbps = /mb/i.test(kbps[2]) ? v * 1024 : v;
        }
        return { type: 'disk_activity', thresholdKbps, stabilitySeconds: 60 };
    }
    // Boşta / idle
    if (/(bo[şs]ta|idle|inactive|hareketsiz)/.test(lower)) {
        const durMs = DeterministicParser.parseDurationMs(lower) || detectEnDurationMs(lower) || 15 * 60000;
        const idleSeconds = Math.max(60, Math.min(86400, Math.round(durMs / 1000)));
        return { type: 'user_idle', idleSeconds, stabilitySeconds: 10 };
    }
    // EN download / network
    if (/(download|network|internet|wifi)/.test(lower) && /(finish|done|below|drop|idle|complete)/.test(lower)) {
        const kbps = lower.match(/(\d+)\s*(kb\/s|kbps)/i);
        return { type: 'network_speed', thresholdKbps: kbps ? parseInt(kbps[1], 10) : 50, stabilitySeconds: 60 };
    }
    // EN cpu / render
    if (/(render|cpu|compile|build)/.test(lower) && /(finish|done|below|drop|idle|complete|bitince|durunca)/.test(lower)) {
        const pct = lower.match(/(\d{1,2})\s*%/);
        return { type: 'cpu_usage', thresholdPercent: pct ? parseInt(pct[1], 10) : 10, stabilitySeconds: 120 };
    }
    // EN battery
    if (/battery/.test(lower)) {
        const pct = lower.match(/(\d{1,3})\s*%/);
        return { type: 'battery_level', belowPercent: pct ? Math.min(99, Math.max(5, parseInt(pct[1], 10))) : 20, stabilitySeconds: 30 };
    }
    // EN process closes
    const procEn = lower.match(/(?:when|after)\s+([a-z0-9_.-]+(?:\.exe)?)\s+(?:closes|exits|finishes|stops)/i);
    if (procEn) {
        const raw = procEn[1];
        const proc = raw.endsWith('.exe') ? raw : `${raw}.exe`;
        return { type: 'process_running', processName: proc, triggerOnClose: true };
    }
    return null;
}

function detectSchedule(text) {
    const lower = String(text || '').toLocaleLowerCase('tr');
    const hm = lower.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
    if (!hm) return null;
    const hh = String(parseInt(hm[1], 10)).padStart(2, '0');
    const mm = hm[2];
    let recurrence = 'daily';
    if (/(hafta\s*i[çc]i|weekday|workday)/i.test(lower)) recurrence = 'weekdays';
    else if (/(hafta\s*sonu|weekend)/i.test(lower)) recurrence = 'weekends';
    return { timeOfDay: `${hh}:${mm}`, recurrence };
}

function inferCategoryAndIcon(tpl) {
    if (tpl.schedule) return { category: 'schedule', icon: 'schedule' };
    if (tpl.trigger && tpl.trigger.type === 'duration') return { category: 'schedule', icon: 'timer' };
    const c = tpl.defaultCondition;
    if (!c) return { category: 'custom', icon: 'auto_awesome' };
    if (c.type === 'network_speed' || c.type === 'directory_idle') return { category: 'download', icon: 'download_done' };
    if (c.type === 'cpu_usage' || c.type === 'disk_activity') return { category: 'render', icon: 'video_settings' };
    if (c.type === 'battery_level') return { category: 'power', icon: 'battery_alert' };
    if (c.type === 'user_idle') return { category: 'power', icon: 'bedtime' };
    if (c.type === 'process_running') {
        if (/steam|epic|game|riot|battle/i.test(c.processName || '')) return { category: 'gaming', icon: 'sports_esports' };
        return tpl.action === 'lock' ? { category: 'security', icon: 'lock' } : { category: 'productivity', icon: 'terminal' };
    }
    return { category: 'custom', icon: 'bookmark' };
}

function extractCustomName(text) {
    const quoted = String(text || '').match(/["“']([^"”']{2,60})["”']/);
    if (quoted) return quoted[1].trim();
    const namedTr = String(text || '').match(/(?:ad[ıi]\s+|ismi\s+)([^\n,;.]{2,50})/i);
    if (namedTr) return namedTr[1].trim();
    return null;
}

function buildAutoName(tpl, lang = 'tr') {
    const isTr = String(lang || 'tr').toLowerCase().startsWith('tr');
    const actTr = { shutdown: 'Kapat', restart: 'Yeniden Başlat', sleep: 'Uyut', hibernate: 'Hazırda Beklet', lock: 'Kilitle', signout: 'Oturumu Kapat' };
    const actEn = { shutdown: 'Shutdown', restart: 'Restart', sleep: 'Sleep', hibernate: 'Hibernate', lock: 'Lock', signout: 'Sign Out' };
    const act = (isTr ? actTr : actEn)[tpl.action] || tpl.action;

    if (tpl.schedule) {
        return isTr ? `${tpl.schedule.timeOfDay} ${act}` : `${act} at ${tpl.schedule.timeOfDay}`;
    }
    if (tpl.trigger && tpl.trigger.type === 'duration') {
        const mins = Math.max(1, Math.round(tpl.trigger.durationMs / 60000));
        return isTr ? `${mins} Dk Sonra ${act}` : `${act} in ${mins}m`;
    }
    const c = tpl.defaultCondition;
    if (c) {
        if (c.type === 'network_speed') return isTr ? `İndirme Bitince ${act}` : `${act} After Download`;
        if (c.type === 'cpu_usage') return isTr ? `Render / CPU Bitince ${act}` : `${act} When CPU Idle`;
        if (c.type === 'disk_activity') return isTr ? `Disk İşlemi Bitince ${act}` : `${act} After Disk I/O`;
        if (c.type === 'user_idle') return isTr ? `Boşta Kalınca ${act}` : `${act} When Idle`;
        if (c.type === 'battery_level') return isTr ? `Pil %${c.belowPercent} Altında ${act}` : `${act} Below ${c.belowPercent}% Battery`;
        if (c.type === 'process_running') return isTr ? `${c.processName} Kapanınca ${act}` : `${act} When ${c.processName} Exits`;
        if (c.type === 'file_stable' || c.type === 'directory_idle') return isTr ? `Dosya Sabitlenince ${act}` : `${act} When File Stable`;
    }
    return isTr ? `Özel ${act} Şablonu` : `Custom ${act} Template`;
}

module.exports = {
    id: 'template',
    version: '1.0.0',
    description: 'Doğal dilden doğrulanmış otomasyon şablonu taslağı üretir.',

    async execute({ text, language = 'tr' }) {
        const raw = String(text || '').trim();
        const isTr = String(language || 'tr').toLowerCase().startsWith('tr');
        if (!raw) {
            return {
                ok: false,
                code: 'EMPTY',
                message: isTr ? 'Lütfen oluşturmak istediğiniz şablonu tarif edin.' : 'Please describe the template you want to create.'
            };
        }
        if (isNegated(raw)) {
            return {
                ok: false,
                code: 'NEGATED_INTENT',
                message: isTr
                    ? 'Cümlede olumsuzluk var; şablon oluşturulmadı. Lütfen istediğiniz eylemi netleştirin.'
                    : 'Negated intent detected; no template was drafted. Please clarify the desired action.'
            };
        }

        const action = detectAction(raw);
        if (!action) {
            return {
                ok: true,
                kind: 'clarify',
                needsClarification: {
                    missingFields: ['action'],
                    question: isTr
                        ? 'Bu şablon hangi güç eylemini yapsın? (kapat, uyut, hazırda beklet, kilitle, yeniden başlat)'
                        : 'Which power action should this template perform? (shutdown, sleep, hibernate, lock, restart)'
                }
            };
        }

        const schedule = detectSchedule(raw);
        const condition = !schedule ? detectCondition(raw) : null;
        const durationMs = (!schedule && !condition)
            ? (DeterministicParser.parseDurationMs(raw.toLocaleLowerCase('tr')) || detectEnDurationMs(raw))
            : null;

        if (!schedule && !condition && !durationMs) {
            return {
                ok: true,
                kind: 'clarify',
                needsClarification: {
                    missingFields: ['trigger'],
                    question: isTr
                        ? 'Şablon ne zaman tetiklensin? (örn. "indirme bitince", "her gece 23:30", "45 dakika sonra", "pil %20 altına düşünce")'
                        : 'When should the template trigger? (e.g., "after download finishes", "every night at 23:30", "in 45 minutes", "below 20% battery")'
                }
            };
        }

        const draft = {
            id: `user_tpl_preview_${Date.now()}`,
            action,
            ...(condition ? { defaultCondition: condition } : {}),
            ...(schedule ? { schedule } : {}),
            ...(durationMs ? { trigger: { type: 'duration', durationMs } } : {})
        };
        const { category, icon } = inferCategoryAndIcon(draft);
        draft.category = category;
        draft.icon = icon;
        draft.name = (extractCustomName(raw) || buildAutoName(draft, language)).slice(0, 80);
        draft.description = raw.slice(0, 180);

        if (!TemplateService.isValidTemplate(draft)) {
            return {
                ok: false,
                code: 'INVALID_TEMPLATE_DRAFT',
                message: isTr ? 'Geçerli bir şablon koşulu veya zamanlaması çıkarılamadı.' : 'Could not build a valid template condition or schedule.'
            };
        }

        const { id: _previewId, ...saveable } = draft;
        void _previewId;
        return {
            ok: true,
            agentId: 'template',
            kind: 'template_proposal',
            templateProposal: saveable,
            summary: isTr
                ? `"${saveable.name}" şablonu hazırlandı. Onayladığınızda Şablonlar listenize kaydedilecek.`
                : `Template "${saveable.name}" is ready. Confirm to save it to your Templates library.`
        };
    }
};
