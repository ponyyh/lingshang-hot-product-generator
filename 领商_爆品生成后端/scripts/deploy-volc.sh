#!/bin/bash
# 把后端和前端页面重新部署到火山引擎函数服务（华南 1 广州，应用 lingshang-hot-product）。
# 用法：bash scripts/deploy-volc.sh
# 前提：已安装 vefaas（npm i -g @volcengine/vefaas-cli）并登录（vefaas login --sso）。
# 环境变量在线上单独保存，本脚本不会上传 .env；要改线上变量用 vefaas env set KEY=VALUE。
set -e
cd "$(dirname "$0")/.."
STAGE=$(mktemp -d)/lingshang-deploy
mkdir -p "$STAGE/public/assets" "$STAGE/.vefaas"
cp server.js package.json "$STAGE/"
cp -R src "$STAGE/src"
cp ../领商_爆品生成网站/{index.html,styles.css,api.js,app.js} "$STAGE/public/"
cp ../领商_爆品生成网站/assets/* "$STAGE/public/assets/"
cp .vefaas/config.json "$STAGE/.vefaas/config.json"

# 本机开着全局代理时，代理节点连不上火山引擎的上传地址；临时起一个本地转发，从 Wi-Fi 网卡直连
LOCAL_ADDR=$(ipconfig getifaddr en0 2>/dev/null || true)
if [ -n "$LOCAL_ADDR" ]; then
  LOCAL_ADDR=$LOCAL_ADDR node scripts/direct-proxy.js > /tmp/lingshang_direct_proxy.log 2>&1 &
  PROXY_PID=$!
  trap 'kill $PROXY_PID 2>/dev/null' EXIT
  sleep 1
  export HTTPS_PROXY=http://127.0.0.1:18899 HTTP_PROXY=http://127.0.0.1:18899
fi

cd "$STAGE"
vefaas deploy --region cn-guangzhou --yes
