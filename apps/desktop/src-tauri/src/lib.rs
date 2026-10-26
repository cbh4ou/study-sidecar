use serde::Deserialize;
use std::{collections::HashMap, env, sync::LazyLock, time::Duration};
use tauri::{AppHandle, Emitter, LogicalSize, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
static HTTP: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("valid client")
});
#[derive(Deserialize)]
struct Steering {
    prompt: String,
}
#[tauri::command]
fn sidecar_token() -> String {
    env::var("SIDECAR_TOKEN").unwrap_or_default()
}
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}
#[tauri::command]
fn set_hud_variant(app: AppHandle, variant: String) -> Result<(), String> {
    let window = app.get_webview_window("pill").ok_or("pill unavailable")?;
    let height = match variant.as_str() {
        "compact" => 72.0,
        "card" | "ambient" => 220.0,
        _ => 700.0,
    };
    window
        .set_size(LogicalSize::new(420.0, height))
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn set_dnd(app: AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window("pill").ok_or("pill unavailable")?;
    if on { window.hide() } else { window.show() }.map_err(|e| e.to_string())
}
#[tauri::command]
fn open_main(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main unavailable")?;
    window.show().map_err(|e| e.to_string())?;
    window.maximize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    if let Some(path) = path {
        if path.starts_with('/') && !path.starts_with("//") {
            let _ = window.emit("app://navigate", path);
        }
    }
    Ok(())
}
fn default_keys() -> HashMap<String, String> {
    [
        ("ptt", "Alt+Space"),
        ("expand", "Alt+S"),
        ("open", "Alt+O"),
        ("copy", "Alt+C"),
        ("dnd", "Alt+D"),
        ("pin", "Alt+P"),
    ]
    .into_iter()
    .map(|(a, k)| (a.into(), k.into()))
    .collect()
}
#[tauri::command]
fn configure_shortcuts(app: AppHandle, hotkeys: HashMap<String, String>) -> Result<(), String> {
    let mut keys = default_keys();
    keys.extend(hotkeys);
    let mut parsed = Vec::new();
    for (action, key) in keys {
        if !["ptt", "expand", "open", "copy", "dnd", "pin"].contains(&action.as_str()) {
            return Err("Unknown shortcut action".into());
        }
        let shortcut: Shortcut = key
            .parse()
            .map_err(|e| format!("Invalid shortcut {key}: {e}"))?;
        if parsed
            .iter()
            .any(|(_, s): &(String, Shortcut)| *s == shortcut)
        {
            return Err("Shortcuts must be unique".into());
        }
        parsed.push((action, shortcut));
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    for (action, shortcut) in parsed {
        app.global_shortcut()
            .on_shortcut(shortcut, move |app, _, event| {
                let pressed = event.state() == ShortcutState::Pressed;
                if action == "ptt" {
                    let _ = app.emit_to(
                        "pill",
                        if pressed {
                            "voice://ptt-start"
                        } else {
                            "voice://ptt-stop"
                        },
                        (),
                    );
                    return;
                }
                if !pressed {
                    return;
                }
                match action.as_str() {
                    "open" => {
                        let _ = open_main(app.clone(), None);
                    }
                    "expand" => {
                        let _ = app.emit_to("pill", "hud://expand", ());
                    }
                    "dnd" => {
                        let _ = app.emit_to("pill", "hud://dnd", ());
                    }
                    "pin" => {
                        let _ = app.emit_to("pill", "hud://pin", ());
                    }
                    "copy" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let port = env::var("SIDECAR_PORT").unwrap_or_else(|_| "4321".into());
                            let request = HTTP
                                .get(format!("http://127.0.0.1:{port}/latest-steering"))
                                .bearer_auth(sidecar_token());
                            if let Ok(response) = request.send().and_then(|r| r.json::<Steering>())
                            {
                                if !response.prompt.is_empty() {
                                    let _ = app.clipboard().write_text(response.prompt);
                                }
                            }
                        });
                    }
                    _ => {}
                }
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            sidecar_token,
            copy_text,
            set_hud_variant,
            set_dnd,
            open_main,
            configure_shortcuts
        ])
        .setup(|app| {
            let root = env::var_os("SIDECAR_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::path::PathBuf::from(env::var_os("HOME").unwrap_or_default())
                        .join(".study-sidecar")
                });
            let keys = std::fs::read(root.join("settings.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .and_then(|v| {
                    serde_json::from_value::<HashMap<String, String>>(v.get("hotkeys")?.clone())
                        .ok()
                })
                .unwrap_or_default();
            if let Err(error) = configure_shortcuts(app.handle().clone(), keys) {
                eprintln!("study-sidecar shortcut registration failed: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Study Sidecar desktop");
}
