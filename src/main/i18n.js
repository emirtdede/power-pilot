'use strict';

/**
 * Main-process i18n loader - WP-14.T3.
 *
 * Yalnızca aktif dilin `<lang>.server.json` dosyası okunur (vm yok).
 * Eksik anahtar önce Türkçe sözlükten (tembel, tek seferlik) tamamlanır;
 * o da yoksa anahtarın kendisi döner ve uyarı yazılır.
 */

const fs = require('fs');
const path = require('path');
const log = require('./logger');

const LOCALE_DIR = path.join(__dirname, 'locales');
// Şu an eksiksiz çevirisi diskte bulunan 17 dil.
const LANGUAGE_ORDER = Object.freeze([
    'tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl',
    'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'
]);

// Dev Cleaner ile birebir aynı 73 dil kataloğu. Çevirisi henüz diskte
// bulunmayan diller arayüzde seçilebilir ve İngilizce (en) fallback döner.
const ALL_LANGUAGES = Object.freeze([
    { id: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
    { id: 'en', name: 'English', nativeName: 'English' },
    { id: 'de', name: 'German', nativeName: 'Deutsch' },
    { id: 'es', name: 'Spanish', nativeName: 'Español' },
    { id: 'fr', name: 'French', nativeName: 'Français' },
    { id: 'it', name: 'Italian', nativeName: 'Italiano' },
    { id: 'pt', name: 'Portuguese', nativeName: 'Português' },
    { id: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
    { id: 'pl', name: 'Polish', nativeName: 'Polski' },
    { id: 'ru', name: 'Russian', nativeName: 'Русский' },
    { id: 'ja', name: 'Japanese', nativeName: '日本語' },
    { id: 'ko', name: 'Korean', nativeName: '한국어' },
    { id: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文' },
    { id: 'zh-tw', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
    { id: 'sv', name: 'Swedish', nativeName: 'Svenska' },
    { id: 'ar', name: 'Arabic', nativeName: 'العربية', rtl: true },
    { id: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
    { id: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
    { id: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
    { id: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
    { id: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
    { id: 'cs', name: 'Czech', nativeName: 'Čeština' },
    { id: 'da', name: 'Danish', nativeName: 'Dansk' },
    { id: 'fi', name: 'Finnish', nativeName: 'Suomi' },
    { id: 'no', name: 'Norwegian', nativeName: 'Norsk' },
    { id: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
    { id: 'ro', name: 'Romanian', nativeName: 'Română' },
    { id: 'th', name: 'Thai', nativeName: 'ไทย' },
    { id: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
    { id: 'fil', name: 'Filipino', nativeName: 'Filipino' },
    { id: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
    { id: 'he', name: 'Hebrew', nativeName: 'עברית', rtl: true },
    { id: 'fa', name: 'Persian', nativeName: 'فارسی', rtl: true },
    { id: 'ur', name: 'Urdu', nativeName: 'اردو', rtl: true },
    { id: 'az', name: 'Azerbaijani', nativeName: 'Azərbaycan dili' },
    { id: 'kk', name: 'Kazakh', nativeName: 'Қазақша' },
    { id: 'uz', name: 'Uzbek', nativeName: 'Oʻzbekcha' },
    { id: 'bg', name: 'Bulgarian', nativeName: 'Български' },
    { id: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
    { id: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
    { id: 'et', name: 'Estonian', nativeName: 'Eesti' },
    { id: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
    { id: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
    { id: 'mr', name: 'Marathi', nativeName: 'मराठी' },
    { id: 'kn', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
    { id: 'gu', name: 'Gujarati', nativeName: 'ગુજરાતી' },
    { id: 'ml', name: 'Malayalam', nativeName: 'മലയാളം' },
    { id: 'pa', name: 'Punjabi', nativeName: 'ਪੰਜਾਬੀ' },
    { id: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
    { id: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
    { id: 'sr', name: 'Serbian', nativeName: 'Srpski' },
    { id: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
    { id: 'bs', name: 'Bosnian', nativeName: 'Bosanski' },
    { id: 'sq', name: 'Albanian', nativeName: 'Shqip' },
    { id: 'mk', name: 'Macedonian', nativeName: 'Македонски' },
    { id: 'is', name: 'Icelandic', nativeName: 'Íslenska' },
    { id: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
    { id: 'am', name: 'Amharic', nativeName: 'አማርኛ' },
    { id: 'ha', name: 'Hausa', nativeName: 'Hausa' },
    { id: 'yo', name: 'Yoruba', nativeName: 'Yorùbá' },
    { id: 'af', name: 'Afrikaans', nativeName: 'Afrikaans' },
    { id: 'ka', name: 'Georgian', nativeName: 'ქართული' },
    { id: 'hy', name: 'Armenian', nativeName: 'Հայերեն' },
    { id: 'ky', name: 'Kyrgyz', nativeName: 'Кыргызча' },
    { id: 'tk', name: 'Turkmen', nativeName: 'Türkmençe' },
    { id: 'mn', name: 'Mongolian', nativeName: 'Монгол' },
    { id: 'ca', name: 'Catalan', nativeName: 'Català' },
    { id: 'eu', name: 'Basque', nativeName: 'Euskara' },
    { id: 'gl', name: 'Galician', nativeName: 'Galego' },
    { id: 'ga', name: 'Irish', nativeName: 'Gaeilge' },
    { id: 'my', name: 'Burmese', nativeName: 'မြန်မာစာ' },
    { id: 'km', name: 'Khmer', nativeName: 'ភាសាខ្មែរ' },
    { id: 'si', name: 'Sinhala', nativeName: 'සිංහල' }
]);
const ALL_LANGUAGE_CODES = Object.freeze(ALL_LANGUAGES.map((l) => l.id));
const RTL_LANGUAGES = Object.freeze(new Set(ALL_LANGUAGES.filter((l) => l.rtl).map((l) => l.id)));
const LANGUAGE_ALIASES = Object.freeze({
    nb: 'no', nbNo: 'no', 'nb-no': 'no',
    zhCn: 'zh', 'zh-cn': 'zh', 'zh-sg': 'zh', 'zh-hans': 'zh',
    'zh-tw': 'zh-tw', 'zh-hk': 'zh-tw', 'zh-hant': 'zh-tw',
    ptPt: 'pt', 'pt-pt': 'pt', 'pt-br': 'pt',
    tl: 'fil', iw: 'he'
});
const cache = new Map();
let turkish = null;
const warned = new Set();

/**
 * Desteklenen diller dışındaki sistem dilleri **İngilizceye** düşer.
 *
 * Önceden 'tr'ye düşüyordu; bu, Rusça/Hintçe/Vietnamca bir Windows'ta
 * uygulamanın ilk açılışta Türkçe görünmesi demekti. İngilizce nötr ve
 * uluslararası varsayılandır; Türkçe yalnızca gerçekten Türkçe sistemde gelir.
 */
const FALLBACK_LANGUAGE = 'en';

function normalizeLanguage(language) {
    const raw = String(language || '').trim();
    if (!raw) return FALLBACK_LANGUAGE;
    const lower = raw.toLowerCase();
    const alias = LANGUAGE_ALIASES[lower] || LANGUAGE_ALIASES[raw];
    if (alias && LANGUAGE_ORDER.includes(alias)) return alias;
    const base = lower.split('-')[0];
    return LANGUAGE_ORDER.includes(base) ? base : FALLBACK_LANGUAGE;
}

/** 73 dil kataloğunda yer alan herhangi bir dil kodunu doğrular. */
function normalizeCatalogLanguage(language) {
    const raw = String(language || '').trim();
    if (!raw) return FALLBACK_LANGUAGE;
    const lower = raw.toLowerCase();
    if (ALL_LANGUAGE_CODES.includes(lower)) return lower;
    const alias = LANGUAGE_ALIASES[lower] || LANGUAGE_ALIASES[raw];
    if (alias && ALL_LANGUAGE_CODES.includes(alias)) return alias;
    const base = lower.split('-')[0];
    return ALL_LANGUAGE_CODES.includes(base) ? base : FALLBACK_LANGUAGE;
}

function hasLocaleFile(lang) {
    if (!ALL_LANGUAGE_CODES.includes(lang)) return false;
    return fs.existsSync(path.join(LOCALE_DIR, `${lang}.server.json`));
}

function readLocaleFile(lang) {
    const file = path.join(LOCALE_DIR, `${lang}.server.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadLocale(language) {
    const lang = normalizeLanguage(language);
    if (cache.has(lang)) return cache.get(lang);
    let dict;
    try {
        dict = readLocaleFile(lang);
    } catch (err) {
        log.warn(`[i18n] ${lang}.server.json okunamadı; Türkçe fallback:`, err && err.message);
        dict = loadTurkish();
    }
    cache.set(lang, dict);
    return dict;
}

/**
 * 73 dilden herhangi biri için sözlük yükler: diskte `<lang>.server.json`
 * varsa onu döndürür; henüz çevrilmemişse İngilizce (`en.server.json`)
 * fallback ile birlikte seçili dil kodunu korur.
 */
function loadLocaleForRenderer(language) {
    const lang = normalizeCatalogLanguage(language);
    const translated = hasLocaleFile(lang);
    const resolvedLang = translated ? lang : FALLBACK_LANGUAGE;
    const dictionary = translated ? (cache.has(lang) ? cache.get(lang) : (() => {
        try {
            const d = readLocaleFile(lang);
            cache.set(lang, d);
            return d;
        } catch (_) {
            return loadLocale(FALLBACK_LANGUAGE);
        }
    })()) : loadLocale(FALLBACK_LANGUAGE);
    return {
        lang,
        resolvedLang,
        fallback: !translated,
        rtl: RTL_LANGUAGES.has(lang),
        dictionary
    };
}

function loadTurkish() {
    if (turkish) return turkish;
    try {
        turkish = readLocaleFile('tr');
    } catch (err) {
        log.error('[i18n] tr.server.json okunamadı:', err && err.message);
        turkish = {};
    }
    return turkish;
}

/** Geriye uyum: verilen dilin sözlüğünü döndürür (varsayılan en). */
function loadTranslations(language = 'en') {
    return loadLocale(language);
}

function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
    ));
}

function translate(language, key, vars) {
    const lang = normalizeLanguage(language);
    const dict = loadLocale(lang);
    let value = dict[key];
    if (typeof value !== 'string') {
        const fallback = loadTurkish();
        value = fallback[key];
        if (typeof value === 'string' && lang !== 'tr' && !warned.has(`${lang}:${key}`)) {
            warned.add(`${lang}:${key}`);
            log.warn(`[i18n] ${lang} için eksik anahtar: ${key} (tr fallback).`);
        }
    }
    if (typeof value !== 'string') {
        if (!warned.has(`missing:${key}`)) {
            warned.add(`missing:${key}`);
            log.warn(`[i18n] bilinmeyen anahtar: ${key}`);
        }
        value = String(key);
    }
    return interpolate(value, vars);
}

function actionLabel(language, action) {
    const key = action === 'shutdown' ? 'actionShutdown'
        : action === 'sleep' ? 'actionSleep'
            : action === 'hibernate' ? 'actionHibernate'
                : action === 'restart' ? 'actionRestart'
                    : action === 'lock' ? 'actionLock'
                        : action === 'signout' ? 'actionSignout'
                            : null;
    return key ? translate(language, key) : String(action || '');
}

// Stored built-in templates use Turkish names. Map them to the same i18n keys
// the renderer uses so tray labels follow the active language.
const BUILTIN_TEMPLATE_KEYS = {
    'İndirme Bitince Kapat': 'tplDownloadShutdown',
    'Render Bitince Kapat': 'tplRenderShutdown',
    'Gece Boşta Kalırsa Uyut': 'tplIdleSleep',
    'Chrome Kapanınca Kilitle': 'tplProcessLock',
    'Steam İndirmesi Bitince Kapat': 'tplSteamDownload',
    'Toplantı Bitince Kilitle': 'tplMeetingLock',
    'Her Gece 01:00 Uyut': 'tplNightlySleep',
    'Pil Azalınca Hazırda Beklet': 'tplBatteryHibernate',
    'İndirilenler Sabitlenince Kapat': 'tplBackupStable',
    'Sunum Kapanınca Kilitle': 'tplPresentationLock',
    'Ağ ve Disk Durunca Kapat': 'tplTorrentCompleteShutdown',
    'Render Bitince Uyku Modu': 'tplRenderSleep',
    'Büyük Kopyalama / Yedek Bitince Kapat': 'tplDiskCopyShutdown',
    'Epic Games İndirmesi Bitince Kapat': 'tplEpicDownloadShutdown',
    'Oyun Sonrası 30 Dk Boşta Uyut': 'tplGamingIdleSleep',
    '30 Dakika Sonra Mola Kilidi': 'tplFocusLock30m',
    'Hafta İçi 18:30 Ekranı Kilitle': 'tplWorkdayEndLock',
    'OBS Yayını Kapanınca Uyut': 'tplObsStreamSleep',
    'Her Gece 02:00 Kapat': 'tplNightlyShutdown',
    'Gece 04:00 Bakım Yeniden Başlat': 'tplWeeklyRestart',
    '1 Saat Sonra Uyut': 'tplTimer60mSleep',
    '2 Saat Sonra Kapat': 'tplTimer120mShutdown'
};

function taskName(language, task) {
    if (!task) return '';
    const name = String(task.name || '');
    const trig = task.trigger || {};
    const lang = normalizeLanguage(language);
    const locale = { no: 'nb-NO', zh: 'zh-CN', pt: 'pt-PT' }[lang] || lang;
    if (task.source === 'user_interface') {
        if (trig.type === 'duration') {
            return translate(lang, 'quickTimerName', { action: actionLabel(lang, task.action) });
        }
        if ((trig.type === 'scheduled_time' || trig.targetTime) && trig.targetTime) {
            return translate(lang, 'scheduledTaskName', {
                action: actionLabel(lang, task.action),
                time: new Date(trig.targetTime).toLocaleTimeString(locale)
            });
        }
        if (task.conditionGroup) return translate(lang, 'smartFinishTaskName');
    }
    if (name.startsWith('Hızlı Zamanlayıcı') || name.startsWith('Quick Timer')) {
        return translate(lang, 'quickTimerName', { action: actionLabel(lang, task.action) });
    }
    if (BUILTIN_TEMPLATE_KEYS[name]) return translate(lang, BUILTIN_TEMPLATE_KEYS[name]);
    return name;
}

function resetCache() {
    cache.clear();
    turkish = null;
    warned.clear();
}

module.exports = {
    LANGUAGE_ORDER,
    ALL_LANGUAGES,
    ALL_LANGUAGE_CODES,
    RTL_LANGUAGES,
    normalizeLanguage,
    normalizeCatalogLanguage,
    hasLocaleFile,
    loadTranslations,
    loadLocale,
    loadLocaleForRenderer,
    translate,
    actionLabel,
    taskName,
    resetCache
};
