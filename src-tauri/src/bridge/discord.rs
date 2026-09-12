use crate::services::discord::{DiscordPresenceState, PresenceCommand};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

// --- Discord Rich Presence (F-050/F-051) + p2d:// ディープリンク ---

fn arg_opt(flag: &str, env_key: &str) -> Option<String> {
    for a in std::env::args() {
        if let Some(v) = a.strip_prefix(flag) {
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    std::env::var(env_key).ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordConfig {
    /// 起動引数 --p2d-discord-client-id= または環境変数 P2D_DISCORD_CLIENT_ID
    pub client_id: Option<String>,
}

/// Discord連携の起動時設定を返す (クライアントIDの解決はフロントエンドで行う)
#[tauri::command]
pub fn get_discord_config() -> DiscordConfig {
    DiscordConfig {
        client_id: arg_opt("--p2d-discord-client-id=", "P2D_DISCORD_CLIENT_ID"),
    }
}

/// 起動引数・2インスタンス目転送で受け取った p2d://join/<code> の保存先
pub struct JoinCodeState(pub Mutex<Option<String>>);

/// `p2d://join/<code>` 形式の引数からルームコードを取り出す
pub fn find_join_url<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for a in args {
        if let Some(rest) = a.as_ref().strip_prefix("p2d://join/") {
            let code: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if code.len() >= 4 {
                return Some(code);
            }
        }
    }
    None
}

/// 冷却起動時のディープリンク参加コードを1回だけ返す
#[tauri::command]
pub fn get_launch_join(state: State<'_, JoinCodeState>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// Discord Rich Presence を更新する (F-050)。失敗は無視 (Discord未起動でも致命傷にしない)
#[tauri::command]
pub fn discord_set_presence(
    state: State<'_, DiscordPresenceState>,
    client_id: String,
    room_code: String,
    details: String,
    viewers: usize,
    start_ts: i64,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = guard.as_ref() {
        handle
            .tx
            .send(PresenceCommand::Set { client_id, room_code, details, viewers, start_ts })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Discord Rich Presence をクリアする (退出時)
#[tauri::command]
pub fn discord_clear_presence(state: State<'_, DiscordPresenceState>) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = guard.as_ref() {
        handle.tx.send(PresenceCommand::Clear).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_is_parsed() {
        assert_eq!(find_join_url(["p2d://join/ABC123"]), Some("ABC123".into()));
        assert_eq!(
            find_join_url(["--url", "p2d://join/CWH4K6?x=1"]),
            Some("CWH4K6".into())
        );
        assert_eq!(find_join_url(["p2d://join/ab"]), None);
        assert_eq!(find_join_url(["unrelated"]), None);
        assert_eq!(find_join_url(Vec::<String>::new()), None);
    }
}
