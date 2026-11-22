# 领商后端

请参阅上一级 README.md。运行：`npm start`；测试：`npm test`。

Dify 输入：hot_link、hot_title、product_info、previous_title、feedback、ip_blacklist。
输出兼容正常分支 title/keywords 与重写分支 rewritten_title/rewritten_keywords。
Dify 密钥只存服务端环境变量 DIFY_API_KEY。

登录页按用户要求保留模拟功能。当前公开演示不依赖真实登录，付费生成接口有单实例限流与并发约束。
