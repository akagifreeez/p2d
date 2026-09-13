# P2D (P2P Desktop Sharing) Project Context

## Overview
P2D is a secure, low-latency **Full Mesh Peer-to-Peer** desktop sharing application built with Tauri v2, React, and WebRTC.
It features multi-peer screen sharing, voice chat (microphone), text chat, and a premium "Cyberpunk Glass" UI.

## Tech Stack
*   **Frontend**: React 18, TypeScript, Vite, TailwindCSS
*   **Backend**: Tauri v2 (Rust), `enigo` (Input Simulation), `arboard` (Clipboard)
*   **Communication**: WebRTC (Full Mesh P2P), WebSocket (Signaling)
*   **Design System**: Custom "Cyberpunk Glass" theme

---

## Architecture (Full Mesh P2P - Updated 2026-09-12)

### 1. Signaling Server (`signaling-server/`)
*   **Server**: Node.js WebSocket server.
*   **Protocol**: JSON-based messages.
*   **Key Messages**:
    *   `room:create` / `room:created`: ルーム作成
    *   `room:join` / `room:joined`: ルーム参加（既存参加者リストを返す）
    *   `peer:joined`: 新規参加者通知（既存メンバー向け）
    *   `peer:offer`, `peer:answer`, `peer:ice-candidate`: WebRTCシグナリング
*   **特徴**: Host/Viewer区別なし。全員が対等な参加者（`participants` Map）。

### 2. WebRTC Implementation (`src/hooks/useWebRTC.ts`)
*   **接続モデル**: Full Mesh（全参加者間で直接P2P接続）
*   **状態管理**:
    *   `participants: Map<string, ParticipantInfo>`: 全参加者情報
    *   `remoteStreams: Map<string, MediaStream>`: 各ピアからの受信ストリーム
    *   `localStream`: 自分の画面共有ストリーム
*   **主要機能**:
    *   `createRoom(name)` / `joinRoom(code, name)`: ルーム操作
    *   `startScreenShare()` / `stopScreenShare()`: 画面共有
    *   `startMicrophone()` / `stopMicrophone()` / `toggleMute()`: マイク制御
    *   `sendChatMessage(text)`: チャット送信（DataChannel経由）
*   **ピア接続フロー**:
    1. 新規参加者がJoin → `room:joined` で既存参加者リスト受信
    2. 新規は各既存ピアに対してOffer送信（Initiator）
    3. 既存は `peer:joined` 受信 → Answer待ち（Receiver）

### 3. UI Components (`src/components/`)
| Component       | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `RoomView.tsx`  | **メイン画面**。入室フロー + ビデオグリッド + コントロールバー |
| `ChatPanel.tsx` | テキストチャット（サイドバー統合）                             |
| `VideoGridItem` | 各ピアのビデオ表示カード                                       |
| `App.tsx`       | ルーティング、設定管理                                         |

### 4. Control Bar Features
| Button           | State               | Behavior                       |
| ---------------- | ------------------- | ------------------------------ |
| **Screen Share** | OFF/ON              | 画面共有開始/停止              |
| **Microphone**   | OFF/ON (Green)      | マイク開始/停止                |
| **Mute**         | Unmuted/Muted (Red) | マイクON時に表示、ミュート切替 |
| **Settings**     | -                   | 設定モーダル表示               |
| **Leave**        | -                   | ルーム退出                     |

### 5. Remote Control Pipeline (`src-tauri/src/services/desktop.rs` + `src/hooks/useWebRTC.ts`)
*   **経路**: ビューア入力 → DataChannel (`input:*` メッセージ) → ホスト → Rust (enigo) 適用
*   **マウス**: 動画タイル上の移動 (60/s スロットル) / ボタン Press・Release 分離 (ドラッグ対応) / スクロール
*   **キーボード**: ホバー中のみ転送 (入力欄フォーカス時は無効)。修飾キーは独立イベントで流すVNCモデル (Ctrl+C = ctrl down, c down, c up, ctrl up)
*   **権限管理 (F-022)**: ホスト側「リモート操作を許可」トグル (**デフォルトOFF=安全側**)。許可ピアにはCTRLバッジ表示。切替時は全ピアへ `control:remote_allowed` 通知
*   **クリップボード**: arboard によるホスト側監視 + `write_clipboard` コマンド

### 6. System Audio Pipeline (`src-tauri/src/services/audio_capture.rs` + `src/lib/systemAudio.ts`, F-031)
*   **経路**: Rust (WASAPI ループバック / cpal 0.15) → Int16 PCM を 20ms ごとに base64 化 → Tauri Channel → AudioWorklet のリングバッファ (50ms プリバッファ) → `MediaStreamAudioDestinationNode` → トラックを全ピアへ addTrack
*   **重要制約**: `cpal::Stream` は WASAPI では `!Send` のため、生成と保持を専用スレッドに閉じ、停止は `mpsc` シグナルで行う (state 間で移動させない)
*   **ループバックの正しい開き方**: `default_input_config()` はレンダーデバイスで `StreamTypeNotSupported` になる。`default_output_config()` の設定を `build_input_stream()` に渡す (eRender デバイスに LOOPBACK フラグが自動付与される)
*   **ローカル再生なし**: ハウリング防止のため AudioContext はスピーカーへ出力せず送信専用
*   単体テスト: `cargo test --lib services::audio_capture` (設定解決 + ストリーム構築/再生の実走確認)

### 7. E2E自己テストモード (`src/lib/e2eRunner.ts` + `bridge::system` のe2e_*コマンド)
*   **起動方法**: `p2d.exe --p2d-e2e-role=host --p2d-e2e-sync=<path> --p2d-e2e-log=<path>` (環境変数 P2D_E2E_ROLE/P2D_E2E_SYNC/P2D_E2E_LOG でも可)
*   **仕組み**: hostがルーム作成→コードをsyncファイルに書く→guestが読んで参加。以降は両インスタンスが自律的に画面共有・リモート操作許可・システム音声・チャットを実行し、`getPeerStats()` (WebRTC getStats) のバイト増加で検証する
*   **検証内容**: host=送信バイト増 (video/audio) + チャット往復 / guest=映像トラック生存+受信バイト増・CTRLバッジ受信・音声受信バイト増・チャット受信
*   **利点**: GUIフォーカス不要 (バックグラウンド完結)・リリースビルドのまま実行可能・結果はJSONレポート (`"passed": true/false`)
*   **2026-09-12実績**: 2インスタンス (同一PC) で全12ステップ pass。システム音声のE2E受信を統計で証明
*   ルームコードは数字6桁ではなく**英数字6文字** (例: CWH4K6)
*   **実機2台検証 (2026-09-13)**: デスクトップ(host) ⇔ ノートPC(akagi-note, scheduled task経由で対話セッション起動) のクロスマシンE2Eで両側 `"passed": true`。注意: SSH直起動ではWebView2のページJSが動かない(セッション0)ためscheduled task必須。E2Eの `--p2d-e2e-log=` 等はCWD相対で解決される

### 8. Discord Rich Presence (`src/lib/discord.ts` + `services/discord.rs` + `bridge/discord.rs`, F-050/F-051)
*   **仕組み**: Discord本体のローカルIPCパイプ (`\\.\pipe\discord-ipc-0..9`) に `discord-rich-presence` クレートで接続。すべてのIOは専用ワーカースレッドで行い、失敗 (Discord未起動・ID無効) は握りつぶして本体に影響させない
*   **表示内容**: details=「画面共有中/ルーム待機中」、state=「部屋 XXXXXX」、経過時間、partyサイズ、ボタン「参加する」→ `p2d://join/<コード>`
*   **更新タイミング**: ルーム入室時・参加者数変更・共有ON/OFF時 (RoomView.tsxのuseEffect)。退出・アプリ終了でclear
*   **クライアントID必須**: Discord Developer Portal でアプリを作成しApplication IDを取得する必要がある。解決順: 起動引数 `--p2d-discord-client-id=` / 環境変数 `P2D_DISCORD_CLIENT_ID` > 設定モーダルの入力欄 (localStorage)。未設定なら機能は無効 (無害)
*   **ディープリンク (F-051)**: `tauri-plugin-deep-link` で `p2d` プロトコルをHKCU登録、`tauri-plugin-single-instance` で2インスタンス目のURLを1インスタンス目へ転送。コールド起動時はargvから復元 (`get_launch_join`)。**E2Eモードではsingle-instanceを無効化** (2インスタンス同時起動が前提のため)

### 9. QR接続・接続履歴 (`src/components/QrJoin.tsx` + `src/lib/history.ts`, F-012/F-013)
*   **QR表示**: ルーム内コントロールバーのQRボタン → `p2d://join/<コード>` のQR + コードの大きな表示 + コピー。カメラで読むとプロトコルハンドラ経由でP2Dが起動し自動参加
*   **QR読み取り**: 参加画面の「QRコードで読み取る」→ カメラ (`getUserMedia`) + jsQR (純JS) でスキャン。`p2d://join/` 形式も素のコードも受け付ける。カメラ権限なしはエラー表示でフォールバック
*   **接続履歴**: 直近8件をlocalStorageに保持。参加画面の「接続履歴」チップをクリックでコード入力に反映

---


## Key Directories & Files
```
src/
├── App.tsx              # Entry, routing, settings
├── components/
│   ├── RoomView.tsx     # Main unified room view (NEW)
│   └── ChatPanel.tsx    # Text chat panel
├── hooks/
│   └── useWebRTC.ts     # Core WebRTC logic (Full Mesh)
├── lib/
│   ├── signalingClient.ts  # WS client wrapper
│   ├── dataChannel.ts      # Type definitions
│   ├── systemAudio.ts      # F-031 システム音声 (AudioWorklet)
│   ├── discord.ts          # F-050/F-051 Discord Rich Presence
│   └── e2eRunner.ts        # E2E自己テストモード
├── stores/
│   └── connectionStore.ts  # Zustand state
└── styles/
    └── index.css        # Material Design 3 (dark, teal seed) トークン+コンポーネントクラス

signaling-server/
├── src/
│   ├── index.ts         # WS server entry
│   ├── roomManager.ts   # Room/Participant management
│   └── types.ts         # Shared types
```

---

## Current Status (2026-09-13)

### ✅ Completed
*   **Full Mesh P2P Architecture**: Host/Viewer区別を廃止、対等なピア接続
*   **Multi-Peer Screen Sharing**: 複数人の画面を同時表示可能
*   **Monitor / Window Selection**: `startCustomScreenShare(sourceId, isMonitor)` による共有対象選択、`QualityConfig` による解像度/FPS設定
*   **Microphone Support**: マイクON/OFF、ミュート、デバイス選択
*   **Voice Activity Detection (VAD)**: 発話検出でアバターがハイライト、DataChannel経由でリモート共有
*   **Remote Control (p2cordから移植・成熟)**: マウス/キーボード/スクロールの完全な入力パイプライン (VNCモデルの修飾キー、ドラッグ対応)
*   **操作権限管理 (F-022)**: 「リモート操作を許可」トグル (デフォルトOFF) + CTRLバッジ表示
*   **Clipboard Sync**: arboardによるホスト側監視 + `write_clipboard`
*   **System Audio Sharing (F-031)**: WASAPIループバックでPCのシステム音声をキャプチャし、独立した音声トラックとして全ピアへ送信。コントロールバーのスピーカートグルで切替
*   **TURN Server Configuration**: 設定画面でTURN URL/Username/Credentialを指定可能（localStorage永続化）
*   **Adaptive Bitrate Control**: 接続品質（RTT/パケットロス）に応じてビットレート自動調整、TURN検出時は帯域制限
*   **Unified RoomView UI**: ビデオグリッド、参加者リスト、チャット統合、接続品質表示
*   **Settings Modal**: マイクデバイス選択、TURNサーバー設定、Adaptive Mode設定
*   **Refactoring & Cleanup**: TypeScriptエラーの一括修正、不要ファイル（HostView.tsx等）の削除
*   **Signaling再接続**: `signalingClient.ts` にWebSocket再接続を実装
*   **実機2台E2E (2026-09-13)**: デスクトップ⇔ノートPCのクロスマシンテストで両側passed。画面/音声受信バイト・CTRLバッジ・チャット往復を実証
*   **Discord Rich Presence (F-050) / 参加ボタン (F-051)**: ルーム中のDiscordステータス表示 + `p2d://join/<code>` ディープリンク参加。要Discord Application ID (設定モーダルまたは起動引数)
*   **QR接続 (F-012) / 接続履歴 (F-013)**: ルーム内QR表示・カメラスキャン参加・直近8件の履歴チップ
*   **ピアレベル自動再接続**: ICE `failed` / `disconnected` 5秒継続で `restartIce()` + 再交渉 (グレア対策: ID比較でoffer送信側を決定)。SDP処理はピア単位で直列化。復旧しない場合は部屋再参加で全接続を再構築 (受信メディアの実績があるピア限定)。シグナリング再接続時は部屋に自動再参加。**実環境検証済み (2026-09-13)**: デスクトップ⇔ノートPCでWi-Fi 16秒断を複数回実施し、自動再接続→メディア復帰を確認
*   **Discord招待 (F-052 v2)**: Rust側を `discord-sdk` 0.4 に移行。プレゼンスに join secret (=ルームコード) を載せ、相手がDiscord上で「参加」した際の **ACTIVITY_JOINイベントを受信**してディープリンクと同じ `p2d-join-url` 経路で自動参加。QRモーダルの「Discord招待文をコピー」(v1) も継続。**要実機確認**: 本環境にDiscordクライアントが無いため、実際の受信は有効なApplication ID+Discord起動+2人のDiscordユーザーで確認すること
*   **リレー品質設定UI**: 設定モーダルで 省データ(1024px/1Mbps/10fps) / 標準(1600px/2.5Mbps/12fps) / 高画質(1920px/5Mbps/15fps) を選択。localStorage保存・変更イベントで稼働中のエンコーダを即時作り直し
*   **Linux検証 (2026-09-13)**: pve上にUbuntu 24.04 VM (192.168.11.16) をcloud-initで自動構築しネイティブビルド。`tauri build` で **deb/rpm/AppImage生成✅**・起動✅・M3 UI描画✅(Noto CJK)・履歴機能✅・シグナリング参加✅。ただし**P2P本体は不可** — Ubuntu/Debian系公式WebKitGTKはWebRTC無効ビルドで`RTCPeerConnection`が未定義 (実証: python-giプローブNO_RTCPC + tcpdumpでメディアパケット0 + offer受信後もanswer不出力)。詳細はKnown Issues

*   **WSリレーモード (2026-09-13実装・実機検証済み)**: WebRTC非対応エンジン(Linux WebKitGTK)向けフォールバック。2モード: **H264/fMP4+MSE (品質モード・デフォルト)** — ホストがWebCodecs VideoEncoder(avc1.420028, 2.5Mbps)→mp4-muxer(fragmented)→top-level box再組立(moof+mdatペア)でWS送信、ゲストはMediaSource(sequence)で`<video>`再生。JPEG比~1/10の帯域・MSE分の1-2秒遅延 / **JPEG (低遅延フォールバック)** — canvas→toDataURLを`<img>`描画。ゲストの能力(`MediaSource.isTypeSupported`)をsubscribe時に申告しホストが視聴者ごとに切替。**音声リレー**: システム音声をMediaRecorder(webm/opus 48kbps)でチャンク送信→ゲストはwebm MSE。チャット(`relay:chat`)・リモート操作入力(`relay:input`)・操作許可バッジ(`relay:control_allowed`)もWS。視聴者subscribe時のみ送信=WebRTC全員対応なら零コスト。自動判定: `typeof RTCPeerConnection === 'undefined'`。**実機検証(2026-09-13)**: デスクトップ(Windows host) × Ubuntu 24.04 VM (guest) で guest passed:true — H264のみで受信(jpegFrames=0)・音声チャンク着信・チャット往復・操作バッジ・スクショでデコード描画を確認。**実装の罠**: sourceopenまでに届いたinit segmentをキューに溜めるだけでは流されず、fragmentが先にappendされてMSEが即死する → sourceopen時に必ずpumpすること
*   **レンデブー最小化 M1-M4 実装 (2026-09-13, 計画書を実装着手)**: ①**M1 名簿ゴシップ** — `src/lib/roster.ts` (決定論的union: joinedAt新しい方+名前辞書順 / depart墓石と再参加の復活規則 / 上限トリム)。DC開通時にroster:sync全件交換、peer:left時にroster:departをゴシップ、移行時は旧自分IDに墓石。split-brain合流を含む単体テスト10件 (test/roster.test.ts)。②**M2 DC中継シグナリング+内蔵サーバー** — `src-tauri/src/services/embedded_server.rs` がホストアプリ内で既存プロトコル (room:create/join, peer:offer/answer/ice, relay:*, peer:tunnel) のサブセットをLAN listen (既定8090, same-room検証付き)。中央サーバー死亡を検知すると4秒後に ホスト=内蔵サーバー / ゲスト=電話帳で学んだendpoint へ自動移行 (createRoomで同じコードを再作成)。`src/lib/signalRouter.ts` でWS死亡時にDC直結/中継1ホップでSDP/ICEを配送 (peer:tunnel封筒、hops=2)。**実機E2E: 中央サーバーkill後の新規参加が内蔵サーバー経由でpassed:true** (参加・名簿収束・映像40KB・音声・操作バッジ・チャット)。1対1リグレッション (中央経由デスクトップ×ノートPC) も両側passed。③**M3 ホスト内蔵リレー+Ed25519署名** — `src/lib/relaySign.ts` (tweetnacl, 署名対象=seq(8B BE)‖ts(8B BE)‖chunk、ルーム毎エフェメラル鍵)。ホストはrelay:keyで公開鍵配布+h264/audio/frameに署名、ゲストは検証してsigVerified/sigInvalidをstats化 (不正チャンクは破棄)。単体テスト6件 (改ざん/なりすまし/リプレイ検知)。④**M4 招待v2** — `p2d://join/CODE@host:port` (Rust find_join_url拡張+JoinInvite型、QR/スキャナ/手入力をparseInviteに統一)。ホストはcreateRoom時に内蔵サーバー起動+LAN IP (get_local_lan_address) をQRに埋め込み、中央サーバー無しでも部屋作成可能 (ローカル生成コード)。E2Eランナーにroster_sync/signature_verification/joinリトライを追加
*   **セキュリティ監査対応 (2026-09-13, GitHub issues #1-#6)**: ①**部屋外中継の拒否(#1)** — サーバーが`peer:offer/answer/ice`と`relay:*`の転送時に送信者・宛先の同一ルーム所属を検証+クライアントも参加者リスト外の着信を破棄(二重化。participantsRefをsetState側で同時更新するように変更) ②**TURN既定資格情報の廃止(#2)** — `TURN_USER/TURN_PASS/TURN_EXTERNAL_IP`を必須化(未設定で起動失敗)、`--external-ip`をcoturnのcommandへ明示(旧: environmentに渡すだけで未反映)、イメージを`coturn/coturn:4.18.0`に固定 ③**TLS整備(#3)** — 公開環境用オーバーレイ`docker-compose.tls.yml`(Caddyがwss終端+coturnにturns証明書)+アプリの平文`ws://`警告UI+DOCKER.md手順 ④**幽霊参加者修正(#4)** — createRoom/joinRoomを原子的移動に(旧所属から必ず退室、失敗時は所属を壊さない)+移動元へpeer:left通知 ⑤**依存ゼロ化(#5)** — signalingのws→8.21(high2件解消)、frontendをvite 8へ(vite/esbuild dev鎖解消、両側audit 0件) ⑥**参加者数上限(#6)** — `P2D_MAX_PARTICIPANTS`(既定8)超過のjoinを`ROOM_FULL`で拒否+UI表示。signaling-serverに`node --test`ベースの単体+統合テスト8件(実サーバー子プロセスで中継拒否・ROOM_FULL・移動時peer:leftを検証)

### 🔄 In Progress / TODO
*   F-052の実機確認 (有効なApplication ID + Discord起動 + 2人のDiscordユーザーでACTIVITY_JOIN受信を確認 — コードは完了)
*   macOSテスト (Apple Silicon実機必須。Linuxは2026-09-13検証済み — Known Issuesのプラットフォーム制約あり)

### 📐 配送方式ロードマップ (2026-09-13 本人確認済みの計画)
1. **現状: Full Mesh P2P** — 1対1・少人数の主用途。送信者上り=視聴者数×ビットレートなので多人数で線形増
2. **✅実装・実機検証済み(2026-09-13): ホストリレー(WS)** — Linux受信用。1対1のLAN想定。H264/MSE(2.5Mbps)+webm/opus音声+チャット+リモ操作。JPEG低遅延フォールバック併存
3. **将来: 自前リレー/SFUノード** — マルチビューアの帯域問題(送信者上りN倍)が実害になったら。信頼モデルは自前サーバーで無傷
3.5. **将来: レンデブー最小化** — サーバーを「最初の接続だけ」(電話帳)に再編。名簿ゴシップ+DC経由シグナリング+ホスト内蔵リレー。**推奨順序: 配信木M1の前** (木のコーディネータがホストに移り木のM1が縮小) → **計画書: [レンデブー最小化計画書.md](レンデブー最小化計画書.md)** (2026-09-13作成・未着手)
4. **✅実装+多人数実機テスト (2026-09-13): 配信木(オーバーレイマルチキャスト)** — 視聴者が子を担当してインフラゼロでスケール。**コーディネータ=ホスト権威** (レンデブーM1-M4済みのため計画書から方式変更)。`src/lib/treeAssign.ts` (幅優先BFS割当、fan-out=ホスト4/中継2、深さ≤3、subtree一括孤児再割当) + 単体テスト6件 (10ノードシミュレーション/中継kill/連鎖離脱)。プロトコルは `relay:tree:promote/relay_ready/assign/parent_lost` (既存relay:*転送に乗る=サーバー変更ゼロ)。中継者は内蔵サーバーをエフェメラルポートで起動し、受信チャンクを**署名ごと無改変パススルー** (鍵/許可状態/チャットも中継)。E2E (`--p2d-force-relay=1 --p2d-tree-fanout=1`): ホスト→中継→子の2層木で子がH264受信 (署名verified=24/invalid=0) ・中継kill後も子がホスト直結へ自動復旧。**既存バグ修正**: エンコーダonBoxが生成時の視聴者リストを凍結しており後発視聴者に映像が届かなかった (relayCapsRef を毎フレーム再取得へ)。
**多人数実機テスト (pve VM3台×3視聴者+デスクトップホスト=9視聴者/10ノード)**: 9/9視聴者 passed — 全員がH264チャンク受信+署名検証 verified=13/invalid=0。木も成立 (5直結+中継1に4人割り当て、昇格→relay_ready→assignの一連が実機動作)。**帯域実測 (2026-09-14)**: 動体表示(MOTIONウィンドウ)+VM1の3視聴者で**fan-out強制修正を含む最終検証**:
- 鎖状木 (host→v1→v2→v3, fanout=1): **ホスト上り 5.14 Mbps** (1ストリーム) — 9/9ではなく3視聴者だが、v1は中継に昇格しv2/v3へパススルー、全員受信+署名verified=23-24/invalid=0
- 全直結メッシュ (fanout=99): **ホスト上り 11.29 Mbps** (3ストリーム) — 同一3視聴者でA/B比較 → **約55%削減**を実測
- 第1回の9視聴者テスト (fanout強制前): 9/9 passedしたが直結5-6残留で圧縮未発現 → BFS昇格候補 (findPromoteCandidate) 修正で解消
- 計測方法: デスクトップ `Get-NetAdapterStatistics -Name 'イーサネット'` SentBytes差分 (by-name必須。by-InterfaceIndexは0を返すバグ) / VM側 `/proc/net/dev` eth0差分

**第1回 (2026-09-14)**: 動体表示(MOTIONウィンドウ)+pve VM3台×3視聴者=9人で実施。**9/9視聴者 passed**(chunks 4-7、署名verified=12-13/invalid=0)。ホスト上り実測: メッシュ相当(全直結)≈**11.3Mbps** / 配信木モード≈**13.7Mbps** — 两者同程度だった。理由: 同時joinストーム下でコーディネータの昇格/割り当てカスケードが追いつかず、fan-out上限(2)を超える5-6直結が残ったため(木の圧縮効果が発現しなかった)。**残課題**: ①joinストーム時のfan-out強制(直結上限超過分の確実な中継への段階的移行) ②計測方法の確立(デスクトップNIC `Get-NetAdapterStatistics -Name 'イーサネット'` by name = 正; by InterfaceIndex = 0を返すバグに注意)。再実行手順 (全て `C:/tmp/` に完備): ①ディスプレイが起きた状態で `p2d-motion.ps1` (描画はウィンドウ内。ウィンドウ移動方式はtao 0.35.3をクラッシュさせる) ②host `--p2d-tree-fanout=4` で9視聴者参加 → デスクトップNIC送信バイトを30秒計測 (=直結本数×レート) ③ `--p2d-tree-fanout=99` で同測定 (全直結メッシュ) → A/B比較。視聴者側は各VMの `/proc/net/dev` rx。※`p2d.exe` のtaskkill後は `p2d_bin` 名の残プロセスにも注意。
**判明した課題と対応 (同日修正済み)**: ①同時参加ストームでsubscribeがhostのpeer:joined処理に先行して破棄 → relay:key受信まで再送 (2/5/9/14s) で回収 ②WS再接続でIDが変わり木登録にゴースト → ノード喪失の意味論を整理 (`handleNodeLoss`: 直結のみ解放/中継配下は中継が報告) + 中継が子のWS切断を `tree:child_lost` でホストへ報告してスロット解放 ③内蔵サーバーの部屋は空でも削除しない (ホスト常駐の予約部屋として保持) ④中継消失時の孤児は `tree:assign{addr=ホスト}` でホスト直結へ即復旧 (実機確認: kill後もverified=22まで受信継続)→ **計画書: [配信木計画書.md](配信木計画書.md)**

### ⚠️ Known Issues
*   **レンデブー最小化の既知制約 (2026-09-13監査で受容)**: ①`peer:tunnel`封筒のoriginalSenderは暗号学的に保証されない (同一ルームのメンバーが他人のIDを名乗ってPC混線/攪乱が可能。部屋参加=信頼境界の前提。恒久対策は配信木§3.5のピア間署名) ②内蔵サーバーは0.0.0.0でlisten (embedded_server_startのhost引数でbind変更可)。ルームコード総当たりやレートリミットは未実装で、公開IPの機器で実行する場合は注意 ③リレーの署名はseq単調チェック+Ed25519で改ざん/なりすまし/リプレイを検知するが、_WS経由のメタデータ (誰がいつ参加したか) はホスト/内蔵サーバーが観測できる
*   **Linux (Ubuntu/Debian系) はWebRTC不可 → WSリレーモードで対応**: ディストリ公式WebKitGTKがWebRTC無効ビルド (`typeof RTCPeerConnection === 'undefined'`)。GStreamerプラグイン追加でも回復しない=エンジン層の欠如。リレーモードで映像(H264/MSE)+音声+チャット+リモート操作が可能(実機検証済み)。リレーのMSEバッファ分1-2秒の遅延あり(低遅延JPEGフォールバック併存)
*   複数音声トラック (マイク+システム音声) のリモート再生はChromiumのメディア要素ミキシング挙動に依存
*   システム音声共有はスピーカー出力を丸ごと拾うため、相手の音声もループする (エコー防止はヘッドホン推奨・UIのツールチップに記載済み)
*   Discord Rich Presenceは有効なApplication IDが無いと表示されない (偽IDではIPC接続後にActivity送信で切断される。動作自体は正常=ログ `[Discord] IPC接続成功`)

---

## Instructions for AI Agents
1.  **Context Loading**: セッション開始時にこのファイルを読むこと。
2.  **Style Consistency**: Cyberpunk Glass テーマを維持（`glass-card`, `btn-primary`, `text-cyan-400`）。
3.  **Code Safety**:
    *   `useWebRTC.ts` 変更時は非同期処理とシグナリング状態に注意。
    *   Rust バックエンド変更時は `tauri dev` 再起動が必要。
4.  **Documentation**: 大きな変更時はこのファイルを更新すること。
