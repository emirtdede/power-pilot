'use strict';

/**
 * Master 73-language catalog for Power Pilot NSIS Installer & Uninstaller.
 * Matches src/main/i18n.js ALL_LANGUAGES 1:1 (exact order, codes, and unique LCIDs).
 *
 * - 54 languages load NSIS 3.0.4.1's native built-in MUI_LANGUAGE table (`nsisName`).
 * - 19 languages (including Turkey Turkish `tr-TR` LCID 1055 to replace upstream NSIS
 *   3.0.4.1's outdated CP1254 Turkish.nlf & typo-ridden Turkish.nsh) load our custom
 *   Unicode (CP1200) UTF-8 BOM NLF v6 + MUI2 tables (`customNlf`).
 * - All 73 languages receive 100% native translations for every Setup & Uninstaller
 *   page, button, dialog, install-mode option, and user-data removal screen (0 leaks).
 */

export const NSIS_LANGUAGES = [
  { code: 'tr', lcid: 1055, label: 'Türkçe (Turkish)', customNlf: 'TurkishTR' },
  { code: 'en', lcid: 1033, label: 'English', nsisName: 'English' },
  { code: 'de', lcid: 1031, label: 'Deutsch (German)', nsisName: 'German' },
  { code: 'es', lcid: 3082, label: 'Español (Spanish)', nsisName: 'SpanishInternational' },
  { code: 'fr', lcid: 1036, label: 'Français (French)', nsisName: 'French' },
  { code: 'it', lcid: 1040, label: 'Italiano (Italian)', nsisName: 'Italian' },
  { code: 'pt', lcid: 2070, label: 'Português (Portuguese)', nsisName: 'Portuguese' },
  { code: 'nl', lcid: 1043, label: 'Nederlands (Dutch)', nsisName: 'Dutch' },
  { code: 'pl', lcid: 1045, label: 'Polski (Polish)', nsisName: 'Polish' },
  { code: 'ru', lcid: 1049, label: 'Русский (Russian)', nsisName: 'Russian' },
  { code: 'ja', lcid: 1041, label: '日本語 (Japanese)', nsisName: 'Japanese' },
  { code: 'ko', lcid: 1042, label: '한국어 (Korean)', nsisName: 'Korean' },
  { code: 'zh', lcid: 2052, label: '简体中文 (Chinese Simplified)', nsisName: 'SimpChinese' },
  { code: 'zh-tw', lcid: 1028, label: '繁體中文 (Chinese Traditional)', nsisName: 'TradChinese' },
  { code: 'sv', lcid: 1053, label: 'Svenska (Swedish)', nsisName: 'Swedish' },
  { code: 'ar', lcid: 1025, label: 'العربية (Arabic)', nsisName: 'Arabic', rtl: true },
  { code: 'hi', lcid: 1081, label: 'हिन्दी (Hindi)', nsisName: 'Hindi' },
  { code: 'id', lcid: 1057, label: 'Bahasa Indonesia (Indonesian)', nsisName: 'Indonesian' },
  { code: 'vi', lcid: 1066, label: 'Tiếng Việt (Vietnamese)', nsisName: 'Vietnamese' },
  { code: 'uk', lcid: 1058, label: 'Українська (Ukrainian)', nsisName: 'Ukrainian' },
  { code: 'el', lcid: 1032, label: 'Ελληνικά (Greek)', nsisName: 'Greek' },
  { code: 'cs', lcid: 1029, label: 'Čeština (Czech)', nsisName: 'Czech' },
  { code: 'da', lcid: 1030, label: 'Dansk (Danish)', nsisName: 'Danish' },
  { code: 'fi', lcid: 1035, label: 'Suomi (Finnish)', nsisName: 'Finnish' },
  { code: 'no', lcid: 1044, label: 'Norsk (Norwegian)', nsisName: 'Norwegian' },
  { code: 'hu', lcid: 1038, label: 'Magyar (Hungarian)', nsisName: 'Hungarian' },
  { code: 'ro', lcid: 1048, label: 'Română (Romanian)', nsisName: 'Romanian' },
  { code: 'th', lcid: 1054, label: 'ไทย (Thai)', nsisName: 'Thai' },
  { code: 'ms', lcid: 1086, label: 'Bahasa Melayu (Malay)', nsisName: 'Malay' },
  { code: 'fil', lcid: 1124, label: 'Filipino', customNlf: 'Filipino' },
  { code: 'bn', lcid: 1093, label: 'বাংলা (Bengali)', customNlf: 'Bengali' },
  { code: 'he', lcid: 1037, label: 'עברית (Hebrew)', nsisName: 'Hebrew', rtl: true },
  { code: 'fa', lcid: 1065, label: 'فارسی (Persian)', nsisName: 'Farsi', rtl: true },
  { code: 'ur', lcid: 1056, label: 'اردو (Urdu)', customNlf: 'Urdu', rtl: true },
  { code: 'az', lcid: 2092, label: 'Azərbaycan dili (Azerbaijani)', customNlf: 'Azerbaijani' },
  { code: 'kk', lcid: 1087, label: 'Қазақша (Kazakh)', customNlf: 'Kazakh' },
  { code: 'uz', lcid: 1091, label: 'Oʻzbekcha (Uzbek)', nsisName: 'Uzbek' },
  { code: 'bg', lcid: 1026, label: 'Български (Bulgarian)', nsisName: 'Bulgarian' },
  { code: 'sk', lcid: 1051, label: 'Slovenčina (Slovak)', nsisName: 'Slovak' },
  { code: 'hr', lcid: 1050, label: 'Hrvatski (Croatian)', nsisName: 'Croatian' },
  { code: 'et', lcid: 1061, label: 'Eesti (Estonian)', nsisName: 'Estonian' },
  { code: 'ta', lcid: 1097, label: 'தமிழ் (Tamil)', customNlf: 'Tamil' },
  { code: 'te', lcid: 1098, label: 'తెలుగు (Telugu)', customNlf: 'Telugu' },
  { code: 'mr', lcid: 1102, label: 'मराठी (Marathi)', customNlf: 'Marathi' },
  { code: 'kn', lcid: 1099, label: 'ಕನ್ನಡ (Kannada)', customNlf: 'Kannada' },
  { code: 'gu', lcid: 1095, label: 'ગુજરાતી (Gujarati)', customNlf: 'Gujarati' },
  { code: 'ml', lcid: 1100, label: 'മലയാളം (Malayalam)', customNlf: 'Malayalam' },
  { code: 'pa', lcid: 1094, label: 'ਪੰਜਾਬੀ (Punjabi)', customNlf: 'Punjabi' },
  { code: 'lt', lcid: 1063, label: 'Lietuvių (Lithuanian)', nsisName: 'Lithuanian' },
  { code: 'lv', lcid: 1062, label: 'Latviešu (Latvian)', nsisName: 'Latvian' },
  { code: 'sr', lcid: 3098, label: 'Srpski (Serbian)', nsisName: 'Serbian' },
  { code: 'sl', lcid: 1060, label: 'Slovenščina (Slovenian)', nsisName: 'Slovenian' },
  { code: 'bs', lcid: 5146, label: 'Bosanski (Bosnian)', nsisName: 'Bosnian' },
  { code: 'sq', lcid: 1052, label: 'Shqip (Albanian)', nsisName: 'Albanian' },
  { code: 'mk', lcid: 1071, label: 'Македонски (Macedonian)', nsisName: 'Macedonian' },
  { code: 'is', lcid: 1039, label: 'Íslenska (Icelandic)', nsisName: 'Icelandic' },
  { code: 'sw', lcid: 1089, label: 'Kiswahili (Swahili)', nsisName: 'Swahili', patchMUI: true },
  { code: 'am', lcid: 1118, label: 'አማርኛ (Amharic)', customNlf: 'Amharic' },
  { code: 'ha', lcid: 1128, label: 'Hausa', customNlf: 'Hausa' },
  { code: 'yo', lcid: 1130, label: 'Yorùbá (Yoruba)', nsisName: 'Yoruba', patchMUI: true },
  { code: 'af', lcid: 1078, label: 'Afrikaans', nsisName: 'Afrikaans' },
  { code: 'ka', lcid: 1079, label: 'ქართული (Georgian)', nsisName: 'Georgian' },
  { code: 'hy', lcid: 1067, label: 'Հայերեն (Armenian)', nsisName: 'Armenian' },
  { code: 'ky', lcid: 1088, label: 'Кыргызча (Kyrgyz)', customNlf: 'Kyrgyz' },
  { code: 'tk', lcid: 1090, label: 'Türkmençe (Turkmen)', customNlf: 'Turkmen' },
  { code: 'mn', lcid: 1104, label: 'Монгол (Mongolian)', nsisName: 'Mongolian' },
  { code: 'ca', lcid: 1027, label: 'Català (Catalan)', nsisName: 'Catalan' },
  { code: 'eu', lcid: 1069, label: 'Euskara (Basque)', nsisName: 'Basque' },
  { code: 'gl', lcid: 1110, label: 'Galego (Galician)', nsisName: 'Galician' },
  { code: 'ga', lcid: 2108, label: 'Gaeilge (Irish)', nsisName: 'Irish' },
  { code: 'my', lcid: 1109, label: 'မြန်မာစာ (Burmese)', customNlf: 'Burmese' },
  { code: 'km', lcid: 1107, label: 'ភាសាខ្មែរ (Khmer)', nsisName: 'Khmer', patchMUI: true },
  { code: 'si', lcid: 1115, label: 'සිංහල (Sinhala)', customNlf: 'Sinhala' }
];
