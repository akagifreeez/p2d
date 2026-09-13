//! P2D ホスト内蔵シグナリング/リレーWSサーバー (レンデブー最小化計画 M2/M3)
//!
//! 中央シグナリングサーバーが死んでも (または最初から無くても) 新規参加が
//! 完結するように、ホストアプリ自身が既存のシグナリング/`relay:*`プロトコル
//! のサブセットをLANにlistenする。中央サーバーは「電話帳」(コード→ここ) に
//! 専用化され、シグナリングとメディアには一切関与しなくなる。
//!
//! プロトコルは中央サーバー (signaling-server/) と同一JSON形状のサブセット:
//! - 接続直後の確認 (room:joined ダミー / myId 付与)
//! - room:create (roomCode/hostEndpoint指定可) / room:join / room:leave
//! - peer:offer/answer/ice 転送 (同一ルーム検証付き)
//! - peer:tunnel / relay:* 転送 (同一ルーム検証付き)
//!
//! 同時扱うルームは1つ (内蔵サーバーは「この部屋のホスト」だけが持つため)。

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// 内蔵サーバーの既定ポート
pub const DEFAULT_EMBEDDED_PORT: u16 = 8090;

struct Client {
    out: mpsc::UnboundedSender<WsMessage>,
    room_code: Option<String>,
    name: Option<String>,
    joined_at: u64,
}

struct Room {
    code: String,
    host_endpoint: Option<String>,
    members: HashSet<String>,
}

#[derive(Default)]
struct ServerStateInner {
    clients: HashMap<String, Client>,
    room: Option<Room>,
}

type SharedState = Arc<Mutex<ServerStateInner>>;

/// Tauri で管理するハンドル (稼働中のポート + 停止通知)
pub struct EmbeddedServerState(pub Mutex<Option<ServerHandle>>);
pub struct ServerHandle {
    pub port: u16,
    shutdown: mpsc::UnboundedSender<()>,
}

static SEQ: AtomicU64 = AtomicU64::new(0);

fn gen_id(prefix: &str) -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    format!("{prefix}-{nanos:08x}{n:04x}")
}

/// 中央サーバーと同じ文字集合の6桁ルームコード (コード未指定時のフォールバック)
fn gen_room_code() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut code = String::new();
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1);
    for _ in 0..6 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        code.push(CHARS[(((seed >> 33) as usize) ^ (SEQ.load(Ordering::Relaxed) as usize)) % CHARS.len()] as char);
    }
    code
}

fn normalize_code(c: String) -> Option<String> {
    let up = c.to_uppercase();
    if (4..=8).contains(&up.len()) && up.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(up)
    } else {
        None
    }
}

/// 内蔵サーバーを起動する (既に起動済みならそのポートを返す)
#[tauri::command]
pub async fn embedded_server_start(
    state: tauri::State<'_, EmbeddedServerState>,
    port: Option<u16>,
) -> Result<u16, String> {
    if let Some(handle) = state.0.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(handle.port);
    }
    let want_port = port.unwrap_or(DEFAULT_EMBEDDED_PORT);

    let listener = TcpListener::bind(("0.0.0.0", want_port))
        .await
        .map_err(|e| format!("ポート{want_port}をlistenできません: {e}"))?;

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let shared: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _addr)) = accepted else { break };
                    let state = shared.clone();
                    tokio::spawn(async move {
                        let _ = handle_connection(stream, state).await;
                    });
                }
            }
        }
        println!("[Embedded] サーバー停止");
    });

    *state.0.lock().map_err(|e| e.to_string())? = Some(ServerHandle {
        port: actual_port,
        shutdown: shutdown_tx,
    });
    println!("[Embedded] ホスト内蔵サーバー起動: 0.0.0.0:{actual_port}");
    Ok(actual_port)
}

/// 内蔵サーバーを停止する
#[tauri::command]
pub fn embedded_server_stop(state: tauri::State<'_, EmbeddedServerState>) -> Result<(), String> {
    if let Some(handle) = state.0.lock().map_err(|e| e.to_string())?.take() {
        let _ = handle.shutdown.send(());
    }
    Ok(())
}

/// 稼働中ならポートを返す
#[tauri::command]
pub fn embedded_server_status(
    state: tauri::State<'_, EmbeddedServerState>,
) -> Result<Option<u16>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|h| h.port))
}

/// LAN側から見た自分のプライマリIPv4アドレス (招待v2のQRに埋め込む)
#[tauri::command]
pub fn get_local_lan_address() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    // 実際にはパケットを送らない (connectは経路選択だけを行う)
    sock.connect("8.8.8.8:80").ok()?;
    let addr = sock.local_addr().ok()?;
    Some(addr.ip().to_string())
}

async fn handle_connection(stream: TcpStream, state: SharedState) {
    let ws = match tokio_tungstenite::accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            println!("[Embedded] WSハンドシェイク失敗: {e}");
            return;
        }
    };
    let client_id = gen_id("emb");
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<WsMessage>();

    // 接続確認 (中央サーバーと同一形状のダミーroom:joined)
    let ack = json!({
        "type": "room:joined",
        "timestamp": now_ms(),
        "payload": { "roomId": "", "roomCode": "", "myId": client_id, "participants": [] }
    });
    let _ = out_tx.send(WsMessage::Text(ack.to_string()));

    {
        let mut st = state.lock().unwrap();
        st.clients.insert(
            client_id.clone(),
            Client { out: out_tx, room_code: None, name: None, joined_at: now_ms() },
        );
    }
    println!("[Embedded] クライアント接続: {client_id}");

    let (mut sink, mut source) = ws.split();
    let write_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = source.next().await {
        match msg {
            WsMessage::Text(text) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    dispatch(&client_id, &value, &state);
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    on_disconnect(&client_id, &state);
    write_task.abort();
    println!("[Embedded] クライアント切断: {client_id}");
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn send_to(state: &SharedState, target: &str, message: serde_json::Value) -> bool {
    let st = state.lock().unwrap();
    if let Some(client) = st.clients.get(target) {
        client.out.send(WsMessage::Text(message.to_string())).is_ok()
    } else {
        false
    }
}

fn send_error(state: &SharedState, target: &str, code: &str, message: &str) {
    send_to(
        state,
        target,
        json!({
            "type": "error",
            "timestamp": now_ms(),
            "payload": { "code": code, "message": message }
        }),
    );
}

fn broadcast_peer_left(state: &SharedState, room_code: &str, left_id: &str) {
    let st = state.lock().unwrap();
    let Some(room) = st.room.as_ref() else { return };
    if room.code != room_code {
        return;
    }
    let msg = json!({
        "type": "peer:left",
        "senderId": left_id,
        "timestamp": now_ms(),
        "payload": { "peerId": left_id }
    });
    for member in &room.members {
        if let Some(c) = st.clients.get(member) {
            let _ = c.out.send(WsMessage::Text(msg.to_string()));
        }
    }
}

enum JoinAction {
    /// 既存ルームへ参加 (コード, 既知のhostEndpoint)
    Join(String, Option<String>),
    /// 新規作成 (要求コード: 未指定なら生成)
    Create(Option<String>),
    Reject,
}

fn dispatch(client_id: &str, value: &serde_json::Value, state: &SharedState) {
    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let target = value.get("targetId").and_then(|v| v.as_str()).map(String::from);
    let payload = value.get("payload").cloned().unwrap_or(serde_json::Value::Null);

    match msg_type {
        "room:create" | "room:join" => {
            let name = payload.get("name").and_then(|v| v.as_str()).map(String::from);
            let requested = payload
                .get("roomCode")
                .and_then(|v| v.as_str())
                .map(String::from);
            let host_endpoint = payload
                .get("hostEndpoint")
                .and_then(|v| v.as_str())
                .map(String::from);
            handle_create_join(client_id, msg_type, name, requested, host_endpoint, state);
        }
        "room:leave" => {
            let left_code = {
                let mut st = state.lock().unwrap();
                if let Some(c) = st.clients.get_mut(client_id) {
                    c.room_code.take()
                } else {
                    None
                }
            };
            if let Some(code) = left_code {
                remove_from_room(state, client_id, &code);
                broadcast_peer_left(state, &code, client_id);
            }
        }
        "peer:offer" | "peer:answer" | "peer:ice" | "peer:tunnel" => {
            forward_to_peer(client_id, target.as_deref(), value, state);
        }
        t if t.starts_with("relay:") => {
            forward_to_peer(client_id, target.as_deref(), value, state);
        }
        _ => {
            send_error(
                state,
                client_id,
                "UNKNOWN_TYPE",
                &format!("不明なメッセージタイプ: {msg_type}"),
            );
        }
    }
}

fn handle_create_join(
    client_id: &str,
    msg_type: &str,
    name: Option<String>,
    requested: Option<String>,
    host_endpoint: Option<String>,
    state: &SharedState,
) {
    // 1) 既存ルームの状態から振る舞いを決める (短いロック区間)
    let action = {
        let st = state.lock().unwrap();
        match st.room.as_ref() {
            Some(room) => {
                let want = requested.clone().unwrap_or_default().to_uppercase();
                if msg_type == "room:create" || want == room.code {
                    JoinAction::Join(room.code.clone(), room.host_endpoint.clone())
                } else {
                    JoinAction::Reject
                }
            }
            None => {
                if msg_type == "room:create" {
                    JoinAction::Create(requested)
                } else {
                    JoinAction::Reject
                }
            }
        }
    };

    if matches!(action, JoinAction::Reject) {
        send_error(state, client_id, "ROOM_NOT_FOUND", "ルームが見つかりません");
        return;
    }

    // 2) メンバー登録と応答内容の組立 (短いロック区間)
    let (room_code, endpoint, participants, peers) = {
        let mut st = state.lock().unwrap();
        let (room_code, endpoint) = match action {
            JoinAction::Create(want) => {
                let code = normalize_code(want.unwrap_or_default()).unwrap_or_else(gen_room_code);
                st.room = Some(Room {
                    code: code.clone(),
                    host_endpoint: host_endpoint.clone(),
                    members: HashSet::new(),
                });
                (code, None)
            }
            JoinAction::Join(code, known_endpoint) => (code, known_endpoint),
            JoinAction::Reject => unreachable!(),
        };
        {
            let room = st.room.as_mut().unwrap();
            room.members.insert(client_id.to_string());
            if room.host_endpoint.is_none() {
                room.host_endpoint = host_endpoint.clone();
            }
        }
        let room = st.room.as_ref().unwrap();
        let endpoint = endpoint.or_else(|| room.host_endpoint.clone());
        let mut parts = Vec::new();
        for m in &room.members {
            if m == client_id {
                continue;
            }
            if let Some(c) = st.clients.get(m) {
                parts.push(json!({ "id": m, "name": c.name, "joinedAt": c.joined_at }));
            }
        }
        let peers: Vec<String> = parts
            .iter()
            .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        (room_code, endpoint, parts, peers)
    };

    // 3) 自分の状態更新
    {
        let mut st = state.lock().unwrap();
        if let Some(c) = st.clients.get_mut(client_id) {
            c.room_code = Some(room_code.clone());
            c.name = name.clone();
        }
    }

    // 4) 自分への応答 (room:createにはcreated+joinedの2通、joinにはjoinedの1通)
    let base = json!({
        "payload": {
            "roomCode": room_code,
            "roomId": room_code,
            "myId": client_id,
            "participants": participants,
            "hostEndpoint": endpoint,
        }
    });
    if msg_type == "room:create" {
        let mut created = base.clone();
        created["type"] = json!("room:created");
        created["senderId"] = json!(client_id);
        created["timestamp"] = json!(now_ms());
        send_to(state, client_id, created);
    }
    let mut joined = base;
    joined["type"] = json!("room:joined");
    joined["senderId"] = json!(client_id);
    joined["timestamp"] = json!(now_ms());
    send_to(state, client_id, joined);

    // 5) 既存メンバーへの参加通知
    let peer_msg = json!({
        "type": "peer:joined",
        "senderId": client_id,
        "timestamp": now_ms(),
        "payload": { "peerId": client_id, "name": name }
    });
    for peer in peers {
        send_to(state, &peer, peer_msg.clone());
    }
}

/// peer:*/relay:* の同一ルーム検証付き転送 (中央サーバーのcanForwardと同等)
fn forward_to_peer(client_id: &str, target: Option<&str>, value: &serde_json::Value, state: &SharedState) {
    let Some(target_id) = target else { return };

    let st = state.lock().unwrap();
    let sender_room = st.clients.get(client_id).and_then(|c| c.room_code.clone());
    let target_room = st.clients.get(target_id).and_then(|c| c.room_code.clone());
    match (sender_room, target_room) {
        (Some(a), Some(b)) if a == b => {
            if let Some(c) = st.clients.get(target_id) {
                let mut fwd = value.clone();
                fwd["senderId"] = json!(client_id);
                fwd["timestamp"] = json!(now_ms());
                let _ = c.out.send(WsMessage::Text(fwd.to_string()));
            }
        }
        _ => {
            println!("[Embedded] ルーム外中継を拒否: {client_id} -> {target_id}");
        }
    }
}

fn remove_from_room(state: &SharedState, client_id: &str, code: &str) {
    let mut st = state.lock().unwrap();
    let mut room_empty = false;
    if let Some(room) = st.room.as_mut() {
        if room.code == code {
            room.members.remove(client_id);
            room_empty = room.members.is_empty();
        }
    }
    if room_empty {
        st.room = None;
    }
}

fn on_disconnect(client_id: &str, state: &SharedState) {
    let left_code = {
        let mut st = state.lock().unwrap();
        st.clients.remove(client_id).and_then(|c| c.room_code)
    };
    if let Some(code) = left_code {
        remove_from_room(state, client_id, &code);
        broadcast_peer_left(state, &code, client_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_code_alphabet_matches_central_server() {
        for _ in 0..50 {
            let code = gen_room_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_alphanumeric()));
        }
    }

    #[test]
    fn ids_are_unique() {
        let a = gen_id("emb");
        let b = gen_id("emb");
        assert_ne!(a, b);
    }

    #[test]
    fn code_normalization() {
        assert_eq!(normalize_code("abc123".into()), Some("ABC123".into()));
        assert_eq!(normalize_code("ab".into()), None);
        assert_eq!(normalize_code("too_long_code".into()), None);
        assert_eq!(normalize_code("AB-CD".into()), None);
    }
}
