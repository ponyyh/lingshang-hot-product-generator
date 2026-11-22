#!/bin/bash
# 启动后端（含前端页面）并通过 Cloudflare 隧道发布成公网 HTTPS 地址。
# 用法：bash scripts/start-public.sh    停止：bash scripts/start-public.sh stop
# 注意：公网地址每次启动都会变；电脑休眠或关机后地址失效，需要重新运行本脚本。
cd "$(dirname "$0")/.." || exit 1
PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-8787}

lsof -ti "tcp:$PORT" | xargs kill 2>/dev/null
pkill -f "cloudflared tunnel --no-autoupdate --url http://localhost:$PORT" 2>/dev/null
[ "$1" = "stop" ] && { echo "已停止"; exit 0; }

nohup node server.js > /tmp/lingshang_server.log 2>&1 &
sleep 1
nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > /tmp/lingshang_tunnel.log 2>&1 &

for _ in $(seq 1 45); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/lingshang_tunnel.log | head -1)
  [ -n "$URL" ] && grep -q 'Registered tunnel connection' /tmp/lingshang_tunnel.log && break
  sleep 1
done
if [ -z "$URL" ]; then echo "隧道启动失败，详见 /tmp/lingshang_tunnel.log"; exit 1; fi
echo "页面与接口地址：$URL"
echo "健康检查：$URL/api/health"
