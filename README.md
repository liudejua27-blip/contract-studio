# 合同工作室

轻量合同网站：用户描述生意并生成初稿，提交核心诉求后确定一位负责律师；由同一位律师沟通、完善合同并交付成品。交付后仍可联系原律师，进一步法律服务另行沟通。客户端、律师工作台和管理页共用 Next.js 应用及 PostgreSQL。文档由 `docx` 生成，实际 DOCX 由 `docx-preview` 预览，在线编辑接入 ONLYOFFICE；私有对象存储支持 S3/MinIO。

## 本地启动

```sh
npm ci
cp .env.example .env.local
# 在本机编辑 .env.local，配置数据库、会话密钥、私有存储、模型和编辑器。
node --env-file=.env.local --import tsx scripts/setup.ts
node --env-file=.env.local --import tsx scripts/local-accounts.ts
npm run dev
```

打开 <http://127.0.0.1:3210>。本地初始化脚本生成用户、律师和管理员测试账号，凭据仅写入忽略的 `.data/local-accounts.json`（权限 0600），不输出到终端。脚本拒绝覆盖现有账号。正式环境请通过受控的管理员引导流程创建首个账号，不使用开发引导脚本。

`NEXT_PUBLIC_*` 中不得存放密钥。`.env.local`、私有文件、测试凭据、数据库与对象存储数据都不得提交 Git。

## 用户流程

1. 用户登录，描述业务与约定；AI 每轮只问 1–3 个必要的生意问题，确认交易摘要后创建实际 Word。专业条款采用独立的系统规则，留给律师审核。
2. 律师审核前即可预览、下载 AI 初稿、继续提出修改要求；页面明确标注审核状态。每次生成均保存为新版本。
3. 指定版本、审核立场和关注事项，提交审核；平台管理员分配律师。
4. 律师在工作台查看需求与原始记录，在线修改，或上传本地修改后的 DOCX。
5. 必要时向用户请求补充信息；用户在审核页面回复。
6. 律师确认最新文档已保存，填写交付说明，交付明确的审阅版本。
7. 用户下载律师交付的原始 Word，可确认收到，或针对该交付版提出修改意见并开启新一轮律师审核；已交付版本保持不变。“确认收到”不代表合同签署。

## 合同类型

对话起草已接入 12 类：软件开发、一般服务、采购、保密、房屋租赁、设备租赁、设计、摄影摄像、营销推广、咨询、SaaS 订阅、事务委托。各类分别配置必需交易事实、条款、附件和律师关注项。劳动、股权投资、建设工程、融资担保、跨境及受监管业务先转律师需求咨询，不硬套通用合同。来源和验证范围见 [类型扩展记录](docs/CONTRACT-TYPE-EXPANSION.md)。

## 真实模型与示例

Pi Agent Core 在服务端负责有限次数的工具循环，沿用 OpenAI-compatible Chat Completions 接口和现有 DeepSeek 配置：`CONTRACT_AI_BASE_URL`、`CONTRACT_AI_MODEL`、`CONTRACT_AI_API_KEY`。交易事实、系统默认条款和律师待审事项分别保存。模型失败或结构不合法时不会降级为“成功合同”。

服务器版使用完整 Pi SDK、PostgreSQL 和私有 S3。任务在后台持久化执行，关闭页面后仍可继续，多进程共享并发上限和会话检查点；支持按待处理任务量自动增减执行进程。部署与配置见 [服务器并发与扩容](docs/SERVER-CONCURRENCY.md)。

只支持 Node 服务器版。`npm run build` 构建网页、完整 Pi SDK 后台和运维程序；Sites 兼容代码与副构建已删除。配置、备份恢复、账号维护和发布检查见 [服务器生产运行手册](docs/SERVER-PRODUCTION.md)。

本地开发可设置 `CONTRACT_DEMO_MODE=true`，再由用户显式勾选“示例体验”。示例使用固定结构和需求原文，不调用模型，版本 source 标记为 `demo`，仅供技术流程验收。生产环境禁用该模式。

## 验证

```sh
npm run check:release
# 另行演练备份恢复，需临时建库权限和匹配的 PostgreSQL 命令行工具：
npm run test:backup
```

发布检查使用临时数据库 schema、独立 Node worker、本地模型和存储替身，验证实际构建的完整起草与审核交付流程，不消耗模型额度，不做 100 用户压测。浏览器和真实服务器验收另行进行。

## 文档

- `docs/API-CONTRACT.md`：接口约定。
- `docs/DESIGN.md`：视觉基准与必要功能偏差。
- `docs/ONLYOFFICE.md`：编辑器安全集成和文件保存。
- `docs/DEPENDENCIES.md`：GitHub 复用、许可证与环境证据。
- `docs/ACCEPTANCE.md`：完整需求验收状态。

ONLYOFFICE Document Server 的 AGPL/商业集成授权需要按最终商业部署方式确认；React 组件授权不能替代服务端授权。未完成真实模型、律师质量评估和部署验收前，不应作为已上线服务宣传。

当前模型配置（2026-09-22）：Node 完整 Pi SDK 默认使用 `deepseek-flash`，需求理解、起草、核对共用此配置，不自动升级或回退到 Pro。部署时显式设置的 `CONTRACT_AI_MODEL` 优先于代码默认值；本次配置修改尚未部署。

所有模型阶段默认启用 Flash Thinking `high`（`CONTRACT_AI_THINKING=enabled`、`CONTRACT_AI_REASONING_EFFORT=high`），包括需求理解。Pi 推理档位映射到 DeepSeek 请求参数，工具循环保留服务端思考内容，不向用户展示隐藏推理。
