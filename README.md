# P2D - P2P Desktop Sharing

<p align="center">
  <img src="public/p2d-icon.svg" width="128" height="128" alt="P2D Logo">
</p>

P2Dは、WebRTCを使用したP2Pデスクトップ共有アプリケーションです。  
サーバーを介さず、直接ピア間で画面共有とリモート操作が可能です。

## ✨ 機能

- 🖥️ **P2P画面共有** - 低遅延でスムーズな画面配信
- 🎮 **リモート操作** - マウス・キーボード入力を遠隔操作
- 📋 **クリップボード共有** - テキストの自動同期
- 💬 **テキストチャット** - DataChannel経由のリアルタイムチャット
- ⚙️ **品質設定** - 解像度、FPS、ビットレート、コーデックを調整可能
- 📊 **統計情報** - リアルタイムでFPS、ビットレート、パケットロスを表示
- 🖥️ **マルチモニター対応** - 複数モニター環境でも正確なリモート操作

## 🛠️ 技術スタック

- **フロントエンド**: React + TypeScript + Vite
- **バックエンド**: Tauri (Rust)
- **リアルタイム通信**: WebRTC
- **シグナリング**: WebSocket
- **スタイリング**: Tailwind CSS

## 🚀 セットアップ

### 必要条件

- Node.js 18+
- Rust (最新安定版)
- npm または pnpm

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/YOUR_USERNAME/P2D.git
cd P2D

# フロントエンドの依存関係をインストール
npm install

# シグナリングサーバーの依存関係をインストール
cd signaling-server
npm install
cd ..
```

### 開発モードで起動

```bash
# シグナリングサーバーを起動（別ターミナルで）
cd signaling-server
npm run dev

# Tauriアプリを起動（メインターミナルで）
npm run tauri dev
```

### ビルド

```bash
npm run tauri build
```

ビルド成果物は `src-tauri/target/release/bundle/` に生成されます。

### 🐳 Docker でシグナリングサーバーを起動

シグナリングサーバーをDockerで起動することもできます。

```bash
cd signaling-server

# ビルド＆起動
docker-compose up -d

# ログ確認
docker-compose logs -f

# 停止
docker-compose down
```

サーバーは `ws://localhost:8080` で起動します。

## 📖 使い方

### ホスト（画面共有側）

1. アプリを起動し「画面を共有する」を選択
2. 「画面共有を開始」ボタンをクリック
3. 表示される6桁のルームコードを視聴者に共有
4. 必要に応じて「リモート操作」を許可

### ビューア（視聴側）

1. アプリを起動し「画面を視聴する」を選択
2. ホストから受け取った6桁のルームコードを入力
3. 「接続する」をクリック
4. リモート操作が許可されていれば、画面上で操作可能

## ⚙️ 設定

### シグナリングサーバーURL

メイン画面右上の「⚙️ Settings」から、シグナリングサーバーのURLを変更できます。  
別PCと接続する場合は、シグナリングサーバーのアドレスを適切に設定してください。

## 📝 ライセンス

MIT License

## 🤝 コントリビューション

Issue、Pull Request歓迎です！
