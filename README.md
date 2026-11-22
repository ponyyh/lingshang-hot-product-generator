# 领商爆品生成

本目录是 GitHub 与火山引擎部署的唯一发布源。前端与后端同源部署。

- 网站： https://sc9oc2u4b15chepfhoq43.apigateway-cn-guangzhou.volceapi.com/
- 网站默认入口 `/` 为登录页，模拟登录后跳转 `/index.html` 工作台。登录页也可通过 `/login.html` 打开。保留现有模拟账号/验证码交互，不连接真实认证或短信。
- 云项目：default；区域：cn-guangzhou；函数：utmxknb9；应用：c7aa00c47e50。
- Dify Workflow：f2845047-af9f-4642-a017-d9a25842a87b。
- Dify API：`POST https://api.dify.ai/v1/workflows/run`，仅服务端调用。

## 本地运行

进入 `领商_爆品生成后端`，从 `.env.example` 配置 `.env`，填入 DIFY_API_KEY，再运行 `npm start`。端口默认 8787。`npm test` 运行接口、空结果、属性约束、Excel 对齐和限流验证。

## 商品与导出

商品源为后端 `templates/product_list.xlsx`。运行 `node scripts/import-products.mjs templates/product_list.xlsx` 后更新 `src/data/products.json`。
指定 DOM `#modalProductList` / `[data-testid="related-products-picker-tbody"]` 读取 `/api/products`；当前模板包含 2 个 SKU、69 列。

| 页面字段 | Excel 原始列 |
| --- | --- |
| 商品名称 | 产品标题 |
| 颜色 | 变种属性值一 |
| 重量 | 重量 |
| 价格 | 申报价格 |
| 外包装形状 | 外包装形状 |

导出只包含选中 SKU，顺序与选择一致。工作表 `pddkj_product`、69 列顺序及其他原始值保留；产品标题写为“中文前标题 + 半角空格 + 本行原产品标题”，来源URL写规范链接，更新时间写北京时间。

## 淘宝分享链接

可直接粘贴完整淘宝分享文案，后端提取 URL 与「商品标题」，分别传入 Dify 的 hot_link、hot_title。淘宝短链接可能只有跳转脚本或被拦截；若链接本身无法获得商品信息，必须提供包含商品标题的分享文案，系统会明确报错，禁止空关键词生成通用标题。不会根据 token 编造商品信息。

参考商品的关键词只作参考，生成标题只允许使用当前选中 SKU 共有且已证实的属性。比如自家 SKU 未证明有支架或磁吸，不能直接照搬参考标题的这些词。

## 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/health | 状态检查 |
| GET | /api/products | 真实商品列表与搜索 |
| POST | /api/agent/hot-product/recognize | Dify 初次识别生成 |
| POST | /api/agent/hot-product/regenerate-title | Dify 重新生成 |
| POST | /api/compliance/validate-title | 标题校验 |
| POST | /api/hot-product/export | product_list.xlsx 下载 |

业务接口为演示模式（AUTH_REQUIRED=false），登录原型的模拟 token 不视为真实鉴权。生成接口限制为每实例每分钟10次、最多3个并发。Dify 失败、空关键词、未证实功能都阻断生成/导出。密钥仅在本地忽略的 `.env` 和云环境变量中保存，不进入 GitHub 或前端。

## 发布

`bash 领商_爆品生成后端/scripts/deploy-volc.sh` 打包当前前端和后端，部署到已有 default 项目函数；会保留云端环境变量。
GitHub 仓库根目录与本目录发布文件一致，忽略 `.env`、`.vefaas`、`.DS_Store`、临时文件及依赖。`deployment.json` 是不含密钥的部署目标配置。

参考开发文档原文为 Chat/Agent API；本项目是 Workflow，实际使用 [Dify Workflow API](https://docs.dify.ai/zh/api-reference/guides/workflow)。

## 网络与双商品修复

生成请求的网关超时为180秒，Dify预算150秒。网络中断时前端最多自动重试一次，同一请求键在同一服务实例内复用5分钟结果，避免重复生成；持续失败显示中文原因与“重试生成”按钮。业务校验失败不自动重发。
多SKU只提取共有正向属性，“无/否/不带”不作为卖点。没有共有正向属性时生成客观品类前标题。
