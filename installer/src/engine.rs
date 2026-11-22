use crate::cli::is_safe_install_dir;
use crate::payload;
use crate::win_sys;
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub install_dir: String,
    pub lang: String,
    pub desktop_shortcut: bool,
    pub start_menu_shortcut: bool,
    pub run_at_startup: bool,
    pub add_to_path: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallOptions {
    pub install_dir: String,
    pub delete_user_data: bool,
}

pub fn resolve_icon_path(install_dir: &Path) -> PathBuf {
    let unpacked_ico = install_dir
        .join("resources")
        .join("app.asar.unpacked")
        .join("src")
        .join("assets")
        .join("icons")
        .join("monochrome-dark.ico");
    if unpacked_ico.exists() {
        return unpacked_ico;
    }
    install_dir.join(win_sys::APP_EXE_NAME)
}

pub fn run_install<F>(
    exe_path: &Path,
    opts: &InstallOptions,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(u8, &str),
{
    let target_dir = PathBuf::from(opts.install_dir.trim());
    if !is_safe_install_dir(&target_dir) {
        return Err(format!(
            "Invalid or restricted installation path: {}",
            target_dir.display()
        ));
    }

    on_progress(5, "stepPrepare");
    on_progress(10, "stepClose");
    win_sys::close_running_app(&target_dir);

    on_progress(15, "stepExtract");
    let trailer = payload::extract_payload(exe_path, &target_dir, |extract_pct| {
        let mapped = 15 + ((extract_pct as u16 * 65) / 100) as u8;
        on_progress(mapped, "stepExtract");
    })
    .map_err(|e| format!("Extraction failed: {e}"))?;

    on_progress(82, "stepRegister");
    payload::write_uninstaller_stub(exe_path, &trailer, &target_dir)
        .map_err(|e| format!("Failed to write uninstall.exe: {e}"))?;

    let app_exe = target_dir.join(win_sys::APP_EXE_NAME);
    let icon_path = resolve_icon_path(&target_dir);
    let estimated_kb = ((trailer.unpacked_bytes / 1024).max(1)) as u32;

    win_sys::write_install_registry(
        &target_dir,
        &trailer.version,
        &opts.lang,
        estimated_kb,
        &icon_path,
    )?;

    if opts.desktop_shortcut {
        if let Some(lnk) = win_sys::desktop_shortcut_path() {
            win_sys::create_shortcut(&lnk, &app_exe, &icon_path, &target_dir, "Power Pilot")?;
        }
    }
    if opts.start_menu_shortcut {
        if let Some(lnk) = win_sys::start_menu_shortcut_path() {
            win_sys::create_shortcut(&lnk, &app_exe, &icon_path, &target_dir, "Power Pilot")?;
        }
    }
    win_sys::set_run_at_startup(opts.run_at_startup, &app_exe)?;

    on_progress(92, "stepPath");
    let cli_bin = target_dir.join("resources").join("bin");
    if opts.add_to_path {
        win_sys::update_user_path(&cli_bin, true)?;
    }

    on_progress(97, "stepRefresh");
    win_sys::refresh_windows_shell();
    on_progress(100, "stepRefresh");
    Ok(())
}

pub fn run_uninstall<F>(opts: &UninstallOptions, mut on_progress: F) -> Result<(), String>
where
    F: FnMut(u8, &str),
{
    let target_dir = PathBuf::from(opts.install_dir.trim());
    if !is_safe_install_dir(&target_dir) {
        return Err(format!(
            "Refusing to remove unsafe directory: {}",
            target_dir.display()
        ));
    }

    on_progress(12, "stepClose");
    win_sys::close_running_app(&target_dir);

    on_progress(28, "stepRegister");
    win_sys::remove_shortcuts();
    let cli_bin = target_dir.join("resources").join("bin");
    let _ = win_sys::update_user_path(&cli_bin, false);
    win_sys::remove_install_registry();

    on_progress(52, "stepRemoveFiles");
    if target_dir.exists() {
        // Retry briefly while parent uninstall.exe exits or Explorer/Defender releases handles
        let mut last_err = None;
        for _ in 0..20 {
            match fs::remove_dir_all(&target_dir) {
                Ok(_) => {
                    last_err = None;
                    break;
                }
                Err(err) => {
                    last_err = Some(err);
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
            }
        }
        if let Some(err) = last_err {
            // If some locked file remained, remove everything possible and schedule remaining dir on reboot
            let _ = remove_best_effort(&target_dir);
            if target_dir.exists() {
                win_sys::schedule_self_delete_on_reboot(&target_dir);
                return Err(format!("Some files could not be removed immediately: {err}"));
            }
        }
    }

    if opts.delete_user_data {
        on_progress(82, "stepRemoveData");
        let data_dir = win_sys::user_data_dir();
        if data_dir.exists() && is_safe_install_dir(&data_dir) {
            let _ = fs::remove_dir_all(&data_dir);
        }
    }

    on_progress(95, "stepRefresh");
    win_sys::refresh_windows_shell();
    on_progress(100, "stepRefresh");
    Ok(())
}

fn remove_best_effort(dir: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.is_dir() {
            let _ = remove_best_effort(&p);
            let _ = fs::remove_dir(&p);
        } else {
            let _ = fs::remove_file(&p);
        }
    }
    let _ = fs::remove_dir(dir);
    Ok(())
}
