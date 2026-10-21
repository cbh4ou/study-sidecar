use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;
use std::{env, fs, path::PathBuf};
use tauri::{AppHandle, Emitter, LogicalSize, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

static HTTP: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("valid reqwest client")
});

#[derive(Deserialize)]
struct SteeringResponse {
    prompt: String,
}

#[derive(Deserialize, Serialize)]
struct DesktopConfig {
    dock_mode: bool,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self { dock_mode: true }
    }
}

fn config_path() -> Result<PathBuf, String> {
    let home = env::var_os("HOME").ok_or("HOME is unavailable")?;
    Ok(PathBuf::from(home).join(".study-sidecar").join("desktop.json"))
}

fn load_config() -> DesktopConfig {
    let Ok(path) = config_path() else { return DesktopConfig::default() };
    fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_config(config: &DesktopConfig) -> Result<(), String> {
    let path = config_path()?;
    let directory = path.parent().ok_or("desktop config path has no parent")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    fs::write(path, serde_json::to_vec(config).map_err(|error| error.to_string())?).map_err(|error| error.to_string())
}

fn apply_dock_mode(app: &AppHandle, dock_mode: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
    window.set_always_on_top(dock_mode).map_err(|error| error.to_string())?;
    let (width, height) = if dock_mode { (420.0, 700.0) } else { (720.0, 860.0) };
    window.set_size(LogicalSize::new(width, height)).map_err(|error| error.to_string())
}

#[tauri::command]
fn dock_mode(app: AppHandle) -> Result<bool, String> {
    let mut config = load_config();
    config.dock_mode = !config.dock_mode;
    apply_dock_mode(&app, config.dock_mode)?;
    save_config(&config)?;
    Ok(config.dock_mode)
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn sidecar_token() -> String {
    env::var("SIDECAR_TOKEN").unwrap_or_default()
}


#[tauri::command]
fn set_hud_variant(app: AppHandle, variant: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window is unavailable")?;
    let (width, height) = match variant.as_str() {
        "compact" => (420.0, 72.0),
        "ambient" => (420.0, 64.0),
        _ => (420.0, 700.0),
    };
    window.set_size(LogicalSize::new(width, height)).map_err(|error| error.to_string())?;
    let pill = variant != "expanded";
    window.set_decorations(!pill).map_err(|error| error.to_string())?;
    window.set_resizable(!pill).map_err(|error| error.to_string())?;
    Ok(())
}


pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![dock_mode, copy_text, set_hud_variant, sidecar_token])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let _ = apply_dock_mode(&app_handle, load_config().dock_mode);
            let copy = Shortcut::new(Some(Modifiers::ALT), Code::KeyC);
            if let Err(error) = app.global_shortcut().on_shortcut(copy, |app, _, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let app = app.clone();
                std::thread::spawn(move || {
                    let mut request = HTTP.get("http://127.0.0.1:4321/latest-steering");
                    if let Ok(token) = std::env::var("SIDECAR_TOKEN") {
                        if !token.is_empty() {
                            request = request.header("Authorization", format!("Bearer {token}"));
                        }
                    }
                    let response = request
                        .send()
                        .and_then(|response| response.json::<SteeringResponse>());
                    if let Ok(response) = response {
                        if !response.prompt.is_empty() {
                            let _ = app.clipboard().write_text(response.prompt);
                        }
                    }
                });
            }) {
                eprintln!("study-sidecar: Alt+C shortcut unavailable: {error}");
            }
            let mute = Shortcut::new(Some(Modifiers::ALT), Code::KeyM);
            let expand = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);
            if let Err(error) = app.global_shortcut().on_shortcut(expand, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("hud://expand", ());
                }
            }) {
                eprintln!("study-sidecar: Alt+S shortcut unavailable: {error}");
            }
            if let Err(error) = app.global_shortcut().on_shortcut(mute, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("voice://mute-toggle", ());
                }
            }) {
                eprintln!("study-sidecar: Alt+M shortcut unavailable: {error}");
            }
            let push_to_talk = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            if let Err(error) = app.global_shortcut().on_shortcut(push_to_talk, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    let _ = app.emit("voice://ptt-toggle", ());
                }
            }) {
                eprintln!("study-sidecar: Alt+Space shortcut unavailable: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Study Partner desktop");
}
