// F-050/F-051/F-052: Discord Rich Presence + 参加シークレット受信
//
// discord-sdk による実装。IPCはDiscord本体 (Windows: \\.\pipe\discord-ipc-0..9 /
// Linux/macOS: $XDG_RUNTIME_DIR/discord-ipc-0..9) で行う。
// Discord未起動・クライアントID未設定・ID無効のいずれでも本体機能に影響させないため、
// すべてのIOはこの専用スレッド内のtokioランタイムで行い、失敗はログして捨てる。
//
// F-052: プレゼンスに join secret (= ルームコード) を載せ、相手がDiscord上で
// 「参加」した際の ACTIVITY_JOIN イベントを受け取って p2d-join-url として
// フロントエンドへ転送する (ディープリンクと同じ経路で参加する)。

use crate::bridge::discord::{JoinCodeState, JoinInvite};
use discord_sdk::activity::{ActivityBuilder, PartyPrivacy, Secrets};
use discord_sdk::{Discord, DiscordApp, DiscordHandler, DiscordMsg, Event, Subscriptions};
use std::num::NonZeroU32;
use std::thread::JoinHandle;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// フロントエンドからのコマンド
pub enum PresenceCommand {
    Set {
        client_id: String,
        room_code: String,
        /// 「画面共有中」「ルーム待機中」など短い説明
        details: String,
        /// 自分を除く参加者数
        viewers: usize,
        /// セッション開始時刻 (unix秒)
        start_ts: i64,
    },
    Clear,
}

pub struct PresenceHandle {
    pub tx: UnboundedSender<PresenceCommand>,
    _worker: Option<JoinHandle<()>>,
}

pub struct DiscordPresenceState(pub std::sync::Mutex<Option<PresenceHandle>>);

/// プレゼンス更新ワーカーを起動する。Tauriコマンドはこのchannelに送るだけで即座に帰る。
pub fn start_worker(app: tauri::AppHandle) -> PresenceHandle {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<PresenceCommand>();
    let worker = std::thread::Builder::new()
        .name("discord-presence".into())
        .spawn(move || worker_loop(app, rx))
        .ok();
    PresenceHandle { tx, _worker: worker }
}

/// ACTIVITY_JOIN をフロントエンドの参加フローへ橋渡しするハンドラ
struct JoinHandler {
    app: tauri::AppHandle,
}

#[async_trait::async_trait]
impl DiscordHandler for JoinHandler {
    async fn on_message(&self, msg: DiscordMsg) {
        let DiscordMsg::Event(Event::ActivityJoin(ev)) = msg else { return };
        let secret = ev.secret;
        if secret.len() < 4 {
            return;
        }
        println!("[Discord] ACTIVITY_JOIN受信: {} → フロントエンドへ転送", secret);
        use tauri::Manager;
        if let Some(state) = self.app.try_state::<JoinCodeState>() {
            if let Ok(mut g) = state.0.lock() {
                *g = Some(JoinInvite { code: secret.clone(), endpoint: None });
            }
        }
        use tauri::Emitter;
        let _ = self.app.emit("p2d-join-url", secret);
    }
}

fn worker_loop(app: tauri::AppHandle, mut rx: UnboundedReceiver<PresenceCommand>) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            println!("[Discord] tokioランタイム起動失敗: {}", e);
            return;
        }
    };

    rt.block_on(async move {
        let mut client: Option<Discord> = None;
        let mut current_id: Option<String> = None;

        while let Some(cmd) = rx.recv().await {
            match cmd {
                PresenceCommand::Set { client_id, room_code, details, viewers, start_ts } => {
                    // クライアントIDが変わったら接続を作り直す
                    if current_id.as_deref() != Some(client_id.as_str()) {
                        if let Some(old) = client.take() {
                            old.disconnect().await;
                        }
                        current_id = None;
                        client = connect(&client_id, app.clone()).await;
                        if client.is_some() {
                            current_id = Some(client_id);
                        }
                    }
                    let Some(d) = client.as_ref() else { continue };

                    let party_size = (viewers + 1).clamp(1, 10) as u32;
                    let activity = ActivityBuilder::new()
                        .details(&details)
                        .state(format!("部屋 {}", room_code))
                        .start_timestamp(start_ts)
                        .party(
                            room_code.clone(),
                            NonZeroU32::new(party_size),
                            NonZeroU32::new(10),
                            PartyPrivacy::Private,
                        )
                        .button(discord_sdk::activity::Button {
                            label: "参加する".into(),
                            url: format!("p2d://join/{}", room_code),
                        })
                        .secrets(Secrets {
                            join: Some(room_code.clone()),
                            ..Default::default()
                        });
                    if let Err(e) = d.update_activity(activity).await {
                        println!("[Discord] set_activity失敗: {}", e);
                        // 接続が死んでいる可能性が高いので切って次回再接続
                        if let Some(old) = client.take() {
                            old.disconnect().await;
                        }
                        current_id = None;
                    }
                }
                PresenceCommand::Clear => {
                    if let Some(d) = client.as_ref() {
                        if let Err(e) = d.clear_activity().await {
                            println!("[Discord] clear_activity失敗: {}", e);
                        }
                    }
                }
            }
        }

        // アプリ終了時: ステータスを掃除してから落ちる
        if let Some(old) = client.take() {
            let _ = old.clear_activity().await;
            old.disconnect().await;
        }
    });
}

async fn connect(client_id: &str, app: tauri::AppHandle) -> Option<Discord> {
    let app_id: i64 = match client_id.trim().parse() {
        Ok(v) => v,
        Err(_) => {
            println!("[Discord] クライアントIDが不正 (数値であること): {}", client_id);
            return None;
        }
    };
    match Discord::new(DiscordApp::from(app_id), Subscriptions::ACTIVITY, Box::new(JoinHandler { app })) {
        Ok(d) => {
            println!("[Discord] IPC接続成功");
            Some(d)
        }
        Err(e) => {
            println!("[Discord] IPC接続失敗 (Discord未起動 or クライアントID無効): {}", e);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn party_size_is_clamped() {
        // ロジックの要所だけ直接確認 (worker_loop内と同じ式)
        assert_eq!((0 + 1).clamp(1, 10), 1);
        assert_eq!((3 + 1).clamp(1, 10), 4);
        assert_eq!((25 + 1).clamp(1, 10), 10);
    }

    #[test]
    fn join_secret_requires_min_length() {
        // ハンドラと同じ判定式 (4文字未満はルームコードとして扱わない)
        let accept = |s: &str| s.len() >= 4;
        assert!(accept("ABC123"));
        assert!(!accept("ab"));
    }
}
