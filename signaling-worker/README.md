# P2D Signaling Server (Cloudflare Workers版)

P2DのシグナリングサーバーをCloudflare Workers + Durable Objectsで動かす版。
**常設サーバーの運用が不要**になる(無料枠で動作、デプロイは `wrangler deploy` 1コマンド)。

## プロトコル互換性

`signaling-server/`(Node.js版)と同一のJSONプロトコル:
`room:create/join/leave`、`peer:offer/answer/ice`、`peer:tunnel`、`relay:*`(同一ルーム所属検証付き転送)。

P2Dアプリの設定でシグナリングURLを `wss://<ワーカーのドメイン>` にするだけで接続できます
(例: `wss://p2d-signaling.<アカウント>.workers.dev`)。

## デプロイ

```bash
cd signaling-worker
npm install
npx wrangler login    # 初回のみ (ブラウザでCloudflare認証)
npx wrangler deploy
# → https://p2d-signaling.<サブドメイン>.workers.dev が発行される
```

**2026-09-14 デプロイ済み**: `wss://p2d-signaling.akagifreeez.workers.dev/?room=<コード>`
(再デプロイは `npx wrangler deploy` のほか、Cloudflare MCPのexecuteツールからAPI直接PUTでも可)

## アーキテクチャ

- **1ルーム = 1 Durable Object** (`RoomDurableObject`)。URLの `?room=<コード>` でDOが特定され、同じ部屋の全員が同じDO上のWebSocketに集約される
- 部屋状態 (参加者・電話帳) はDOのインスタンスフィールド。WSが開いている間はDOが稼働し続けることが保証される
- 参加上限: `MAX_PARTICIPANTS` (既定8、wrangler.tomlのvarsで変更)
- メッセージ処理のコアは `src/room-core.ts` (WebSocketに依存しない純粋関数) に分離し、`npm test` で単体検証できる

## 制約・注意

- **メッセージサイズ上限**: 1メッセージ1MB (リレーチャンクは数十〜数百KBなのでOK)
- **リレーモードの中継をWorker経由で行う場合**: WSメッセージ数が増えるため無料枠の上限に触れうる。**推奨は配信木+内蔵サーバー構成** (メディアはWorkerを通らず、電話帳としてのみ使用)
- 無料枠の制約詳細はCloudflareのドキュメント参照

## テスト

```bash
npm test   # 部屋コアの単体テスト (7件: 参加(Room_FULL含む)/転送/無改変パススルー/退出/エラー)
```

ローカル動作確認:

```bash
npx wrangler dev --port 8787
# 別ターミナルでWSクライアントから ws://127.0.0.1:8787/?room=TEST12 に接続して検証
```
