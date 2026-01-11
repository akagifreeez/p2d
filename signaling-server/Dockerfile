# P2D Signaling Server
FROM node:20-alpine

# ヘルスチェック用にnetcat追加
RUN apk add --no-cache netcat-openbsd

WORKDIR /app

# 依存関係をコピー＆インストール
COPY package*.json ./
RUN npm ci --only=production

# ソースコードをコピー
COPY src ./src
COPY tsconfig.json ./

# TypeScriptをグローバルにインストールしてビルド
RUN npm install -g typescript tsx

# ポート開放
EXPOSE 8080

# 起動コマンド
CMD ["npx", "tsx", "src/index.ts"]
