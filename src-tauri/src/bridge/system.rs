use tauri::{Window, State, PhysicalPosition, PhysicalSize};
use crate::services::desktop::{self, MonitorInfo, ClipboardState};
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

