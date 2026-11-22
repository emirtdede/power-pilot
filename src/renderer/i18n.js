/**
 * i18n.js - WP-14.T2 + 73-language catalog (Dev Cleaner parity)
 * Yalnızca aktif dil sözlüğü IPC ile yüklenir. 73 dilin tamamı listede
 * seçilebilir; çevirisi henüz diskte bulunmayan diller İngilizce (en)
 * fallback sözlüğünü kullanır.
 */
let translations = {};

(function () {
    'use strict';

    // O-19: locale dosyası bozuk/eksikse sayaç çizimi çökmesin.
    // Nötr varsayılan: İngilizce (desteklenmeyen sistem dili Türkçe'ye düşmesin).
    const FALLBACK_DICTIONARY = {
        timeFormatDays: 'd',
        timeFormatHours: 'h',
        timeFormatMinutes: 'm',
        timeFormatSeconds: 's',
        activeTimerText: 'Computer will {action} in {time}.',
        activeTimerCancelledText: 'Timer cancelled.',
        unknownError: 'Unknown error'
    };

    // Diskte tam çevirisi bulunan 17 dil (ilk açılışta sistem dili algısı bunu kullanır).
    const TRANSLATED = [
        'tr', 'en', 'de', 'sv', 'no', 'da', 'fr', 'pl', 'it', 'nl',
        'cs', 'es', 'pt', 'ja', 'zh', 'ko', 'ar'
    ];

    // Dev Cleaner ile birebir aynı 73 dil kataloğu.
    const ALL_LANGUAGES = [
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
    ];

    const SUPPORTED = ALL_LANGUAGES.map((l) => l.id);
    const RTL_SET = new Set(ALL_LANGUAGES.filter((l) => l.rtl).map((l) => l.id));

    // Desteklenmeyen sistem dili → 'en' (uluslararası varsayılan).
    const UI_FALLBACK_LANG = 'en';

    function isRtl(lang) {
        return RTL_SET.has(String(lang || '').toLowerCase());
    }

    function detectInitialLanguage() {
        let lang = null;
        try { lang = localStorage.getItem('language'); } catch (_) {}
        if (!lang) {
            const raw = String(navigator.language || UI_FALLBACK_LANG).toLowerCase();
            const sys = raw.split('-')[0];
            // İlk açılışta yalnızca çevirisi hazır diller otomatik seçilir;
            // diğer sistem dilleri İngilizceye düşer.
            return TRANSLATED.includes(sys) ? sys : UI_FALLBACK_LANG;
        }
        const lower = String(lang).toLowerCase();
        return SUPPORTED.includes(lower) ? lower : UI_FALLBACK_LANG;
    }

    let currentLanguage = detectInitialLanguage();

    async function load(lang) {
        if (!window.electronAPI || typeof window.electronAPI.getLocale !== 'function') {
            throw new Error('LOCALE_IPC_UNAVAILABLE');
        }
        const lower = String(lang || '').toLowerCase();
        const requested = SUPPORTED.includes(lower) ? lower : UI_FALLBACK_LANG;
        const res = await window.electronAPI.getLocale(requested);
        if (!res || res.ok !== true || !res.dictionary) {
            throw new Error((res && res.code) || 'LOCALE_LOAD_FAILED');
        }
        const actual = SUPPORTED.includes(res.lang) ? res.lang : requested;
        // Tek aktif sözlük: önceki dil nesnesi tutulmaz.
        translations = { [actual]: res.dictionary };
        currentLanguage = actual;
        document.documentElement.setAttribute('lang', actual);
        document.documentElement.setAttribute('dir', (res.rtl === true || isRtl(actual)) ? 'rtl' : 'ltr');
        return res.dictionary;
    }

    const ready = load(currentLanguage).catch((err) => {
        console.error('[i18n] locale yüklenemedi:', err && err.message);
        translations = { [currentLanguage]: FALLBACK_DICTIONARY };
        return FALLBACK_DICTIONARY;
    });

    // Güvenlik ağı: sözlük yüklenemese veya app.js erken çökse bile statik
    // iskelet gizli kalmasın (i18n-pending CSS kapısı).
    const revealSkeleton = () => {
        try {
            const root = document.documentElement;
            if (root && root.classList && typeof root.classList.remove === 'function') {
                root.classList.remove('i18n-pending');
            }
        } catch (_) { /* sınırlı DOM (test/VM) - kapı yoksa yapılacak iş yok */ }
    };
    if (typeof setTimeout === 'function') setTimeout(revealSkeleton, 2000);

    window.PPLocale = {
        ready,
        load,
        isRtl,
        get language() { return currentLanguage; },
        get supported() { return SUPPORTED.slice(); },
        get translated() { return TRANSLATED.slice(); },
        get catalog() { return ALL_LANGUAGES.slice(); }
    };
})();
