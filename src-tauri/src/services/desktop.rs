use tauri::{State, Window, Emitter};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use arboard::Clipboard;
use enigo::{
    Enigo, Settings, 
    Mouse, Keyboard, 
    Button, 
    Direction, 
    Axis,
    Coordinate
};

// 無限ループ防止のためのクリップボード状態
pub struct ClipboardState(pub Arc<Mutex<String>>);

#[derive(serde::Serialize)]
pub struct MonitorInfo {
    name: String,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
}

/// 利用可能なモニター一覧を取得

pub fn get_monitors(window: Window) -> Result<Vec<MonitorInfo>, String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let info = monitors.into_iter().map(|m| {
        let size = m.size();
        let pos = m.position();
        MonitorInfo {
            name: m.name().map(|n| n.to_string()).unwrap_or_else(|| "Unknown".to_string()),
            width: size.width,
            height: size.height,
            x: pos.x,
            y: pos.y,
        }
    }).collect();
    Ok(info)
}

/// マウス移動をシミュレート (0.0 - 1.0 の正規化座標)

pub async fn simulate_mouse_move(window: Window, x: f64, y: f64, monitor_name: Option<String>) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    
    let target_monitor = if let Some(name) = monitor_name {
        monitors.into_iter().find(|m| m.name().as_deref() == Some(&name))
    } else {
        window.current_monitor().map_err(|e| e.to_string())?
    };

    if let Some(monitor) = target_monitor {
        let size = monitor.size();
        let position = monitor.position(); // モニターの左上座標を取得
        
        let width = size.width as f64;
        let height = size.height as f64;
        
        // モニターのオフセットを加算して正しい絶対座標を計算
        let target_x = position.x + (x * width) as i32;
        let target_y = position.y + (y * height) as i32;
        
        let mut enigo = Enigo::new(&Settings::default()).unwrap();
        // move_mouse は Coordinate::Abs で絶対座標移動
        let _ = enigo.move_mouse(target_x, target_y, Coordinate::Abs);
    }
    Ok(())
}

/// マウスクリックをシミュレート

pub fn simulate_click(button: String) {
    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    let btn = match button.as_str() {
        "left" => Button::Left,
        "right" => Button::Right,
        "middle" => Button::Middle,
        _ => return,
    };
    let _ = enigo.button(btn, Direction::Click);
}

/// スクロールをシミュレート

pub fn simulate_scroll(delta_x: i32, delta_y: i32) {
    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    if delta_y != 0 {
        let _ = enigo.scroll(delta_y, Axis::Vertical);
    }
    if delta_x != 0 {
        let _ = enigo.scroll(delta_x, Axis::Horizontal);
    }
}

/// キー入力をシミュレート

pub fn simulate_key(key: String) {
    let mut enigo = Enigo::new(&Settings::default()).unwrap();
    // 簡易的な実装: 文字列をそのままタイプ
    let _ = enigo.text(&key);
}

/// クリップボード書き込みコマンド

pub fn write_clipboard(text: String, state: State<'_, ClipboardState>) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text.clone()).map_err(|e| e.to_string())?;
    
    // 書き込み後にステートを更新して、監視スレッドによる再検知（ループバック）を防止
    if let Ok(mut last) = state.0.lock() {
        *last = text;
    }
    Ok(())
}

pub fn init_clipboard(app: &tauri::AppHandle, state: Arc<Mutex<String>>) {
    let app_handle = app.clone();
    thread::spawn(move || {
        let mut clipboard = match Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Clipboard init failed: {}", e);
                return;
            }
        };

        println!("Clipboard monitoring started."); // 開始ログ

        loop {
            match clipboard.get_text() {
                Ok(text) => {
                    let mut should_emit = false;
                    // 現在のクリップボード内容が、最後にアプリが認識したものと異なるかチェック
                    if let Ok(mut last) = state.lock() {
                        if *last != text {
                            // 短すぎる、または長すぎるテキストはログに出さない等の配慮も可能だが、デバッグ中は出す
                            // println!("Clipboard changed detected in Rust: {} chars", text.len());
                            *last = text.clone();
                            should_emit = true;
                        }
                    } else {
                        eprintln!("Failed to lock clipboard state");
                    }
                    
                    if should_emit {
                        if let Err(e) = app_handle.emit("clipboard-changed", &text) {
                            eprintln!("Failed to emit event: {}", e);
                        } else {
                            // println!("Emitted clipboard-changed event");
                        }
                    }
                },
                Err(_e) => {
                    // 頻繁に出るかもしれないので、一時的なエラーでないか注意
                    // Arboardのエラー詳細が不明だが、ログには出してみる
                    // eprintln!("Clipboard get error: {}", e);
                }
            }
            thread::sleep(Duration::from_millis(1000));
        }
    });
}
