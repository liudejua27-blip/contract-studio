# 运行环境与复用依赖

核查时间：2026-09-18（Asia/Shanghai）。本文件记录的是本机观察到的状态和公开上游资料，不把“仓库存在”或“包能安装”当作端到端可用。

## 本机运行环境

| 项目 | 已观察状态 | 连接方式或限制 |
| --- | --- | --- |
| Node.js | `v22.23.2` | 可运行 Next.js 开发和构建命令 |
| npm | `10.9.8` | `package-lock.json` 和 `node_modules` 已存在；当前 `npm ls postcss` 显示 `8.5.28 overridden`，`npm audit --omit=dev` 返回 0；`npm run typecheck`、`npm test`（13/13）和 `npm run build` 已通过；`npm ci` 仍需在干净环境复跑 |
| Docker | Client `29.6.0` / Server `29.5.2` | Docker daemon 可用；既有 ONLYOFFICE 未改动，按父代理授权启动了 loopback MinIO；没有启动 Compose PostgreSQL 或新的 ONLYOFFICE |
| PostgreSQL | 本机 `127.0.0.1:5432`，`pg_isready` 接受连接；服务器版本 `17.10` | 已创建专用空数据库 `contract_studio`；公共 schema 当前 0 张表。没有修改已有数据库或服务 |
| ONLYOFFICE Docs | 容器 `contract-review-onlyoffice`，镜像 `onlyoffice/documentserver:9.3.1.2`，状态 `healthy` | 仅绑定 `127.0.0.1:8081 -> 80`；`GET /healthcheck` 返回 `true`。容器启用 JWT，使用 `Authorization` 请求头；JWT secret 仅安全复制到未提交的 `.env.local`，没有写入仓库、日志或本文件 |
| MinIO | `contract-studio-minio-1` 已按协调启动，状态 running | 仅绑定 `127.0.0.1:59000` API / `59001` Console；`/minio/health/live` 返回 200；`contract-studio` bucket 匿名访问 403，认证 put/get roundtrip 通过并清理 probe |
| 模型配置 | 当前进程没有发现 `OPENAI`、`ANTHROPIC`、`DEEPSEEK`、`QWEN`、`DASHSCOPE`、`MODEL`、`LLM` 或 `AI_` 前缀环境变量；项目根没有 `.env` 文件 | live 模型不可验收。只记录变量名是否存在，没有扫描文件系统或输出任何 secret |

专用 PostgreSQL 的两种连接方法：

```text
# 已验证的宿主机 PostgreSQL
postgresql://127.0.0.1:5432/contract_studio

# 若由 compose 的 infra profile 启动独立 PostgreSQL，宿主机端口为 55432；密码来自本地 .env，不能写入文档
postgresql://contract_studio:<POSTGRES_PASSWORD>@127.0.0.1:55432/contract_studio
```

应用进程在宿主机运行时使用 `127.0.0.1:5432`；应用若也容器化，应使用 Compose 服务名 `postgres:5432`，不要把宿主机的 `5432` 映射为新服务。现有 `contract_review` 等数据库仅作环境盘点，不能复用。

## ONLYOFFICE 的安全连接方法

现有服务可以由浏览器访问：

```text
documentServerUrl = http://127.0.0.1:8081
healthcheck       = http://127.0.0.1:8081/healthcheck
```

ONLYOFFICE 文档服务在容器内回调应用。若 Next.js 在宿主机运行，回调地址应使用宿主机可达地址，例如 macOS Docker 的 `http://host.docker.internal:3210`，并确保应用监听容器可达的地址。当前 `src/server/contracts.ts` 优先读取 `ONLYOFFICE_DOCUMENT_BASE_URL` 生成文档地址，优先读取 `ONLYOFFICE_CALLBACK_BASE_URL`（兼容 `OO_CALLBACK_BASE_URL`）生成回调地址；浏览器仍使用 `APP_BASE_URL`，不能把它直接改成 `host.docker.internal`，否则 CSRF origin 会失败。开发环境还要把 `host.docker.internal` 放入 `ONLYOFFICE_ALLOW_PRIVATE_HOSTS`，否则 HTTP 私网 origin 会被配置校验拒绝；生产应使用 HTTPS。已从既有 ONLYOFFICE 容器访问宿主机 `/api/capabilities` 得到 HTTP 200，证明网络可达，但仍不能替代一次实际保存回调验收。

现有容器的 JWT secret 未写入仓库、日志或本文件；本机 `.env.local` 中仅保留运行所需的未提交值。应用要么通过本机秘密管理拿到与现有容器一致的 secret 并签发短期配置 token，要么在得到协调后启动 Compose 中独立的 ONLYOFFICE 服务并使用其独立 secret。文档 URL、回调 URL 和 token 都必须是窄权限、短期、按版本绑定的值，不能暴露永久公开链接。

## Compose 提供的可选服务

[`compose.yaml`](../compose.yaml) 只包含本地依赖，不包含应用镜像。所有服务均需显式 profile 才会启动：

| Profile | 服务 | 宿主机端口 | 容器内连接 |
| --- | --- | --- | --- |
| `infra` | PostgreSQL | `127.0.0.1:55432` | `postgres:5432` |
| `infra` | MinIO API / Console | `127.0.0.1:59000` / `127.0.0.1:59001` | `minio:9000` / `minio:9001` |
| `onlyoffice` | ONLYOFFICE Docs | `127.0.0.1:8082` | `onlyoffice:80` |

`8082` 特意避开当前已运行的 `8081`。本次只按协调启动了 `minio` 服务，未启动 Compose PostgreSQL 或新的 ONLYOFFICE；启动前后均使用 `docker compose ... config --quiet` 做静态校验。

## GitHub 复用核实

以下资料由 GitHub CLI 公共 API 和 npm registry 在核查时间读取。版本是当时可见版本，升级前仍需跑项目的安装、类型检查、构建和浏览器验收。

| 组件 | 当前项目声明 | 上游核实结果 | API / 复用边界 |
| --- | --- | --- | --- |
| [`assistant-ui/assistant-ui`](https://github.com/assistant-ui/assistant-ui) | `@assistant-ui/react` `^0.11.0` | 仓库 SPDX `MIT`；npm `@assistant-ui/react` `0.15.20`，MIT | 官方 README 展示 `AssistantRuntimeProvider`、`useChatRuntime` 和自定义 runtime 适配；复用 React 组件和 runtime API，不复制整站或其托管云服务 |
| [`dolanmiu/docx`](https://github.com/dolanmiu/docx) | `docx` `^9.5.1` | 仓库 SPDX `MIT`；npm / GitHub 最新 release `9.7.1`，MIT | 用其 JS/TS `Document` / `Packer` 生成 DOCX；生成内容仍需做中文排版、版本 hash 和回读验收 |
| [`ONLYOFFICE/document-editor-react`](https://github.com/ONLYOFFICE/document-editor-react) | `@onlyoffice/document-editor-react` `^2.0.0` | 仓库 SPDX `Apache-2.0`；npm / GitHub 最新 release `2.2.0` | React 组件需要 `documentServerUrl` 和 `config`；官方 README 明确 `editorConfig.callbackUrl` 是保存功能所需。组件不是文档服务本身 |
| [`ONLYOFFICE/DocumentServer`](https://github.com/ONLYOFFICE/DocumentServer) | 本机镜像 `9.3.1.2` | 仓库 SPDX `AGPL-3.0`；GitHub 最新 release `v9.4.0`；社区版 AGPL，Enterprise/Developer 为专有许可 | 闭源商业集成在生产前必须由负责人完成许可选择和法务确认；不能因 React wrapper 是 Apache-2.0 就推断 Document Server 也是 Apache/MIT |
| [`minio/minio`](https://github.com/minio/minio) | 首次拉取 Docker Hub tag 被拒；Quay `latest` 多架构 manifest digest 已核实，Compose 固定该 digest | GitHub SPDX `AGPL-3.0`；公开仓库当前标记为 archived，GitHub 最新可见 release `RELEASE.2025-10-15T17-29-55Z`；Quay `latest` manifest `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` | 仅作为可替换的本地 S3 兼容存储草案；生产许可和版本需另行确认 |

以上复用均只取公开 API、组件和许可证信息，没有把 `contract-review` Vue 项目整套复制到 Next.js；Vue 项目只能作为交互/流程参考，具体业务权限、版本冻结、律师分配和交付状态以本项目 API 契约为准。

## 安装与安全注意事项

- 当前 `package.json` 声明的包版本和上游最新版本不完全一致。升级 `assistant-ui`、`docx`、ONLYOFFICE wrapper 或 Next.js 前，应由主代理更新 lockfile 并跑 `typecheck`、`build`、API 测试和浏览器验收。
- 当前 `package-lock.json` 是 Next `15.5.25`，根 `package.json` 已加入 `overrides.postcss=8.5.28`；本机 `npm ls postcss` 显示 `next@15.5.25 -> postcss@8.5.28 overridden`，`npm audit --omit=dev` 返回 `found 0 vulnerabilities`。这解决了 PostCSS `<=8.5.22` 的已知审计项，不需要为此直接跳到 Next 16；当前 `typecheck`、13 项单测和生产构建已通过，正式交付前仍需在干净依赖状态运行 `npm ci` 并重跑这些检查。
- 认证限流已放在 `src/server/rate-limit.ts`：它以哈希后的规范化 email 和可选来源标识写入 PostgreSQL `auth_rate_limits`，默认 15 分钟窗口，避免仅使用 serverless 进程内内存。`AUTH_RATE_LIMIT_SCHEMA_SQL` 需要由后端在 `scripts/setup.ts` 的正式迁移中追加；route 还要将可信代理解析后的来源标识传给 `login(input, { sourceIdentifier })` 和 `registerClient(input, { sourceIdentifier })`。
- `CONTRACT_AI_API_KEY`（或 `OPENAI_API_KEY`）、`CONTRACT_SESSION_SECRET`、`AWS_SECRET_ACCESS_KEY`、`ONLYOFFICE`/JWT 相关密钥只能写入本地未提交的 `.env` 或秘密管理器；不要复制到聊天、截图、Git、测试 fixture 或文档。
- `CONTRACT_DEMO_MODE=true` 时必须在 UI 和 API 回执中明确是 demo 来源；没有完成模型配置和真实样例评估前，不能把 demo 结果写成 live 模型质量证据。
