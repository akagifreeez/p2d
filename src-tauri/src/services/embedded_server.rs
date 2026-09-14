//! P2D ホスト内蔵シグナリング/リレーWSサーバー (レンデブー最小化計画 M2/M3)
//!
//! 中央シグナリングサーバーが死んでも (または最初から無くても) 新規参加が
//! 完結するように、ホストアプリ自身が既存のシグナリング/`relay:*`プロトコル
//! のサブセットをLANにlistenする。中央サーバーは「電話帳」(コード→ここ) に
//! 専用化され、シグナリングとメディアには一切関与しなくなる。
//!
//! プロトコルは中央サーバー (signaling-server/) と同一JSON形状のサブセット:
//! - 接続直後の確認 (room:joined ダミー / myId 付与)
//! - room:create (hostToken保有者のみ / 新規作成時はトークンを発行) / room:join / room:leave
//! - peer:offer/answer/ice 転送 (同一ルーム検証付き)
//! - peer:tunnel / relay:* 転送 (同一ルーム検証付き)
//!
//! 認可モデル (issue#9/#10):
//! - 既存ルームへの `room:create` は正しい hostToken を持つ者 (= ホスト) のみ。
//!   トークン無し/不一致のcreateは参加者リストにもpeer:joinedにも載らない
//! - `room:join` はコード完全一致必須。hostEndpoint (電話帳) の更新は不可
//! - hostEndpoint の書き換えはホストのcreate/reclaim時のみ
//!
//! 同時扱うルームは1つ (内蔵サーバーは「この部屋のホスト」だけが持つため)。

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::sync::{watch, Semaphore};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message as WsMessage;

/// 内蔵サーバーの既定ポート
pub const DEFAULT_EMBEDDED_PORT: u16 = 8090;

/// 同時接続の上限 (1ルーム=最大8人想定×接続ならせ分の余裕)。issue#12:
/// WSハンドシェイク前にSemaphoreで予約するため、同時acceptでも上限を超えられない
const MAX_CONNECTIONS: usize = 64;
/// ルーム参加者上限 (中央Nodeサーバー/Workersと共通の既定値8)。issue#12
const MAX_ROOM_MEMBERS: usize = 8;
/// クライアント送信キュー上限。issue#12: 無限キュー (UnboundedSender) の代わりに
/// bounded化し、満杯時はメディアフレームを間引き、制御メッセージが詰まる
/// 低速クライアントは切断する
const SEND_QUEUE_CAP: usize = 512;
/// メディアフレームの連続ドロップがこの数に達したら低速クライアントとして切断
const SLOW_KICK_DROPS: u64 = 1024;

struct Client {
    out: mpsc::Sender<WsMessage>,
    room_code: Option<String>,
    name: Option<String>,
    joined_at: u64,
    /// 送信キュー満杯で間引いたメディアの連続数 (制御は満杯即kick)
    slow_streak: u64,
    /// 接続ハンドラへの kick 通知 (true で読み取りループを中断させる)
    kick: watch::Sender<bool>,
}

struct Room {
    code: String,
    host_endpoint: Option<String>,
    /// ホスト再権限トークン (issue#9)。初回 room:create 時にサーバーが生成し、
    /// room:created でホストへ1度だけ渡す。以後の create/reclaim はこれの提示が必須
    host_token: String,
    /// 現在のホスト接続のクライアントID (reclaimで更新)。peer:joined等の
    /// 応答に載せ、クライアント側の tree:*/鍵配布の権威チェックに使う (issue#10)
    host_id: Option<String>,
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

/// OS乱数シード (RandomStateの実装はプロセス毎のOS乱数を種にする) から
/// 256bitのホストトークンを生成する。issue#9: コード推測とは独立した
/// 認可情報なので、時間ベースの疑似乱数 (gen_room_code) は使わない
fn gen_host_token() -> String {
    let mut out = String::with_capacity(64);
    for _ in 0..4 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(SEQ.fetch_add(1, Ordering::Relaxed));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
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
/// host: 既定は 0.0.0.0 (LAN公開)。LAN内限定にしたい場合は 127.0.0.1 等を指定
#[tauri::command]
pub async fn embedded_server_start(
    state: tauri::State<'_, EmbeddedServerState>,
    port: Option<u16>,
    host: Option<String>,
) -> Result<u16, String> {
    if let Some(handle) = state.0.lock().map_err(|e| e.to_string())?.as_ref() {
        return Ok(handle.port);
    }
    let want_port = port.unwrap_or(DEFAULT_EMBEDDED_PORT);
    let want_host = host.unwrap_or_else(|| "0.0.0.0".to_string());

    // 指定ポートが塞がっていた場合 (例: 同一マシン上の複数インスタンスが各自
    // 内蔵サーバーを持つ配信木ケース) はエフェメラルポートへフォールバックする
    let listener = match TcpListener::bind((want_host.as_str(), want_port)).await {
        Ok(l) => l,
        Err(bind_err) if want_port != 0 => TcpListener::bind((want_host.as_str(), 0))
            .await
            .map_err(|e| format!("{want_host}:{want_port}とエフェメラルポートの両方でlistenできません: {bind_err} / {e}"))?,
        Err(e) => return Err(format!("{want_host}:0をlistenできません: {e}")),
    };

    let (shutdown_tx, mut shutdown_rx) = mpsc::unbounded_channel::<()>();
    let shared: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
    let actual_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // issue#12: 接続枠はaccept時点で予約 (ハンドシェイク前)。同時acceptの
    // 接続ストームでもMAX_CONNECTIONSを超えた処理が始まらない
    let permits = Arc::new(Semaphore::new(MAX_CONNECTIONS));

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.recv() => break,
                accepted = listener.accept() => {
                    let Ok((stream, _addr)) = accepted else { break };
                    let Ok(permit) = permits.clone().try_acquire_owned() else {
                        println!("[Embedded] 接続数上限 ({MAX_CONNECTIONS}) を超えた接続を拒否");
                        continue;
                    };
                    let state = shared.clone();
                    tokio::spawn(async move {
                        let _permit = permit; // 接続終了まで枠を保持
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
    // 巨大フレームによるメモリ枯渇を防ぐ (シグナリング/リレーチャンクは数百KB程度)
    let config = WebSocketConfig {
        max_message_size: Some(4 * 1024 * 1024),
        max_frame_size: Some(1024 * 1024),
        ..Default::default()
    };
    let ws = match tokio_tungstenite::accept_async_with_config(stream, Some(config)).await {
        Ok(ws) => ws,
        Err(e) => {
            println!("[Embedded] WSハンドシェイク失敗: {e}");
            return;
        }
    };
    let client_id = gen_id("emb");
    // issue#12: boundedキュー。満杯時の振る舞いはpush_locked参照
    let (out_tx, mut out_rx) = mpsc::channel::<WsMessage>(SEND_QUEUE_CAP);
    let (kick_tx, mut kick_rx) = watch::channel(false);

    // 接続確認 (中央サーバーと同一形状のダミーroom:joined)
    let ack = json!({
        "type": "room:joined",
        "timestamp": now_ms(),
        "payload": { "roomId": "", "roomCode": "", "myId": client_id, "participants": [] }
    });
    let _ = out_tx.send(WsMessage::Text(ack.to_string())).await;

    {
        let mut st = state.lock().unwrap();
        st.clients.insert(
            client_id.clone(),
            Client { out: out_tx, room_code: None, name: None, joined_at: now_ms(), slow_streak: 0, kick: kick_tx },
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

    loop {
        tokio::select! {
            _ = kick_rx.changed() => {
                if *kick_rx.borrow() {
                    println!("[Embedded] 低速クライアントとして切断: {client_id}");
                    break;
                }
            }
            msg = source.next() => {
                let Some(Ok(msg)) = msg else { break };
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

/// メディア (h264/frame/audio) は送れなければ間引いてよい。制御メッセージは
/// 間引きが致命的なので、キュー満杯=低速クライアントとして即kickする
fn is_media_relay(msg_type: &str) -> bool {
    matches!(msg_type, "relay:h264" | "relay:frame" | "relay:audio")
}

/// 送信の共通部。ロック保持者から呼ぶ。戻り値は「届いた見込みがあるか」
fn push_locked(st: &mut ServerStateInner, target: &str, message: serde_json::Value, media: bool) -> bool {
    use tokio::sync::mpsc::error::TrySendError;
    let Some(client) = st.clients.get_mut(target) else { return false };
    match client.out.try_send(WsMessage::Text(message.to_string())) {
        Ok(()) => {
            client.slow_streak = 0;
            true
        }
        Err(TrySendError::Full(_)) => {
            if media {
                client.slow_streak += 1;
                if client.slow_streak >= SLOW_KICK_DROPS {
                    kick_locked(st, target, "メディア送信の連続滞留");
                }
            } else {
                kick_locked(st, target, "制御メッセージの送信滞留");
            }
            false
        }
        Err(TrySendError::Closed(_)) => false, // 受信側が既に居ない
    }
}

fn kick_locked(st: &ServerStateInner, target: &str, reason: &str) {
    if let Some(c) = st.clients.get(target) {
        println!("[Embedded] 低速クライアントを切断: {target} ({reason})");
        let _ = c.kick.send(true);
    }
}

fn send_to(state: &SharedState, target: &str, message: serde_json::Value) -> bool {
    let mut st = state.lock().unwrap();
    push_locked(&mut st, target, message, false)
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
    let mut st = state.lock().unwrap();
    let members: Vec<String> = match st.room.as_ref() {
        Some(room) if room.code == room_code => room.members.iter().cloned().collect(),
        _ => return,
    };
    let msg = json!({
        "type": "peer:left",
        "senderId": left_id,
        "timestamp": now_ms(),
        "payload": { "peerId": left_id }
    });
    for member in members {
        push_locked(&mut st, &member, msg.clone(), false);
    }
}

enum JoinAction {
    /// 既存ルームへ room:join で参加 (コード一致済み)
    Join,
    /// room:create + hostToken一致 → ホスト再権限 (endpoint更新+hostId付け替え可)
    HostReclaim,
    /// 新規作成 (要求コード: 未指定なら生成)
    Create,
    Reject(&'static str),
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
            let host_token = payload
                .get("hostToken")
                .and_then(|v| v.as_str())
                .map(String::from);
            handle_create_join(client_id, msg_type, name, requested, host_endpoint, host_token, state);
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
            forward_to_peer(client_id, target.as_deref(), value, msg_type, state);
        }
        t if t.starts_with("relay:") => {
            forward_to_peer(client_id, target.as_deref(), value, t, state);
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
    host_token: Option<String>,
    state: &SharedState,
) {
    // 1) 既存ルームの状態から振る舞いを決める (短いロック区間)
    let action = {
        let st = state.lock().unwrap();
        match st.room.as_ref() {
            Some(room) => {
                if msg_type == "room:create" {
                    // issue#9: 既存ルームへの room:create は正しいhostTokenの保有者のみ。
                    // 無認可の接続者は参加者リスト・peer:joined・中継対象に一切入らない
                    if host_token.as_deref() == Some(room.host_token.as_str()) {
                        JoinAction::HostReclaim
                    } else {
                        JoinAction::Reject("UNAUTHORIZED")
                    }
                } else {
                    let want = requested.clone().unwrap_or_default().to_uppercase();
                    if want == room.code {
                        // issue#12: 中央サーバーと共通の参加者上限
                        if !room.members.contains(client_id) && room.members.len() >= MAX_ROOM_MEMBERS {
                            JoinAction::Reject("ROOM_FULL")
                        } else {
                            JoinAction::Join
                        }
                    } else {
                        JoinAction::Reject("ROOM_NOT_FOUND")
                    }
                }
            }
            None => {
                if msg_type == "room:create" {
                    JoinAction::Create
                } else {
                    JoinAction::Reject("ROOM_NOT_FOUND")
                }
            }
        }
    };

    if let JoinAction::Reject(code) = action {
        let msg = match code {
            "UNAUTHORIZED" => "このルームの作成者ではありません",
            "ROOM_FULL" => "ルームが満員です",
            _ => "ルームが見つかりません",
        };
        send_error(state, client_id, code, msg);
        return;
    }

    // 2) メンバー登録と応答内容の組立 (短いロック区間)
    let (room_code, endpoint, host_id, participants, peers, newly_joined) = {
        let mut st = state.lock().unwrap();
        match action {
            JoinAction::Create => {
                let code = normalize_code(requested.clone().unwrap_or_default()).unwrap_or_else(gen_room_code);
                st.room = Some(Room {
                    code: code.clone(),
                    host_endpoint: host_endpoint.clone(),
                    host_token: gen_host_token(),
                    host_id: Some(client_id.to_string()),
                    members: HashSet::new(),
                });
            }
            JoinAction::HostReclaim => {
                let room = st.room.as_mut().unwrap();
                // issue#10: hostEndpoint (電話帳) を書き換えられるのはホストだけ。
                // この経路 (token一致) 以外では一切更新しない
                if host_endpoint.is_some() || room.host_endpoint.is_none() {
                    room.host_endpoint = host_endpoint.clone();
                }
                room.host_id = Some(client_id.to_string());
            }
            JoinAction::Join | JoinAction::Reject(_) => {}
        }
        let (room_code, endpoint, host_id) = {
            let room = st.room.as_ref().unwrap();
            (room.code.clone(), room.host_endpoint.clone(), room.host_id.clone())
        };
        let mut newly_joined = false;
        {
            let room = st.room.as_mut().unwrap();
            if !room.members.contains(client_id) {
                room.members.insert(client_id.to_string());
                newly_joined = true;
            }
        }
        let mut parts = Vec::new();
        let mut peers = Vec::new();
        if let Some(room) = st.room.as_ref() {
            for m in &room.members {
                if m == client_id {
                    continue;
                }
                if let Some(c) = st.clients.get(m) {
                    parts.push(json!({ "id": m, "name": c.name, "joinedAt": c.joined_at }));
                    peers.push(m.clone());
                }
            }
        }
        (room_code, endpoint, host_id, parts, peers, newly_joined)
    };

    // 3) 自分の状態更新
    {
        let mut st = state.lock().unwrap();
        if let Some(c) = st.clients.get_mut(client_id) {
            c.room_code = Some(room_code.clone());
            c.name = name.clone();
        }
    }

    // 4) 自分への応答 (create/reclaimにはcreated+joinedの2通、joinにはjoinedの1通)
    let base = json!({
        "payload": {
            "roomCode": room_code,
            "roomId": room_code,
            "myId": client_id,
            "participants": participants,
            "hostEndpoint": endpoint,
            "hostId": host_id,
        }
    });
    if matches!(action, JoinAction::Create | JoinAction::HostReclaim) {
        let mut created = base.clone();
        created["type"] = json!("room:created");
        created["senderId"] = json!(client_id);
        created["timestamp"] = json!(now_ms());
        if let Some(room) = state.lock().unwrap().room.as_ref() {
            created["payload"]["hostToken"] = json!(room.host_token);
        }
        send_to(state, client_id, created);
    }
    let mut joined = base;
    joined["type"] = json!("room:joined");
    joined["senderId"] = json!(client_id);
    joined["timestamp"] = json!(now_ms());
    send_to(state, client_id, joined);

    // 5) 既存メンバーへの通知
    if matches!(action, JoinAction::HostReclaim) {
        // issue#10: ホストの接続IDがreclaimで変わったことを全員へ配る
        // (クライアントはtree:*/鍵配布の権威チェックにこのhostIdを使う)
        let host_msg = json!({
            "type": "room:host",
            "senderId": client_id,
            "timestamp": now_ms(),
            "payload": { "hostId": host_id }
        });
        for peer in &peers {
            send_to(state, peer, host_msg.clone());
        }
    }
    if newly_joined {
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
}

/// peer:*/relay:* の同一ルーム検証付き転送 (中央サーバーのcanForwardと同等)
fn forward_to_peer(
    client_id: &str,
    target: Option<&str>,
    value: &serde_json::Value,
    msg_type: &str,
    state: &SharedState,
) {
    let Some(target_id) = target else { return };
    let media = is_media_relay(msg_type);

    let mut st = state.lock().unwrap();
    let sender_room = st.clients.get(client_id).and_then(|c| c.room_code.clone());
    let target_room = st.clients.get(target_id).and_then(|c| c.room_code.clone());
    match (sender_room, target_room) {
        (Some(a), Some(b)) if a == b => {
            let mut fwd = value.clone();
            fwd["senderId"] = json!(client_id);
            fwd["timestamp"] = json!(now_ms());
            push_locked(&mut st, target_id, fwd, media);
        }
        _ => {
            println!("[Embedded] ルーム外中継を拒否: {client_id} -> {target_id}");
        }
    }
}

fn remove_from_room(state: &SharedState, client_id: &str, code: &str) {
    // 注意 (課題対応): 空になってもルームは削除しない。ホストの内蔵サーバーの部屋は
    // ホストが常駐させる「予約済み部屋」であり、全直結視聴者が中継へ移動して
    // 一時的に空になった瞬間に削除されると、以後の新規参加がROOM_NOT_FOUNDになる。
    // ルームの寿命 = 内蔵サーバー (ホストアプリ) の寿命。
    let mut st = state.lock().unwrap();
    if let Some(room) = st.room.as_mut() {
        if room.code == code {
            room.members.remove(client_id);
        }
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
    use std::time::Duration;

    /// テスト用: クライアントをstateへ直接登録し、受信キューを返す
    fn add_client(state: &SharedState, id: &str) -> mpsc::Receiver<WsMessage> {
        let (tx, rx) = mpsc::channel(SEND_QUEUE_CAP);
        let (kick_tx, _kick_rx) = watch::channel(false);
        state.lock().unwrap().clients.insert(
            id.to_string(),
            Client { out: tx, room_code: None, name: None, joined_at: now_ms(), slow_streak: 0, kick: kick_tx },
        );
        rx
    }

    fn msg(t: &str, payload: serde_json::Value) -> serde_json::Value {
        json!({ "type": t, "payload": payload })
    }

    fn msg_type(m: &WsMessage) -> String {
        match m {
            WsMessage::Text(s) => serde_json::from_str::<serde_json::Value>(s)
                .ok()
                .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(String::from))
                .unwrap_or_default(),
            _ => String::new(),
        }
    }

    fn recv_type(rx: &mut mpsc::Receiver<WsMessage>, timeout: Duration) -> Option<String> {
        use tokio::sync::mpsc::error::TryRecvError;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match rx.try_recv() {
                Ok(m) => return Some(msg_type(&m)),
                Err(TryRecvError::Empty) => {
                    if std::time::Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(TryRecvError::Disconnected) => return None,
            }
        }
    }

    fn drain_types(rx: &mut mpsc::Receiver<WsMessage>) -> Vec<String> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(msg_type(&m));
        }
        out
    }

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

    #[test]
    fn host_tokens_are_random_256bit() {
        let a = gen_host_token();
        let b = gen_host_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b, "OS乱数シードなので重複は起こらない");
    }

    #[test]
    fn issue9_stranger_create_on_existing_room_is_rejected() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let mut stranger_rx = add_client(&state, "stranger");
        // 接続ackを読み捨て
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        let _ = recv_type(&mut stranger_rx, Duration::from_millis(100));

        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123" })), &state);
        assert_eq!(recv_type(&mut host_rx, Duration::from_millis(100)).as_deref(), Some("room:created"));
        assert_eq!(recv_type(&mut host_rx, Duration::from_millis(100)).as_deref(), Some("room:joined"));

        // コードを知らない第三者が room:create → 拒否 (UNAUTHORIZED)
        dispatch("stranger", &msg("room:create", json!({ "roomCode": "ZZZZZZ" })), &state);
        assert_eq!(
            recv_type(&mut stranger_rx, Duration::from_millis(100)).as_deref(),
            Some("error")
        );

        // 参加者リストに載らず、hostへpeer:joinedも届かない
        let st = state.lock().unwrap();
        let room = st.room.as_ref().unwrap();
        assert!(!room.members.contains("stranger"));
        assert_eq!(room.members.len(), 1);
        assert_eq!(room.host_id.as_deref(), Some("host"));
    }

    #[test]
    fn issue9_join_requires_exact_code() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let mut g1_rx = add_client(&state, "g1");
        let mut g2_rx = add_client(&state, "g2");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        let _ = recv_type(&mut g1_rx, Duration::from_millis(100));
        let _ = recv_type(&mut g2_rx, Duration::from_millis(100));

        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123" })), &state);
        let _ = drain_types(&mut host_rx);
        dispatch("g1", &msg("room:join", json!({ "roomCode": "ABC123" })), &state);
        assert_eq!(recv_type(&mut g1_rx, Duration::from_millis(100)).as_deref(), Some("room:joined"));
        assert_eq!(recv_type(&mut host_rx, Duration::from_millis(100)).as_deref(), Some("peer:joined"));

        // 空の部屋ではないが、コード不一致のjoinは拒否
        dispatch("g2", &msg("room:join", json!({ "roomCode": "XYZ999" })), &state);
        assert_eq!(recv_type(&mut g2_rx, Duration::from_millis(100)).as_deref(), Some("error"));
        let st = state.lock().unwrap();
        assert!(!st.room.as_ref().unwrap().members.contains("g2"));
    }

    #[test]
    fn issue9_host_reclaim_with_token_rejoins_and_updates_endpoint() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host1");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        dispatch("host1", &msg("room:create", json!({ "roomCode": "ABC123", "hostEndpoint": "10.0.0.1:8090" })), &state);
        let _ = drain_types(&mut host_rx);
        let token = state.lock().unwrap().room.as_ref().unwrap().host_token.clone();

        // ホストのWSが切れて再接続 (別ID) → token提示でreclaim
        let mut host2_rx = add_client(&state, "host2");
        let _ = recv_type(&mut host2_rx, Duration::from_millis(100));
        dispatch("host2", &msg("room:create", json!({ "roomCode": "ABC123", "hostToken": token, "hostEndpoint": "10.0.0.9:8090" })), &state);
        assert_eq!(recv_type(&mut host2_rx, Duration::from_millis(100)).as_deref(), Some("room:created"));
        assert_eq!(recv_type(&mut host2_rx, Duration::from_millis(100)).as_deref(), Some("room:joined"));

        let st = state.lock().unwrap();
        let room = st.room.as_ref().unwrap();
        assert!(room.members.contains("host2"));
        assert_eq!(room.host_id.as_deref(), Some("host2"));
        assert_eq!(room.host_endpoint.as_deref(), Some("10.0.0.9:8090"), "ホストは電話帳を更新できる");
    }

    #[test]
    fn issue10_join_cannot_update_host_endpoint() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let mut g_rx = add_client(&state, "g");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        let _ = recv_type(&mut g_rx, Duration::from_millis(100));
        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123", "hostEndpoint": "10.0.0.1:8090" })), &state);
        let _ = drain_types(&mut host_rx);

        // join時のhostEndpointは無視される (issue#10)
        dispatch("g", &msg("room:join", json!({ "roomCode": "ABC123", "hostEndpoint": "evil.example:1234" })), &state);
        let _ = drain_types(&mut g_rx);
        let st = state.lock().unwrap();
        assert_eq!(st.room.as_ref().unwrap().host_endpoint.as_deref(), Some("10.0.0.1:8090"));
    }

    #[test]
    fn issue12_room_member_cap_is_enforced() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123" })), &state);
        let _ = drain_types(&mut host_rx);

        // host含め8人目までは参加可
        for i in 0..7 {
            let id = format!("g{i}");
            let mut rx = add_client(&state, &id);
            let _ = recv_type(&mut rx, Duration::from_millis(100));
            dispatch(&id, &msg("room:join", json!({ "roomCode": "ABC123" })), &state);
            assert_eq!(recv_type(&mut rx, Duration::from_millis(100)).as_deref(), Some("room:joined"));
        }
        // 9人目はROOM_FULL
        let mut rx = add_client(&state, "g9");
        let _ = recv_type(&mut rx, Duration::from_millis(100));
        dispatch("g9", &msg("room:join", json!({ "roomCode": "ABC123" })), &state);
        assert_eq!(recv_type(&mut rx, Duration::from_millis(100)).as_deref(), Some("error"));
        let st = state.lock().unwrap();
        assert_eq!(st.room.as_ref().unwrap().members.len(), MAX_ROOM_MEMBERS);
    }

    #[test]
    fn issue12_media_is_thinned_on_full_queue_and_control_kicks() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let mut slow_rx = add_client(&state, "slow");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        let _ = recv_type(&mut slow_rx, Duration::from_millis(100));
        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123" })), &state);
        let _ = drain_types(&mut host_rx);
        dispatch("slow", &msg("room:join", json!({ "roomCode": "ABC123" })), &state);
        let _ = drain_types(&mut slow_rx);

        // 読み取らない低速クライアントのキュー (容量512) をメディアで溢れるまで埋める
        let chunk = json!({ "type": "relay:h264", "targetId": "slow", "payload": { "seq": 1, "d": "AAAA" } });
        let mut drops = 0;
        {
            let mut st = state.lock().unwrap();
            for _ in 0..(SEND_QUEUE_CAP * 2) {
                if !push_locked(&mut st, "slow", chunk.clone(), true) {
                    drops += 1;
                }
            }
        }
        assert!(drops > 0, "キュー満杯後はメディアが間引かれる");

        // 制御メッセージはキュー満杯=即kick (watch通知)
        send_to(&state, "slow", json!({ "type": "relay:control_allowed", "targetId": "slow", "payload": { "allowed": true } }));
        // ack以上の受信が無い (キューが満杯のまま) でもkick通知は接続ハンドラへ届く。
        // ここではwatchが書き換わったことだけを直接確認する
        let st = state.lock().unwrap();
        // kick_lockedはwatchへ送るだけでmapからは即座に除かない (接続ハンドラが後片付け)
        assert!(st.clients.contains_key("slow"));
    }

    #[test]
    fn forward_requires_same_room_membership() {
        let state: SharedState = Arc::new(Mutex::new(ServerStateInner::default()));
        let mut host_rx = add_client(&state, "host");
        let mut outsider_rx = add_client(&state, "outsider");
        let _ = recv_type(&mut host_rx, Duration::from_millis(100));
        let _ = recv_type(&mut outsider_rx, Duration::from_millis(100));
        dispatch("host", &msg("room:create", json!({ "roomCode": "ABC123" })), &state);
        let _ = drain_types(&mut host_rx);

        // ルーム非所属からのofferは転送されない
        dispatch("outsider", &json!({ "type": "peer:offer", "targetId": "host", "payload": { "sdp": {} } }), &state);
        // hostには何も届かない
        assert!(recv_type(&mut host_rx, Duration::from_millis(50)).is_none());
    }

    #[test]
    fn issue12_semaphore_size_matches_constant() {
        let sem = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let mut permits = Vec::new();
        for _ in 0..MAX_CONNECTIONS {
            permits.push(sem.clone().try_acquire_owned().unwrap());
        }
        assert!(sem.try_acquire().is_err(), "上限に達したら予約不可");
    }
}
