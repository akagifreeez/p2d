# P2D - Cyberpunk P2P Desktop Sharing

<p align="center">
  <img src="public/p2d-icon.svg" width="120" height="120" alt="P2D Logo">
  <br>
  <strong>Tauri v2 + React + WebRTC による、モダンでセキュアな Full Mesh P2P デスクトップ共有ツール</strong>
</p>

## ✨ 特徴

P2D (Peer-to-Desktop) は、サーバーを経由せず（P2P）、低遅延で高画質な画面共有とボイスチャットを提供するアプリケーションです。
SFチックな "Cyberpunk Glass/Neon" デザインを採用し、没入感のあるユーザー体験を提供します。

- 🕸️ **Full Mesh P2P Architecture**
  - 中央サーバー不要（シグナリングのみ）。参加者全員が互いに直接接続し、対等な関係で通信します。
  - 複数人の画面を同時に共有・視聴可能（Multi-Stream Support）。

- 🖥️ **Ultra-Low Latency Screen Sharing**
  - WebRTCによる低遅延配信。
  - **Adaptive Bitrate Control**: ネットワーク品質（RTT/パケットロス）をリアルタイム監視し、画質を自動最適化します。

- 🎙️ **Crystal Clear Voice Chat**
  - 高品質な音声通話機能を内蔵。
  - **Voice Activity Detection (VAD)**: 発話を検出し、アバターのハイライトやDataChannel通知を行います。

- 🛡️ **Secure & Private**
  - エンドツーエンド暗号化（WebRTC標準）。
  - カスタム **TURNサーバー** 対応（NAT越えが必要な厳しいネットワーク環境でも接続可能）。

- 🎮 **Remote Control** (Beta)
  - 相手の画面を自分のPCのように操作（マウス/キーボード）。
  - DataChannel経由で入力を同期します。

- 🎨 **Modern Cyberpunk UI**
  - TailwindCSSによる洗練されたダークモード・ガラスモーフィズムデザイン。
  - 直感的な操作が可能なユニファイドインターフェース。

## 🛠️ 技術スタック

*   **Frontend**: React 18, TypeScript, Vite, TailwindCSS, Lucide Icons
*   **Backend**: Tauri v2 (Rust), `arboard` (Clipboard), `enigo` (Input Simulation)
*   **Communication**: WebRTC (RTCPeerConnection, RTCDataChannel), WebSocket (Signaling)
*   **State Management**: Zustand
*   **DevOps**: Docker (Signaling & TURN Server)

## 🚀 はじめ方 (Getting Started)

### 前提条件

*   **Node.js**: v18以上
*   **Rust**: 最新安定版 (`rustup update` 推奨)
*   **Build Tools**: 各プラットフォームのTauri依存関係（Windowsなら VS Build Tools with C++）

### インストール & 起動

1. **リポジトリのクローン**
   ```bash
   git clone https://github.com/your-repo/P2D.git
   cd P2D
   ```

2. **依存関係のインストール**
   ```bash
   # フロントエンド & Tauri
   npm install

   # シグナリングサーバー
   cd signaling-server
   npm install
   cd ..
   ```

3. **ローカル開発サーバーの起動** (推奨)
   シグナリングサーバーとTauriアプリを同時に起動します。
   
   ```bash
   # ターミナル1: シグナリングサーバー
   cd signaling-server
   npm run dev
   ```

   ```bash
   # ターミナル2: Tauriアプリ開発モード
   npm run tauri dev
   ```

### 🐳 Dockerによるサーバーデプロイ (Optional)

本番環境やLAN外からの接続用に、シグナリングサーバーとTURNサーバーをDockerで簡単に起動できます。
設定の詳細などは [DOCKER.md](./DOCKER.md) を参照してください。

```bash
# ビルド & 起動
docker-compose up -d

# ログ確認
docker-compose logs -f
```

## 📖 使い方

### ルームの作成と参加

従来の「ホスト/ゲスト」方式ではなく、**ルームコード** を共有するだけで誰とでもつながれます。

1. **ルーム作成**: ホーム画面で「Create Room」をクリックします。
2. **コード共有**: 左上に表示される **6桁のルームコード** を相手に伝えます。
3. **参加**: 相手はホーム画面で「Join Room」を選択し、コードを入力して参加します。

### 画面共有 & ボイスチャット

*   **画面共有**: 下部バーの **モニターアイコン** をクリックし、共有したいウィンドウや画面を選択します。
*   **マイク**: **マイクアイコン** でON/OFFを切り替えます。
*   **設定**: 右上の設定アイコンから、入力デバイスの変更やTURNサーバーの設定、Adaptive Bitrate機能のON/OFFが可能です。

## ⚙️ 設定 (Advanced)

*   **TURN Server**: 企業内ネットワークや厳しいNAT環境下で接続できない場合、独自または公開TURNサーバーを設定に追加できます。
*   **Adaptive Bitrate Mode**: デフォルトで有効。不安定な回線での画質崩壊を防ぎます。

## 🤝 Contributing

Pull Request は大歓迎です！
バグ報告や機能要望は Issue までお願いします。

## 📜 License

MIT License
