# Contract Studio 验收清单

核查时间：2026-09-18（Asia/Shanghai）。本清单按“本机检查、实现测试、浏览器验收、部署、线上验收”分层；某一层通过不代表其他层已通过。

状态含义：

- `已验证`：本次有可复现命令或明确输出证据。
- `待执行`：范围已定义，但本次没有运行，不能当作通过。
- `受阻`：缺少配置、实现或外部条件，需要补齐后再测。
- `失败`：已执行并得到失败结果，必须记录原因和修复。

## 当前环境证据

| 编号 | 检查 | 状态 | 证据 |
| --- | --- | --- | --- |
| ENV-01 | Node/npm/Docker 可用 | 已验证 | Node `22.23.2`、npm `10.9.8`、Docker Client/Server `29.6.0/29.5.2` |
| ENV-02 | 专用 PostgreSQL 可连接 | 已验证 | `pg_isready -h 127.0.0.1 -p 5432` 接受连接；`contract_studio` 已创建，`current_database()` 正确，公共 schema 0 张表 |
| ENV-03 | 既有 ONLYOFFICE 健康与容器到应用网络 | 已验证（网络可达） | 容器 `contract-review-onlyoffice` healthy；`curl http://127.0.0.1:8081/healthcheck` 返回 `true`；从该容器访问宿主机 `http://host.docker.internal:3210/api/capabilities` 返回 HTTP 200。该 200 只证明网络可达，不代表保存回调闭环通过 |
| ENV-04 | MinIO 私有对象存储可用 | 已验证 | `contract-studio-minio-1` 仅绑定 `127.0.0.1:59000/59001`；`/minio/health/live` 返回 200；`contract-studio` bucket 已创建；匿名访问返回 403；认证对象 put/get hash roundtrip 通过并清理 probe |
| ENV-05 | live 模型可用 | 受阻 | 当前进程和项目根没有发现模型环境变量或 `.env`；需用户配置模型变量后才能测 live |
| ENV-06 | 应用依赖已安装、lockfile 固定 | 已验证（本地） | `npm ls postcss` 为 `8.5.28 overridden`，`npm audit --omit=dev` 为 0；`npm run typecheck` 通过，`npm test` 13/13 通过，`npm run build` 通过；仍需在干净环境复跑 `npm ci` 后再作部署验收 |

## 已有 API smoke 证据

`docs/api-smoke-results.json`（2026-09-18 09:33:44Z）记录了 12 个已执行检查，结果为 `passed`：三种角色登录和持久 session、注册防自提权、合同/版本下载权限、demo DOCX 与 hash、审核版本冻结及重复任务防护、管理员分配、律师开始、补充信息往返、伪 DOCX 拒绝、精确律师文件交付和交付后新草稿、登出撤销 session。该报告明确记录 live AI 未配置/未执行，ONLYOFFICE 需要独立浏览器验收；以下条目只在对应范围内标记 smoke 证据。

此前一次源码过渡状态的 `npm run typecheck` 曾失败；父代理修正后当前复跑已通过。依赖审计已在主代理加入 `postcss` 8.5.28 override 后清零，但这不替代 `npm ci` 和生产构建。

## 配置门槛

在 `live` 模式前，用户必须通过秘密管理或本地未提交 `.env` 配置以下项目：

1. `CONTRACT_AI_API_KEY`（或 `OPENAI_API_KEY`）、`CONTRACT_AI_BASE_URL`（或 `OPENAI_BASE_URL` / `OPENAI_API_BASE_URL`）、`CONTRACT_AI_MODEL`（或 `OPENAI_MODEL`）：模型密钥、兼容 API 根地址和模型名。当前代码默认调用 `/chat/completions`。
2. `DATABASE_URL`：指向专用 `contract_studio`，不能指向既有业务数据库。
3. `CONTRACT_SESSION_SECRET`（或 `SESSION_SECRET`）：会话和当前 OnlyOffice scoped token 使用的签名密钥；生产必须是至少 32 字节的本地秘密。
4. `CONTRACT_STORAGE_DRIVER`、`CONTRACT_PRIVATE_STORAGE_DIR`：本地开发文件模式。若使用 S3/MinIO，代码以 `S3_BUCKET` 是否存在选择 S3，并由 AWS SDK 默认凭据链读取 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`，而不是 `S3_ACCESS_KEY_ID`。当前本机已创建私有 `contract-studio` bucket 并通过认证 roundtrip；应用端写入仍需随 API 闭环复验。
5. `ONLYOFFICE_URL` 和 `NEXT_PUBLIC_APP_URL`（启用在线编辑时）。现有服务的 JWT secret 未写入文档，需要通过本机秘密渠道配置；当前实现的 scoped token 由 `CONTRACT_SESSION_SECRET` 签发，必须与启用 JWT 的 DocumentServer 集成验证。

未配置模型时只能验收 `demo` 模式。Demo 必须在页面、接口回执和版本 `source` 中显式标记，不能冒充真实模型结论。

## P0 业务闭环

下列场景全部通过，才能称为“第一版闭环可演示”。每一项都要保留请求、响应、版本 ID、角色和时间证据。

| 编号 | 验收场景 | 通过条件 | 状态 |
| --- | --- | --- | --- |
| API-01 | 登录、登出和 session | `GET /api/session` 只返回当前用户；登出后失效；密码不出现在日志/响应 | 已验证（API smoke） |
| API-02 | 角色边界 | 客户、律师、管理员访问范围分别符合契约；普通注册不能自提权；用户只能看自己的合同，律师只能看分配任务 | 已验证（API smoke） |
| API-03 | 新建合同 | `POST /api/contracts` 创建空合同，owner 正确，初始版本为空或按约定返回 | 待执行 |
| API-04 | 对话持久化 | `POST /api/contracts/:id/chat` 同时持久化 user/assistant 消息；生成失败不能伪造新版本 | 待执行 |
| API-05 | 追问与缺失信息 | 模型/DEMO 不编造名称、金额、日期或立场；可以生成带待补充标记的草稿 | 待执行 |
| API-06 | 生成与下载 | `generate=true` 创建不可变 Version 和 DOCX；`GET /api/files/:versionId` 返回对应 bytes；版本 hash 可复核 | 已验证（API smoke） |
| API-07 | Demo/live 边界 | Demo 来源明显；live 只在完整模型配置下调用；模型未配置时返回明确配置缺失而非静默降级 | 已验证 demo；live 受阻 |
| API-08 | 提交审核冻结 | 提交时冻结指定 version、代表立场、concerns 和之前需求摘要；同一合同不能重复创建 open review | 已验证（API smoke） |
| API-09 | 分配与开始 | 只有管理员能分配；只有被分配律师能 start；未分配任务不能被其他律师打开 | 已验证（API smoke） |
| API-10 | 审核沟通 | 律师 `requestInfo` 将状态置为 `need_info`；用户回复后回到 `reviewing`；消息按 review 隔离 | 已验证（API smoke） |
| API-11 | 律师上传审阅版 | 只有 assigned lawyer 能上传；上传生成 immutable review Version，保留原始提交版，并更新 `editingVersionId` / save 状态 | 待执行 |
| API-12 | 确认交付 | `complete` 只接受已保存的当前 review Version；有 pending/error editor save、版本不匹配或缺失 delivery note 时拒绝 | 已验证（API smoke；非 OnlyOffice 回调） |
| API-13 | 最终下载 | 客户下载到的 bytes 与律师确认版本 hash 相同；AI JSON 不能覆盖律师 DOCX | 已验证（API smoke） |
| API-14 | 重复/并发操作 | 重复提交、重复分配、重复完成、重复上传不会产生错误版本或错误状态；并发保存有清晰失败回执 | 待执行 |
| API-15 | 数据隔离 | 使用两个客户、两个律师和管理员的测试账号互相访问；越权请求返回正确 401/403/404，不泄露存在性 | 已验证（API smoke 覆盖未分配律师/无关客户） |

## ONLYOFFICE 与文件安全

| 编号 | 验收场景 | 通过条件 | 状态 |
| --- | --- | --- | --- |
| OO-01 | 配置 token | `documentServerUrl` 可达；短期 scoped token 绑定用户、合同、review、version、session 和过期时间；当前实现把 scoped token 放在文档/回调 URL 查询参数中，需完成访问日志、Referer 和浏览器缓存控制审查后才能接受 | 待执行 |
| OO-02 | 打开文档 | assigned lawyer 可打开指定审阅版；客户只获得只读/预览配置；他人无法打开 | 待执行 |
| OO-03 | 保存回调 | callback URL 可从 DocumentServer 容器访问；服务验证签名、版本和角色后保存；未知 token/版本被拒绝 | 待执行 |
| OO-04 | 保存状态 | 回调中 `pending`、`saved`、`error` 状态准确反映；网络断开或保存失败不显示“已保存” | 待执行 |
| OO-05 | 版本回读 | 浏览器保存后重新打开、刷新和下载，正文、批注/修订策略和 hash 与服务端一致 | 待执行 |
| OO-06 | 旧版本保护 | 旧 AI 草稿、原始提交版和已交付版可追溯；律师上传/保存不会覆盖历史文件 | 待执行 |
| OO-07 | 文件类型和大小 | 只接受约定的 DOCX；大小、压缩包路径、恶意文件和内容类型检查有失败证据 | 待执行 |

现有 ONLYOFFICE 在 `127.0.0.1:8081`，但容器回调宿主机应用时不能使用容器内的 `127.0.0.1`。宿主机开发需用 Docker 可达的回调地址（macOS 通常为 `host.docker.internal`），并让应用监听容器可达地址。当前实现用 `APP_BASE_URL` 服务浏览器 CSRF，同时从 `OO_CALLBACK_BASE_URL` 读取回调基址；不能把 `APP_BASE_URL` 直接改成 `host.docker.internal`，否则浏览器 API 的 CSRF origin 会失败。容器到 `/api/capabilities` 已有 200 网络证据，但还没有一次真实 OnlyOffice 保存回调证据；此外 force-save 命令需要核对现有服务的 JWT `Authorization` 要求。

## 认证、权限与回调安全专项（静态检查）

这些条目是代码审查结论，不把静态检查冒充攻击测试或线上验收。

| 编号 | 检查 | 状态 | 证据与后续 |
| --- | --- | --- | --- |
| AUTH-01 | 密码哈希和比较 | 已确认（静态） | `auth.ts` 使用随机 16 字节 salt、scrypt `N=16384,r=8,p=1`、64 字节派生值和 `timingSafeEqual`；生产仍需限流和异常监控 |
| AUTH-02 | session 持久化、撤销和 disabled | 已确认（静态/API smoke） | JWT 只携带 `sid/sub` 等声明；数据库保存 SHA-256 token hash；每次请求检查 session 过期/撤销、用户 disabled，并以数据库 role 为准。当前禁用用户不会撤销其 session 行，但请求会立即拒绝；重新启用后旧 cookie 仍可能恢复，需禁用时批量撤销 |
| AUTH-03 | 登录/注册限流 | 已实现（函数/本地 DB probe） | `rate-limit.ts` 使用 PostgreSQL 窗口，不依赖进程内计数；按规范化 email 建全局桶，并在传入来源标识时增加 email+source 和 source 桶。正式迁移仍需把 `AUTH_RATE_LIMIT_SCHEMA_SQL` 追加 `scripts/setup.ts`；route 需传可信代理解析后的来源标识 |
| AUTH-04 | 管理员禁用保护 | 已实现（route 参数待合并） | `updateUser(id, input, actorId?)` 在事务内锁定目标、禁用时撤销 active sessions，阻止传入 `actorId` 的自禁用和最后 active admin 禁用；`PATCH` route 必须传当前 `auth.user.id` |
| AUTH-05 | 密码哈希编码参数边界 | 已实现（静态/单测） | `verifyPassword` 只接受本服务的 `N/r/p`、16 字节 salt、64 字节派生值和安全 base64url 编码，并限制 scrypt 内存计算量 |
| AUTH-06 | 变更请求 CSRF | 部分确认 | POST 路由有 Fetch-Site/Origin 检查；`PATCH /users/:id` 未复用同一 guard；OnlyOffice callback 豁免是设计要求，但仍需独立请求体大小上限 |
| AUTH-07 | OnlyOffice 回调授权链 | 待执行（静态部分通过） | 已有 DS JWT、短期 callback token、角色/session/version 绑定、可信下载 origin、私网解析阻断、大小/DOCX 校验和内容寻址对象；实际 DS callback、重放、过期/错版本及 force-save 仍未完成浏览器/容器验收 |

## 界面与恢复

| 编号 | 验收场景 | 通过条件 | 状态 |
| --- | --- | --- | --- |
| UI-01 | 客户首次进入 | 主要入口直接引导“说说你需要签一份什么合同”；示例仅帮助开始，不限制合同类型 | 待执行 |
| UI-02 | 客户工作区 | 生成前只显示聊天；生成后显示实际 DOCX 预览；“AI 草稿，未经律师审核”清楚可见 | 待执行 |
| UI-03 | 客户移动端 | 对话/合同可切换，不强行挤三栏；草稿、审核中、待补充、律师已交付状态可理解 | 待执行 |
| UI-04 | 律师待办 | 首页展示合同、用户立场、提交时间、状态、操作；管理员分配和固定律师策略可见 | 待执行 |
| UI-05 | 律师审阅 | 宽文档、窄侧栏；用户需求、原始对话、补充信息、审核记录都无需反复跳页 | 待执行 |
| UI-06 | 断线恢复 | 刷新、网络失败、保存失败、重复点击不会丢消息/草稿或伪造完成状态 | 待执行 |
| UI-07 | 需求版本 | 审核期间补充信息进入 review 沟通，不覆盖冻结提交版本；交付后 AI 改写产生未审核新草稿 | 待执行 |

## 执行顺序与命令

本次只启动了父代理明确授权的 loopback MinIO；没有启动 Compose PostgreSQL 或新的 ONLYOFFICE。应用实现完成后按下列顺序补证据：

```bash
# 依赖配置静态检查，不启动服务
docker compose --env-file .env.example config --quiet

# 本机依赖检查
pg_isready -h 127.0.0.1 -p 5432
curl -fsS http://127.0.0.1:8081/healthcheck
curl -fsS http://127.0.0.1:59000/minio/health/live
psql -h 127.0.0.1 -p 5432 -d contract_studio -Atqc 'select current_database()'

# 应用完成后，由主代理运行
npm ci
npm ls postcss
npm audit --omit=dev
npm run typecheck
npm test
npm run build

# 浏览器/OnlyOffice 回归需在服务启动并配置后运行；结果单独记录为浏览器验收
```

当前 `npm run typecheck` 通过，`npm test` 13/13 通过，`npm run build` 通过，依赖 `npm audit --omit=dev` 为 0；`npm ci` 尚未在干净环境执行，真实模型质量评估和浏览器/ONLYOFFICE 交互尚未执行。不能因为静态 Compose、依赖 audit=0、构建通过或容器健康就标记线上验收完成。部署、线上验收、真实律师评估和公开发布均无证据。

## 2026-09-19 增量验收

- 已在真实浏览器验证管理页：当前管理员自停用被拒绝并显示中文提示；仅针对既有隔离测试用户执行停用后显示“已停用”，重新启用恢复“正常”。
- Admin UI 支持账户状态及启停操作，分配选项排除停用律师。
- 路由已接 actorId、显式可信代理来源、PATCH CSRF 和回调请求体上限；对应 HTTP handler 单测通过。上文 AUTH-03/04/06 的“路由待接入”描述为历史记录，现已补齐。
- 本轮普通 npm test 的 13 pass / 1 skip 不包括 DB 隔离执行；DB 隔离另由带 .env.local 的测试命令实际通过。
- 用户已选择 DeepSeek，配置样例改为官方 API 与 deepseek-v4-pro；API 密钥尚未配置，真实生成与律师质量评估仍未执行。
- 在线编辑连接失败增加重新连接入口；真实编辑保存仍需继续验收。
