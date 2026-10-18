# Shared API contract
All API routes are /api/..., JSON except file operations. Success {data: T}; error {error: string}, proper status codes. Types src/lib/types.ts.
GET session => User|null. POST auth/login {email,password}=>User; POST auth/register {name,email,password}=>User(client only); POST auth/logout=>null.
GET capabilities => Capabilities.
GET contracts => Contract[] accessible by owner or assigned lawyer or admin.
POST contracts {title?} => Contract empty.
GET contracts/:id => Contract accessible.
POST contracts/:id/chat {message,mode?:'demo'|'live',generate?:boolean} => Contract. Chat persists both messages; generate yields immutable Version + DOCX. Demo mode explicit, clearly source demo. During open review refuse AI modification and ask use review message route.
POST contracts/:id/reviews {versionId,stance,concerns} => Contract frozen review snapshot (requirements = prior messages). Open review duplicate prevented. Unassigned initially.
POST contracts/:id/reviews/:reviewId/assign {lawyerId} => Contract admin only.
POST contracts/:id/reviews/:reviewId/start {} => Contract assigned lawyer only.
POST contracts/:id/reviews/:reviewId/messages {content,requestInfo?:boolean} => Contract owner/assigned lawyer/admin. lawyer requestInfo sets need_info, user response returns reviewing.
POST contracts/:id/reviews/:reviewId/upload multipart file => Contract. Assigned lawyer only; immutable DOCX review version; mark editingVersionId and saved.
POST contracts/:id/reviews/:reviewId/complete {versionId,deliveryNote} => Contract assigned lawyer only; require saved exact review Version, no pending editor save. Freeze final.
POST contracts/:id/reviews/:reviewId/respond {action:'received'|'request_changes',feedback?} => Contract owner only after delivery. 'received' records file receipt, not signature. Legacy 'request_changes' returns CONTRACT_DELIVERED; use the original review messages for continued communication. No new review or lawyer reassignment after delivery.
GET files/:versionId => DOCX bytes after role ownership check.
GET users => User[] admin only. POST users {name,email,password,role}=>User admin only. PATCH users/:id {name?,disabled?}=>User admin; no privilege self elevation via normal registration.
GET contracts/:id/reviews/:reviewId/editor => ONLYOFFICE config assigned lawyer (and optional view config owner). POST .../editor/save => saving status; force-save token tied to revision.
ONLYOFFICE integration document URL and callback use signed narrow tokens bound to the active website login session and current review grant; no public permanent URLs.

## Contract materials (Node)
GET contracts/:id/materials => MaterialInfo[] (no full extracted text).
POST contracts/:id/materials multipart {file,purpose:'transaction'|'reference'} => MaterialInfo. Client owner only; DOCX/PDF/TXT/MD, 10 MB/file, 20 retained materials/contract. Same active hash and purpose returns the existing material.
GET contracts/:id/materials/:materialId => original attachment after scope and SHA-256 checks; private/no-store/nosniff.
POST contracts/:id/materials/:materialId/withdraw {} => MaterialInfo[]. Removes from current drafting, preserves frozen historical access.
Material mutations refuse active Agent jobs and open review, increment workflow revision and invalidate prior confirmation. Assigned lawyers only access material IDs associated with their frozen review versions. Agent reads extracted chunks internally; no unauthenticated material URLs.
Capabilities.legalSearchConfigured reports configuration only, not provider health or verified legal validity. Legal research remains an Agent tool rather than a public arbitrary-search API.

## Reviewed feedback and preferences
GET learning?contract=...&review=...&offset=0 => {items:LearningRecord[],hasMore:boolean}; 50 records/page, owner / currently assigned reviewer / admin scope.
POST contracts/:id/reviews/:reviewId/learning => LearningRecord. Assigned lawyer only, completed and unchallenged delivery; immutable submitted/final versions, verified file hashes and exact before/after quotes; requestId is idempotent. Optional preference and anonymized sample have separate pending states.
POST learning/:id/decision {revision,kind:'preference'|'sample',action:'confirm'|'reject'|'revoke',note?,deidentified?} => LearningRecord. Only client owner confirms their preference, only admin confirms evaluation samples (deidentified:true required). Version conflicts return 409; pending => active/rejected, active => revoked. Content is immutable; corrections are new proposals.
Source delivery changes_requested suspends matching/export. No automatic global policy update, model training or public dataset export. Internal get_clause_preferences exposes at most 12 confirmed owner-scoped candidates; resulting versions preserve preferenceAudit.

Responsible lawyer: assignment is initial-only; once assigned, the contract remains with that lawyer. There is no transfer endpoint. Review messages remain available to the owner and assigned lawyer after delivery without reopening or changing the final document. Feedback learning is optional and never a delivery approval gate.

## 沟通、补充材料与保存（2026-09-26）

- `POST contracts/:id/reviews/:reviewId/messages` 可传 UUID `requestId`；同一发送者、同一沟通、同一编号的重复请求只产生一条消息和一次通知，编号相同但内容不同返回 409。
- `GET/POST contracts/:id/reviews/:reviewId/materials` 查看或上传本次沟通补充材料；仅合同用户、负责律师可上传，管理员只读。下载复用私有材料接口。支持 DOCX/PDF/TXT/MD，10 MB/份；同一沟通同一文件去重。
- 补充材料独立关联沟通，不更改原送审版、确认事实或 Agent 输入版本。原有起草材料的冻结限制保留。
- 编辑器保存收到 ONLYOFFICE `error:4` 时，若已确认没有待保存修改、保存请求仍有效且文件哈希正确，则复用已有律师版，或从原文件保存一份律师版；可直接交付，不要求制造文字改动。
- 已交付合同拒绝编辑状态变更和保存请求，后续沟通仍可继续。

## 浏览器详情、历史与删除（2026-09-26 代码审计修复）

- `GET contracts/:id` 返回当前工作视图：最近 50 条起草消息、每次沟通最近 50 条消息，`messagesHasMore` 表示还有更早记录。版本列表保留元数据，默认只带当前版本及最近送审来源的正文；`bodyLoaded:false` 表示需要单独读取正文，不代表空合同。
- `GET contracts/:id/messages?before=<messageId>`、`GET contracts/:id/reviews/:reviewId/messages?before=<messageId>` 返回 `{items,hasMore}`，每页最多 50 条、按时间正序；`before` 必须属于当前合同/沟通。律师不可读取客户私有起草对话。
- `GET contracts/:id/versions/:versionId` 按原有版本权限返回单份完整版本。旧版本在选择或对比时读取。
- 详情响应包含按账号与角色隔离的 `ETag`。每次条件请求都重新验证身份和授权；未变化返回 304，变化后返回新工作视图。变化标记包含编辑回调状态，不依赖单一 `updated_at`。浏览器缓存仅在内存中保存，退出及切换账号清空。
- 旧 `GET contracts` 最多返回最近 20 份工作视图；列表分页使用 `GET contract-list?page=...`。后台 Agent 保留完整历史读取，不使用浏览器分页结果生成合同。
- 删除实际截止时间是原申请截止时间与最近合同活动后 30 天中的较晚者。`GET/POST .../deletion` 均返回实际时间；继续沟通/修改后重新保留 30 天，届满由离线维护清理。审核/生成活动仍阻止清理。
- 清理按编辑会话、审核记录、合同的依赖顺序执行；单份合同独立事务，失败不会回滚其他合同。维护命令有部分失败时返回非零退出码。
- Word 预览位于不允许脚本和同源权限的 sandbox iframe，禁用活动内容和文档内链接跳转，网络策略禁止外部加载。原 Word 下载保持不变。

## Agent 问答与本版起草说明（2026-09-26，第五轮）

- Node 起草入口仍为 `POST contracts/:id/chat {requestId,message?,confirmId?}`。意图区分在后台完成，前端不提交 `answer/update` 权限字段。成功的只读回答不改变原摘要、确认时间、输入版本或 Word；修改才更新摘要。处理中暂不允许用旧摘要确认或送审。
- `FACT_CHECK_UNCERTAIN` 表示事实尚不能核对，保留候选稿、停止自动改写并提示具体缺口；手动重试继续核验。明确冲突继续用 `DRAFT_MISMATCH`。专业不确定性可以形成初稿，但结论标记为 `needs_lawyer`。
- `Version.content.agentOutcome` 是可选历史快照：`version:1, contentSha256, checkedAt, consistency, reviewNotes, goal?`。`goal` 包含服务器从该版确认记录复制的 `value`，以及 `status, explanation, clauses[{target,index,quote}]`。状态为 `addressed/partial/unaddressed/needs_lawyer`，不代表律师审定。旧版没有该字段时不补造结论。
- 只读问答保留前一个失败生成任务的候选稿和重试入口，因此答复消息到达时，任务仍可能显示原生成阶段的 `failed`。任务身份与幂等约束保留；手动重试更新执行编号，进程恢复使用原阶段缓存。
- 输入确认快照、重试计数与内部续接候选存于现有 workflow JSON，无需新增数据库表。`continuation` 与 `content/repairFeedback/lease` 一样，从浏览器详情、订阅和进度读取中排除。

## 材料冲突、网页扩展与任务预算（第六轮）

- `Intake.materialConflicts?` 保存 `{topic,question,alternatives:[{materialId,sha256,chunkId,quote}]}`。每个主题 2–4 个原文依据；引用须属于本次可用交易材料，参考范本不可当作交易承诺。未解决的分歧继续显示在原有 `conflicts`，复用摘要确认约束；不增加审批。下一轮自然语言取舍由模型提交 `resolvedMaterialConflicts[{topic,quote}]`，quote 必须在当前用户消息中。材料撤回或版本变化清理过期分歧。
- 原有 `read_legal_source` 工具增加 `offset?`、`expand?`，仍只能读已知来源 ID。`expand:true` 每阶段最多提取 2 个已检索官方网页；同一父来源 24 小时内可复用本合同已提取结果。返回新来源 ID 与父 ID，保留旧引用；全文提取最多 50000 字，每页最多 7000 字，返回 `nextOffset/totalCharacters/extraction`。`validity` 始终 `not_verified`。读取失败不以摘要冒充全文。
- `GenerationJob.budget?` 持久化 `policy,startedAt,calls,accountedTokens,inputTokens,outputTokens,unknownCalls,modelMs,pending?`。模型请求前预留、返回后结算；受原任务 ID/租约/版本保护。阶段推进及重试沿用记录，取消或旧租约不得覆盖新任务。生成失败后的只读问答仍可恢复原候选任务及其预算。
- `AI_TASK_BUDGET_EXCEEDED` 保留草稿并停止后续模型调用；`AI_BUDGET_RECORD_FAILED` 表示用量写入未完成，也停止新调用。这两类不自动重试。Word 导出不消耗模型预算，可以在已经通过核验后完成。
- `GET operations/generation` 增加 `tasks`（最近 20 份合同的当前任务预算，仅管理员访问）。统计估值不能视为供应商账单。
