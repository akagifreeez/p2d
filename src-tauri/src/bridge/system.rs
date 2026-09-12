use tauri::{Window, State, PhysicalPosition, PhysicalSize, ipc::Channel};
use crate::services::desktop::{self, MonitorInfo, ClipboardState};
use crate::services::audio_capture::{self, AudioCaptureState, SystemAudioConfig};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub monitor_name: Option<String>,
}

#[tauri::command]
pub fn get_monitors(window: Window) -> Result<Vec<MonitorInfo>, String> {
    desktop::get_monitors(window)
}

/// ウィンドウ位置を取得
#[tauri::command]
pub fn get_window_position(window: Window) -> Result<WindowPosition, String> {
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    
    Ok(WindowPosition {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        monitor_name: monitor.and_then(|m| m.name().map(|s| s.to_string())),
    })
}

/// ウィンドウ位置を復元
#[tauri::command]
pub fn set_window_position(window: Window, pos: WindowPosition) -> Result<(), String> {
    window.set_position(PhysicalPosition::new(pos.x, pos.y))
        .map_err(|e| e.to_string())?;
    window.set_size(PhysicalSize::new(pos.width, pos.height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 次のモニターへウィンドウを移動
#[tauri::command]
pub fn move_to_next_monitor(window: Window) -> Result<(), String> {
    let monitors: Vec<_> = window.available_monitors().map_err(|e| e.to_string())?;
    if monitors.len() <= 1 { return Ok(()); }

    let current = window.current_monitor().map_err(|e| e.to_string())?;
    let current_name = current.and_then(|m| m.name().map(|s| s.to_string()));

    let current_index = monitors.iter().position(|m| m.name().map(|s| s.to_string()) == current_name).unwrap_or(0);
    let next_index = (current_index + 1) % monitors.len();

    if let Some(monitor) = monitors.get(next_index) {
        window.set_position(*(monitor.position())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 前のモニターへウィンドウを移動
#[tauri::command]
pub fn move_to_prev_monitor(window: Window) -> Result<(), String> {
    let monitors: Vec<_> = window.available_monitors().map_err(|e| e.to_string())?;
    if monitors.len() <= 1 { return Ok(()); }

    let current = window.current_monitor().map_err(|e| e.to_string())?;
    let current_name = current.and_then(|m| m.name().map(|s| s.to_string()));

    let current_index = monitors.iter().position(|m| m.name().map(|s| s.to_string()) == current_name).unwrap_or(0);
    let prev_index = if current_index == 0 { monitors.len() - 1 } else { current_index - 1 };

    if let Some(monitor) = monitors.get(prev_index) {
        window.set_position(*(monitor.position())).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn simulate_mouse_move(window: Window, x: f64, y: f64, monitor_name: Option<String>) -> Result<(), String> {
    desktop::simulate_mouse_move(window, x, y, monitor_name).await
}

#[tauri::command]
pub fn simulate_click(button: String) {
    desktop::simulate_click(button)
}

#[tauri::command]
pub fn simulate_scroll(delta_x: i32, delta_y: i32) {
    desktop::simulate_scroll(delta_x, delta_y)
}

#[tauri::command]
pub fn simulate_key(key: String) {
    desktop::simulate_key(key)
}

#[tauri::command]
pub fn write_clipboard(text: String, state: State<'_, ClipboardState>) -> Result<(), String> {
    desktop::write_clipboard(text, state)
}

/// キーイベント適用 (down/up分離・特殊キー対応)
#[tauri::command]
pub fn simulate_key_event(key: String, direction: String) -> Result<(), String> {
    desktop::simulate_key_event(key, direction)
}

/// マウスボタン Press/Release (ドラッグ対応)
#[tauri::command]
pub fn simulate_mouse_button(button: String, direction: String) -> Result<(), String> {
    desktop::simulate_mouse_button(button, direction)
}

/// システム音声のループバック設定を取得 (F-031)
#[tauri::command]
pub fn get_system_audio_config() -> Result<SystemAudioConfig, String> {
    audio_capture::get_config()
}

/// システム音声キャプチャを開始し、PCM チャンクを Channel へ流す (F-031)
#[tauri::command]
pub fn start_system_audio_capture(
    on_data: Channel<String>,
    state: State<'_, AudioCaptureState>,
) -> Result<SystemAudioConfig, String> {
    audio_capture::start(on_data, state)
}

/// システム音声キャプチャを停止 (F-031)
#[tauri::command]
pub fn stop_system_audio_capture(state: State<'_, AudioCaptureState>) -> Result<(), String> {
    audio_capture::stop(state)
}

// --- E2E自己テストモード (P2D_E2E_ROLE 環境変数 または --p2d-e2e-role= 引数がある場合のみ動作) ---

fn e2e_opt(flag: &str, env_key: &str) -> Option<String> {
    for a in std::env::args() {
        if let Some(v) = a.strip_prefix(flag) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    std::env::var(env_key).ok()
}

pub(crate) fn e2e_enabled() -> bool {
    e2e_opt("--p2d-e2e-role=", "P2D_E2E_ROLE").is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eConfig {
    pub enabled: bool,
    pub role: Option<String>,
    pub sync_path: Option<String>,
    pub log_path: Option<String>,
    /// 既知のルームコードを直指定 (syncファイル不要のguest参加用)
    pub room: Option<String>,
    /// シグナリングURL上書き (リモートマシンのサーバーへ接続する場合)
    pub signaling_url: Option<String>,
    /// フロー後のクリーンアップ (共有停止) をスキップし接続を維持する (再接続検証用)
    pub stay: Option<String>,
}

/// E2E設定を起動引数 / 環境変数から取得
/// 引数: --p2d-e2e-role=host|guest --p2d-e2e-sync=<path> --p2d-e2e-log=<path>
///       --p2d-e2e-room=<code> --p2d-signaling-url=ws://...
/// 環境変数: P2D_E2E_ROLE / P2D_E2E_SYNC / P2D_E2E_LOG / P2D_E2E_ROOM / P2D_SIGNALING_URL
#[tauri::command]
pub fn get_e2e_config() -> E2eConfig {
    let role = e2e_opt("--p2d-e2e-role=", "P2D_E2E_ROLE");
    E2eConfig {
        enabled: role.is_some(),
        role,
        sync_path: e2e_opt("--p2d-e2e-sync=", "P2D_E2E_SYNC"),
        log_path: e2e_opt("--p2d-e2e-log=", "P2D_E2E_LOG"),
        room: e2e_opt("--p2d-e2e-room=", "P2D_E2E_ROOM"),
        signaling_url: e2e_opt("--p2d-signaling-url=", "P2D_SIGNALING_URL"),
        stay: e2e_opt("--p2d-e2e-stay=", "P2D_E2E_STAY"),
    }
}

/// E2Eモード専用のファイル書き込み (同期用・レポート用)
#[tauri::command]
pub fn e2e_file_write(path: String, content: String) -> Result<(), String> {
    println!("[E2E-file] enter: path={:?} len={}", path, content.len());
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        let _ = std::fs::create_dir_all(parent); // 親ディレクトリが無ければ作る
    }
    let result = std::fs::write(p, content).map_err(|e| e.to_string());
    println!("[E2E-file] result: {:?}", &result);
    result
}

/// E2Eモード専用のファイル読み込み (ルームコード受け渡し等)
#[tauri::command]
pub fn e2e_file_read(path: String) -> Result<String, String> {
    if !e2e_enabled() {
        return Err("E2Eモードでのみ使用できます".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// E2Eモード用: フロントのログをアプリのstdoutへ中継 (デバッグ可視化用)
#[tauri::command]
pub fn e2e_stdout(line: String) {
    if e2e_enabled() {
        println!("[E2E-web] {}", line);
    }
}

