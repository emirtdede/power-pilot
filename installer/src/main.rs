#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use powerpilot_setup_lib::cli;
use powerpilot_setup_lib::engine::{self, InstallOptions, UninstallOptions};
use powerpilot_setup_lib::payload;
use powerpilot_setup_lib::win_sys;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::WindowBuilder;
use wry::http::{header::CONTENT_TYPE, Response, StatusCode};
use wry::WebViewBuilder;

const HTML_INDEX: &[u8] = include_bytes!("../ui/index.html");
const CSS_SETUP: &[u8] = include_bytes!("../ui/setup.css");
const JS_I18N: &[u8] = include_bytes!("../ui/i18n-73.js");
const JS_SETUP: &[u8] = include_bytes!("../ui/setup.js");

const WINDOW_W: f64 = 712.0;
const WINDOW_H: f64 = 496.0;

#[derive(Debug)]
enum UserEvent {
    IpcMessage(String),
    SendToUi(Value),
}

fn resolve_target_install_dir(cli_args: &cli::CliArgs, installed: &win_sys::InstalledInfo, current_exe: &std::path::Path) -> PathBuf {
    if let Some(ref d) = cli_args.install_dir {
        return d.clone();
    }
    if cli_args.uninstall {
        if let Some(ref d) = installed.install_dir {
            return d.clone();
        }
        if let Some(parent) = current_exe.parent() {
            if parent.join(win_sys::APP_EXE_NAME).exists() {
                return parent.to_path_buf();
            }
        }
    } else if let Some(ref d) = installed.install_dir {
        return d.clone();
    }
    win_sys::default_install_dir()
}

fn run_silent(
    cli_args: &cli::CliArgs,
    current_exe: &std::path::Path,
    install_dir: &std::path::Path,
    lang: &str,
) -> i32 {
    if cli_args.uninstall {
        let opts = UninstallOptions {
            install_dir: install_dir.to_string_lossy().to_string(),
            delete_user_data: cli_args.delete_data,
        };
        match engine::run_uninstall(&opts, |_, _| {}) {
            Ok(()) => {
                if cli_args.is_temp_uninstaller {
                    win_sys::schedule_self_delete_on_reboot(current_exe);
                }
                0
            }
            Err(_) => 1,
        }
    } else {
        let opts = InstallOptions {
            install_dir: install_dir.to_string_lossy().to_string(),
            lang: lang.to_string(),
            desktop_shortcut: cli_args.desktop_shortcut,
            start_menu_shortcut: cli_args.start_menu_shortcut,
            run_at_startup: cli_args.run_at_startup,
            add_to_path: cli_args.add_to_path,
        };
        match engine::run_install(current_exe, &opts, |_, _| {}) {
            Ok(()) => {
                if cli_args.launch_after {
                    win_sys::launch_app(install_dir);
                }
                0
            }
            Err(_) => 1,
        }
    }
}

fn center_window(window: &tao::window::Window) {
    if let Some(monitor) = window.current_monitor().or_else(|| window.primary_monitor()) {
        let mon_size = monitor.size();
        let mon_pos = monitor.position();
        let win_size = window.outer_size();
        let x = mon_pos.x + ((mon_size.width as i32 - win_size.width as i32) / 2);
        let y = mon_pos.y + ((mon_size.height as i32 - win_size.height as i32) / 2);
        window.set_outer_position(tao::dpi::PhysicalPosition::new(x, y));
    }
}

fn push_event(proxy: &EventLoopProxy<UserEvent>, value: Value) {
    let _ = proxy.send_event(UserEvent::SendToUi(value));
}

fn main() {
    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("setup.exe"));
    let exe_stem = current_exe.file_stem().and_then(|s| s.to_str());
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let cli_args = cli::parse_args(exe_stem, &raw_args);

    let installed = win_sys::read_installed_info();
    let install_dir = resolve_target_install_dir(&cli_args, &installed, &current_exe);

    // If uninstall.exe was launched directly from inside install_dir, stage into %TEMP% and relaunch
    // so the entire install folder can be removed cleanly without cmd.exe hacks.
    if cli_args.uninstall && !cli_args.is_temp_uninstaller {
        match win_sys::respawn_uninstaller_from_temp(&current_exe, &install_dir, &raw_args) {
            Ok(true) => std::process::exit(0),
            Ok(false) => {}
            Err(_) => {
                if cli_args.silent {
                    std::process::exit(1);
                }
            }
        }
    }

    let trailer = payload::read_trailer(&current_exe).ok().flatten();
    let app_version = trailer
        .as_ref()
        .map(|t| t.version.clone())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "1.0.0".to_string());
    let required_mb = trailer
        .as_ref()
        .map(|t| ((t.unpacked_bytes + 1_048_575) / 1_048_576).max(1))
        .unwrap_or(240);

    let detected_lang = cli_args
        .lang
        .clone()
        .or_else(|| if cli_args.uninstall { installed.language.clone() } else { None })
        .unwrap_or_else(|| win_sys::detect_windows_language().to_string());

    if cli_args.silent {
        let code = run_silent(&cli_args, &current_exe, &install_dir, &detected_lang);
        std::process::exit(code);
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let window = WindowBuilder::new()
        .with_title(if cli_args.uninstall { "Power Pilot Uninstall" } else { "Power Pilot Setup" })
        .with_inner_size(LogicalSize::new(WINDOW_W, WINDOW_H))
        .with_resizable(false)
        .with_decorations(false)
        .with_transparent(true)
        .with_visible(false)
        .build(&event_loop)
        .expect("Failed to create frameless setup window");

    center_window(&window);

    let ipc_proxy = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_devtools(false)
        .with_custom_protocol("pps".into(), move |_id, request| {
            let path = request.uri().path();
            let (mime, body): (&str, &[u8]) = match path {
                "/" | "/index.html" => ("text/html; charset=utf-8", HTML_INDEX),
                "/setup.css" => ("text/css; charset=utf-8", CSS_SETUP),
                "/i18n-73.js" => ("application/javascript; charset=utf-8", JS_I18N),
                "/setup.js" => ("application/javascript; charset=utf-8", JS_SETUP),
                _ => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(std::borrow::Cow::Borrowed(&b"Not Found"[..]))
                        .unwrap();
                }
            };
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, mime)
                .body(std::borrow::Cow::Borrowed(body))
                .unwrap()
        })
        .with_url("pps://localhost/index.html")
        .with_ipc_handler(move |req| {
            let _ = ipc_proxy.send_event(UserEvent::IpcMessage(req.body().to_string()));
        })
        .build(&window)
        .expect("Failed to create WebView2 instance");

    let exe_arc = Arc::new(current_exe.clone());
    let init_payload = json!({
        "type": "init",
        "appName": win_sys::APP_NAME,
        "version": app_version,
        "installedVersion": installed.version,
        "mode": if cli_args.uninstall { "uninstall" } else { "install" },
        "lang": detected_lang,
        "installDir": install_dir.to_string_lossy(),
        "userDataDir": win_sys::user_data_dir().to_string_lossy(),
        "requiredMb": required_mb,
        "desktopShortcut": cli_args.desktop_shortcut,
        "startMenuShortcut": cli_args.start_menu_shortcut,
        "runAtStartup": cli_args.run_at_startup,
        "addToPath": cli_args.add_to_path
    });

    let is_temp_uninst = cli_args.is_temp_uninstaller;
    let exe_for_exit = current_exe.clone();

    #[cfg(windows)]
    let hwnd_raw: isize = {
        use tao::platform::windows::WindowExtWindows;
        window.hwnd()
    };
    #[cfg(not(windows))]
    let hwnd_raw: isize = 0;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if is_temp_uninst {
                    win_sys::schedule_self_delete_on_reboot(&exe_for_exit);
                }
                *control_flow = ControlFlow::Exit;
            }
            Event::UserEvent(UserEvent::SendToUi(val)) => {
                if let Ok(serialized) = serde_json::to_string(&val) {
                    let script = format!("window.__PP_SETUP__ && window.__PP_SETUP__.receive({serialized});");
                    let _ = webview.evaluate_script(&script);
                }
            }
            Event::UserEvent(UserEvent::IpcMessage(body)) => {
                let Ok(msg) = serde_json::from_str::<Value>(&body) else {
                    return;
                };
                let action = msg.get("action").and_then(|v| v.as_str()).unwrap_or("");
                match action {
                    "ready" => {
                        push_event(&proxy, init_payload.clone());
                        window.set_visible(true);
                    }
                    "startDrag" => {
                        let _ = window.drag_window();
                    }
                    "minimize" => {
                        window.set_minimized(true);
                    }
                    "close" => {
                        if is_temp_uninst {
                            win_sys::schedule_self_delete_on_reboot(&exe_for_exit);
                        }
                        *control_flow = ControlFlow::Exit;
                    }
                    "launchAndClose" => {
                        let dir = msg
                            .get("installDir")
                            .and_then(|v| v.as_str())
                            .map(PathBuf::from)
                            .unwrap_or_else(|| install_dir.clone());
                        win_sys::launch_app(&dir);
                        *control_flow = ControlFlow::Exit;
                    }
                    "browseFolder" => {
                        let current = msg.get("currentDir").and_then(|v| v.as_str()).map(|s| s.to_string());
                        if let Some(selected) = win_sys::browse_folder_dialog(hwnd_raw, current.as_deref()) {
                            let final_path = PathBuf::from(&selected);
                            let out = if final_path
                                .file_name()
                                .and_then(|s| s.to_str())
                                .map(|n| n.eq_ignore_ascii_case(win_sys::APP_NAME))
                                .unwrap_or(false)
                            {
                                final_path
                            } else {
                                final_path.join(win_sys::APP_NAME)
                            };
                            push_event(
                                &proxy,
                                json!({ "type": "folderSelected", "path": out.to_string_lossy() }),
                            );
                        }
                    }
                    "install" => {
                        if let Ok(opts) = serde_json::from_value::<InstallOptions>(msg.clone()) {
                            let exe_c = Arc::clone(&exe_arc);
                            let p = proxy.clone();
                            std::thread::spawn(move || {
                                let mut last_sent = 0u8;
                                let res = engine::run_install(&exe_c, &opts, |pct, step| {
                                    if pct != last_sent || pct == 100 || pct <= 15 {
                                        last_sent = pct;
                                        push_event(&p, json!({ "type": "progress", "percent": pct, "stepKey": step }));
                                    }
                                });
                                match res {
                                    Ok(()) => push_event(&p, json!({ "type": "done" })),
                                    Err(err) => push_event(&p, json!({ "type": "error", "message": err })),
                                }
                            });
                        }
                    }
                    "uninstall" => {
                        if let Ok(opts) = serde_json::from_value::<UninstallOptions>(msg.clone()) {
                            let p = proxy.clone();
                            std::thread::spawn(move || {
                                let res = engine::run_uninstall(&opts, |pct, step| {
                                    push_event(&p, json!({ "type": "progress", "percent": pct, "stepKey": step }));
                                });
                                match res {
                                    Ok(()) => push_event(&p, json!({ "type": "done" })),
                                    Err(err) => push_event(&p, json!({ "type": "error", "message": err })),
                                }
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    });
}
