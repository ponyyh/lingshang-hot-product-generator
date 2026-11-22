# 领商 · 爆品生成 后端

零依赖的 Node 服务（Node 22 及以上），同一个端口同时提供接口（`/api/*`）和前端页面（读取同级目录 `领商_爆品生成网站`）。

## 运行

```bash
cp .env.example .env        # 填写 AUTH_SECRET、TEST_ACCOUNTS、ARK_API_KEY、ARK_MODEL
node server.js              # 本机访问 http://localhost:8787/
bash scripts/start-public.sh   # 另外发布成公网 HTTPS 地址（Cloudflare 临时隧道）
npm test                    # 自动化测试（模型用假数据，不产生费用）
BASE_URL=<地址> TEST_USER=<账号> TEST_PASS=<密码> node scripts/smoke.mjs   # 对运行中的服务做真实验收
```

临时隧道的地址每次启动都会变，电脑休眠或关机后失效。

## 线上部署（火山引擎函数服务）

- **地址**：`https://sc9oc2u4b15chepfhoq43.apigateway-cn-guangzhou.volceapi.com`（页面和接口同一个地址）
- **位置**：华南 1（广州），应用 `lingshang-hot-product`，API 网关 `lingshang-gw`（Serverless）
- **规格**：0.25 核 / 512MB，实例数 0 到 2，没有请求时不占实例，所以闲置后第一次访问会慢一些
- **重新部署**：`bash scripts/deploy-volc.sh`（只上传代码和前端页面，不上传 `.env`）
- **环境变量**：线上单独保存，用 `vefaas env list` 查看、`vefaas env set KEY=VALUE` 修改，改完需要重新部署才生效
- **访问限制**：这个域名在境外代理节点下可能连不上，需要直连或让代理对它走直连

## 接口协议

统一响应 `{ code, message, data, requestId }`，`code === 0` 为成功。业务失败时 HTTP 状态码仍是 200，前端读 `message` 提示用户；设置 `STRICT_HTTP_STATUS=true` 后改为返回对应的 HTTP 状态码。

| 接口 | 方法与路径 | 说明 |
|---|---|---|
| 健康检查 | `GET /api/health` | 不需要登录 |
| 登录 | `POST /api/auth/login` | `{ username, password }` → `{ token, tokenType, expiresIn }` |
| 商品列表 | `GET /api/products?keyword=&page=1&pageSize=200` | `pageSize` 最大 200；无结果时 `total: 0, list: []` |
| 识别爆款链接 | `POST /api/agent/hot-product/recognize` | `{ productIds, hotLink }` → `{ taskId, title, extractedInfo, attempts }` |
| 重新生成标题 | `POST /api/agent/hot-product/regenerate-title` | `{ taskId, productIds, hotLink, previousTitle }` → `{ taskId, title, attempts }` |
| 标题校验 | `POST /api/compliance/validate-title` | `{ title, productIds }` → `{ passed }`，不通过时带 `violationType`、`category`、`hitWords`、`toastMsg`、`inlineMsg` |
| 导出方案 | `POST /api/hot-product/export` | `{ taskId, productIds, hotLink, title }` → 直接返回 CSV 文件流；导出前服务端会再校验一次标题 |

错误码：`40001` 参数错误，`40101` 未登录或登录过期，`40102` 账号或密码错误，`40401` 接口不存在，`42201` 标题未通过校验，`42901` 模型限流，`50201` 模型服务不可用，`50301` 模型未配置，`50401` 模型超时。

## 联调约定

- **Agent 调用方式**：由后端统一封装，前端不直接请求模型，密钥只在服务端的 `.env` 里。
- **同步还是异步**：同步返回。单次生成实测 1 到 4 秒，亚马逊链接经商品数据服务首次读取时要 15 到 40 秒；服务端总预算 50 秒（`AGENT_BUDGET_MS`），在前端 60 秒超时之内。`taskId` 只用于串联同一次任务的请求，没有进度查询接口。
- **重试**：生成的标题会先过一遍合规校验，不通过时带着原因让模型重写一次，仍不通过则删除极限词兜底，再不行返回 `42201`。模型超时或报错不自动重试，由用户点「重新生成」。
- **鉴权**：除健康检查和登录外都需要 `Authorization: Bearer <token>`，令牌默认 24 小时有效。测试账号在 `.env` 的 `TEST_ACCOUNTS` 里配置。
- **跨域**：页面与接口同源时不涉及。前端单独部署时，把前端来源写进 `ALLOWED_ORIGINS`（当前为 `*`），放行 `GET, POST, OPTIONS` 和 `Content-Type, Authorization` 请求头。用的是请求头鉴权，不涉及 Cookie。

## 亚马逊商品链接

- **读取内容**：商品标题、品牌、类目、五点描述、规格表，交给模型提炼成中文卖点；标题里的机型只取关联商品的机型。
- **链接格式**：`/dp/商品编号`、带标题路径和追踪参数的长链接、`/gp/product/` 都可以；搜索页和首页会提示不是商品详情页。
- **读取路径**：先由服务器直连；被亚马逊返回验证页或连不上时，改走商品数据服务 ScraperAPI（`SCRAPER_API_KEY`）。线上实测美国站走数据服务、英国站直连即可。
- **耗时**：直连 2 到 4 秒；经数据服务首次读取实测 15 到 40 秒。所以前端请求超时是 60 秒，服务端总预算 50 秒，其中数据服务最多 40 秒。
- **缓存**：经数据服务读到的商品信息按「站点 + 商品编号」缓存 6 小时，同一商品再次识别或重新生成不再读取，约 1 秒返回。缓存在实例内存里，实例回收后失效。
- **额度**：一次亚马逊读取消耗 5 个额度，失败不计。用 `curl "https://api.scraperapi.com/account?api_key=<密钥>"` 查看剩余额度。
- **是否生效**：`GET /api/health` 的 `amazonDataServiceConfigured` 为 `true` 表示已配置；识别结果的 `extractedInfo.source` 为 `scraper` 表示这次是经它读取的。
- **更换密钥**：`vefaas env set SCRAPER_API_KEY=<密钥> --region cn-guangzhou --yes`，再运行 `bash scripts/deploy-volc.sh`。

## 目前的限制

- **商品库是种子数据**：200 条与前端演示数据一致的手机壳，写在 `src/products.js` 里，没有接真实商品库。
- **需要登录的链接读不到内容**：淘宝、千牛后台等链接抓不到商品信息，这时只根据关联商品生成标题，`extractedInfo.fetched` 为 `false`，`note` 里有原因。
- **敏感词库是基础版**：`src/compliance.js` 里的词表只覆盖常见词，正式使用前应换成风控词库或内容安全服务。
- **账号是配置文件里的测试账号**：没有用户表，也没有登录失败次数限制。
