use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliArgs {
    pub uninstall: bool,
    pub silent: bool,
    pub passive: bool,
    pub install_dir: Option<PathBuf>,
    pub lang: Option<String>,
    pub delete_data: bool,
    pub desktop_shortcut: bool,
    pub start_menu_shortcut: bool,
    pub run_at_startup: bool,
    pub add_to_path: bool,
    pub launch_after: bool,
    pub is_temp_uninstaller: bool,
}

impl Default for CliArgs {
    fn default() -> Self {
        Self {
            uninstall: false,
            silent: false,
            passive: false,
            install_dir: None,
            lang: None,
            delete_data: false,
            desktop_shortcut: true,
            start_menu_shortcut: true,
            run_at_startup: false,
            add_to_path: true,
            launch_after: false,
            is_temp_uninstaller: false,
        }
    }
}

fn strip_quotes(raw: &str) -> &str {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    }
}

pub fn parse_args<I, S>(exe_name: Option<&str>, args: I) -> CliArgs
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut cfg = CliArgs::default();

    if let Some(stem) = exe_name {
        if stem.to_ascii_lowercase().starts_with("uninstall") {
            cfg.uninstall = true;
        }
    }

    let list: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    let mut i = 0;
    while i < list.len() {
        let raw = list[i].trim();
        let upper = raw.to_ascii_uppercase();

        if upper == "/S" || upper == "/SILENT" || upper == "/VERYSILENT" || upper == "--SILENT" {
            cfg.silent = true;
        } else if upper == "/P" || upper == "/PASSIVE" || upper == "--PASSIVE" {
            cfg.silent = true;
            cfg.passive = true;
        } else if upper == "--UNINSTALL" || upper == "/UNINSTALL" || upper == "-U" {
            cfg.uninstall = true;
        } else if upper == "--DELETE-DATA" || upper == "/DELETE-DATA" || upper == "/DELETEDATA" {
            cfg.delete_data = true;
        } else if upper == "--NO-DESKTOP" || upper == "/NODESKTOP" {
            cfg.desktop_shortcut = false;
        } else if upper == "--NO-STARTMENU" || upper == "/NOSTARTMENU" {
            cfg.start_menu_shortcut = false;
        } else if upper == "--STARTUP" || upper == "/STARTUP" {
            cfg.run_at_startup = true;
        } else if upper == "--NO-PATH" || upper == "/NOPATH" {
            cfg.add_to_path = false;
        } else if upper == "--LAUNCH" || upper == "/LAUNCH" {
            cfg.launch_after = true;
        } else if upper == "--TEMP-UNINSTALLER" {
            cfg.is_temp_uninstaller = true;
        } else if let Some(val) = strip_prefix_ci(raw, "/DIR=")
            .or_else(|| strip_prefix_ci(raw, "/D="))
            .or_else(|| strip_prefix_ci(raw, "--dir="))
            .or_else(|| strip_prefix_ci(raw, "--install-dir="))
        {
            let clean = strip_quotes(val);
            if !clean.is_empty() {
                cfg.install_dir = Some(PathBuf::from(clean));
            }
        } else if (upper == "/DIR" || upper == "--DIR" || upper == "--INSTALL-DIR") && i + 1 < list.len() {
            i += 1;
            let clean = strip_quotes(&list[i]);
            if !clean.is_empty() {
                cfg.install_dir = Some(PathBuf::from(clean));
            }
        } else if let Some(val) = strip_prefix_ci(raw, "--lang=").or_else(|| strip_prefix_ci(raw, "/LANG=")) {
            let clean = strip_quotes(val);
            if !clean.is_empty() {
                cfg.lang = Some(clean.to_ascii_lowercase());
            }
        }
        i += 1;
    }

    cfg
}

fn strip_prefix_ci<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    if input.len() >= prefix.len() && input[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&input[prefix.len()..])
    } else {
        None
    }
}

/// Refuses catastrophic root / Windows system paths before destructive uninstall deletion.
pub fn is_safe_install_dir(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let norm = path.to_string_lossy().replace('/', "\\");
    let trimmed = norm.trim_end_matches('\\');
    if trimmed.len() <= 3 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let blocked = [
        "c:\\windows",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\users",
        "c:\\programdata",
    ];
    if blocked.iter().any(|b| lower == *b) {
        return false;
    }
    if lower.starts_with("c:\\windows\\") {
        return false;
    }
    // Must have at least 2 path components beyond drive prefix (e.g. C:\Foo\Bar or C:\PowerPilot)
    path.components().count() >= 3
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_silent_dir_and_uninstall_switches() {
        let c = parse_args(
            Some("Power Pilot Setup 1.0.0"),
            ["/VERYSILENT", "/DIR=\"C:\\Apps\\Power Pilot\"", "--startup", "--no-desktop"],
        );
        assert!(c.silent);
        assert!(!c.uninstall);
        assert_eq!(c.install_dir, Some(PathBuf::from("C:\\Apps\\Power Pilot")));
        assert!(c.run_at_startup);
        assert!(!c.desktop_shortcut);
        assert!(c.add_to_path);

        let p = parse_args(Some("Setup"), ["/P", "/DIR=D:\\Tools\\PP"]);
        assert!(p.silent);
        assert!(p.passive);
        assert_eq!(p.install_dir, Some(PathBuf::from("D:\\Tools\\PP")));

        let u = parse_args(Some("uninstall"), ["/S", "--delete-data"]);
        assert!(u.uninstall);
        assert!(u.silent);
        assert!(u.delete_data);
    }

    #[test]
    fn rejects_unsafe_system_directories() {
        assert!(!is_safe_install_dir(Path::new("C:\\")));
        assert!(!is_safe_install_dir(Path::new("C:\\Windows")));
        assert!(!is_safe_install_dir(Path::new("C:\\Program Files")));
        assert!(!is_safe_install_dir(Path::new("C:\\Users")));
        assert!(!is_safe_install_dir(Path::new("relative\\dir")));
        assert!(is_safe_install_dir(Path::new(
            "C:\\Users\\emir\\AppData\\Local\\Programs\\Power Pilot"
        )));
    }
}
