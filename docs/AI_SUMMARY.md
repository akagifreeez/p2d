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

## Architecture (Full Mesh P2P - Updated 2026-01-12)

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
│   └── dataChannel.ts      # Type definitions
├── stores/
│   └── connectionStore.ts  # Zustand state
└── styles/
    └── index.css        # Cyberpunk Glass theme

signaling-server/
├── src/
│   ├── index.ts         # WS server entry
│   ├── roomManager.ts   # Room/Participant management
│   └── types.ts         # Shared types
```

---

## Current Status (2026-01-12)

### ✅ Completed
*   **Full Mesh P2P Architecture**: Host/Viewer区別を廃止、対等なピア接続
*   **Multi-Peer Screen Sharing**: 複数人の画面を同時表示可能
*   **Microphone Support**: マイクON/OFF、ミュート、デバイス選択
*   **Voice Activity Detection (VAD)**: 発話検出でアバターがハイライト、DataChannel経由でリモート共有
*   **TURN Server Configuration**: 設定画面でTURN URL/Username/Credentialを指定可能（localStorage永続化）
*   **Adaptive Bitrate Control**: 接続品質（RTT/パケットロス）に応じてビットレート自動調整、TURN検出時は帯域制限
*   **Unified RoomView UI**: ビデオグリッド、参加者リスト、チャット統合、接続品質表示
*   **Settings Modal**: マイクデバイス選択、TURNサーバー設定、Adaptive Mode設定
*   **Refactoring & Cleanup**: TypeScriptエラーの一括修正、不要ファイル（HostView.tsx等）の削除

### 🔄 In Progress / TODO
*   リモートコントロール（マウス/キーボード）のFull Mesh対応

### ⚠️ Known Issues
*   特になし

---

## Instructions for AI Agents
1.  **Context Loading**: セッション開始時にこのファイルを読むこと。
2.  **Style Consistency**: Cyberpunk Glass テーマを維持（`glass-card`, `btn-primary`, `text-cyan-400`）。
3.  **Code Safety**:
    *   `useWebRTC.ts` 変更時は非同期処理とシグナリング状態に注意。
    *   Rust バックエンド変更時は `tauri dev` 再起動が必要。
4.  **Documentation**: 大きな変更時はこのファイルを更新すること。
