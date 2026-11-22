#!/bin/bash
# Deploy only runtime source and public assets; never package .env or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOY_STAGE=$(mktemp -d)/lingshang-deploy
mkdir -p "$DEPLOY_STAGE/public" "$DEPLOY_STAGE/.vefaas"
cp server.js package.json "$DEPLOY_STAGE/"
cp -R src "$DEPLOY_STAGE/src"
cp ../领商_爆品生成网站/{index.html,styles.css,api.js,app.js,login.html,login.css,login.js} "$DEPLOY_STAGE/public/"
cp -R ../领商_爆品生成网站/assets "$DEPLOY_STAGE/public/assets"
cp deployment.json "$DEPLOY_STAGE/.vefaas/config.json"
find "$DEPLOY_STAGE" -name .DS_Store -delete
LOCAL_ADDR=$(ipconfig getifaddr en0 2>/dev/null || true)
if [ -n "$LOCAL_ADDR" ]; then
 LOCAL_ADDR=$LOCAL_ADDR node scripts/direct-proxy.js > /tmp/lingshang_direct_proxy.log 2>&1 &
 PROXY_PID=$!
 trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
 export HTTPS_PROXY=http://127.0.0.1:18899 HTTP_PROXY=http://127.0.0.1:18899
fi
cd "$DEPLOY_STAGE"
vefaas deploy --region cn-guangzhou --yes

# Keep the public gateway longer than the 150-second Dify budget.
vefaas trigger apig update --id utmxknb9 --route-id rdc16k4saini45cedquu0 --gateway-id gdc16iqkaini45cedqut0 --timeout 180 --region cn-guangzhou --yes
