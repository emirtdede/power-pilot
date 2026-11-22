; Power Pilot - Vellium Windows 11 Multi-Language (73 Languages, 0 Leaks) Installer & Uninstaller Script
; Features:
;   - Startup 73-language selector popup INSIDE .onInit (LangDLL::LangDialog) BEFORE wizard creation
;   - Auto-detects Windows UI language via kernel32::GetUserDefaultUILanguage(); falls back to English (1033 / en)
;   - Native NSIS language tables for ALL 73 languages (54 built-in MUI2 + 19 custom Unicode UTF-8 BOM NLF v6, incl. Turkey Turkish tr-TR)
;   - 100% localized Setup AND Uninstaller pages, buttons, install-mode options, dialogs, and "Delete User Data" screen
;   - UAC inner-instance handoff prevents double language prompt when elevating for All Users
;   - Standalone .ico for DisplayIcon & shortcuts + synchronous SHChangeNotify(SHCNF_FLUSH) + ie4uinit -show
;     eliminates initial blank/white icon lag in Control Panel and Windows 11 Taskbar

!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var /GLOBAL SelectedLangCode
Var /GLOBAL SelectedLangLcid

!ifndef BUILD_UNINSTALLER
  Var /GLOBAL StrLangHeader
  Var /GLOBAL StrLangDesc

  !ifdef MUI_WELCOMEPAGE_TITLE
    !undef MUI_WELCOMEPAGE_TITLE
  !endif
  !define MUI_WELCOMEPAGE_TITLE "$(PP_WelcomeTitle)"

  !ifdef MUI_WELCOMEPAGE_TEXT
    !undef MUI_WELCOMEPAGE_TEXT
  !endif
  !define MUI_WELCOMEPAGE_TEXT "$(PP_WelcomeText)"

  !ifdef MUI_FINISHPAGE_TITLE
    !undef MUI_FINISHPAGE_TITLE
  !endif
  !define MUI_FINISHPAGE_TITLE "$(PP_FinishTitle)"

  !ifdef MUI_FINISHPAGE_TEXT
    !undef MUI_FINISHPAGE_TEXT
  !endif
  !define MUI_FINISHPAGE_TEXT "$(PP_FinishText)"

  !ifdef MUI_FINISHPAGE_RUN_TEXT
    !undef MUI_FINISHPAGE_RUN_TEXT
  !endif
  !define MUI_FINISHPAGE_RUN_TEXT "$(PP_FinishRun)"

  !ifdef MUI_FINISHPAGE_LINK
    !undef MUI_FINISHPAGE_LINK
  !endif
  !define MUI_FINISHPAGE_LINK "vellium.dev"

  !ifdef MUI_FINISHPAGE_LINK_LOCATION
    !undef MUI_FINISHPAGE_LINK_LOCATION
  !endif
  !define MUI_FINISHPAGE_LINK_LOCATION "https://vellium.dev"
!else
  Var /GLOBAL UnDataDialog
  Var /GLOBAL UnDataInfoLabel
  Var /GLOBAL UnDataCheckbox
  Var /GLOBAL UnDataHintLabel
  Var /GLOBAL DeleteUserDataFlag

  !ifdef MUI_WELCOMEPAGE_TITLE
    !undef MUI_WELCOMEPAGE_TITLE
  !endif
  !define MUI_WELCOMEPAGE_TITLE "$(PP_UnWelcomeTitle)"

  !ifdef MUI_WELCOMEPAGE_TEXT
    !undef MUI_WELCOMEPAGE_TEXT
  !endif
  !define MUI_WELCOMEPAGE_TEXT "$(PP_UnWelcomeText)"

  !ifdef MUI_UNFINISHPAGE_TITLE
    !undef MUI_UNFINISHPAGE_TITLE
  !endif
  !define MUI_UNFINISHPAGE_TITLE "$(PP_UnFinishTitle)"

  !ifdef MUI_UNFINISHPAGE_TEXT
    !undef MUI_UNFINISHPAGE_TEXT
  !endif
  !define MUI_UNFINISHPAGE_TEXT "$(PP_UnFinishText)"
!endif

!ifndef MUI_HEADERIMAGE_RIGHT
  !define MUI_HEADERIMAGE_RIGHT
!endif

; Runs right after !insertmacro addLangs (English 1033) in installer.nsi:
; loads all 72 other native NSIS tables (54 built-in + 18 custom NLF v6) and all 73-lang LangStrings.
!macro customHeader
  !include "nsis-langs\powerpilot-73langs.nsh"
!macroend

; Shared macro: detect Windows UI language via kernel32::GetUserDefaultUILanguage()
; Maps LCID (decimal, since LogicLib Switch compares strings) to one of the 73 catalog languages;
; falls back to English (en, LCID 1033) when system language is not in the 73-language catalog.
!macro DETECT_WINDOWS_LANG_BODY
  StrCpy $SelectedLangCode "en"
  StrCpy $SelectedLangLcid "1033"
  System::Call 'kernel32::GetUserDefaultUILanguage() i .r0'
  IntOp $0 $0 & 0xFFFF

  ; Exact LCID matches where primary language ID is shared (zh-tw, bs, hr, sr)
  ${Switch} $0
    ${Case} 1028 ; zh-TW
    ${Case} 3076 ; zh-HK
    ${Case} 5124 ; zh-MO
      StrCpy $SelectedLangCode "zh-tw"
      StrCpy $SelectedLangLcid "1028"
      Goto detect_done
    ${Case} 5146  ; bs-Latn-BA
    ${Case} 8218  ; bs-Cyrl-BA
    ${Case} 30746 ; bs
    ${Case} 25626 ; bs-Cyrl
      StrCpy $SelectedLangCode "bs"
      StrCpy $SelectedLangLcid "5146"
      Goto detect_done
    ${Case} 1050 ; hr-HR
    ${Case} 4122 ; hr-BA
      StrCpy $SelectedLangCode "hr"
      StrCpy $SelectedLangLcid "1050"
      Goto detect_done
    ${Case} 2074  ; sr-Latn-CS
    ${Case} 3098  ; sr-Cyrl-CS
    ${Case} 6170  ; sr-Latn-BA
    ${Case} 7194  ; sr-Cyrl-BA
    ${Case} 9242  ; sr-Latn-RS
    ${Case} 10266 ; sr-Cyrl-RS
    ${Case} 11290 ; sr-Latn-ME
    ${Case} 12314 ; sr-Cyrl-ME
      StrCpy $SelectedLangCode "sr"
      StrCpy $SelectedLangLcid "3098"
      Goto detect_done
  ${EndSwitch}

  ; Primary language ID (low 10 bits: LCID & 0x3FF, compared as decimal strings)
  IntOp $1 $0 & 0x3FF
  ${Switch} $1
    ${Case} 31  ; tr
      StrCpy $SelectedLangCode "tr"
      StrCpy $SelectedLangLcid "1055"
      ${Break}
    ${Case} 9   ; en
      StrCpy $SelectedLangCode "en"
      StrCpy $SelectedLangLcid "1033"
      ${Break}
    ${Case} 7   ; de
      StrCpy $SelectedLangCode "de"
      StrCpy $SelectedLangLcid "1031"
      ${Break}
    ${Case} 10  ; es
      StrCpy $SelectedLangCode "es"
      StrCpy $SelectedLangLcid "3082"
      ${Break}
    ${Case} 12  ; fr
      StrCpy $SelectedLangCode "fr"
      StrCpy $SelectedLangLcid "1036"
      ${Break}
    ${Case} 16  ; it
      StrCpy $SelectedLangCode "it"
      StrCpy $SelectedLangLcid "1040"
      ${Break}
    ${Case} 22  ; pt
      StrCpy $SelectedLangCode "pt"
      StrCpy $SelectedLangLcid "2070"
      ${Break}
    ${Case} 19  ; nl
      StrCpy $SelectedLangCode "nl"
      StrCpy $SelectedLangLcid "1043"
      ${Break}
    ${Case} 21  ; pl
      StrCpy $SelectedLangCode "pl"
      StrCpy $SelectedLangLcid "1045"
      ${Break}
    ${Case} 25  ; ru
      StrCpy $SelectedLangCode "ru"
      StrCpy $SelectedLangLcid "1049"
      ${Break}
    ${Case} 17  ; ja
      StrCpy $SelectedLangCode "ja"
      StrCpy $SelectedLangLcid "1041"
      ${Break}
    ${Case} 18  ; ko
      StrCpy $SelectedLangCode "ko"
      StrCpy $SelectedLangLcid "1042"
      ${Break}
    ${Case} 4   ; zh
      StrCpy $SelectedLangCode "zh"
      StrCpy $SelectedLangLcid "2052"
      ${Break}
    ${Case} 29  ; sv
      StrCpy $SelectedLangCode "sv"
      StrCpy $SelectedLangLcid "1053"
      ${Break}
    ${Case} 1   ; ar
      StrCpy $SelectedLangCode "ar"
      StrCpy $SelectedLangLcid "1025"
      ${Break}
    ${Case} 57  ; hi
      StrCpy $SelectedLangCode "hi"
      StrCpy $SelectedLangLcid "1081"
      ${Break}
    ${Case} 33  ; id
      StrCpy $SelectedLangCode "id"
      StrCpy $SelectedLangLcid "1057"
      ${Break}
    ${Case} 42  ; vi
      StrCpy $SelectedLangCode "vi"
      StrCpy $SelectedLangLcid "1066"
      ${Break}
    ${Case} 34  ; uk
      StrCpy $SelectedLangCode "uk"
      StrCpy $SelectedLangLcid "1058"
      ${Break}
    ${Case} 8   ; el
      StrCpy $SelectedLangCode "el"
      StrCpy $SelectedLangLcid "1032"
      ${Break}
    ${Case} 5   ; cs
      StrCpy $SelectedLangCode "cs"
      StrCpy $SelectedLangLcid "1029"
      ${Break}
    ${Case} 6   ; da
      StrCpy $SelectedLangCode "da"
      StrCpy $SelectedLangLcid "1030"
      ${Break}
    ${Case} 11  ; fi
      StrCpy $SelectedLangCode "fi"
      StrCpy $SelectedLangLcid "1035"
      ${Break}
    ${Case} 20  ; no
      StrCpy $SelectedLangCode "no"
      StrCpy $SelectedLangLcid "1044"
      ${Break}
    ${Case} 14  ; hu
      StrCpy $SelectedLangCode "hu"
      StrCpy $SelectedLangLcid "1038"
      ${Break}
    ${Case} 24  ; ro
      StrCpy $SelectedLangCode "ro"
      StrCpy $SelectedLangLcid "1048"
      ${Break}
    ${Case} 30  ; th
      StrCpy $SelectedLangCode "th"
      StrCpy $SelectedLangLcid "1054"
      ${Break}
    ${Case} 62  ; ms
      StrCpy $SelectedLangCode "ms"
      StrCpy $SelectedLangLcid "1086"
      ${Break}
    ${Case} 100 ; fil
      StrCpy $SelectedLangCode "fil"
      StrCpy $SelectedLangLcid "1124"
      ${Break}
    ${Case} 69  ; bn
      StrCpy $SelectedLangCode "bn"
      StrCpy $SelectedLangLcid "1093"
      ${Break}
    ${Case} 13  ; he
      StrCpy $SelectedLangCode "he"
      StrCpy $SelectedLangLcid "1037"
      ${Break}
    ${Case} 41  ; fa
      StrCpy $SelectedLangCode "fa"
      StrCpy $SelectedLangLcid "1065"
      ${Break}
    ${Case} 32  ; ur
      StrCpy $SelectedLangCode "ur"
      StrCpy $SelectedLangLcid "1056"
      ${Break}
    ${Case} 44  ; az
      StrCpy $SelectedLangCode "az"
      StrCpy $SelectedLangLcid "2092"
      ${Break}
    ${Case} 63  ; kk
      StrCpy $SelectedLangCode "kk"
      StrCpy $SelectedLangLcid "1087"
      ${Break}
    ${Case} 67  ; uz
      StrCpy $SelectedLangCode "uz"
      StrCpy $SelectedLangLcid "1091"
      ${Break}
    ${Case} 2   ; bg
      StrCpy $SelectedLangCode "bg"
      StrCpy $SelectedLangLcid "1026"
      ${Break}
    ${Case} 27  ; sk
      StrCpy $SelectedLangCode "sk"
      StrCpy $SelectedLangLcid "1051"
      ${Break}
    ${Case} 37  ; et
      StrCpy $SelectedLangCode "et"
      StrCpy $SelectedLangLcid "1061"
      ${Break}
    ${Case} 73  ; ta
      StrCpy $SelectedLangCode "ta"
      StrCpy $SelectedLangLcid "1097"
      ${Break}
    ${Case} 74  ; te
      StrCpy $SelectedLangCode "te"
      StrCpy $SelectedLangLcid "1098"
      ${Break}
    ${Case} 78  ; mr
      StrCpy $SelectedLangCode "mr"
      StrCpy $SelectedLangLcid "1102"
      ${Break}
    ${Case} 75  ; kn
      StrCpy $SelectedLangCode "kn"
      StrCpy $SelectedLangLcid "1099"
      ${Break}
    ${Case} 71  ; gu
      StrCpy $SelectedLangCode "gu"
      StrCpy $SelectedLangLcid "1095"
      ${Break}
    ${Case} 76  ; ml
      StrCpy $SelectedLangCode "ml"
      StrCpy $SelectedLangLcid "1100"
      ${Break}
    ${Case} 70  ; pa
      StrCpy $SelectedLangCode "pa"
      StrCpy $SelectedLangLcid "1094"
      ${Break}
    ${Case} 39  ; lt
      StrCpy $SelectedLangCode "lt"
      StrCpy $SelectedLangLcid "1063"
      ${Break}
    ${Case} 38  ; lv
      StrCpy $SelectedLangCode "lv"
      StrCpy $SelectedLangLcid "1062"
      ${Break}
    ${Case} 36  ; sl
      StrCpy $SelectedLangCode "sl"
      StrCpy $SelectedLangLcid "1060"
      ${Break}
    ${Case} 28  ; sq
      StrCpy $SelectedLangCode "sq"
      StrCpy $SelectedLangLcid "1052"
      ${Break}
    ${Case} 47  ; mk
      StrCpy $SelectedLangCode "mk"
      StrCpy $SelectedLangLcid "1071"
      ${Break}
    ${Case} 15  ; is
      StrCpy $SelectedLangCode "is"
      StrCpy $SelectedLangLcid "1039"
      ${Break}
    ${Case} 65  ; sw
      StrCpy $SelectedLangCode "sw"
      StrCpy $SelectedLangLcid "1089"
      ${Break}
    ${Case} 94  ; am
      StrCpy $SelectedLangCode "am"
      StrCpy $SelectedLangLcid "1118"
      ${Break}
    ${Case} 104 ; ha
      StrCpy $SelectedLangCode "ha"
      StrCpy $SelectedLangLcid "1128"
      ${Break}
    ${Case} 106 ; yo
      StrCpy $SelectedLangCode "yo"
      StrCpy $SelectedLangLcid "1130"
      ${Break}
    ${Case} 54  ; af
      StrCpy $SelectedLangCode "af"
      StrCpy $SelectedLangLcid "1078"
      ${Break}
    ${Case} 55  ; ka
      StrCpy $SelectedLangCode "ka"
      StrCpy $SelectedLangLcid "1079"
      ${Break}
    ${Case} 43  ; hy
      StrCpy $SelectedLangCode "hy"
      StrCpy $SelectedLangLcid "1067"
      ${Break}
    ${Case} 64  ; ky
      StrCpy $SelectedLangCode "ky"
      StrCpy $SelectedLangLcid "1088"
      ${Break}
    ${Case} 66  ; tk
      StrCpy $SelectedLangCode "tk"
      StrCpy $SelectedLangLcid "1090"
      ${Break}
    ${Case} 80  ; mn
      StrCpy $SelectedLangCode "mn"
      StrCpy $SelectedLangLcid "1104"
      ${Break}
    ${Case} 3   ; ca
      StrCpy $SelectedLangCode "ca"
      StrCpy $SelectedLangLcid "1027"
      ${Break}
    ${Case} 45  ; eu
      StrCpy $SelectedLangCode "eu"
      StrCpy $SelectedLangLcid "1069"
      ${Break}
    ${Case} 86  ; gl
      StrCpy $SelectedLangCode "gl"
      StrCpy $SelectedLangLcid "1110"
      ${Break}
    ${Case} 60  ; ga
      StrCpy $SelectedLangCode "ga"
      StrCpy $SelectedLangLcid "2108"
      ${Break}
    ${Case} 85  ; my
      StrCpy $SelectedLangCode "my"
      StrCpy $SelectedLangLcid "1109"
      ${Break}
    ${Case} 83  ; km
      StrCpy $SelectedLangCode "km"
      StrCpy $SelectedLangLcid "1107"
      ${Break}
    ${Case} 91  ; si
      StrCpy $SelectedLangCode "si"
      StrCpy $SelectedLangLcid "1115"
      ${Break}
  ${EndSwitch}

  detect_done:
!macroend

; Shared macro: maps EVERY ONE of the 73 unique LCIDs 1:1 to ($SelectedLangCode, NSIS $LANGUAGE).
; Because all 73 native NSIS tables are loaded in customHeader, ZERO languages fall back to English!
!macro APPLY_SELECTED_LCID_BODY
  StrCpy $SelectedLangCode "en"
  StrCpy $LANGUAGE "1033"
  ${Switch} $SelectedLangLcid
    ${Case} 1055
      StrCpy $SelectedLangCode "tr"
      StrCpy $LANGUAGE "1055"
      ${Break}
    ${Case} 1033
      StrCpy $SelectedLangCode "en"
      StrCpy $LANGUAGE "1033"
      ${Break}
    ${Case} 1031
      StrCpy $SelectedLangCode "de"
      StrCpy $LANGUAGE "1031"
      ${Break}
    ${Case} 3082
      StrCpy $SelectedLangCode "es"
      StrCpy $LANGUAGE "3082"
      ${Break}
    ${Case} 1036
      StrCpy $SelectedLangCode "fr"
      StrCpy $LANGUAGE "1036"
      ${Break}
    ${Case} 1040
      StrCpy $SelectedLangCode "it"
      StrCpy $LANGUAGE "1040"
      ${Break}
    ${Case} 2070
      StrCpy $SelectedLangCode "pt"
      StrCpy $LANGUAGE "2070"
      ${Break}
    ${Case} 1043
      StrCpy $SelectedLangCode "nl"
      StrCpy $LANGUAGE "1043"
      ${Break}
    ${Case} 1045
      StrCpy $SelectedLangCode "pl"
      StrCpy $LANGUAGE "1045"
      ${Break}
    ${Case} 1049
      StrCpy $SelectedLangCode "ru"
      StrCpy $LANGUAGE "1049"
      ${Break}
    ${Case} 1041
      StrCpy $SelectedLangCode "ja"
      StrCpy $LANGUAGE "1041"
      ${Break}
    ${Case} 1042
      StrCpy $SelectedLangCode "ko"
      StrCpy $LANGUAGE "1042"
      ${Break}
    ${Case} 2052
      StrCpy $SelectedLangCode "zh"
      StrCpy $LANGUAGE "2052"
      ${Break}
    ${Case} 1028
      StrCpy $SelectedLangCode "zh-tw"
      StrCpy $LANGUAGE "1028"
      ${Break}
    ${Case} 1053
      StrCpy $SelectedLangCode "sv"
      StrCpy $LANGUAGE "1053"
      ${Break}
    ${Case} 1025
      StrCpy $SelectedLangCode "ar"
      StrCpy $LANGUAGE "1025"
      ${Break}
    ${Case} 1081
      StrCpy $SelectedLangCode "hi"
      StrCpy $LANGUAGE "1081"
      ${Break}
    ${Case} 1057
      StrCpy $SelectedLangCode "id"
      StrCpy $LANGUAGE "1057"
      ${Break}
    ${Case} 1066
      StrCpy $SelectedLangCode "vi"
      StrCpy $LANGUAGE "1066"
      ${Break}
    ${Case} 1058
      StrCpy $SelectedLangCode "uk"
      StrCpy $LANGUAGE "1058"
      ${Break}
    ${Case} 1032
      StrCpy $SelectedLangCode "el"
      StrCpy $LANGUAGE "1032"
      ${Break}
    ${Case} 1029
      StrCpy $SelectedLangCode "cs"
      StrCpy $LANGUAGE "1029"
      ${Break}
    ${Case} 1030
      StrCpy $SelectedLangCode "da"
      StrCpy $LANGUAGE "1030"
      ${Break}
    ${Case} 1035
      StrCpy $SelectedLangCode "fi"
      StrCpy $LANGUAGE "1035"
      ${Break}
    ${Case} 1044
      StrCpy $SelectedLangCode "no"
      StrCpy $LANGUAGE "1044"
      ${Break}
    ${Case} 1038
      StrCpy $SelectedLangCode "hu"
      StrCpy $LANGUAGE "1038"
      ${Break}
    ${Case} 1048
      StrCpy $SelectedLangCode "ro"
      StrCpy $LANGUAGE "1048"
      ${Break}
    ${Case} 1054
      StrCpy $SelectedLangCode "th"
      StrCpy $LANGUAGE "1054"
      ${Break}
    ${Case} 1086
      StrCpy $SelectedLangCode "ms"
      StrCpy $LANGUAGE "1086"
      ${Break}
    ${Case} 1124
      StrCpy $SelectedLangCode "fil"
      StrCpy $LANGUAGE "1124"
      ${Break}
    ${Case} 1093
      StrCpy $SelectedLangCode "bn"
      StrCpy $LANGUAGE "1093"
      ${Break}
    ${Case} 1037
      StrCpy $SelectedLangCode "he"
      StrCpy $LANGUAGE "1037"
      ${Break}
    ${Case} 1065
      StrCpy $SelectedLangCode "fa"
      StrCpy $LANGUAGE "1065"
      ${Break}
    ${Case} 1056
      StrCpy $SelectedLangCode "ur"
      StrCpy $LANGUAGE "1056"
      ${Break}
    ${Case} 2092
      StrCpy $SelectedLangCode "az"
      StrCpy $LANGUAGE "2092"
      ${Break}
    ${Case} 1087
      StrCpy $SelectedLangCode "kk"
      StrCpy $LANGUAGE "1087"
      ${Break}
    ${Case} 1091
    ${Case} 2115
      StrCpy $SelectedLangCode "uz"
      StrCpy $LANGUAGE "1091"
      ${Break}
    ${Case} 1026
      StrCpy $SelectedLangCode "bg"
      StrCpy $LANGUAGE "1026"
      ${Break}
    ${Case} 1051
      StrCpy $SelectedLangCode "sk"
      StrCpy $LANGUAGE "1051"
      ${Break}
    ${Case} 1050
      StrCpy $SelectedLangCode "hr"
      StrCpy $LANGUAGE "1050"
      ${Break}
    ${Case} 1061
      StrCpy $SelectedLangCode "et"
      StrCpy $LANGUAGE "1061"
      ${Break}
    ${Case} 1097
      StrCpy $SelectedLangCode "ta"
      StrCpy $LANGUAGE "1097"
      ${Break}
    ${Case} 1098
      StrCpy $SelectedLangCode "te"
      StrCpy $LANGUAGE "1098"
      ${Break}
    ${Case} 1102
      StrCpy $SelectedLangCode "mr"
      StrCpy $LANGUAGE "1102"
      ${Break}
    ${Case} 1099
      StrCpy $SelectedLangCode "kn"
      StrCpy $LANGUAGE "1099"
      ${Break}
    ${Case} 1095
      StrCpy $SelectedLangCode "gu"
      StrCpy $LANGUAGE "1095"
      ${Break}
    ${Case} 1100
      StrCpy $SelectedLangCode "ml"
      StrCpy $LANGUAGE "1100"
      ${Break}
    ${Case} 1094
      StrCpy $SelectedLangCode "pa"
      StrCpy $LANGUAGE "1094"
      ${Break}
    ${Case} 1063
      StrCpy $SelectedLangCode "lt"
      StrCpy $LANGUAGE "1063"
      ${Break}
    ${Case} 1062
      StrCpy $SelectedLangCode "lv"
      StrCpy $LANGUAGE "1062"
      ${Break}
    ${Case} 3098
      StrCpy $SelectedLangCode "sr"
      StrCpy $LANGUAGE "3098"
      ${Break}
    ${Case} 1060
      StrCpy $SelectedLangCode "sl"
      StrCpy $LANGUAGE "1060"
      ${Break}
    ${Case} 5146
    ${Case} 8218
      StrCpy $SelectedLangCode "bs"
      StrCpy $LANGUAGE "5146"
      ${Break}
    ${Case} 1052
      StrCpy $SelectedLangCode "sq"
      StrCpy $LANGUAGE "1052"
      ${Break}
    ${Case} 1071
      StrCpy $SelectedLangCode "mk"
      StrCpy $LANGUAGE "1071"
      ${Break}
    ${Case} 1039
      StrCpy $SelectedLangCode "is"
      StrCpy $LANGUAGE "1039"
      ${Break}
    ${Case} 1089
      StrCpy $SelectedLangCode "sw"
      StrCpy $LANGUAGE "1089"
      ${Break}
    ${Case} 1118
      StrCpy $SelectedLangCode "am"
      StrCpy $LANGUAGE "1118"
      ${Break}
    ${Case} 1128
      StrCpy $SelectedLangCode "ha"
      StrCpy $LANGUAGE "1128"
      ${Break}
    ${Case} 1130
      StrCpy $SelectedLangCode "yo"
      StrCpy $LANGUAGE "1130"
      ${Break}
    ${Case} 1078
      StrCpy $SelectedLangCode "af"
      StrCpy $LANGUAGE "1078"
      ${Break}
    ${Case} 1079
      StrCpy $SelectedLangCode "ka"
      StrCpy $LANGUAGE "1079"
      ${Break}
    ${Case} 1067
      StrCpy $SelectedLangCode "hy"
      StrCpy $LANGUAGE "1067"
      ${Break}
    ${Case} 1088
      StrCpy $SelectedLangCode "ky"
      StrCpy $LANGUAGE "1088"
      ${Break}
    ${Case} 1090
      StrCpy $SelectedLangCode "tk"
      StrCpy $LANGUAGE "1090"
      ${Break}
    ${Case} 1104
      StrCpy $SelectedLangCode "mn"
      StrCpy $LANGUAGE "1104"
      ${Break}
    ${Case} 1027
      StrCpy $SelectedLangCode "ca"
      StrCpy $LANGUAGE "1027"
      ${Break}
    ${Case} 1069
      StrCpy $SelectedLangCode "eu"
      StrCpy $LANGUAGE "1069"
      ${Break}
    ${Case} 1110
      StrCpy $SelectedLangCode "gl"
      StrCpy $LANGUAGE "1110"
      ${Break}
    ${Case} 2108
      StrCpy $SelectedLangCode "ga"
      StrCpy $LANGUAGE "2108"
      ${Break}
    ${Case} 1109
      StrCpy $SelectedLangCode "my"
      StrCpy $LANGUAGE "1109"
      ${Break}
    ${Case} 1107
      StrCpy $SelectedLangCode "km"
      StrCpy $LANGUAGE "1107"
      ${Break}
    ${Case} 1115
      StrCpy $SelectedLangCode "si"
      StrCpy $LANGUAGE "1115"
      ${Break}
  ${EndSwitch}
!macroend

!ifndef BUILD_UNINSTALLER
  Function DetectWindowsLanguage
    !insertmacro DETECT_WINDOWS_LANG_BODY
  FunctionEnd

  Function ApplySelectedLcid
    !insertmacro APPLY_SELECTED_LCID_BODY
  FunctionEnd

  !include "nsis-langs\langdialog-titles.nsh"

  !macro customInit
    Call DetectWindowsLanguage

    ; If elevated inner UAC instance (after choosing "All Users"), reuse already-picked language without re-prompting
    ${If} ${UAC_IsInnerInstance}
      ReadRegStr $0 HKCU "Software\Vellium\PowerPilot" "PendingInstallLanguageLcid"
      ${If} $0 != ""
        StrCpy $SelectedLangLcid $0
      ${EndIf}
      Call ApplySelectedLcid
    ${Else}
      Call ApplyLangDialogTitle
      ; Pre-select detected Windows language (or English 1033 fallback) in LangDLL
      StrCpy $LANGUAGE $SelectedLangLcid

      ${Unless} ${Silent}
        ${IfNot} ${isUpdated}
          LangDLL::LangDialog "$StrLangHeader" "$StrLangDesc" "A" \
            "Türkçe (Turkish)" "1055" \
            "English" "1033" \
            "Deutsch (German)" "1031" \
            "Español (Spanish)" "3082" \
            "Français (French)" "1036" \
            "Italiano (Italian)" "1040" \
            "Português (Portuguese)" "2070" \
            "Nederlands (Dutch)" "1043" \
            "Polski (Polish)" "1045" \
            "Русский (Russian)" "1049" \
            "日本語 (Japanese)" "1041" \
            "한국어 (Korean)" "1042" \
            "简体中文 (Chinese Simplified)" "2052" \
            "繁體中文 (Chinese Traditional)" "1028" \
            "Svenska (Swedish)" "1053" \
            "العربية (Arabic)" "1025" \
            "हिन्दी (Hindi)" "1081" \
            "Bahasa Indonesia (Indonesian)" "1057" \
            "Tiếng Việt (Vietnamese)" "1066" \
            "Українська (Ukrainian)" "1058" \
            "Ελληνικά (Greek)" "1032" \
            "Čeština (Czech)" "1029" \
            "Dansk (Danish)" "1030" \
            "Suomi (Finnish)" "1035" \
            "Norsk (Norwegian)" "1044" \
            "Magyar (Hungarian)" "1038" \
            "Română (Romanian)" "1048" \
            "ไทย (Thai)" "1054" \
            "Bahasa Melayu (Malay)" "1086" \
            "Filipino" "1124" \
            "বাংলা (Bengali)" "1093" \
            "עברית (Hebrew)" "1037" \
            "فارسی (Persian)" "1065" \
            "اردو (Urdu)" "1056" \
            "Azərbaycan dili (Azerbaijani)" "2092" \
            "Қазақша (Kazakh)" "1087" \
            "Oʻzbekcha (Uzbek)" "1091" \
            "Български (Bulgarian)" "1026" \
            "Slovenčina (Slovak)" "1051" \
            "Hrvatski (Croatian)" "1050" \
            "Eesti (Estonian)" "1061" \
            "தமிழ் (Tamil)" "1097" \
            "తెలుగు (Telugu)" "1098" \
            "मराठी (Marathi)" "1102" \
            "ಕನ್ನಡ (Kannada)" "1099" \
            "ગુજરાતી (Gujarati)" "1095" \
            "മലയാളം (Malayalam)" "1100" \
            "ਪੰਜਾਬੀ (Punjabi)" "1094" \
            "Lietuvių (Lithuanian)" "1063" \
            "Latviešu (Latvian)" "1062" \
            "Srpski (Serbian)" "3098" \
            "Slovenščina (Slovenian)" "1060" \
            "Bosanski (Bosnian)" "5146" \
            "Shqip (Albanian)" "1052" \
            "Македонски (Macedonian)" "1071" \
            "Íslenska (Icelandic)" "1039" \
            "Kiswahili (Swahili)" "1089" \
            "አማርኛ (Amharic)" "1118" \
            "Hausa" "1128" \
            "Yorùbá (Yoruba)" "1130" \
            "Afrikaans" "1078" \
            "ქართული (Georgian)" "1079" \
            "Հայերեն (Armenian)" "1067" \
            "Кыргызча (Kyrgyz)" "1088" \
            "Türkmençe (Turkmen)" "1090" \
            "Монгол (Mongolian)" "1104" \
            "Català (Catalan)" "1027" \
            "Euskara (Basque)" "1069" \
            "Galego (Galician)" "1110" \
            "Gaeilge (Irish)" "2108" \
            "မြန်မာစာ (Burmese)" "1109" \
            "ភាសាខ្មែរ (Khmer)" "1107" \
            "සිංහල (Sinhala)" "1115" \
            ""
          Pop $0
          ${If} $0 == "cancel"
            Abort
          ${EndIf}
          StrCpy $SelectedLangLcid $0
          WriteRegStr HKCU "Software\Vellium\PowerPilot" "PendingInstallLanguageLcid" "$SelectedLangLcid"
        ${EndIf}
      ${EndUnless}

      ; Lock NSIS $LANGUAGE to the exact chosen 1-of-73 native table BEFORE wizard UI opens
      Call ApplySelectedLcid
    ${EndIf}
  !macroend

  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  Function un.DetectWindowsLanguage
    !insertmacro DETECT_WINDOWS_LANG_BODY
  FunctionEnd

  Function un.ApplySelectedLcid
    !insertmacro APPLY_SELECTED_LCID_BODY
  FunctionEnd

  !macro customUnInit
    ReadRegStr $SelectedLangLcid HKCU "Software\Vellium\PowerPilot" "InstallLanguageLcid"
    ${If} $SelectedLangLcid == ""
      ReadRegStr $SelectedLangLcid HKLM "Software\Vellium\PowerPilot" "InstallLanguageLcid"
    ${EndIf}
    ${If} $SelectedLangLcid == ""
      Call un.DetectWindowsLanguage
    ${EndIf}
    ; Lock $LANGUAGE to the exact 1-of-73 native table BEFORE uninstaller UI opens
    Call un.ApplySelectedLcid
  !macroend

  !macro customUnWelcomePage
    !insertmacro MUI_UNPAGE_WELCOME
    UninstPage custom un.UserDataPageCreate un.UserDataPageLeave

    Function un.UserDataPageCreate
      !insertmacro MUI_HEADER_TEXT "$(PP_UnDataHeader)" "$(PP_UnDataSub)"

      nsDialogs::Create 1018
      Pop $UnDataDialog
      ${If} $UnDataDialog == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 8u 100% 34u "$(PP_UnDataInfo)"
      Pop $UnDataInfoLabel

      ${NSD_CreateCheckbox} 0 50u 100% 18u "$(PP_UnDataCheck)"
      Pop $UnDataCheckbox
      ${If} $DeleteUserDataFlag == ${BST_CHECKED}
        ${NSD_Check} $UnDataCheckbox
      ${EndIf}

      ${NSD_CreateLabel} 14u 72u 92% 34u "$(PP_UnDataHint)"
      Pop $UnDataHintLabel

      nsDialogs::Show
    FunctionEnd

    Function un.UserDataPageLeave
      ${NSD_GetState} $UnDataCheckbox $DeleteUserDataFlag
    FunctionEnd
  !macroend
!endif

!macro customInstall
  ; Point DisplayIcon AND Desktop/Start Menu shortcuts to the lightweight standalone .ico
  ; ($INSTDIR\uninstallerIcon.ico) instead of the ~200MB Power Pilot.exe so Control Panel
  ; and Windows 11 Taskbar render the crisp icon IMMEDIATELY with zero blank/white delay.
  StrCpy $8 "$INSTDIR\uninstallerIcon.ico"
  ${IfNot} ${FileExists} "$8"
    StrCpy $8 "$INSTDIR\resources\app.asar.unpacked\src\assets\icons\monochrome-dark.ico"
  ${EndIf}
  ${If} ${FileExists} "$8"
    WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$8,0"
    ${If} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$8" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}
    ${If} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$8" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${Else}
    WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  ${EndIf}

  ; Windows 11 Settings > Installed Apps & Control Panel publisher and support metadata
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Vellium Teknoloji Anonim Şirketi"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout" "https://vellium.dev"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo" "https://vellium.dev/en/products/power-pilot"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "HelpLink" "https://vellium.dev/en/legal/support"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Contact" "support@vellium.dev"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Comments" "Power Pilot - Vellium (https://vellium.dev)"
  WriteRegDWORD SHCTX "${UNINSTALL_REGISTRY_KEY}" "NoModify" 1
  WriteRegDWORD SHCTX "${UNINSTALL_REGISTRY_KEY}" "NoRepair" 1

  ; Persist chosen 73-language code & LCID for uninstaller (both HKCU & SHCTX) + app handoff
  ${If} $SelectedLangCode == ""
    StrCpy $SelectedLangCode "en"
  ${EndIf}
  ${If} $SelectedLangLcid == ""
    StrCpy $SelectedLangLcid "1033"
  ${EndIf}
  WriteRegStr HKCU "Software\Vellium\PowerPilot" "InstallLanguage" "$SelectedLangCode"
  WriteRegStr HKCU "Software\Vellium\PowerPilot" "InstallLanguageLcid" "$SelectedLangLcid"
  WriteRegStr SHCTX "Software\Vellium\PowerPilot" "InstallLanguage" "$SelectedLangCode"
  WriteRegStr SHCTX "Software\Vellium\PowerPilot" "InstallLanguageLcid" "$SelectedLangLcid"
  DeleteRegValue HKCU "Software\Vellium\PowerPilot" "PendingInstallLanguageLcid"

  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}
  CreateDirectory "$APPDATA\powerpilot"
  FileOpen $9 "$APPDATA\powerpilot\installer-language.json" w
  ${If} $9 != ""
    FileWrite $9 '{"language":"$SelectedLangCode"}'
    FileClose $9
  ${EndIf}
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}

  ; Register $INSTDIR\resources\bin on User/Machine PATH safely (unlimited length via .NET Environment API; zero truncation)
  ${If} $installMode == "all"
    nsExec::ExecToLog "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command $\"$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.Trim().TrimEnd('\') -ine $$d.TrimEnd('\') }); $$parts += $$d; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'Machine')$\""
    Pop $0
  ${Else}
    nsExec::ExecToLog "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command $\"$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.Trim().TrimEnd('\') -ine $$d.TrimEnd('\') }); $$parts += $$d; [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User')$\""
    Pop $0
  ${EndIf}

  ; Synchronous Windows Explorer icon cache flush (SHCNF_FLUSH | SHCNF_PATHW + ie4uinit -show)
  ${If} ${FileExists} "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x1005, w "$newDesktopLink", i 0)'
  ${EndIf}
  ${If} ${FileExists} "$newStartMenuLink"
    System::Call 'Shell32::SHChangeNotify(i 0x00002000, i 0x1005, w "$newStartMenuLink", i 0)'
  ${EndIf}
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    nsExec::ExecToLog '"$SYSDIR\ie4uinit.exe" -show'
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; Remove $INSTDIR\resources\bin from PATH cleanly on uninstall (zero truncation)
  ${If} $installMode == "all"
    nsExec::ExecToLog "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command $\"$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'Machine'); if ($$p) { $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.Trim().TrimEnd('\') -ine $$d.TrimEnd('\') }); [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'Machine') }$\""
    Pop $0
  ${Else}
    nsExec::ExecToLog "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command $\"$$d = '$INSTDIR\resources\bin'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$p) { $$parts = @($$p -split ';' | Where-Object { $$_ -and $$_.Trim().TrimEnd('\') -ine $$d.TrimEnd('\') }); [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User') }$\""
    Pop $0
  ${EndIf}

  ; Clean Windows Task Scheduler entries without -ExecutionPolicy Bypass (avoids AV heuristics)
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Get-ScheduledTask -TaskPath \PowerPilot* -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$$false -ErrorAction SilentlyContinue"'
  Pop $0
  DetailPrint "Power Pilot: Task Scheduler ($0)"

  ${If} $DeleteUserDataFlag == ${BST_CHECKED}
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    RMDir /r "$APPDATA\powerpilot"
    RMDir /r "$APPDATA\Power Pilot"
    RMDir /r "$LOCALAPPDATA\powerpilot"
    RMDir /r "$LOCALAPPDATA\Power Pilot"
    DeleteRegKey HKCU "Software\Vellium\PowerPilot"
    DeleteRegKey SHCTX "Software\Vellium\PowerPilot"

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
