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

    // E2E自己テストモードは同一exeの2インスタンス同時起動を前提とするため、
    // single-instance (2インスタンス目を排除する) をこのときだけ無効化する
    let e2e_mode = bridge::system::e2e_enabled();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init());

    let builder = if e2e_mode {
        builder
    } else {
        // single-instance は最初に登録する必要がある (2インスタンス目の起動をここで受け、
        // p2d://join/CODE[@host:port] を実行中インスタンスへ転送する — F-051 / M4)
        builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(invite) = bridge::discord::find_join_url(args) {
                {
                    let state = app.state::<bridge::discord::JoinCodeState>();
                    if let Ok(mut g) = state.0.lock() {
                        *g = Some(invite.clone());
                    };
                }
                use tauri::Emitter;
                // ペイロードはJSON文字列 {code, endpoint} (旧クライアント形式=素のコードにも対応)
                let payload = serde_json::json!({
                    "code": invite.code,
                    "endpoint": invite.endpoint,
                });
                let _ = app.emit("p2d-join-url", payload.to_string());
            }
        }))
    };

    builder
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
            // Bridge: Discord Rich Presence (F-050/F-051)
            bridge::discord::get_discord_config,
            bridge::discord::get_launch_join,
            bridge::discord::get_launch_invite,
            bridge::discord::discord_set_presence,
            bridge::discord::discord_clear_presence,
            // レンデブー最小化 (M2/M3/M4): ホスト内蔵サーバー + LAN住所
            services::embedded_server::embedded_server_start,
            services::embedded_server::embedded_server_stop,
            services::embedded_server::embedded_server_status,
            services::embedded_server::get_local_lan_address,
        ])
        .setup(|app| {
            // クリップボード状態の初期化
            let clipboard_state = Arc::new(Mutex::new(String::new()));
            app.manage(services::desktop::ClipboardState(clipboard_state.clone()));

            // クリップボード監視開始
            services::desktop::init_clipboard(app.handle(), clipboard_state);

            // システム音声キャプチャ状態の初期化 (F-031)
            app.manage(services::audio_capture::AudioCaptureState(Mutex::new(None)));

            // Discord Presenceワーカー起動 (F-050/F-052)
            app.manage(services::discord::DiscordPresenceState(
                Mutex::new(Some(services::discord::start_worker(app.handle().clone()))),
            ));

            // ホスト内蔵シグナリング/リレーWSサーバー (レンデブー最小化 M2/M3)
            app.manage(services::embedded_server::EmbeddedServerState(
                Mutex::new(None),
            ));

            // ディープリンク (p2d://join/CODE[@host:port]) の処理 (F-051 / M4)
            // プロトコルハンドラ登録 (Windows: HKCU\Software\Classes\p2d)。失敗しても致命傷にしない。
            app.manage(bridge::discord::JoinCodeState(Mutex::new(
                bridge::discord::find_join_url(env::args()),
            )));
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register("p2d") {
                    println!("[DeepLink] プロトコル登録スキップ: {}", e);
                }
            }

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
