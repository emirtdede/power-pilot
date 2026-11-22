/**
 * TemplateService.js - WP-7
 * Kategorize edilmiş 22 hazır otomasyon şablonu + kullanıcı özel şablonları +
 * yerleşik şablon düzenleme (override), silme/gizleme ve varsayılana sıfırlama / geri getirme.
 *
 * Kural: her şablon ya desteklenen bir defaultCondition/defaultConditionGroup,
 * ya schedule.timeOfDay, ya da trigger (duration) içermek zorundadır (ölü şablon yasak).
 */
'use strict';

const os = require('os');
const path = require('path');
const { canonicalProcessName } = require('./processNames');
const { PowerService } = require('./PowerService');

const SUPPORTED_TEMPLATE_CONDITIONS = new Set([
    'process_running', 'cpu_usage', 'user_idle', 'file_stable',
    'directory_idle', 'network_speed', 'disk_activity', 'battery_level'
]);

const TEMPLATE_CATEGORIES = Object.freeze([
    'download',
    'render',
    'gaming',
    'productivity',
    'schedule',
    'power',
    'security',
    'custom'
]);

class TemplateService {
    constructor(storageService = null) {
        this.storage = storageService;
        this.templates = [
            // ── 1. İNDİRME (download) ─────────────────────────────────────────
            {
                id: 'tpl_download_shutdown',
                name: 'İndirme Bitince Kapat',
                description: 'Ağ indirme hızı belirlediğiniz eşiğin altına düştüğünde bilgisayarı güvenle kapatır.',
                action: 'shutdown',
                icon: 'download_done',
                category: 'download',
                defaultCondition: {
                    type: 'network_speed',
                    thresholdKbps: 50,
                    stabilitySeconds: 60
                }
            },
            {
                id: 'tpl_steam_download',
                name: 'Steam İndirmesi Bitince Kapat',
                description: 'Steam çalışırken ağ durulursa (indirme bittiyse) bilgisayarı kapatır.',
                action: 'shutdown',
                icon: 'sports_esports',
                category: 'download',
                defaultConditionGroup: {
                    operator: 'AND',
                    stabilitySeconds: 60,
                    conditions: [
                        { type: 'process_running', processName: 'steam.exe', triggerOnClose: false },
                        { type: 'network_speed', thresholdKbps: 50 }
                    ]
                }
            },
            {
                id: 'tpl_backup_stable',
                name: 'İndirilenler Sabitlenince Kapat',
                description: 'İndirilenler klasörü 5 dakika değişmezse (indirme bittiyse) kapatır. Farklı klasör için şablonu düzenleyin.',
                action: 'shutdown',
                icon: 'folder_copy',
                category: 'download',
                defaultCondition: {
                    type: 'directory_idle',
                    dirPath: path.join(os.homedir(), 'Downloads'),
                    stableSeconds: 300
                }
            },
            {
                id: 'tpl_torrent_complete_shutdown',
                name: 'Ağ ve Disk Durunca Kapat',
                description: 'Hem ağ indirmesi hem disk yazması durduğunda (büyük indirme/arşiv açma bittiğinde) kapatır.',
                action: 'shutdown',
                icon: 'cloud_done',
                category: 'download',
                defaultConditionGroup: {
                    operator: 'AND',
                    stabilitySeconds: 120,
                    conditions: [
                        { type: 'network_speed', thresholdKbps: 80 },
                        { type: 'disk_activity', thresholdKbps: 500 }
                    ]
                }
            },

            // ── 2. RENDER & DERLEME (render) ──────────────────────────────────
            {
                id: 'tpl_render_shutdown',
                name: 'Render Bitince Kapat',
                description: 'HandBrake, Premiere veya Blender gibi render yazılımınız bittiğinde CPU %10 altına düşünce kapatır.',
                action: 'shutdown',
                icon: 'video_settings',
                category: 'render',
                defaultCondition: {
                    type: 'cpu_usage',
                    thresholdPercent: 10,
                    stabilitySeconds: 120
                }
            },
            {
                id: 'tpl_render_sleep',
                name: 'Render Bitince Uyku Modu',
                description: 'Video/3D render sonrası CPU ve disk kullanımı düştüğünde projeyi kaybetmeden uyku moduna alır.',
                action: 'sleep',
                icon: 'movie_filter',
                category: 'render',
                defaultConditionGroup: {
                    operator: 'AND',
                    stabilitySeconds: 90,
                    conditions: [
                        { type: 'cpu_usage', thresholdPercent: 12 },
                        { type: 'disk_activity', thresholdKbps: 500 }
                    ]
                }
            },
            {
                id: 'tpl_disk_copy_shutdown',
                name: 'Büyük Kopyalama / Yedek Bitince Kapat',
                description: 'Harici disk yedeklemesi veya büyük dosya aktarımı bitip disk I/O sakinleşince kapatır.',
                action: 'shutdown',
                icon: 'hard_drive',
                category: 'render',
                defaultCondition: {
                    type: 'disk_activity',
                    thresholdKbps: 300,
                    stabilitySeconds: 90
                }
            },

            // ── 3. OYUN (gaming) ──────────────────────────────────────────────
            {
                id: 'tpl_epic_download_shutdown',
                name: 'Epic Games İndirmesi Bitince Kapat',
                description: 'Epic Games Launcher çalışırken indirme hızı 100 KB/s altına indiğinde kapatır.',
                action: 'shutdown',
                icon: 'stadia_controller',
                category: 'gaming',
                defaultConditionGroup: {
                    operator: 'AND',
                    stabilitySeconds: 90,
                    conditions: [
                        { type: 'process_running', processName: 'epicgameslauncher.exe', triggerOnClose: false },
                        { type: 'network_speed', thresholdKbps: 100 }
                    ]
                }
            },
            {
                id: 'tpl_gaming_idle_sleep',
                name: 'Oyun Sonrası 30 Dk Boşta Uyut',
                description: 'Bilgisayar başında 30 dakika etkileşim olmazsa ekranı ve sistemi uyku moduna alır.',
                action: 'sleep',
                icon: 'gamepad',
                category: 'gaming',
                defaultCondition: {
                    type: 'user_idle',
                    idleSeconds: 1800,
                    stabilitySeconds: 15
                }
            },

            // ── 4. ÜRETKENLİK (productivity) ──────────────────────────────────
            {
                id: 'tpl_focus_lock_30m',
                name: '30 Dakika Sonra Mola Kilidi',
                description: '30 dakikalık odaklanma oturumu bitiminde ekranı otomatik kilitleyerek mola hatırlatır.',
                action: 'lock',
                icon: 'hourglass_top',
                category: 'productivity',
                trigger: { type: 'duration', durationMs: 30 * 60 * 1000 }
            },
            {
                id: 'tpl_workday_end_lock',
                name: 'Hafta İçi 18:30 Ekranı Kilitle',
                description: 'Mesai bitiminde her hafta içi saat 18:30\'da ekranı otomatik kilitler.',
                action: 'lock',
                icon: 'work_history',
                category: 'productivity',
                schedule: { timeOfDay: '18:30', recurrence: 'weekdays' }
            },
            {
                id: 'tpl_obs_stream_sleep',
                name: 'OBS Yayını Kapanınca Uyut',
                description: 'OBS Studio kapandığında sistemi uyku moduna alır.',
                action: 'sleep',
                icon: 'podcasts',
                category: 'productivity',
                defaultCondition: {
                    type: 'process_running',
                    triggerOnClose: true,
                    processName: 'obs64.exe'
                }
            },

            // ── 5. ZAMANLI (schedule) ─────────────────────────────────────────
            {
                id: 'tpl_nightly_sleep',
                name: 'Her Gece 01:00 Uyut',
                description: 'Her gece saat 01:00\u2019de bilgisayarı uyku moduna alır.',
                action: 'sleep',
                icon: 'nightlight',
                category: 'schedule',
                schedule: { timeOfDay: '01:00', recurrence: 'daily' }
            },
            {
                id: 'tpl_nightly_shutdown',
                name: 'Her Gece 02:00 Kapat',
                description: 'Gece açık unutulan bilgisayarları her gün 02:00\'de güvenle kapatır.',
                action: 'shutdown',
                icon: 'power_settings_new',
                category: 'schedule',
                schedule: { timeOfDay: '02:00', recurrence: 'daily' }
            },
            {
                id: 'tpl_weekly_restart',
                name: 'Gece 04:00 Bakım Yeniden Başlat',
                description: 'Güncellemelerin ve belleğin tazelenmesi için saat 04:00\'te yeniden başlatır.',
                action: 'restart',
                icon: 'restart_alt',
                category: 'schedule',
                schedule: { timeOfDay: '04:00', recurrence: 'weekends' }
            },
            {
                id: 'tpl_timer_60m_sleep',
                name: '1 Saat Sonra Uyut',
                description: 'Video veya müzik dinlerken 60 dakika sonra bilgisayarı otomatik uyutur.',
                action: 'sleep',
                icon: 'snooze',
                category: 'schedule',
                trigger: { type: 'duration', durationMs: 60 * 60 * 1000 }
            },
            {
                id: 'tpl_timer_120m_shutdown',
                name: '2 Saat Sonra Kapat',
                description: '2 saatlik geri sayım bitiminde bilgisayarı güvenle kapatır.',
                action: 'shutdown',
                icon: 'timer',
                category: 'schedule',
                trigger: { type: 'duration', durationMs: 120 * 60 * 1000 }
            },

            // ── 6. GÜÇ & PİL (power) ──────────────────────────────────────────
            {
                id: 'tpl_idle_sleep',
                name: 'Gece Boşta Kalırsa Uyut',
                description: 'Klavye ve fare 15 dakika boyunca kullanılmazsa bilgisayarı uyku moduna alır.',
                action: 'sleep',
                icon: 'bedtime',
                category: 'power',
                defaultCondition: {
                    type: 'user_idle',
                    idleSeconds: 900,
                    stabilitySeconds: 10
                }
            },
            {
                id: 'tpl_battery_hibernate',
                name: 'Pil Azalınca Hazırda Beklet',
                description: 'Batarya %20\u2019nin altına düşünce oturumu diske kaydedip bekletir.',
                action: 'hibernate',
                icon: 'battery_alert',
                category: 'power',
                defaultCondition: {
                    type: 'battery_level',
                    belowPercent: 20,
                    stabilitySeconds: 30
                }
            },

            // ── 7. GÜVENLİK (security) ────────────────────────────────────────
            {
                id: 'tpl_process_lock',
                name: 'Chrome Kapanınca Kilitle',
                description: 'Chrome tarayıcısı kapandığında ekranı otomatik kilitler. Farklı bir uygulama için şablonu düzenleyin.',
                action: 'lock',
                icon: 'lock',
                category: 'security',
                defaultCondition: {
                    type: 'process_running',
                    triggerOnClose: true,
                    processName: 'chrome.exe'
                }
            },
            {
                id: 'tpl_meeting_lock',
                name: 'Toplantı Bitince Kilitle',
                description: 'Zoom veya Teams kapandığında ekranı otomatik kilitler.',
                action: 'lock',
                icon: 'video_call',
                category: 'security',
                defaultCondition: {
                    type: 'process_running',
                    triggerOnClose: true,
                    processName: 'zoom.exe'
                }
            },
            {
                id: 'tpl_presentation_lock',
                name: 'Sunum Kapanınca Kilitle',
                description: 'PowerPoint kapandığında (sunum bittiyse) ekranı kilitler.',
                action: 'lock',
                icon: 'present_to_all',
                category: 'security',
                defaultCondition: {
                    type: 'process_running',
                    triggerOnClose: true,
                    processName: 'powerpnt.exe'
                }
            }
        ];
    }

    static getCategories() {
        return [...TEMPLATE_CATEGORIES];
    }

    static isSupportedCondition(type) {
        return SUPPORTED_TEMPLATE_CONDITIONS.has(type);
    }

    static isRunnableCondition(cond) {
        if (!cond || typeof cond !== 'object' || !TemplateService.isSupportedCondition(cond.type)) return false;
        if (cond.type === 'process_running') return canonicalProcessName(cond.processName).length > 0;
        if (cond.type === 'file_stable') return typeof cond.filePath === 'string' && cond.filePath.trim().length > 0;
        if (cond.type === 'directory_idle') return typeof (cond.dirPath || cond.filePath) === 'string' && String(cond.dirPath || cond.filePath).trim().length > 0;
        if (cond.type === 'cpu_usage') {
            return cond.thresholdPercent == null || (typeof cond.thresholdPercent === 'number' && cond.thresholdPercent >= 0 && cond.thresholdPercent <= 100);
        }
        if (cond.type === 'user_idle') {
            return cond.idleSeconds == null || (Number.isInteger(cond.idleSeconds) && cond.idleSeconds >= 1);
        }
        if (cond.type === 'network_speed' || cond.type === 'disk_activity') {
            return cond.thresholdKbps == null || (typeof cond.thresholdKbps === 'number' && cond.thresholdKbps >= 0);
        }
        if (cond.type === 'battery_level') {
            return cond.belowPercent != null || cond.abovePercent != null;
        }
        return true;
    }

    // Şablon geçerliliği: koşul destekli, saatli zamanlama YA DA süreli (duration) olmalı.
    static isValidTemplate(tpl) {
        if (!tpl || typeof tpl !== 'object') return false;
        if (typeof tpl.id !== 'string' || typeof tpl.name !== 'string' || typeof tpl.action !== 'string') return false;
        if (!PowerService.isValidAction(tpl.action)) return false;
        if (tpl.name.trim().length === 0 || tpl.name.length > 80) return false;
        const cond = tpl.defaultCondition;
        const group = tpl.defaultConditionGroup;
        const sched = tpl.schedule;
        const trig = tpl.trigger;
        if (cond && TemplateService.isRunnableCondition(cond)) return true;
        if (group && Array.isArray(group.conditions) && group.conditions.length > 0 &&
            group.conditions.every((c) => TemplateService.isRunnableCondition(c))) return true;
        if (sched && typeof sched.timeOfDay === 'string' && /^([01]\d|2[0-3]):([0-5]\d)$/.test(sched.timeOfDay)) return true;
        if (trig && trig.type === 'duration' && Number.isInteger(trig.durationMs) && trig.durationMs >= 60000 && trig.durationMs <= 2500000000) return true;
        return false;
    }

    isBuiltInId(id) {
        return this.templates.some((t) => t.id === id);
    }

    getBuiltInById(id) {
        const hit = this.templates.find((t) => t.id === id);
        return hit ? JSON.parse(JSON.stringify(hit)) : null;
    }

    _readSettings() {
        if (!this.storage || typeof this.storage.getSettings !== 'function') return {};
        try {
            return this.storage.getSettings() || {};
        } catch (_) {
            return {};
        }
    }

    getHiddenBuiltInIds() {
        const s = this._readSettings();
        const raw = Array.isArray(s.hiddenBuiltInTemplates) ? s.hiddenBuiltInTemplates : [];
        return raw.filter((id) => this.isBuiltInId(id));
    }

    getBuiltInOverrides() {
        const s = this._readSettings();
        return (s.templateOverrides && typeof s.templateOverrides === 'object' && !Array.isArray(s.templateOverrides))
            ? s.templateOverrides
            : {};
    }

    getHiddenBuiltIns() {
        const hiddenSet = new Set(this.getHiddenBuiltInIds());
        return this.templates
            .filter((t) => hiddenSet.has(t.id))
            .map((t) => ({ ...t, builtIn: true, hidden: true }));
    }

    getTemplates({ includeHidden = false } = {}) {
        const hiddenSet = new Set(this.getHiddenBuiltInIds());
        const overrides = this.getBuiltInOverrides();

        const builtIns = [];
        for (const base of this.templates) {
            const isHidden = hiddenSet.has(base.id);
            if (isHidden && !includeHidden) continue;
            const ov = overrides[base.id];
            if (ov && TemplateService.isValidTemplate({ ...ov, id: base.id })) {
                builtIns.push({
                    ...ov,
                    id: base.id,
                    builtIn: true,
                    modified: true,
                    ...(isHidden ? { hidden: true } : {})
                });
            } else {
                builtIns.push({
                    ...base,
                    builtIn: true,
                    modified: false,
                    ...(isHidden ? { hidden: true } : {})
                });
            }
        }

        const customs = this.storage && typeof this.storage.getTemplates === 'function'
            ? this.storage.getTemplates()
            : [];
        const quarantined = (customs || []).map((tpl) => {
            if (TemplateService.isValidTemplate(tpl)) return { ...tpl, custom: true, builtIn: false };
            return { ...tpl, custom: true, builtIn: false, disabled: true, disabledReason: 'Geçersiz şablon kaydı (karantina)' };
        });

        return [...builtIns, ...quarantined];
    }
}

module.exports = TemplateService;
module.exports.TEMPLATE_CATEGORIES = TEMPLATE_CATEGORIES;
module.exports.SUPPORTED_TEMPLATE_CONDITIONS = SUPPORTED_TEMPLATE_CONDITIONS;
