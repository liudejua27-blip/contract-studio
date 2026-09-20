# 合同工作室

轻量合同网站：用户对话起草并下载 Word，平台分配律师，律师审阅、补充沟通和交付指定版本。客户端、律师工作台和管理页共用 Next.js 应用及 PostgreSQL。文档由 `docx` 生成，实际 DOCX 由 `docx-preview` 预览，在线编辑接入 ONLYOFFICE；私有对象存储支持 S3/MinIO。

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

1. 用户登录，描述业务与约定；AI 追问必要信息，点击“生成合同草稿”创建实际 Word。
2. 预览、下载、继续提出修改要求。每次生成均保存为新版本。
3. 指定版本、审核立场和关注事项，提交审核；平台管理员分配律师。
4. 律师在工作台查看需求与原始记录，在线修改，或上传本地修改后的 DOCX。
5. 必要时向用户请求补充信息；用户在审核页面回复。
6. 律师确认最新文档已保存，填写交付说明，交付明确的审阅版本。
7. 用户下载律师确认的原始文件字节。此后 AI 改写会生成新的未审核草稿，不改变已交付文件。

## 真实模型与示例

模型在服务端调用 OpenAI-compatible Chat Completions 接口，配置 `CONTRACT_AI_BASE_URL`、`CONTRACT_AI_MODEL`、`CONTRACT_AI_API_KEY`。只配置密钥不代表连通或质量已验证。模型失败或结构不合法时不会降级为“成功合同”。

本地开发可设置 `CONTRACT_DEMO_MODE=true`，再由用户显式勾选“示例体验”。示例使用固定结构和需求原文，不调用模型，版本 source 标记为 `demo`，仅供技术流程验收。生产环境禁用该模式。

## 验证

```sh
npm run typecheck
npm test
npm run build
# 本地服务运行且测试账户已初始化时：
node scripts/smoke.mjs
```

HTTP smoke 创建独立测试合同，检查角色隔离、真实 DOCX 下载、送审冻结、分配、补充沟通、交付字节一致和交付后的新草稿。它不代表真实 AI 或专业律师法律质量验收。浏览器验收需另外检查桌面、手机、在线编辑和保存回调。

## 文档

- `docs/API-CONTRACT.md`：接口约定。
- `docs/DESIGN.md`：视觉基准与必要功能偏差。
- `docs/ONLYOFFICE.md`：编辑器安全集成和文件保存。
- `docs/DEPENDENCIES.md`：GitHub 复用、许可证与环境证据。
- `docs/ACCEPTANCE.md`：完整需求验收状态。

ONLYOFFICE Document Server 的 AGPL/商业集成授权需要按最终商业部署方式确认；React 组件授权不能替代服务端授权。未完成真实模型、律师质量评估和部署验收前，不应作为已上线服务宣传。
