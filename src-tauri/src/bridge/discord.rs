use crate::services::discord::{DiscordPresenceState, PresenceCommand};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

// --- Discord Rich Presence (F-050/F-051) + p2d:// ディープリンク + 招待v2 (M4) ---

/// 参加招待の解析結果。
/// 招待v2 (レンデブー最小化M4): `p2d://join/<CODE>@<host>:<port>` はホストの
/// 内蔵サーバーへ直行する (シグナリングサーバー不使用)。endpointがNoneなら従来通り。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JoinInvite {
    pub code: String,
    /// "host:port" 形式の内蔵サーバー住所 (v2のみ)
    pub endpoint: Option<String>,
}

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

/// 起動引数・2インスタンス目転送で受け取った招待の保存先
pub struct JoinCodeState(pub Mutex<Option<JoinInvite>>);

/// `p2d://join/<code>` / `p2d://join/<code>@<host>:<port>` 形式の引数を解析する (M4)
pub fn find_join_url<I, S>(args: I) -> Option<JoinInvite>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    for a in args {
        if let Some(rest) = a.as_ref().strip_prefix("p2d://join/") {
            let code: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
            if code.len() < 4 {
                continue;
            }
            // 招待v2: `@` 以降を host:port として取り出す (クエリ類は無視)
            let endpoint = rest.find('@').and_then(|at| {
                let raw = &rest[at + 1..];
                let ep: String = raw
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == ':' || *c == '-')
                    .collect();
                let parts: Vec<&str> = ep.split(':').collect();
                let valid = parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty();
                if valid {
                    Some(ep)
                } else {
                    None
                }
            });
            return Some(JoinInvite { code, endpoint });
        }
    }
    None
}

/// 冷却起動時のディープリンク参加コードを1回だけ返す (後方互換: コードのみ)
#[tauri::command]
pub fn get_launch_join(state: State<'_, JoinCodeState>) -> Option<String> {
    state
        .0
        .lock()
        .ok()
        .and_then(|mut g| g.take().map(|inv| inv.code))
}

/// 冷却起動時の招待 (コード+endpoint) を1回だけ返す (M4)
#[tauri::command]
pub fn get_launch_invite(state: State<'_, JoinCodeState>) -> Option<JoinInvite> {
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
        assert_eq!(
            find_join_url(["p2d://join/ABC123"]),
            Some(JoinInvite { code: "ABC123".into(), endpoint: None })
        );
        assert_eq!(
            find_join_url(["--url", "p2d://join/CWH4K6?x=1"]),
            Some(JoinInvite { code: "CWH4K6".into(), endpoint: None })
        );
        assert_eq!(find_join_url(["p2d://join/ab"]), None);
        assert_eq!(find_join_url(["unrelated"]), None);
        assert_eq!(find_join_url(Vec::<String>::new()), None);
    }

    #[test]
    fn invite_v2_with_endpoint_is_parsed() {
        assert_eq!(
            find_join_url(["p2d://join/ABC123@192.168.11.5:8090"]),
            Some(JoinInvite { code: "ABC123".into(), endpoint: Some("192.168.11.5:8090".into()) })
        );
        assert_eq!(
            find_join_url(["p2d://join/ABC123@p2d-host.local:8090?src=qr"]),
            Some(JoinInvite {
                code: "ABC123".into(),
                endpoint: Some("p2d-host.local:8090".into())
            })
        );
        // endpointが壊れている場合は従来形式としてコードだけ採用
        assert_eq!(
            find_join_url(["p2d://join/ABC123@:8090"]),
            Some(JoinInvite { code: "ABC123".into(), endpoint: None })
        );
        assert_eq!(
            find_join_url(["p2d://join/ABC123@host-only"]),
            Some(JoinInvite { code: "ABC123".into(), endpoint: None })
        );
    }
}
