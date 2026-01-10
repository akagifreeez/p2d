# P2D Signaling Server
FROM node:20-alpine

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
