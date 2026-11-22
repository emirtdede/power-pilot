use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "Power Pilot";
pub const APP_PUBLISHER: &str = "Vellium Teknoloji Anonim Sirketi";
pub const APP_URL: &str = "https://vellium.dev";
pub const APP_EXE_NAME: &str = "Power Pilot.exe";
pub const UNINSTALL_REG_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Power Pilot";
pub const APP_REG_SUBKEY: &str = r"Software\Vellium\PowerPilot";
pub const RUN_REG_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

#[derive(Debug, Clone, Default)]
pub struct InstalledInfo {
    pub version: Option<String>,
    pub install_dir: Option<PathBuf>,
    pub language: Option<String>,
}

pub fn default_install_dir() -> PathBuf {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        if !local.trim().is_empty() {
            return PathBuf::from(local).join("Programs").join(APP_NAME);
        }
    }
    PathBuf::from(r"C:\Program Files").join(APP_NAME)
}

pub fn user_data_dir() -> PathBuf {
    if let Ok(roaming) = std::env::var("APPDATA") {
        if !roaming.trim().is_empty() {
            return PathBuf::from(roaming).join("powerpilot");
        }
    }
    default_install_dir().join("data")
}

/// Maps Windows LCID (from GetUserDefaultUILanguage) to one of the 73 supported codes; falls back to "en".
pub fn map_lcid_to_lang(lcid: u16) -> &'static str {
    match lcid {
        1028 | 3076 | 5124 => return "zh-tw",
        5146 | 8218 | 30746 | 25626 => return "bs",
        1050 | 4122 => return "hr",
        2074 | 3098 | 6170 | 7194 | 9242 | 10266 | 11290 | 12314 => return "sr",
        _ => {}
    }
    match lcid & 0x3FF {
        31 => "tr",
        9 => "en",
        7 => "de",
        10 => "es",
        12 => "fr",
        16 => "it",
        22 => "pt",
        19 => "nl",
        21 => "pl",
        25 => "ru",
        17 => "ja",
        18 => "ko",
        4 => "zh",
        29 => "sv",
        1 => "ar",
        57 => "hi",
        33 => "id",
        42 => "vi",
        34 => "uk",
        8 => "el",
        5 => "cs",
        6 => "da",
        11 => "fi",
        20 => "no",
        14 => "hu",
        24 => "ro",
        30 => "th",
        62 => "ms",
        100 => "fil",
        69 => "bn",
        13 => "he",
        41 => "fa",
        32 => "ur",
        44 => "az",
        63 => "kk",
        67 => "uz",
        2 => "bg",
        27 => "sk",
        37 => "et",
        73 => "ta",
        74 => "te",
        78 => "mr",
        75 => "kn",
        71 => "gu",
        76 => "ml",
        70 => "pa",
        39 => "lt",
        38 => "lv",
        36 => "sl",
        28 => "sq",
        47 => "mk",
        15 => "is",
        65 => "sw",
        94 => "am",
        104 => "ha",
        106 => "yo",
        54 => "af",
        55 => "ka",
        43 => "hy",
        64 => "ky",
        66 => "tk",
        80 => "mn",
        3 => "ca",
        45 => "eu",
        86 => "gl",
        60 => "ga",
        85 => "my",
        83 => "km",
        91 => "si",
        _ => "en",
    }
}

/// Pure PATH merger: idempotently adds or removes a directory from a `;`-delimited Windows PATH string.
pub fn merge_path_entries(current: &str, target: &str, add: bool) -> String {
    let norm_target = target.trim().trim_end_matches('\\').to_ascii_lowercase();
    let mut parts: Vec<String> = current
        .split(';')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter(|s| s.trim_end_matches('\\').to_ascii_lowercase() != norm_target)
        .map(|s| s.to_string())
        .collect();
    if add && !target.trim().is_empty() {
        parts.push(target.trim().to_string());
    }
    parts.join(";")
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW,
        RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE,
        KEY_WRITE, REG_DWORD, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, IFileOpenDialog, IShellLinkW, SHChangeNotify, SHGetKnownFolderPath,
        ShellLink, FOLDERID_Desktop, FOLDERID_Programs, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
        KNOWN_FOLDER_FLAG, SHCNE_ASSOCCHANGED, SHCNF_FLUSH, SHCNF_IDLIST, SIGDN_FILESYSPATH,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn detect_windows_language() -> &'static str {
        let lcid = unsafe { GetUserDefaultUILanguage() };
        map_lcid_to_lang(lcid)
    }

    fn reg_read_string(root: HKEY, subkey: &str, name: &str) -> Option<String> {
        unsafe {
            let mut hkey = HKEY::default();
            let sub_w = to_wide(subkey);
            if RegOpenKeyExW(root, PCWSTR(sub_w.as_ptr()), 0, KEY_READ, &mut hkey).is_err() {
                return None;
            }
            let name_w = to_wide(name);
            let mut vtype = REG_VALUE_TYPE(0);
            let mut size = 0u32;
            let ok = RegQueryValueExW(
                hkey,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut vtype),
                None,
                Some(&mut size),
            )
            .is_ok();
            if !ok || size < 2 {
                let _ = RegCloseKey(hkey);
                return None;
            }
            let mut buf = vec![0u8; size as usize];
            let ok2 = RegQueryValueExW(
                hkey,
                PCWSTR(name_w.as_ptr()),
                None,
                Some(&mut vtype),
                Some(buf.as_mut_ptr()),
                Some(&mut size),
            )
            .is_ok();
            let _ = RegCloseKey(hkey);
            if !ok2 {
                return None;
            }
            let wide: Vec<u16> = buf
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .take_while(|&ch| ch != 0)
                .collect();
            Some(String::from_utf16_lossy(&wide))
        }
    }

    fn reg_set_string(hkey: HKEY, name: &str, val: &str, expand: bool) -> Result<(), String> {
        let name_w = to_wide(name);
        let val_w = to_wide(val);
        let bytes = unsafe {
            std::slice::from_raw_parts(val_w.as_ptr() as *const u8, val_w.len() * 2)
        };
        let kind = if expand { REG_EXPAND_SZ } else { REG_SZ };
        unsafe {
            RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), 0, kind, Some(bytes))
                .ok()
                .map_err(|e| format!("RegSetValueExW({name}) failed: {e}"))
        }
    }

    fn reg_set_dword(hkey: HKEY, name: &str, val: u32) -> Result<(), String> {
        let name_w = to_wide(name);
        let bytes = val.to_le_bytes();
        unsafe {
            RegSetValueExW(hkey, PCWSTR(name_w.as_ptr()), 0, REG_DWORD, Some(&bytes))
                .ok()
                .map_err(|e| format!("RegSetValueExW({name}) failed: {e}"))
        }
    }

    pub fn read_installed_info() -> InstalledInfo {
        let version = reg_read_string(HKEY_CURRENT_USER, UNINSTALL_REG_SUBKEY, "DisplayVersion");
        let install_dir = reg_read_string(HKEY_CURRENT_USER, UNINSTALL_REG_SUBKEY, "InstallLocation")
            .or_else(|| reg_read_string(HKEY_CURRENT_USER, APP_REG_SUBKEY, "InstallDir"))
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        let language = reg_read_string(HKEY_CURRENT_USER, APP_REG_SUBKEY, "InstallLanguage");
        InstalledInfo {
            version,
            install_dir,
            language,
        }
    }

    pub fn write_install_registry(
        install_dir: &Path,
        version: &str,
        lang: &str,
        estimated_kb: u32,
        icon_path: &Path,
    ) -> Result<(), String> {
        let install_str = install_dir.to_string_lossy().to_string();
        let uninst_exe = install_dir.join("uninstall.exe").to_string_lossy().to_string();
        let icon_str = icon_path.to_string_lossy().to_string();

        unsafe {
            let mut hkey = HKEY::default();
            let sub_w = to_wide(UNINSTALL_REG_SUBKEY);
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_w.as_ptr()),
                0,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut hkey,
                None,
            )
            .ok()
            .map_err(|e| format!("Failed to create Uninstall registry key: {e}"))?;

            let res = (|| {
                reg_set_string(hkey, "DisplayName", APP_NAME, false)?;
                reg_set_string(hkey, "DisplayVersion", version, false)?;
                reg_set_string(hkey, "Publisher", APP_PUBLISHER, false)?;
                reg_set_string(hkey, "DisplayIcon", &icon_str, false)?;
                reg_set_string(hkey, "InstallLocation", &install_str, false)?;
                reg_set_string(hkey, "UninstallString", &format!("\"{uninst_exe}\""), false)?;
                reg_set_string(hkey, "QuietUninstallString", &format!("\"{uninst_exe}\" /S"), false)?;
                reg_set_string(hkey, "URLInfoAbout", APP_URL, false)?;
                reg_set_dword(hkey, "EstimatedSize", estimated_kb)?;
                reg_set_dword(hkey, "NoModify", 1)?;
                reg_set_dword(hkey, "NoRepair", 1)?;
                Ok::<(), String>(())
            })();
            let _ = RegCloseKey(hkey);
            res?;

            let mut app_key = HKEY::default();
            let app_sub_w = to_wide(APP_REG_SUBKEY);
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(app_sub_w.as_ptr()),
                0,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE,
                None,
                &mut app_key,
                None,
            )
            .ok()
            .map_err(|e| format!("Failed to create App registry key: {e}"))?;
            let res2 = (|| {
                reg_set_string(app_key, "InstallLanguage", lang, false)?;
                reg_set_string(app_key, "InstallDir", &install_str, false)?;
                reg_set_string(app_key, "Version", version, false)?;
                Ok::<(), String>(())
            })();
            let _ = RegCloseKey(app_key);
            res2
        }
    }

    pub fn remove_install_registry() {
        unsafe {
            let uninst_w = to_wide(UNINSTALL_REG_SUBKEY);
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(uninst_w.as_ptr()));
            let app_w = to_wide(APP_REG_SUBKEY);
            let _ = RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(app_w.as_ptr()));
        }
        let _ = set_run_at_startup(false, Path::new(""));
    }

    pub fn set_run_at_startup(enabled: bool, exe_path: &Path) -> Result<(), String> {
        unsafe {
            let mut hkey = HKEY::default();
            let sub_w = to_wide(RUN_REG_SUBKEY);
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_w.as_ptr()),
                0,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                None,
            )
            .is_err()
            {
                return Ok(());
            }
            let res = if enabled {
                let cmd = format!("\"{}\" --autostart", exe_path.to_string_lossy());
                reg_set_string(hkey, APP_NAME, &cmd, false)
            } else {
                let name_w = to_wide(APP_NAME);
                let _ = RegDeleteValueW(hkey, PCWSTR(name_w.as_ptr()));
                Ok(())
            };
            let _ = RegCloseKey(hkey);
            res
        }
    }

    pub fn update_user_path(bin_dir: &Path, add: bool) -> Result<(), String> {
        let current = reg_read_string(HKEY_CURRENT_USER, "Environment", "Path").unwrap_or_default();
        let target = bin_dir.to_string_lossy().to_string();
        let updated = merge_path_entries(&current, &target, add);
        if updated == current {
            return Ok(());
        }
        unsafe {
            let mut hkey = HKEY::default();
            let sub_w = to_wide("Environment");
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(sub_w.as_ptr()),
                0,
                None,
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                None,
            )
            .ok()
            .map_err(|e| format!("Failed to open HKCU\\Environment: {e}"))?;
            let r = reg_set_string(hkey, "Path", &updated, true);
            let _ = RegCloseKey(hkey);
            r?;

            let env_w = to_wide("Environment");
            let mut _res = 0usize;
            let _ = SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                WPARAM(0),
                LPARAM(env_w.as_ptr() as isize),
                SMTO_ABORTIFHUNG,
                1500,
                Some(&mut _res),
            );
        }
        Ok(())
    }

    fn known_folder_path(id: &windows::core::GUID) -> Option<PathBuf> {
        unsafe {
            let raw: PWSTR = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
            let s = raw.to_string().ok();
            CoTaskMemFree(Some(raw.0 as *const _));
            s.map(PathBuf::from)
        }
    }

    pub fn desktop_shortcut_path() -> Option<PathBuf> {
        known_folder_path(&FOLDERID_Desktop).map(|d| d.join(format!("{APP_NAME}.lnk")))
    }

    pub fn start_menu_shortcut_path() -> Option<PathBuf> {
        known_folder_path(&FOLDERID_Programs).map(|d| d.join(format!("{APP_NAME}.lnk")))
    }

    pub fn create_shortcut(
        lnk_path: &Path,
        target_exe: &Path,
        icon_path: &Path,
        working_dir: &Path,
        description: &str,
    ) -> Result<(), String> {
        if let Some(parent) = lnk_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let res = (|| {
                let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("CoCreateInstance(ShellLink) failed: {e}"))?;
                let target_w = to_wide(&target_exe.to_string_lossy());
                let icon_w = to_wide(&icon_path.to_string_lossy());
                let dir_w = to_wide(&working_dir.to_string_lossy());
                let desc_w = to_wide(description);
                link.SetPath(PCWSTR(target_w.as_ptr())).map_err(|e| format!("SetPath: {e}"))?;
                link.SetIconLocation(PCWSTR(icon_w.as_ptr()), 0).map_err(|e| format!("SetIconLocation: {e}"))?;
                link.SetWorkingDirectory(PCWSTR(dir_w.as_ptr())).map_err(|e| format!("SetWorkingDirectory: {e}"))?;
                link.SetDescription(PCWSTR(desc_w.as_ptr())).map_err(|e| format!("SetDescription: {e}"))?;

                let pf: IPersistFile = link.cast().map_err(|e| format!("IPersistFile cast: {e}"))?;
                let lnk_w = to_wide(&lnk_path.to_string_lossy());
                pf.Save(PCWSTR(lnk_w.as_ptr()), true).map_err(|e| format!("IPersistFile::Save: {e}"))?;
                Ok::<(), String>(())
            })();
            CoUninitialize();
            res
        }
    }

    pub fn remove_shortcuts() {
        if let Some(p) = desktop_shortcut_path() {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = start_menu_shortcut_path() {
            let _ = std::fs::remove_file(p);
        }
    }

    pub fn refresh_windows_shell() {
        unsafe {
            SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST | SHCNF_FLUSH, None, None);
        }
    }

    pub fn close_running_app(install_dir: &Path) {
        let dir_lower = install_dir.to_string_lossy().to_ascii_lowercase();
        let my_pid = std::process::id();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return;
            };
            let mut pe = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut pe).is_ok() {
                loop {
                    let pid = pe.th32ProcessID;
                    if pid != my_pid && pid > 4 {
                        let name_len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                        let exe_name = String::from_utf16_lossy(&pe.szExeFile[..name_len]);
                        if exe_name.eq_ignore_ascii_case(APP_EXE_NAME) {
                            if let Ok(proc_h) = OpenProcess(
                                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE,
                                false,
                                pid,
                            ) {
                                let mut path_buf = vec![0u16; 1024];
                                let mut len = path_buf.len() as u32;
                                let matches_dir = QueryFullProcessImageNameW(
                                    proc_h,
                                    PROCESS_NAME_FORMAT(0),
                                    PWSTR(path_buf.as_mut_ptr()),
                                    &mut len,
                                )
                                .is_ok()
                                    && String::from_utf16_lossy(&path_buf[..len as usize])
                                        .to_ascii_lowercase()
                                        .starts_with(&dir_lower);
                                if matches_dir {
                                    let _ = TerminateProcess(proc_h, 0);
                                }
                                let _ = CloseHandle(proc_h);
                            }
                        }
                    }
                    if Process32NextW(snap, &mut pe).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        std::thread::sleep(std::time::Duration::from_millis(350));
    }

    pub fn browse_folder_dialog(hwnd_raw: isize, initial_dir: Option<&str>) -> Option<String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let chosen = (|| {
                let dialog: IFileOpenDialog =
                    CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).ok()?;
                let opts = dialog.GetOptions().ok()?;
                dialog
                    .SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM)
                    .ok()?;
                if let Some(dir) = initial_dir {
                    let p = Path::new(dir);
                    if p.exists() {
                        let h = HSTRING::from(dir);
                        if let Ok(item) = windows::Win32::UI::Shell::SHCreateItemFromParsingName::<
                            _,
                            _,
                            windows::Win32::UI::Shell::IShellItem,
                        >(&h, None)
                        {
                            let _ = dialog.SetFolder(&item);
                        }
                    }
                }
                let owner = HWND(hwnd_raw as *mut _);
                dialog.Show(owner).ok()?;
                let result = dialog.GetResult().ok()?;
                let display = result.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
                let path_str = display.to_string().ok();
                CoTaskMemFree(Some(display.0 as *const _));
                path_str
            })();
            CoUninitialize();
            chosen
        }
    }

    pub fn schedule_self_delete_on_reboot(path: &Path) {
        let wide = to_wide(&path.to_string_lossy());
        unsafe {
            let _ = MoveFileExW(PCWSTR(wide.as_ptr()), None, MOVEFILE_DELAY_UNTIL_REBOOT);
        }
    }

    pub fn launch_app(install_dir: &Path) {
        let exe = install_dir.join(APP_EXE_NAME);
        if exe.exists() {
            let _ = std::process::Command::new(&exe)
                .current_dir(install_dir)
                .spawn();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn detect_windows_language() -> &'static str { "en" }
    pub fn read_installed_info() -> InstalledInfo { InstalledInfo::default() }
    pub fn write_install_registry(_: &Path, _: &str, _: &str, _: u32, _: &Path) -> Result<(), String> { Ok(()) }
    pub fn remove_install_registry() {}
    pub fn set_run_at_startup(_: bool, _: &Path) -> Result<(), String> { Ok(()) }
    pub fn update_user_path(_: &Path, _: bool) -> Result<(), String> { Ok(()) }
    pub fn desktop_shortcut_path() -> Option<PathBuf> { None }
    pub fn start_menu_shortcut_path() -> Option<PathBuf> { None }
    pub fn create_shortcut(_: &Path, _: &Path, _: &Path, _: &Path, _: &str) -> Result<(), String> { Ok(()) }
    pub fn remove_shortcuts() {}
    pub fn refresh_windows_shell() {}
    pub fn close_running_app(_: &Path) {}
    pub fn browse_folder_dialog(_: isize, _: Option<&str>) -> Option<String> { None }
    pub fn schedule_self_delete_on_reboot(_: &Path) {}
    pub fn launch_app(_: &Path) {}
}

pub use imp::*;

/// If `uninstall.exe` was launched from inside `install_dir`, copies itself to `%TEMP%`
/// and respawns with `--uninstall --temp-uninstaller --install-dir="<install_dir>"` so
/// the entire install folder (including `uninstall.exe`) can be deleted cleanly without cmd.exe.
pub fn respawn_uninstaller_from_temp(
    current_exe: &Path,
    install_dir: &Path,
    raw_args: &[String],
) -> Result<bool, String> {
    let exe_norm = current_exe.to_string_lossy().to_ascii_lowercase();
    let dir_norm = install_dir.to_string_lossy().to_ascii_lowercase();
    if !exe_norm.starts_with(&dir_norm) {
        return Ok(false);
    }
    let tmp_exe = std::env::temp_dir().join(format!("pp-uninst-{}.exe", std::process::id()));
    std::fs::copy(current_exe, &tmp_exe)
        .map_err(|e| format!("Failed to stage uninstaller in temp: {e}"))?;

    let mut cmd = std::process::Command::new(&tmp_exe);
    cmd.arg("--uninstall")
        .arg("--temp-uninstaller")
        .arg(format!("--install-dir={}", install_dir.to_string_lossy()));
    for a in raw_args {
        let up = a.to_ascii_uppercase();
        if up == "--TEMP-UNINSTALLER" || up.starts_with("--INSTALL-DIR=") {
            continue;
        }
        cmd.arg(a);
    }
    // Always detach-spawn and exit immediately so Windows releases the file lock on
    // `<install_dir>\uninstall.exe` before the temp uninstaller removes `<install_dir>`.
    cmd.spawn()
        .map_err(|e| format!("Failed to spawn temp uninstaller: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_lcid_to_supported_73_languages_and_falls_back_to_en() {
        assert_eq!(map_lcid_to_lang(1055), "tr");
        assert_eq!(map_lcid_to_lang(1033), "en");
        assert_eq!(map_lcid_to_lang(1031), "de");
        assert_eq!(map_lcid_to_lang(1025), "ar");
        assert_eq!(map_lcid_to_lang(1028), "zh-tw");
        assert_eq!(map_lcid_to_lang(2052), "zh");
        assert_eq!(map_lcid_to_lang(5146), "bs");
        assert_eq!(map_lcid_to_lang(1050), "hr");
        assert_eq!(map_lcid_to_lang(3098), "sr");
        assert_eq!(map_lcid_to_lang(0xFFFF), "en");
    }

    #[test]
    fn merges_path_idempotently() {
        let base = r"C:\Windows\System32;C:\Tools";
        let added = merge_path_entries(base, r"C:\Users\u\Power Pilot\resources\bin", true);
        assert_eq!(added, r"C:\Windows\System32;C:\Tools;C:\Users\u\Power Pilot\resources\bin");
        let added2 = merge_path_entries(&added, r"C:\Users\u\Power Pilot\resources\bin\", true);
        assert_eq!(added2, r"C:\Windows\System32;C:\Tools;C:\Users\u\Power Pilot\resources\bin\");
        let removed = merge_path_entries(&added2, r"C:\Users\u\Power Pilot\resources\bin", false);
        assert_eq!(removed, base);
    }
}
