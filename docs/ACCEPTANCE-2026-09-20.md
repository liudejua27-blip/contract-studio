# 2026-09-20 真实模型与部署检查

## 本轮结果

- DeepSeek 密钥配置存在，官方模型列表 HTTP 200，包含 deepseek-v4-pro。未输出密钥。
- 第一次真实生成在 45 秒时超时；区分模型超时和网络连接失败，默认及本地配置等待时间改为 180 秒。
- 生成请求启用 JSON 输出，finish_reason=length 时拒绝保存，避免把截断响应当完整草稿。
- 修复后真实生成耗时 46.5 秒，产生 12,109 字节 DOCX，提取正文确认双方测试公司名称、20000 元和待补充项。未进行专业法律质量认证。
- 通过网站 HTTP 接口登录、创建合同、真实生成并保存、下载校验 SHA-256、提交准确版本审核，全部通过。真实接口生成耗时 29 秒。见 deepseek-http-results.json。
- 全量测试 24/24，0 跳过；生产构建通过；原有 12 项 HTTP 流程检查通过。

## 目标判断

本地技术闭环可用，整体目标未完成。待完成：云端运行适配及部署、线上多账号与文件访问验收、专业律师质量评估、更多异常恢复场景。

## Sites 部署状态

已通过 Sites 创建私有站点，project_id 保存于 .openai/hosting.json。尚未上传源代码、配置密钥、保存部署版本或发布，因此没有可使用的部署网址。不得把 expected_url 当成功上线证据。下一次必须复用该 project_id，不能重复创建。

经 Sites 技能和代码核对，当前不是可直接上传的 Cloudflare Worker 包：

1. Next.js 当前产物是 .next-build，不是 Sites 要求的 Worker fetch 入口。
2. pg 使用 PostgreSQL TCP 和交互式事务/行锁，Sites 禁止 raw TCP。需迁移 D1 并重做原子操作，或保留经过 HTTP 接口连接的独立后端，不能把 PostgreSQL 语法直接改字符串后声称兼容。
3. S3_ENDPOINT 指向 127.0.0.1:59000 的本地 MinIO。应改为 Sites R2 或可达的私有对象存储。
4. ONLYOFFICE_URL 指向 127.0.0.1:8081。Sites 不运行该文档服务容器，需公网 HTTPS 文档服务及其合法授权，或经用户同意暂用已有下载修改后上传流程。
5. 私有 Sites 的外层访问控制是否允许独立文档服务读取签名文件和提交回调，需上线后专门确认，不能假定 JWT 自动穿透平台登录。

已询问用户是否有公网 ONLYOFFICE 或接受首版下载修改后上传，答复尚未收到。不以静态展示页替代合同应用上线。

## 参考

- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion/
- DeepSeek JSON output: https://api-docs.deepseek.com/guides/json_mode/
- Sites 托管技能：本地插件 sites-hosting/SKILL.md。
