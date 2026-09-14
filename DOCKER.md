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
| signaling | 8080        | WebSocket シグナリング (公開構成では localhostバインド+ Caddyでwss終端) |
| turn      | 3478        | TURN/STUN (UDP/TCP)      |
| turn      | 5349        | TURNS (TLS over TCP / DTLS over UDP。TLSオーバーレイ時) |
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

## 公開環境での TLS (監査#3 / issue#3)

インターネットに公開する場合はTLSオーバーレイを使用し、クライアントには
`wss://` と `turns://` のみを案内してください (2026-09-14に証明書付きで疎通確認済み):

```bash
cp .env.example .env
# .env に追加: CADDY_DOMAIN=p2d.example.com (Let's Encryptで自動取得)

mkdir -p turn/certs
# 証明書を配置 (Let's Encrypt の fullchain.pem / privkey.pem をコピー)
#   turn/certs/turn.crt  <- fullchain.pem
#   turn/certs/turn.key  <- privkey.pem
# ※ turn/certs/ は .gitignore 済み (自己署名テスト証明書の混入防止)

docker compose -f docker-compose.yml -f docker-compose.tls.yml up -d
```

オーバーレイで変わること:

- **シグナリング**: Caddy が 80/443 でTLS終端し `wss://<CADDY_DOMAIN>` を
  signaling:8080 へ中継。8080の直接公開は解除 (localhostバインドのみ)。
- **TURN**: `--cert` / `--pkey` 付きで起動し `turns:<CADDY_DOMAIN>:5349` (TCP/TLS と
  UDP/DTLS) が有効化。**最低バージョンは TLS 1.3 / DTLS 1.2**
  (`--no-tlsv1_2`。coturn 4.18.0 には `--no-tlsv1` / `--no-tlsv1_1` が存在せず、
  指定すると起動に失敗するため 2026-09-14 に修正)。マルチキャストピアも無効化。

クライアント設定:

- **Signaling Server URL**: `wss://p2d.example.com`
- **TURN Server URL**: `turns:p2d.example.com:5349` (`?transport=tcp` はTLS、`udp` はDTLS)

疎通確認 (自己署名でも同様に確認できる):

```bash
# TURNS: 証明書を検証しつつTLSハンドシェイク (Verify return code: 0 (ok) が出れば疎通)
echo | openssl s_client -connect <SERVER>:5349 -servername p2d.example.com \
  -CAfile turn/certs/turn.crt -verify_return_error

# wss: 検証クライアント or ブラウザで証明書を確認
#   node なら Caddyの内部CA (localhost構成時) を pin して wss で接続し
#   room:create → room:created の往復を確認できる
docker compose -f docker-compose.yml -f docker-compose.tls.yml logs turn | grep -i tls
#   "TLS 1.3 supported" / "DTLS 1.2 supported" / "Certificate file found" を確認
```

2026-09-14 の実走確認 (CADDY_DOMAIN=localhost の内部CA構成 + 自己署名TURN証明書):

- Caddy: `wss://localhost` で room:create/room:join/relay転送の往復 5/5 pass
  (クライアントは Caddy ルートCA を pin して証明書検証)
- coturn: `openssl s_client -connect :5349` で TLSv1.3 ハンドシェイク、
  `Verify return code: 0 (ok)`。DTLSリスナーも起動を確認

## シグナリングのネイティブTLS (リバースプロキシなし)

Caddy を使わず Node サーバー自身でTLSを終端することもできる
(`signaling-server/src/index.ts`、issue#3):

```bash
P2D_TLS_CERT=/etc/letsencrypt/live/p2d.example.com/fullchain.pem \
P2D_TLS_KEY=/etc/letsencrypt/live/p2d.example.com/privkey.pem \
PORT=8443 npm start
# クライアントは wss://p2d.example.com:8443
```

どちらの構成でも、クライアントがローカル/プライベート網以外で `ws://` / `turn://`
を設定している場合は設定画面と接続中の画面の両方に警告が表示される
(`src/lib/securityUrl.ts`)。

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
sudo ufw allow 5349/tcp   # TURNS (TLS)
sudo ufw allow 5349/udp   # TURNS (DTLS)
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
