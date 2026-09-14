# P2D Docker Deployment

Signaling ServerとTURNサーバーをDockerで起動できます。
なお、シグナリングのみならDocker不要の**Cloudflare Workers版** (`signaling-worker/`) もあります (TURNと併用する場合やオフライン環境では本Docker構成を使用)。

## クイックスタート (LAN向け)

```bash
# 1. 環境変数を設定
cp .env.example .env
# .envを編集: TURN_USER / TURN_PASS / TURN_EXTERNAL_IP は必須 (未設定だと起動しない)

# 2. 起動
docker-compose up -d

# 3. ログ確認
docker-compose logs -f
```

> **注意**: `TURN_USER` / `TURN_PASS` / `TURN_EXTERNAL_IP` に既定値はありません
> (監査#2)。これは既定資格情報のまま公開サーバーを立ててしまう事故を防ぐための
> 意図的な挙動です。`TURN_EXTERNAL_IP` は coturn の `--external-ip` に渡されます
> (NAT/VPS環境ではグローバルIP、自宅LANではそのホストのプライベートIP)。

## サービス構成

| Service   | Port        | 用途                     |
| --------- | ----------- | ------------------------ |
| signaling | 8080        | WebSocket シグナリング   |
| turn      | 3478        | TURN/STUN (UDP/TCP)      |
| turn      | 5349        | TURNS (TLS over TCP/UDP) |
| turn      | 49152-49200 | Relay ポート (UDP)       |

TURNイメージは `coturn/coturn:4.18.0` に固定されています (latestは使わない)。

## P2Dアプリでの設定

起動後、P2Dアプリの設定画面で以下を入力:

- **Signaling Server URL**: `ws://YOUR_SERVER_IP:8080` (LAN限定。公開環境は後述の `wss://` を使う)
- **TURN Server URL**: `turn:YOUR_SERVER_IP:3478`
- **Username**: `.env`で設定した `TURN_USER`
- **Credential**: `.env`で設定した `TURN_PASS`

`ws://` は暗号化されません。アプリはローカル/プライベート網以外への `ws://` 接続に
警告を表示します (監査#3)。インターネットに公開する場合は必ず次の「公開環境での TLS」
を使ってください。

## 公開環境での TLS (監査#3)

インターネットに公開する場合はTLSオーバーレイを使用し、クライアントには
`wss://` と `turns://` のみを案内してください:

```bash
cp .env.example .env
# .env に追加: CADDY_DOMAIN=p2d.example.com (Let's Encryptで自動取得)

mkdir -p turn/certs
# 証明書を配置 (Let's Encrypt の fullchain.pem / privkey.pem をコピー)
#   turn/certs/turn.crt  <- fullchain.pem
#   turn/certs/turn.key  <- privkey.pem

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

オーバーレイで変わること:

- **シグナリング**: Caddy が 80/443 でTLS終端し `wss://<CADDY_DOMAIN>` を
  signaling:8080 へ中継。8080の直接公開は解除 (localhostバインドのみ)。
- **TURN**: `--cert` / `--pkey` 付きで起動し `turns:<CADDY_DOMAIN>:5349` が有効化。
  TLS 1.0/1.1 は無効化、マルチキャストピアも無効化。

クライアント設定:

- **Signaling Server URL**: `wss://p2d.example.com`
- **TURN Server URL**: `turns:p2d.example.com:5349`

疎通確認:

```bash
# wss: ブラウザで https://<CADDY_DOMAIN> にアクセスして証明書を確認
# turns: coturn のログでTLSハンドシェイクを確認
docker compose -f docker-compose.yml -f docker-compose.tls.yml logs turn | grep -i tls
```

> 将来改善候補: 静的 `--user` の代わりに coturn の REST API
> (shared-secret + 時限資格情報) を導入すると、資格情報の漏洩リスクをさらに減らせます。

## サポート規模 (監査#6)

シグナリングサーバーは1ルームの参加者数を `P2D_MAX_PARTICIPANTS` (既定8) に制限し、
超過を `ROOM_FULL` エラーで拒否します。Full Meshでは送信帯域・接続数が
「参加者数 × 同時配信数」で増えるため、目安は次のとおり:

| 構成                        | ホスト上り帯域の目安 (standard品質 約2.5Mbps/視聴者) |
| --------------------------- | ---------------------------------------------------- |
| 1配信 × 3視聴者             | 約8Mbps                                              |
| 1配信 × 8視聴者 (既定上限)  | 約20Mbps                                             |

多人数・長時間の配信が主用途の場合は、WSリレーモード (Linux視聴) や
配信木化 (docs/配信木計画書.md) への移行を検討してください。

## ファイアウォール設定

```bash
# LAN構成
sudo ufw allow 8080/tcp   # Signaling
sudo ufw allow 3478/tcp   # TURN TCP
sudo ufw allow 3478/udp   # TURN UDP
sudo ufw allow 49152:49200/udp  # Relay

# TLSオーバーレイ構成では追加で
sudo ufw allow 80/tcp     # ACME (http-01)
sudo ufw allow 443/tcp    # wss
sudo ufw allow 5349/tcp   # TURNS
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

### 起動時に "TURN_USER を設定してください" と出る
`.env` に `TURN_USER` / `TURN_PASS` / `TURN_EXTERNAL_IP` を設定する (必須項目)。

### TURN接続できない
1. ファイアウォールでUDPポートが開いているか確認
2. `TURN_EXTERNAL_IP`が正しく設定されているか確認 (coturnの `--external-ip` に渡る)
3. `docker-compose logs turn`でエラーを確認

### Signaling接続できない
1. `docker-compose logs signaling`でエラーを確認
2. ポート8080にアクセスできるか確認
3. 公開環境で `ws://` ではなく `wss://` を使っているか確認
