# OnlyOffice 集成约定

合同工作室只把 ONLYOFFICE 当作律师工作台的编辑器。合同原始草稿、律师审核版本和最终交付版本都由服务端版本表与私有对象存储控制；浏览器拿到的编辑器配置和文件 URL 都是短期、用途受限的签名 URL。

## 服务端配置

生产环境至少设置以下变量：

```text
ONLYOFFICE_DOCUMENT_SERVER_URL=https://office.example.com
ONLYOFFICE_JWT_SECRET=长度不少于32字节的随机值
APP_BASE_URL=https://contracts.example.com
ONLYOFFICE_TRUSTED_DOWNLOAD_ORIGINS=https://contracts.example.com
S3_BUCKET=private-contracts
S3_REGION=...
```

开发环境若 Document Server 通过 Docker 主机名访问本机服务，必须逐个列出允许的主机名：

```text
ONLYOFFICE_ALLOW_PRIVATE_HOSTS=host.docker.internal,127.0.0.1
```

这只在非 production 环境放行对应的 HTTP origin 和下载地址；不会接受任意私网主机名。
生产环境仍要求 HTTPS。生产自托管私有地址可通过同一精确 allowlist 绕过 DNS 私网拒绝，
但仍须命中 `ONLYOFFICE_TRUSTED_DOWNLOAD_ORIGINS`，并由部署方承担该地址的网络隔离。

`ONLYOFFICE_DOCUMENT_SERVER_URL` 和 `APP_BASE_URL` 必须是 HTTPS origin。开发环境可以使用 `http://localhost`，但应把该例外限制在本机。对象存储生产环境使用 S3 或兼容 S3 的私有桶；本地 private filesystem 只作为开发与测试 fallback，生产环境没有 `S3_BUCKET` 时启动应失败。

OnlyOffice Document Server 的 JWT secret 必须与 `ONLYOFFICE_JWT_SECRET` 一致。Document Server 的许可证、AGPL 或商业 Developer Edition 选择属于部署方决策，React 组件本身不包含 Document Server 授权。

## 编辑器配置接口

backend 的
`GET /api/contracts/:contractId/reviews/:reviewId/editor` 返回：

```json
{
  "data": {
    "documentServerUrl": "https://office.example.com",
    "config": {
      "document": {
        "fileType": "docx",
        "key": "sha256-derived-document-key",
        "title": "合同-v2.docx",
        "url": "https://contracts.example.com/api/files/onlyoffice?token=...",
        "permissions": { "edit": true, "download": true, "print": true }
      },
      "documentType": "word",
      "editorConfig": {
        "mode": "edit",
        "callbackUrl": "https://contracts.example.com/api/onlyoffice/callback?token=...",
        "customization": { "forcesave": true, "autosave": true },
        "lang": "zh-CN",
        "user": { "id": "lawyer-id", "name": "律师" }
      },
      "token": "JWT(payload = { document, documentType, editorConfig })"
    }
  }
}
```

`config.token` 是 ONLYOFFICE 浏览器配置签名，JWT payload 必须是完整的
`{ document, documentType, editorConfig }` 配置；它不是文件下载 token，也不包含本系统的
review/session claims。文档 URL 和 callback URL 内的窄 token 仍分别绑定读取和回调用途。
这遵循 [ONLYOFFICE Browser signature 文档](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/browser/)
对完整配置签名的要求。

backend 调用 `createEditorConfig` 时应传入 reviewId、versionId、当前 editor session 的 `sessionId`、base versionId、revision、scratch `fileKey` 和原始 `sourceFileKey`。`fileKey` 是 OnlyOffice 读入的 scratch 对象，回调绝不覆盖它；回调会根据下载后 DOCX 的 sha256 生成新的 immutable fileKey，并把 sourceFileKey 交给数据库 hook 校验。回调 token 不允许客户端自行指定这些值。客户只允许拿到 view 配置，分配的律师才允许拿到 edit 配置。

文档 token 的用途是 `contract-document-read`，callback token 的用途是 `contract-document-callback`。两者均绑定 review、version、revision、fileKey、document key、session 和角色，并使用 HS256 签名。文档读取 token 和 `config.token` 默认 15 分钟过期；callback token 默认 8 小时，以覆盖一次律师审阅 session。所有 TTL 都有服务端上限且可按 token 类别配置，不能由浏览器延长。session 仍由数据库的 active/assigned/disabled 状态、当前 revision 和 complete 事务校验撤销；过期或被撤销的 token 必须提示重新打开编辑器。文件 URL 不是永久公开地址。

## callback 保存规则

OnlyOffice callback 的 URL 窄 token 与 Document Server body JWT 必须同时通过。body JWT 从 `Authorization: Bearer ...` 或 JSON 的 `token` 字段读取，使用同一 `ONLYOFFICE_JWT_SECRET` 和 HS256 校验；JWT 含 `exp` 时校验过期时间。官方 header 模式的 payload 是 `{ payload: { key, status, url, userdata, ... } }`，JSON body 仍携带同一组字段；官方 body 模式可以只发送 `{ token: JWT }`，其 JWT payload 直接是 `{ key, status, url, userdata, ... }`。服务端会校验 body 中出现的每个字段都被 JWT 完整覆盖，并使用签名 payload 中的 url、key、status、userdata。URL token 绑定业务 session，body JWT 证明回调正文由可信 Document Server 签发；只验证其中一个不能写入文件。

参照 [callback handler 文档](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/)、
[header token 文档](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-header/)
和 [body token 文档](https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-body/)。

OnlyOffice callback 的 `status` 按官方约定处理：

| status | 处理 |
| --- | --- |
| 1、4 | 当前没有需要持久化的变更，返回 `{ "error": 0 }`，不改数据库 |
| 2 | 普通保存，下载并校验 DOCX 后持久化 |
| 6 | force-save，下载并校验 DOCX 后持久化 |
| 3、7 | 保存失败，返回错误，不覆盖此前已保存版本 |

状态 2 和 6 必须同时满足以下条件才返回 `{ "error": 0 }`：

1. callback token 能通过 JWT 校验，且用途、reviewId、versionId、revision、fileKey 全部匹配。
2. callback body 的 `key`（若有）与 token 中的 document key 一致。
3. callback body 的 `url` 是 HTTPS，并且 origin 命中 `ONLYOFFICE_TRUSTED_DOWNLOAD_ORIGINS`。开发环境的 localhost 例外必须显式列出。
4. 下载禁止自动跟随重定向；DNS 解析到私有、回环、链路本地或保留地址时拒绝。响应大小先受限，再用 `fflate` 检查 ZIP 中央目录、entry 数量、压缩/解压大小、路径、加密标志和必要 OOXML 文件。
5. 服务端计算下载后 DOCX 的 sha256，并把同一份 bytes 写入按 `sourceFileKey` 所在目录、session revision 和 sha256 生成的新私有对象 key。这样律师编辑后每次不同内容都是新对象，回调永远不会覆盖原始草稿或前一个律师版本；相同 sha256 的重复 callback 可以幂等确认。
6. 存储成功后调用 backend 的事务持久化 hook：

```ts
persistRevision({
  reviewId,
  versionId,
  revision,
  sessionId,
  sourceFileKey,
  fileKey,
  bytes,
  sha256,
  status, // 2 | 6
  userData, // body.userdata: force-save nonce/epoch
})
```

hook 必须在数据库事务中确认 session/revision 仍属于该审核任务、sourceFileKey 仍是该 session 的 base source，并拒绝旧 session、旧律师、已交付审核。相同 sha256 的 callback 可以直接幂等返回；同一活跃 session 的不同 sha256 应创建新的 immutable Version。对象写入发生在数据库指针更新之前；数据库 hook 失败时，旧的已保存指针保持不变，重复 callback 使用相同 sha256 可安全重试。

## 脏状态与交付

OnlyOffice 的文档状态事件只表示编辑器发生了变化，不能被当作保存成功。前端在 `onDocumentStateChange` 得到 `data: true` 时，应调用 backend 的窄 token dirty 接口，把审核任务置为 `saveStatus = "pending"`。律师再次编辑时，即使上一次 callback 曾经返回 `saved`，也必须先变回 `pending`。

force-save 回调完成且 backend 已持久化精确 revision 后，才把 `saveStatus` 置为 `saved`。`complete` 接口必须在同一个数据库事务中检查：审核未交付、editingVersionId 与请求版本一致、saveStatus 为 saved、当前 revision 没有 dirty 标记。保存中、保存失败和过期 revision 都不能交付。

## DOCX 文本上下文

需要让 AI 改写已有律师文件时，backend 应先从当前真实 DOCX bytes 调用 `extractDocxText`，再把提取的段落/表格文本作为上下文传给模型。提取函数先执行 ZIP/OOXML 结构和大小限制，拒绝 DTD 与外部实体，只读取 `word/document.xml` 的可见文字和段落、表格换行。模型生成的新合同仍建立新版本，不能用旧的 JSON 草稿覆盖律师文件。

## 下载路由

`/api/files/onlyoffice` 只接受签名 document token。路由先验证 token，再按 token 中绑定的 version/fileKey 从私有存储读取 DOCX，并使用 `application/vnd.openxmlformats-officedocument.wordprocessingml.document` 返回。它不接受客户端传入的任意路径、versionId 或 URL。

## 参考官方接口

实现依据 ONLYOFFICE 官方 callback handler 约定中的状态 1、2、3、4、6、7，以及官方文档对 callback URL 下载和 force-save 的说明。部署时仍应对实际 Document Server 版本做一次状态 2、6 保存、断线重试、旧 token 和保存失败验收。
