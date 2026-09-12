// P2D - ライブラリモジュール
// Tauriコマンドと共通機能を定義

mod bridge;   // Tauriコマンド (Controller)
mod services; // 純粋なビジネスロジック (desktop)

use std::sync::{Arc, Mutex};
use std::env;
use tauri::Manager;

/// アプリケーション情報を取得するコマンド
#[tauri::command]
fn get_app_info() -> serde_json::Value {
    serde_json::json!({
        "name": "P2D",
        "version": "0.1.0",
        "description": "P2P Desktop Sharing Application"
    })
}

/// Tauriアプリケーションを実行
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Windows向け: GPU使用を強制するWebView2追加引数
    // 外部から環境変数が指定されている場合 (例: CDPテスト用の--remote-debugging-port) は尊重して追記する
    #[cfg(target_os = "windows")]
    {
        const GPU_FLAGS: &str =
            "--ignore-gpu-blocklist --enable-gpu-rasterization --enable-accelerated-video-decode";
        match env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            Ok(existing) => {
                if !existing.contains("ignore-gpu-blocklist") {
                    env::set_var(
                        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                        format!("{existing} {GPU_FLAGS}"),
                    );
                }
            }
            Err(_) => {
                env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", GPU_FLAGS);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            // Bridge: System/Desktop (入力注入・ウィンドウ管理)
            bridge::system::get_monitors,
            bridge::system::get_window_position,
            bridge::system::set_window_position,
            bridge::system::move_to_next_monitor,
            bridge::system::move_to_prev_monitor,
            bridge::system::simulate_mouse_move,
            bridge::system::simulate_click,
            bridge::system::simulate_scroll,
            bridge::system::simulate_key,
            bridge::system::simulate_key_event,
            bridge::system::simulate_mouse_button,
            bridge::system::write_clipboard,
            bridge::system::get_system_audio_config,
            bridge::system::start_system_audio_capture,
            bridge::system::stop_system_audio_capture,
            bridge::system::get_e2e_config,
            bridge::system::e2e_file_write,
            bridge::system::e2e_file_read,
            bridge::system::e2e_stdout,
            // Bridge: Capture (ネイティブキャプチャ)
            bridge::capture::get_capture_sources,
            bridge::capture::get_source_frame,
        ])
        .setup(|app| {
            // クリップボード状態の初期化
            let clipboard_state = Arc::new(Mutex::new(String::new()));
            app.manage(services::desktop::ClipboardState(clipboard_state.clone()));

            // クリップボード監視開始
            services::desktop::init_clipboard(app.handle(), clipboard_state);

            // システム音声キャプチャ状態の初期化 (F-031)
            app.manage(services::audio_capture::AudioCaptureState(Mutex::new(None)));

            // 開発時にDevToolsを開く
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Tauriアプリケーションの起動に失敗しました");
}
