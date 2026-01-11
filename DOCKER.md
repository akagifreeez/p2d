# P2D Docker Deployment

Signaling ServerとTURNサーバーをDockerで簡単に起動できます。

## クイックスタート

```bash
# 1. 環境変数を設定
cp .env.example .env
# .envを編集してTURN_PASSを変更

# 2. 起動
docker-compose up -d

# 3. ログ確認
docker-compose logs -f
```

## サービス構成

| Service   | Port        | 用途                     |
| --------- | ----------- | ------------------------ |
| signaling | 8080        | WebSocket シグナリング   |
| turn      | 3478        | TURN/STUN (UDP/TCP)      |
| turn      | 5349        | TURNS (TLS over TCP/UDP) |
| turn      | 49152-49200 | Relay ポート (UDP)       |

## P2Dアプリでの設定

起動後、P2Dアプリの設定画面で以下を入力:

- **Signaling Server URL**: `ws://YOUR_SERVER_IP:8080`
- **TURN Server URL**: `turn:YOUR_SERVER_IP:3478`
- **Username**: `p2d` (または.envで設定した値)
- **Credential**: `.envで設定したTURN_PASS`

## 本番環境向け設定

### 1. 認証情報の変更

```bash
# .env
TURN_USER=your_username
TURN_PASS=your_strong_password
```

### 2. 外部IPの設定（VPS等で必要）

```bash
# .env
TURN_EXTERNAL_IP=203.0.113.100
```

### 3. ファイアウォール設定

```bash
# 必要なポートを開放
sudo ufw allow 8080/tcp   # Signaling
sudo ufw allow 3478/tcp   # TURN TCP
sudo ufw allow 3478/udp   # TURN UDP
sudo ufw allow 49152:49200/udp  # Relay
```

## コマンド

```bash
# 起動
docker-compose up -d

# 停止
docker-compose down

# リビルド（コード変更後）
docker-compose up -d --build

# ログ確認
docker-compose logs signaling
docker-compose logs turn
```

## トラブルシューティング

### TURN接続できない
1. ファイアウォールでUDPポートが開いているか確認
2. `TURN_EXTERNAL_IP`が正しく設定されているか確認
3. `docker-compose logs turn`でエラーを確認

### Signaling接続できない
1. `docker-compose logs signaling`でエラーを確認
2. ポート8080にアクセスできるか確認
