#!/usr/bin/env bash
# Ship Snap & Sell to the VPS: rsync source, install deps on the box, restart pm2.
# Usage: infra/deploy.sh   (.env.production must exist locally, or .env already on the box)
set -euo pipefail
HOST=root@75.119.132.248
DIR=/root/snapsell
NAME=snapsell
PORT=4090
NODE_BIN=/root/.nvm/versions/node/v25.2.1/bin
cd "$(dirname "$0")/.."

ssh "$HOST" "mkdir -p $DIR/data/uploads"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude .env.production --exclude data --exclude .git --exclude '*.zip' \
  ./ "$HOST:$DIR/"
if [ -f .env.production ]; then scp -q .env.production "$HOST:$DIR/.env"; fi

ssh "$HOST" "export PATH=$NODE_BIN:\$PATH && cd $DIR && npm ci --omit=dev --no-audit --no-fund \
  && (pm2 describe $NAME >/dev/null 2>&1 && pm2 restart $NAME --update-env || pm2 start src/server.js --name $NAME) \
  && pm2 save >/dev/null"
sleep 3
ssh "$HOST" "curl -fsS http://127.0.0.1:$PORT/api/health" && echo
