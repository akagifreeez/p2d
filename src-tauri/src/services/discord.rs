// F-050/F-051: Discord Rich Presence 連携
// Discord本体がローカルIPCパイプ (Windows: \\.\pipe\discord-ipc-0..9) で待ち受けている
// 場合のみ動作する。Discord未起動・クライアントID未設定・ID無効のいずれでも本体機能に
// 影響させないため、すべてのIOはこの専用スレッドで行い、失敗はログして捨てる。

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;

/// フロントエンドからのコマンド
pub enum PresenceCommand {
    Set {
        client_id: String,
        room_code: String,
        /// 「画面共有中」「ルーム待機中」など短い説明
        details: String,
        /// 自分を除く参加者数
        viewers: usize,
        /// セッション開始时刻 (unix秒)
        start_ts: i64,
    },
    Clear,
}

pub struct PresenceHandle {
    pub tx: Sender<PresenceCommand>,
    _worker: Option<JoinHandle<()>>,
}

pub struct DiscordPresenceState(pub std::sync::Mutex<Option<PresenceHandle>>);

/// プレゼンス更新ワーカーを起動する。Tauriコマンドはこのchannelに送るだけで即座に帰る。
pub fn start_worker() -> PresenceHandle {
    let (tx, rx) = mpsc::channel::<PresenceCommand>();
    let worker = std::thread::Builder::new()
        .name("discord-presence".into())
        .spawn(move || worker_loop(rx))
        .ok();
    PresenceHandle { tx, _worker: worker }
}

fn worker_loop(rx: mpsc::Receiver<PresenceCommand>) {
    let mut client: Option<DiscordIpcClient> = None;

    for cmd in rx {
        match cmd {
            PresenceCommand::Set { client_id, room_code, details, viewers, start_ts } => {
                if client.is_none() {
                    client = connect(&client_id);
                }
                let Some(c) = client.as_mut() else { continue };
                let party_size = (viewers + 1).clamp(1, 10) as i32;
                let payload = activity::Activity::new()
                    .details(&details)
                    .state(format!("部屋 {}", room_code))
                    .timestamps(activity::Timestamps::new().start(start_ts))
                    .party(activity::Party::new().size([party_size, 10]))
                    .buttons(vec![activity::Button::new(
                        "参加する",
                        format!("p2d://join/{}", room_code),
                    )]);
                if let Err(e) = c.set_activity(payload) {
                    println!("[Discord] set_activity失敗: {}", e);
                    // 接続が死んでいる可能性が高いので切って次回再接続
                    let _ = c.close();
                    client = None;
                }
            }
            PresenceCommand::Clear => {
                if let Some(c) = client.as_mut() {
                    if let Err(e) = c.clear_activity() {
                        println!("[Discord] clear_activity失敗: {}", e);
                    }
                }
            }
        }
    }

    // アプリ終了時: ステータスを掃除してから落ちる
    if let Some(mut c) = client.take() {
        let _ = c.clear_activity();
        let _ = c.close();
    }
}

fn connect(client_id: &str) -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(client_id);
    match client.connect() {
        Ok(()) => {
            println!("[Discord] IPC接続成功");
            Some(client)
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
}
