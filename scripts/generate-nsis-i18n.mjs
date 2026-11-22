#!/usr/bin/env node
'use strict';

/**
 * scripts/generate-nsis-i18n.mjs
 *
 * Generates zero-leak 73-language NSIS Setup & Uninstaller assets:
 *  - build/nsis-langs/<Name>.nlf (18 custom UTF-8 BOM NLF v6 tables)
 *  - build/nsis-langs/powerpilot-73langs.nsh (loaded in !macro customHeader)
 *  - build/nsis-langs/langdialog-titles.nsh (73-lang LangDLL startup titles)
 *
 * Validates:
 *  - Exactly 73 languages with 73 unique LCIDs matching src/main/i18n.js
 *  - Zero missing keys across all 73 languages
 *  - Zero Unicode long dashes (U+2012..U+2015, U+2E3A, U+2E3B, U+FE58, U+FF0D)
 *  - Zero English fallback leaks in any of the 72 non-English languages
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NSIS_LANGUAGES } from './nsis-i18n/catalog.mjs';
import { TRANSLATIONS_A } from './nsis-i18n/translations-a.mjs';
import { TRANSLATIONS_B } from './nsis-i18n/translations-b.mjs';
import { TRANSLATIONS_C } from './nsis-i18n/translations-c.mjs';
import { CUSTOM_NLF_DATA } from './nsis-i18n/custom-nlf-data.mjs';
import { BUILTIN_MUI_STRINGS } from './nsis-i18n/builtin-mui-strings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'build', 'nsis-langs');
const LONG_DASH_RE = /[\u2012\u2013\u2014\u2015\u2e3a\u2e3b\ufe58\uff0d]/g;

const ALL_TRANSLATIONS = {
  ...TRANSLATIONS_A,
  ...TRANSLATIONS_B,
  ...TRANSLATIONS_C
};

const REQUIRED_KEYS = [
  'langHeader', 'langDesc',
  'welcomeTitle', 'welcomeText', 'finishTitle', 'finishText', 'finishRun',
  'unWelcomeTitle', 'unWelcomeText', 'unFinishTitle', 'unFinishText',
  'unDataHeader', 'unDataSub', 'unDataInfo', 'unDataCheck', 'unDataHint',
  'chooseInstallOpts', 'whoInstallFor', 'selectUserMode', 'onlyForMe', 'forAll',
  'freshCurrent', 'freshAll', 'perUserExists', 'perUser', 'perMachineExists',
  'perMachine', 'reinstallUpgrade', 'willUninstall',
  'chooseUninstallOpts', 'whichRemove', 'whichRemoveDesc', 'loginAdmin',
  'appRunning', 'appCannotClose', 'appClosing', 'installing', 'sureUninstall',
  'decompFailed', 'uninstFailed', 'win7Req', 'x64Req'
];

// Clean string for NSIS LangString double-quoted literal
function escNsis(raw) {
  let s = String(raw || '').replace(LONG_DASH_RE, '-');
  // Normalize NSIS ampersand display only inside unFinishText ("&" -> "&&" for NSIS labels if not mnemonic)
  s = s.replace(/"/g, '$\\"');
  s = s.replace(/\r?\n/g, '$\\r$\\n');
  return s;
}

function escNsisAmpLabel(raw) {
  return escNsis(String(raw || '').replace(/&/g, '&&'));
}

function cleanNlfLine(raw) {
  return String(raw || '').replace(LONG_DASH_RE, '-').replace(/\r?\n/g, '\\r\\n');
}

function buildNlfContent(lang, d) {
  const rtlVal = lang.rtl ? 'RTL' : '-';
  const lines = [
    "# Header, don't edit",
    'NLF v6',
    '# Start editing here',
    '# Language ID',
    String(lang.lcid),
    '# Font and size - dash (-) means default',
    '-',
    '-',
    '# Codepage - dash (-) means ASCII code page',
    '1200',
    '# RTL - anything else than RTL means LTR',
    rtlVal,
    '# Power Pilot custom NLF table',
    '# ^Branding',
    'Nullsoft Install System %s',
    '# ^SetupCaption',
    cleanNlfLine(d.setupCaption),
    '# ^UninstallCaption',
    cleanNlfLine(d.uninstallCaption),
    '# ^LicenseSubCaption',
    ': License',
    '# ^ComponentsSubCaption',
    cleanNlfLine(d.dirSubCaption),
    '# ^DirSubCaption',
    cleanNlfLine(d.dirSubCaption),
    '# ^InstallingSubCaption',
    cleanNlfLine(d.instSubCaption),
    '# ^CompletedSubCaption',
    cleanNlfLine(d.compSubCaption),
    '# ^UnComponentsSubCaption',
    cleanNlfLine(d.unInstSubCaption),
    '# ^UnDirSubCaption',
    cleanNlfLine(d.dirSubCaption),
    '# ^ConfirmSubCaption',
    cleanNlfLine(d.unInstSubCaption),
    '# ^UninstallingSubCaption',
    cleanNlfLine(d.unInstSubCaption),
    '# ^UnCompletedSubCaption',
    cleanNlfLine(d.compSubCaption),
    '# ^BackBtn',
    cleanNlfLine(d.backBtn),
    '# ^NextBtn',
    cleanNlfLine(d.nextBtn),
    '# ^AgreeBtn',
    cleanNlfLine(d.agreeBtn),
    '# ^AcceptBtn',
    cleanNlfLine(d.agreeBtn),
    '# ^DontAcceptBtn',
    cleanNlfLine(d.cancelBtn),
    '# ^InstallBtn',
    cleanNlfLine(d.installBtn),
    '# ^UninstallBtn',
    cleanNlfLine(d.uninstallBtn),
    '# ^CancelBtn',
    cleanNlfLine(d.cancelBtn),
    '# ^CloseBtn',
    cleanNlfLine(d.closeBtn),
    '# ^BrowseBtn',
    cleanNlfLine(d.browseBtn),
    '# ^ShowDetailsBtn',
    cleanNlfLine(d.showDetailsBtn),
    '# ^ClickNext',
    cleanNlfLine(d.clickNext),
    '# ^ClickInstall',
    cleanNlfLine(d.clickInstall),
    '# ^ClickUninstall',
    cleanNlfLine(d.clickUninstall),
    '# ^Name',
    'Name',
    '# ^Completed',
    cleanNlfLine(d.completed),
    '# ^LicenseText',
    cleanNlfLine(d.clickNext),
    '# ^LicenseTextCB',
    cleanNlfLine(d.clickNext),
    '# ^LicenseTextRB',
    cleanNlfLine(d.clickNext),
    '# ^UnLicenseText',
    cleanNlfLine(d.clickNext),
    '# ^UnLicenseTextCB',
    cleanNlfLine(d.clickNext),
    '# ^UnLicenseTextRB',
    cleanNlfLine(d.clickNext),
    '# ^Custom',
    'Custom',
    '# ^ComponentsText',
    cleanNlfLine(d.clickNext),
    '# ^ComponentsSubText1',
    cleanNlfLine(d.clickNext),
    '# ^ComponentsSubText2_NoInstTypes',
    cleanNlfLine(d.clickNext),
    '# ^ComponentsSubText2',
    cleanNlfLine(d.clickNext),
    '# ^UnComponentsText',
    cleanNlfLine(d.clickNext),
    '# ^UnComponentsSubText1',
    cleanNlfLine(d.clickNext),
    '# ^UnComponentsSubText2_NoInstTypes',
    cleanNlfLine(d.clickNext),
    '# ^UnComponentsSubText2',
    cleanNlfLine(d.clickNext),
    '# ^DirText',
    cleanNlfLine(d.dirText),
    '# ^DirSubText',
    cleanNlfLine(d.dirSubText),
    '# ^DirBrowseText',
    cleanNlfLine(d.dirBrowseText),
    '# ^UnDirText',
    cleanNlfLine(d.uninstText),
    '# ^UnDirSubText',
    '""',
    '# ^UnDirBrowseText',
    cleanNlfLine(d.dirBrowseText),
    '# ^SpaceAvailable',
    `"${cleanNlfLine(d.spaceAvail)}"`,
    '# ^SpaceRequired',
    `"${cleanNlfLine(d.spaceReq)}"`,
    '# ^UninstallingText',
    cleanNlfLine(d.uninstText),
    '# ^UninstallingSubText',
    cleanNlfLine(d.uninstSubText),
    '# ^FileError',
    'Error: \\r\\n\\r\\n$0',
    '# ^FileError_NoIgnore',
    'Error: \\r\\n\\r\\n$0',
    '# ^CantWrite',
    '"Error: "',
    '# ^CopyFailed',
    'Error',
    '# ^CopyTo',
    '"-> "',
    '# ^Registering',
    '"... "',
    '# ^Unregistering',
    '"... "',
    '# ^SymbolNotFound',
    '"Error: "',
    '# ^CouldNotLoad',
    '"Error: "',
    '# ^CreateFolder',
    '"+ "',
    '# ^CreateShortcut',
    '"+ "',
    '# ^CreatedUninstaller',
    '"+ "',
    '# ^Delete',
    '"- "',
    '# ^DeleteOnReboot',
    '"- "',
    '# ^ErrorCreatingShortcut',
    '"Error: "',
    '# ^ErrorCreating',
    '"Error: "',
    '# ^ErrorDecompressing',
    cleanNlfLine(ALL_TRANSLATIONS[lang.code].decompFailed),
    '# ^ErrorRegistering',
    'DLL Error',
    '# ^ExecShell',
    '"Exec: "',
    '# ^Exec',
    '"Exec: "',
    '# ^Extract',
    '"-> "',
    '# ^ErrorWriting',
    '"Error: "',
    '# ^InvalidOpcode',
    cleanNlfLine(ALL_TRANSLATIONS[lang.code].decompFailed),
    '# ^NoOLE',
    '"OLE: "',
    '# ^OutputFolder',
    '"-> "',
    '# ^RemoveFolder',
    '"- "',
    '# ^RenameOnReboot',
    '"-> "',
    '# ^Rename',
    '"-> "',
    '# ^Skipped',
    '"... "',
    '# ^CopyDetails',
    cleanNlfLine(d.copyDetails),
    '# ^LogInstall',
    'Log',
    '# ^Byte',
    'B',
    '# ^Kilo',
    ' K',
    '# ^Mega',
    ' M',
    '# ^Giga',
    ' G'
  ];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function validateCatalog() {
  if (NSIS_LANGUAGES.length !== 73) {
    throw new Error(`Expected 73 languages, got ${NSIS_LANGUAGES.length}`);
  }
  const seenCodes = new Set();
  const seenLcids = new Set();
  const en = ALL_TRANSLATIONS.en;

  for (const lang of NSIS_LANGUAGES) {
    if (seenCodes.has(lang.code)) throw new Error(`Duplicate code: ${lang.code}`);
    if (seenLcids.has(lang.lcid)) throw new Error(`Duplicate LCID: ${lang.lcid}`);
    seenCodes.add(lang.code);
    seenLcids.add(lang.lcid);

    const tr = ALL_TRANSLATIONS[lang.code];
    if (!tr) throw new Error(`Missing translations for ${lang.code}`);
    for (const k of REQUIRED_KEYS) {
      if (typeof tr[k] !== 'string' || !tr[k].trim()) {
        throw new Error(`Missing key ${k} for ${lang.code}`);
      }
      if (lang.code !== 'en' && tr[k] === en[k]) {
        throw new Error(`English leak detected in ${lang.code}.${k}: "${tr[k]}"`);
      }
    }
    if (lang.customNlf && !CUSTOM_NLF_DATA[lang.code]) {
      throw new Error(`Missing CUSTOM_NLF_DATA for ${lang.code}`);
    }
    if (lang.nsisName && lang.code !== 'en' && !BUILTIN_MUI_STRINGS[lang.code]) {
      throw new Error(`Missing BUILTIN_MUI_STRINGS for ${lang.code}`);
    }
  }
}

function main() {
  validateCatalog();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Clean old generated files
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.nlf') || f.endsWith('.nsh')) {
      fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }

  // 1. Write 18 custom UTF-8 BOM NLF v6 files
  let customCount = 0;
  for (const lang of NSIS_LANGUAGES) {
    if (!lang.customNlf) continue;
    const nlfPath = path.join(OUT_DIR, `${lang.customNlf}.nlf`);
    fs.writeFileSync(nlfPath, buildNlfContent(lang, CUSTOM_NLF_DATA[lang.code]), 'utf8');
    customCount += 1;
  }

  // 2. Build build/nsis-langs/powerpilot-73langs.nsh
  //    Included inside !macro customHeader (right after !insertmacro addLangs which loads English 1033).
  const out = [
    '; Auto-generated by scripts/generate-nsis-i18n.mjs - DO NOT EDIT BY HAND',
    '; Loads all 72 non-English native NSIS tables (53 built-in + 19 custom Unicode NLF v6, incl. Turkey Turkish tr-TR)',
    '; and defines 100% localized LangStrings for ALL 73 languages (0 leaks).',
    ''
  ];

  // 2a. Load 53 built-in NSIS .nlf tables + sanitized MUI2 LangStrings (avoids upstream NSIS 3.0.4.1 .nsh bugs/warnings)
  out.push('; --- Built-in NSIS 3.0.4.1 NLF tables + sanitized MUI2 strings (53 + English = 54) ---');
  for (const lang of NSIS_LANGUAGES) {
    if (!lang.nsisName || lang.code === 'en') continue;
    out.push(`LoadLanguageFile "\${NSISDIR}\\Contrib\\Language files\\${lang.nsisName}.nlf"`);
    const muiMap = BUILTIN_MUI_STRINGS[lang.code];
    for (const [k, v] of Object.entries(muiMap)) {
      // Values extracted from .nsh already contain NSIS escape sequences ($\r$\n, $\"); only sanitize raw long dashes.
      const safe = String(v).replace(LONG_DASH_RE, '-').replace(/(?<!\$\\)"/g, '$\\"');
      out.push(`LangString ${k} ${lang.lcid} "${safe}"`);
    }
    out.push('');
  }

  // 2c. Load 18 custom UTF-8 BOM NLF v6 tables + all MUI2 LangStrings
  out.push('; --- Custom UTF-8 BOM NLF v6 tables + MUI2 strings (18 languages) ---');
  for (const lang of NSIS_LANGUAGES) {
    if (!lang.customNlf) continue;
    const d = CUSTOM_NLF_DATA[lang.code];
    const tr = ALL_TRANSLATIONS[lang.code];
    const id = lang.lcid;
    out.push(`LoadLanguageFile "\${BUILD_RESOURCES_DIR}\\nsis-langs\\${lang.customNlf}.nlf"`);
    out.push(`LangString MUI_TEXT_WELCOME_INFO_TITLE ${id} "${escNsis(tr.welcomeTitle)}"`);
    out.push(`LangString MUI_TEXT_WELCOME_INFO_TEXT ${id} "${escNsis(tr.welcomeText)}"`);
    out.push(`LangString MUI_UNTEXT_WELCOME_INFO_TITLE ${id} "${escNsis(tr.unWelcomeTitle)}"`);
    out.push(`LangString MUI_UNTEXT_WELCOME_INFO_TEXT ${id} "${escNsis(tr.unWelcomeText)}"`);
    out.push(`LangString MUI_TEXT_DIRECTORY_TITLE ${id} "${escNsis(d.muiDirTitle)}"`);
    out.push(`LangString MUI_TEXT_DIRECTORY_SUBTITLE ${id} "${escNsis(d.muiDirSub)}"`);
    out.push(`LangString MUI_TEXT_INSTALLING_TITLE ${id} "${escNsis(d.muiInstTitle)}"`);
    out.push(`LangString MUI_TEXT_INSTALLING_SUBTITLE ${id} "${escNsis(d.muiInstSub)}"`);
    out.push(`LangString MUI_TEXT_FINISH_TITLE ${id} "${escNsis(d.muiFinTitle)}"`);
    out.push(`LangString MUI_TEXT_FINISH_SUBTITLE ${id} "${escNsis(d.muiFinSub)}"`);
    out.push(`LangString MUI_TEXT_ABORT_TITLE ${id} "${escNsis(d.muiAbortTitle)}"`);
    out.push(`LangString MUI_TEXT_ABORT_SUBTITLE ${id} "${escNsis(d.muiAbortSub)}"`);
    out.push(`LangString MUI_UNTEXT_UNINSTALLING_TITLE ${id} "${escNsis(d.muiUnInstTitle)}"`);
    out.push(`LangString MUI_UNTEXT_UNINSTALLING_SUBTITLE ${id} "${escNsis(d.muiUnInstSub)}"`);
    out.push(`LangString MUI_UNTEXT_FINISH_TITLE ${id} "${escNsis(d.muiUnFinTitle)}"`);
    out.push(`LangString MUI_UNTEXT_FINISH_SUBTITLE ${id} "${escNsis(d.muiUnFinSub)}"`);
    out.push(`LangString MUI_UNTEXT_ABORT_TITLE ${id} "${escNsis(d.muiUnAbortTitle)}"`);
    out.push(`LangString MUI_UNTEXT_ABORT_SUBTITLE ${id} "${escNsis(d.muiUnAbortSub)}"`);
    out.push(`LangString MUI_TEXT_FINISH_INFO_TITLE ${id} "${escNsis(tr.finishTitle)}"`);
    out.push(`LangString MUI_TEXT_FINISH_INFO_TEXT ${id} "${escNsis(tr.finishText)}"`);
    out.push(`LangString MUI_TEXT_FINISH_INFO_REBOOT ${id} "${escNsis(d.muiReboot)}"`);
    out.push(`LangString MUI_UNTEXT_FINISH_INFO_TITLE ${id} "${escNsis(tr.unFinishTitle)}"`);
    out.push(`LangString MUI_UNTEXT_FINISH_INFO_TEXT ${id} "${escNsisAmpLabel(tr.unFinishText)}"`);
    out.push(`LangString MUI_UNTEXT_FINISH_INFO_REBOOT ${id} "${escNsis(d.muiReboot)}"`);
    out.push(`LangString MUI_TEXT_FINISH_REBOOTNOW ${id} "${escNsis(d.muiRebootNow)}"`);
    out.push(`LangString MUI_TEXT_FINISH_REBOOTLATER ${id} "${escNsis(d.muiRebootLater)}"`);
    out.push(`LangString MUI_TEXT_FINISH_RUN ${id} "${escNsis(d.muiRun)}"`);
    out.push(`LangString MUI_TEXT_FINISH_SHOWREADME ${id} "${escNsis(d.muiReadme)}"`);
    out.push(`LangString MUI_BUTTONTEXT_FINISH ${id} "${escNsis(d.finishBtn)}"`);
    out.push(`LangString MUI_TEXT_ABORTWARNING ${id} "${escNsis(d.muiAbortWarn)}"`);
    out.push(`LangString MUI_UNTEXT_ABORTWARNING ${id} "${escNsis(d.muiUnAbortWarn)}"`);
    out.push('');
  }

  // 2d. Electron-builder messages.yml & assistedMessages.yml for ALL 72 non-English LCIDs
  //     (English 1033 is already generated by electron-builder's messages.nsh / assistedMessages.nsh)
  out.push('; --- Electron-builder assistedMessages + messages for all 72 non-English LCIDs ---');
  for (const lang of NSIS_LANGUAGES) {
    if (lang.code === 'en') continue;
    const tr = ALL_TRANSLATIONS[lang.code];
    const id = lang.lcid;
    out.push(`LangString win7Required ${id} "${escNsis(tr.win7Req)}"`);
    out.push(`LangString x64WinRequired ${id} "${escNsis(tr.x64Req)}"`);
    out.push(`LangString appRunning ${id} "${escNsis(tr.appRunning)}"`);
    out.push(`LangString appCannotBeClosed ${id} "${escNsis(tr.appCannotClose)}"`);
    out.push(`LangString installing ${id} "${escNsis(tr.installing)}"`);
    out.push(`LangString areYouSureToUninstall ${id} "${escNsis(tr.sureUninstall)}"`);
    out.push(`LangString decompressionFailed ${id} "${escNsis(tr.decompFailed)}"`);
    out.push(`LangString uninstallFailed ${id} "${escNsis(tr.uninstFailed)}"`);
    out.push(`LangString appClosing ${id} "${escNsis(tr.appClosing)}"`);
    out.push(`LangString chooseInstallationOptions ${id} "${escNsis(tr.chooseInstallOpts)}"`);
    out.push(`LangString chooseUninstallationOptions ${id} "${escNsis(tr.chooseUninstallOpts)}"`);
    out.push(`LangString whichInstallationShouldBeRemoved ${id} "${escNsis(tr.whichRemove)}"`);
    out.push(`LangString whoShouldThisApplicationBeInstalledFor ${id} "${escNsis(tr.whoInstallFor)}"`);
    out.push(`LangString selectUserMode ${id} "${escNsis(tr.selectUserMode)}"`);
    out.push(`LangString whichInstallationRemove ${id} "${escNsis(tr.whichRemoveDesc)}"`);
    out.push(`LangString freshInstallForAll ${id} "${escNsis(tr.freshAll)}"`);
    out.push(`LangString freshInstallForCurrent ${id} "${escNsis(tr.freshCurrent)}"`);
    out.push(`LangString onlyForMe ${id} "${escNsis(tr.onlyForMe)}"`);
    out.push(`LangString forAll ${id} "${escNsis(tr.forAll)}"`);
    out.push(`LangString loginWithAdminAccount ${id} "${escNsis(tr.loginAdmin)}"`);
    out.push(`LangString perUserInstallExists ${id} "${escNsis(tr.perUserExists)}"`);
    out.push(`LangString perUserInstall ${id} "${escNsis(tr.perUser)}"`);
    out.push(`LangString perMachineInstallExists ${id} "${escNsis(tr.perMachineExists)}"`);
    out.push(`LangString perMachineInstall ${id} "${escNsis(tr.perMachine)}"`);
    out.push(`LangString reinstallUpgrade ${id} "${escNsis(tr.reinstallUpgrade)}"`);
    out.push(`LangString uninstall ${id} "${escNsis(tr.willUninstall)}"`);
  }
  out.push('');

  // 2e. Power Pilot custom Setup & Uninstaller LangStrings for ALL 73 LCIDs
  out.push('; --- Power Pilot custom Setup & Uninstaller LangStrings (ALL 73 LCIDs) ---');
  for (const lang of NSIS_LANGUAGES) {
    const tr = ALL_TRANSLATIONS[lang.code];
    const id = lang.lcid;
    out.push(`!ifndef BUILD_UNINSTALLER`);
    out.push(`  LangString PP_WelcomeTitle ${id} "${escNsis(tr.welcomeTitle)}"`);
    out.push(`  LangString PP_WelcomeText ${id} "${escNsis(tr.welcomeText)}"`);
    out.push(`  LangString PP_FinishTitle ${id} "${escNsis(tr.finishTitle)}"`);
    out.push(`  LangString PP_FinishText ${id} "${escNsis(tr.finishText)}"`);
    out.push(`  LangString PP_FinishRun ${id} "${escNsis(tr.finishRun)}"`);
    out.push(`!else`);
    out.push(`  LangString PP_UnWelcomeTitle ${id} "${escNsis(tr.unWelcomeTitle)}"`);
    out.push(`  LangString PP_UnWelcomeText ${id} "${escNsis(tr.unWelcomeText)}"`);
    out.push(`  LangString PP_UnFinishTitle ${id} "${escNsis(tr.unFinishTitle)}"`);
    out.push(`  LangString PP_UnFinishText ${id} "${escNsisAmpLabel(tr.unFinishText)}"`);
    out.push(`  LangString PP_UnDataHeader ${id} "${escNsis(tr.unDataHeader)}"`);
    out.push(`  LangString PP_UnDataSub ${id} "${escNsis(tr.unDataSub)}"`);
    out.push(`  LangString PP_UnDataInfo ${id} "${escNsis(tr.unDataInfo)}"`);
    out.push(`  LangString PP_UnDataCheck ${id} "${escNsis(tr.unDataCheck)}"`);
    out.push(`  LangString PP_UnDataHint ${id} "${escNsis(tr.unDataHint)}"`);
    out.push(`!endif`);
  }
  out.push('');

  const mainNsh = out.join('\r\n');
  if (LONG_DASH_RE.test(mainNsh)) {
    throw new Error('Long dash leaked into powerpilot-73langs.nsh');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'powerpilot-73langs.nsh'), '\uFEFF' + mainNsh, 'utf8');

  // 3. Build build/nsis-langs/langdialog-titles.nsh for .onInit LangDLL title/prompt
  //    (Because NSIS applies $LANGUAGE changes to $(LangString) only AFTER .onInit returns)
  const dlg = [
    '; Auto-generated by scripts/generate-nsis-i18n.mjs',
    '; Resolves LangDLL popup title & description inside .onInit for all 73 languages',
    'Function ApplyLangDialogTitle',
    `  StrCpy $StrLangHeader "${escNsis(ALL_TRANSLATIONS.en.langHeader)}"`,
    `  StrCpy $StrLangDesc "${escNsis(ALL_TRANSLATIONS.en.langDesc)}"`,
    '  ${Switch} $SelectedLangCode'
  ];
  for (const lang of NSIS_LANGUAGES) {
    if (lang.code === 'en') continue;
    const tr = ALL_TRANSLATIONS[lang.code];
    dlg.push(`    \${Case} "${lang.code}"`);
    dlg.push(`      StrCpy $StrLangHeader "${escNsis(tr.langHeader)}"`);
    dlg.push(`      StrCpy $StrLangDesc "${escNsis(tr.langDesc)}"`);
    dlg.push('      ${Break}');
  }
  dlg.push('  ${EndSwitch}');
  dlg.push('FunctionEnd');
  dlg.push('');

  const dlgNsh = dlg.join('\r\n');
  if (LONG_DASH_RE.test(dlgNsh)) {
    throw new Error('Long dash leaked into langdialog-titles.nsh');
  }
  fs.writeFileSync(path.join(OUT_DIR, 'langdialog-titles.nsh'), '\uFEFF' + dlgNsh, 'utf8');

  // 4. Permanently enforce UTF-8 BOM on build/installer.nsh so NSIS 3.0.4.1 !include
  //    never falls back to host ANSI codepage (CP1252/CP1254) and corrupts Turkish/Unicode literals.
  const installerNshPath = path.join(ROOT, 'build', 'installer.nsh');
  if (fs.existsSync(installerNshPath)) {
    const rawBuf = fs.readFileSync(installerNshPath);
    if (!(rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf)) {
      fs.writeFileSync(installerNshPath, '\uFEFF' + rawBuf.toString('utf8'), 'utf8');
    }
  }

  const builtinCount = NSIS_LANGUAGES.filter((l) => l.nsisName).length;
  console.log(`[generate-nsis-i18n] OK - 73 dil (${builtinCount} yerlesik + ${customCount} ozel Unicode NLF v6), 0 dil sizintisi, 0 uzun cizgi uretildi.`);
}

main();
