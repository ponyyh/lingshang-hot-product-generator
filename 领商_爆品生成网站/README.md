# 领商前端

页面与视觉沿用原版。业务接口为真实同源接口，API_CONFIG.USE_MOCK=false。账号和短信登录保持原型模拟功能，与业务开关分开。

通过后端 `npm start` 提供静态页面和接口，不使用 file:// 直接打开。入口 index.html；登录原型 login.html。
商品表来自模板，选择器 #modalProductList / [data-testid="related-products-picker-tbody"] 保持不变。

粘贴完整淘宝分享文案可同时提供链接和商品标题，Dify 用标题补充被淘宝跳转页隐藏的信息。仅链接缺少信息时显示明确提示。
导出 product_list.xlsx，中文前标题逐行拼接原型号后缀。更多内容见上级 README.md。
