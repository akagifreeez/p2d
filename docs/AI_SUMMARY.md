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

### 🔄 In Progress / TODO
*   F-052の実機確認 (有効なApplication ID + Discord起動 + 2人のDiscordユーザーでACTIVITY_JOIN受信を確認 — コードは完了)
*   macOSテスト (Apple Silicon実機必須。Linuxは2026-09-13検証済み — Known Issuesのプラットフォーム制約あり)

### 📐 配送方式ロードマップ (2026-09-13 本人確認済みの計画)
1. **現状: Full Mesh P2P** — 1対1・少人数の主用途。送信者上り=視聴者数×ビットレートなので多人数で線形増
2. **✅実装・実機検証済み(2026-09-13): ホストリレー(WS)** — Linux受信用。1対1のLAN想定。H264/MSE(2.5Mbps)+webm/opus音声+チャット+リモ操作。JPEG低遅延フォールバック併存
3. **将来: 自前リレー/SFUノード** — マルチビューアの帯域問題(送信者上りN倍)が実害になったら。信頼モデルは自前サーバーで無傷
4. **さらに先: 配信木(オーバーレイマルチキャスト)** — 視聴者が子を担当してインフラゼロでスケール。離脱時の再接続(サブツリー付け替え)が勝負所。インフラゼロ哲学を貫る場合のみ

### ⚠️ Known Issues
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
