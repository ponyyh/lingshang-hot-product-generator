# 真实联调接口

所有业务接口与网页同源。JSON 响应为 `{code,message,data,requestId}`。成功 code=0；错误为 HTTP 4xx/5xx + 明确 message（本地可关闭 STRICT_HTTP_STATUS）。

- GET /api/products?keyword=&page=1&pageSize=200：data={total,page,pageSize,list}。列表字段 name/color/weight/price/packaging 分别映射模板的产品标题/变种属性值一/重量/申报价格/外包装形状，同时保留 title/model/skuCode 等完整字段。
- POST /api/agent/hot-product/recognize：body={productIds,hotLink}，hotLink 支持 URL 或淘宝完整分享文案。data={taskId,title,extractedInfo:{keywords,workflowRunId,sourceUrl,source,matchedCount},attempts}。
- POST /api/agent/hot-product/regenerate-title：同上，并接受 taskId、previousTitle；保留 taskId。
- POST /api/compliance/validate-title：body={title,productIds}，data={passed,...}。
- POST /api/hot-product/export：body={taskId,productIds,hotLink,title}。下载 product_list.xlsx，每个选中 SKU 一行，顺序一致，69列表头/原值保留。产品标题=title+空格+原产品标题；来源URL=解析出的规范URL；更新时间=北京时间。服务端再次校验标题和属性。
- GET /api/health：agentConfigured、productCount、authRequired 等运行状态。

登录页的 loginByAccount / sendSmsCode / loginByPhone 保持模拟返回，不连接真实账号或短信。
Dify：POST https://api.dify.ai/v1/workflows/run，仅服务端携带 Bearer 密钥。

DOM：tbody id=modalProductList，data-testid=related-products-picker-tbody，二者仍各唯一一个。
