# 简历星球 TECH

- 版本：v1.2
- 日期：2026-08-31
- 对应产品文档：[PRD.md](./PRD.md)
- 对应交互原型：[index.prototype.backup.html](./index.prototype.backup.html)
- 系统提示词协议：[SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)
- AI 行为验收集：[AI_BEHAVIOR_TESTS.md](./AI_BEHAVIOR_TESTS.md)

## 1. 技术目标

系统需要稳定完成“个人资料 + 模板 + 岗位信息 → 可编辑草稿 → AI 生成 → PDF/DOCX → 不可变版本”的闭环，并满足以下约束：

- 编辑体验低延迟，自动保存可恢复；
- 上传文件安全、可追踪、可过期清理；
- OCR、模板解析、AI 生成和文档渲染异步执行；
- AI 输出结构化、可验证、可追溯，不直接操作文档；
- 草稿修改可恢复但不污染历史；用户主动保存和成功生成均创建不可变版本；
- 每次生成输入一致，生成快照与任务一一对应；
- 用户数据严格隔离，敏感信息加密和脱敏；
- 任务支持幂等、重试、超时、取消和部分成功。

## 2. 推荐技术栈

| 层 | 推荐方案 | 说明 |
|---|---|---|
| Web | Next.js 15、React 19、TypeScript | App Router；编辑器交互使用 Client Component |
| UI | Tailwind CSS + Radix UI | 自建视觉令牌，保证可访问性 |
| 表单 | React Hook Form + Zod | 前后端共享校验规则 |
| API | NestJS + TypeScript | 模块边界清晰，适合 REST、WebSocket 和队列 |
| 主数据库 | PostgreSQL 16 | 事务、JSONB、行级约束 |
| 缓存/队列 | Redis 7 + BullMQ | 自动保存缓存、限流、异步任务 |
| 文件存储 | S3 兼容对象存储 | 原始上传、预览图、PDF、DOCX |
| OCR | 可替换 OCR Provider Adapter | 首选云 OCR，保留本地模型兜底 |
| AI | LLM Provider Adapter | 模型可切换，强制 JSON Schema 输出 |
| 文档渲染 | Chromium + DOCX 模板引擎 | HTML/CSS 到 PDF；结构化内容到 DOCX |
| 可观测性 | OpenTelemetry + Sentry + Prometheus | Trace、错误和业务指标统一 |
| 部署 | Docker + Kubernetes 或托管容器 | Web/API 与 Worker 独立扩容 |

MVP 也可采用单仓库 pnpm workspace：apps/web、apps/api、apps/worker、packages/contracts、packages/resume-schema、packages/template-engine。

## 3. 总体架构

请求链路：

浏览器
→ Web/BFF
→ API 服务
→ PostgreSQL / Redis / 对象存储

异步链路：

API 服务
→ BullMQ
→ OCR Worker / Template Worker / AI Worker / Render Worker
→ 对象存储
→ PostgreSQL
→ WebSocket 或 SSE
→ 浏览器

模块职责：

- Web：表单、预览、语音采集、分片上传、任务进度、结果下载；
- API：认证、授权、业务校验、快照事务、任务编排、签名 URL；
- Worker：执行耗时或不可信文件处理；
- PostgreSQL：保存可编辑草稿、修改事件、不可变版本、生成快照、任务状态和审计日志；
- Redis：队列、短期缓存、分布式锁、限流；
- 对象存储：原始文件、转码文件、缩略图、导出文件；
- AI/OCR 适配器：屏蔽供应商差异，统一超时和错误码。

## 4. 前端设计

### 4.1 页面与路由

| 路由 | 页面 |
|---|---|
| /projects | 项目列表 |
| /projects/:id | 三栏工作区：资料库、简历画布、AI 对话 |
| /projects/:id/versions | 历史版本 |
| /projects/:id/versions/:versionId | 版本详情与比较 |

个人信息、岗位信息、模板、历史版本和生成进度使用工作区内的居中 Dialog，不通过页面跳转打断当前简历与对话上下文。普通界面不提供独立来源页；来源仅用于内部事实校验和审计。移动端将左侧资料卡片置于画布上方，右侧 AI 对话改为可关闭浮层。

### 4.2 状态分层

- 服务端状态：TanStack Query，管理项目、模板、岗位、任务和快照；
- 表单状态：React Hook Form；
- 轻量 UI 状态：Zustand，管理当前步骤、抽屉、预览缩放；
- 临时草稿：IndexedDB，离线保存未同步字段和录音片段；
- 简历草稿：服务端保存当前 Resume JSON、base_version_id 和 revision；
- 待成版修改：记录已应用但尚未保存为版本的正文与模板 change events；
- 任务进度：优先 SSE，断线后使用任务详情接口补状态。

### 4.3 自动保存

1. 字段修改后 800 ms debounce；
2. 请求携带 revision 和客户端 mutation_id；
3. 服务端通过乐观锁更新；
4. 成功返回新 revision；
5. 409 表示冲突，前端展示差异并让用户选择；
6. 网络失败写入 IndexedDB 队列；
7. 网络恢复后按修改时间重放；
8. 页面关闭前若仍有未同步数据，触发浏览器提示。

长文本可按字段保存，不整表覆盖，减少冲突。

简历正文或模板每次成功修改后，写入草稿并追加可撤销 change event；不得因此自动创建历史版本。前端仅在存在未成版修改时点亮“保存为版本”。撤销应同时回滚草稿并标记对应事件 reverted。

### 4.4 语音录入

- 使用 MediaRecorder 采集 WebM/Opus；
- 每 10 秒形成一个片段并上传，避免长录音丢失；
- 浏览器不支持时退化为整段上传；
- API 返回临时上传凭证，音频不经过 Web 服务转发；
- 完成后创建 transcription job；
- SSE 推送 partial 和 final 文本；
- 用户取消时停止上传并删除临时片段；
- 转写结果插入光标处，用户确认后保存。

### 4.5 上传

- 客户端先校验扩展名、大小、数量和图片尺寸；
- API 创建 upload session 并返回预签名分片 URL；
- 客户端直传对象存储；
- 完成后 API 校验 MIME magic bytes 和 SHA-256；
- 文件进入 quarantined 状态，经病毒扫描后才可解析；
- 上传失败支持断点续传；
- 目录选择通过 webkitdirectory 渐进增强，其他浏览器支持多文件选择。

## 5. 后端模块

### 5.1 模块拆分

- AuthModule：登录、会话、访问令牌；
- ProjectModule：项目生命周期；
- ProfileModule：个人信息与字段修订；
- TemplateModule：系统模板、自定义模板和版本；
- UploadModule：预签名上传、扫描、文件元数据；
- SpeechModule：音频转写任务；
- JobModule：岗位源文件、OCR、确认与分析；
- PolishModule：字段级 AI 润色；
- GenerationModule：校验、快照、编排和结果；
- VersionModule：主动保存、历史查询、比较、复制和导出；
- SnapshotModule：生成输入冻结与内部诊断；
- RenderModule：HTML、PDF、DOCX；
- QuotaModule：额度预占、结算和回退；
- AuditModule：敏感操作审计。

### 5.2 API 约定

- REST 路径版本为 /api/v1；
- 请求与响应使用 JSON，文件使用对象存储直传；
- 所有写请求支持 Idempotency-Key；
- 使用 RFC 7807 Problem Details 返回错误；
- 时间统一为 UTC ISO 8601；
- ID 使用 UUIDv7；
- 分页使用 cursor；
- API 返回 request_id，前端问题反馈可携带该值。

## 6. 核心 API

### 项目和个人信息

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /projects | 创建项目 |
| GET | /projects/:id | 获取工作区聚合数据 |
| PATCH | /projects/:id | 更新项目名和设置 |
| GET | /projects/:id/profile | 获取个人信息 |
| PATCH | /projects/:id/profile/fields/:field | 字段级自动保存 |
| POST | /projects/:id/profile/experiences | 新增经历 |
| PATCH | /experiences/:id | 修改经历 |
| DELETE | /experiences/:id | 软删除经历 |
| POST | /polish | 发起字段润色 |
| POST | /polish/:id/apply | 应用并记录建议 |

### AI 对话与动作

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /projects/:id/ai/messages | 发送消息并返回结构化回复与建议动作 |
| POST | /projects/:id/ai/conversations | 结束当前任务并开始空对话，保留待确认资料 |
| POST | /ai/actions/:id/confirm | 确认待确认事实、岗位或修改方案 |
| POST | /ai/actions/:id/reject | 拒绝建议动作并记录原因 |
| POST | /ai/actions/:id/revert | 撤销已执行的白名单动作 |
| GET | /projects/:id/ai/actions?status=pending | 获取左侧待确认内容 |

所有动作确认、拒绝和撤销接口必须携带 Idempotency-Key、expected_revision，并由 API 根据动作类型重新鉴权与校验。客户端不得直接把模型输出转换为资料写请求。

### 上传、模板和岗位

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /uploads | 创建上传会话 |
| POST | /uploads/:id/complete | 完成上传并触发扫描 |
| DELETE | /uploads/:id | 删除未引用上传 |
| GET | /templates/system | 获取系统模板 |
| POST | /templates/custom | 从上传文件创建模板 |
| GET | /templates/:id/status | 查询解析状态 |
| PUT | /projects/:id/template | 选择模板版本 |
| POST | /projects/:id/jobs | 创建目标岗位 |
| POST | /jobs/:id/sources | 添加图片来源 |
| POST | /jobs/:id/ocr | 发起 OCR |
| PATCH | /jobs/:id/text | 保存用户确认文本 |
| POST | /jobs/:id/analyze | 分析岗位 |
| GET | /jobs/:id/events | 订阅任务状态 |

### 生成与快照

| 方法 | 路径 | 用途 |
|---|---|---|
| PATCH | /projects/:id/resume-draft | 自动保存当前简历草稿 |
| POST | /projects/:id/resume-draft/changes/:changeId/revert | 撤销已应用修改 |
| POST | /projects/:id/versions | 用户主动将当前草稿保存为版本 |
| GET | /projects/:id/versions | 获取用户可见历史版本 |
| GET | /versions/:id | 获取版本及当时三类输入 |
| GET | /versions/:id/compare?target=:targetId | 比较两个版本 |
| POST | /versions/:id/clone | 复制为新的当前草稿，不覆盖原版本 |
| POST | /projects/:id/generations | 创建快照并发起生成 |
| GET | /generations/:id | 获取状态和结果 |
| GET | /generations/:id/events | SSE 进度 |
| POST | /generations/:id/retry | 重试失败步骤 |
| POST | /generations/:id/cancel | 请求取消 |
| POST | /versions/:id/export | 导出版本数据包 |
| POST | /artifacts/:id/download-url | 获取短期下载地址 |

创建生成请求体包含 project_revision、profile_revision、template_version_id、job_revision 和 client_request_id。任何 revision 不匹配时返回 409，避免用户看到的内容与快照不一致。

主动保存版本请求包含 name、draft_revision、profile_revision、template_version_id、job_revision 和待成版 change_ids。服务端必须在一个事务内校验并深拷贝，不接受客户端直接提交伪造的快照内容。

## 7. 数据模型

所有业务表包含 id、owner_id、created_at、updated_at。软删除表另有 deleted_at。

### 7.1 可编辑实体

users
- email、phone、display_name、status

resume_projects
- name、current_profile_id、current_template_version_id、current_job_id、revision、status

profiles
- project_id、basics_json、summary、revision

experiences
- profile_id、type、organization、title、start_date、end_date、is_current、description、sort_order、revision

template_definitions
- owner_id 可空；name、kind、status、source_upload_id

template_versions
- template_id、version、schema_json、preview_artifact_id、parser_version、checksum

target_jobs
- project_id、title、company、confirmed_text、analysis_json、revision、status

job_sources
- job_id、upload_id、sort_order、ocr_raw_text、ocr_confidence

uploads
- owner_id、object_key、original_name、mime_type、size、sha256、status、expires_at

ai_conversations
- project_id、active_scope_type、active_scope_id、status（active / closed）、created_at、updated_at

ai_messages
- conversation_id、role、content、scope_type、scope_id、model_metadata_json、created_at

ai_action_requests
- conversation_id、message_id、action_type、target_type、target_id
- payload_json、evidence_json、confidence、requires_confirmation
- status、expected_revision、policy_version、applied_at、reverted_at

fact_candidates
- project_id、target_type、target_id、field_path、proposed_value_json
- source_type、source_id、status、confirmed_by、confirmed_at、rejected_at

change_receipts
- action_request_id、resource_type、resource_id、before_json、after_json
- mutation_id、reverted_at、created_at

resume_drafts
- project_id 唯一、resume_json、base_version_id、revision、has_unsnapshotted_changes

resume_change_events
- project_id、draft_revision、change_type、scope_type、scope_id
- before_json、after_json、actor_type、mutation_id、reverted_at、created_at

### 7.2 版本、生成与快照

resume_versions
- project_id、version_no、kind（manual / generated）、name、base_version_id
- profile_payload、template_payload、job_payload、resume_payload JSONB
- change_summary_json、artifact_refs_json、generation_snapshot_id 可空、status
- created_by、created_at

generation_snapshots
- project_id、generation_no
- profile_payload JSONB
- template_payload JSONB
- job_payload JSONB
- generation_config JSONB
- input_hash
- status
- created_by、created_at

generation_jobs
- snapshot_id 唯一
- status、current_step、progress
- model_provider、model_name、prompt_version
- attempt_count、started_at、finished_at
- error_code、error_message_safe
- token_usage_json、cost_amount

resume_outputs
- snapshot_id
- resume_json JSONB
- explanation_json JSONB
- validation_json JSONB
- status

artifacts
- snapshot_id 可空、version_id 可空、type
- object_key、mime_type、size、sha256
- status、expires_at 可空

audit_logs
- owner_id、actor_id、action、resource_type、resource_id
- request_id、ip_hash、metadata_json、created_at

### 7.3 关键约束

- generation_snapshots(project_id, generation_no) 唯一；
- resume_versions(project_id, version_no) 唯一；
- resume_drafts(project_id) 唯一；
- resume_change_events(project_id, mutation_id) 唯一；
- generation_jobs(snapshot_id) 唯一；
- artifacts(snapshot_id, type, sha256) 唯一；
- artifacts 至少关联 snapshot_id 或 version_id；manual 版本产物可只关联 version_id；
- resume_versions 和 generation_snapshots 的冻结 payload 禁止 UPDATE；状态变化使用受限服务或独立事件表；
- 对象键包含 owner_id 的不可猜测前缀，但授权仍以数据库为准；
- input_hash 用于审计和重复生成提示，不能直接替代幂等键。

## 8. 快照与生成事务

### 8.1 创建阶段

在一个数据库事务中：

1. SELECT FOR UPDATE 锁定项目；
2. 校验 owner、revision、模板 ready、岗位 confirmed；
3. 预占一次生成额度；
4. 读取个人信息、模板版本、岗位及源文件；
5. 深拷贝成规范化 JSON；
6. 分配下一个 generation_no；
7. 写入 generation_snapshots；
8. 写入 generation_jobs，状态 queued；
9. 写入 outbox_events；
10. 提交事务。

独立 outbox publisher 把事件投递到 BullMQ。这样数据库提交成功但队列暂时不可用时，任务仍不会丢失。

生成快照是内部任务记录，不立即出现在历史列表。Worker 成功产出可用简历后，finalize 事务创建 `kind=generated` 的 resume_version；失败只保留诊断快照和原因。

### 8.2 主动保存版本

在单个事务中锁定项目与草稿，校验 owner、draft/profile/job/template revision 和 change_ids，分配下一个项目版本号，深拷贝三类输入及 Resume JSON，写入 `kind=manual` 的 resume_version，再更新草稿的 base_version_id 并清除 has_unsnapshotted_changes。重复 Idempotency-Key 不得新增版本。

### 8.3 执行阶段

Worker 按以下 DAG 执行：

- analyze_job
- compose_resume
- validate_facts
- render_html
- 并行执行 render_pdf 与 render_docx
- validate_artifacts
- finalize

每一步写入任务步骤表或事件流，并具有独立超时、最大重试次数和错误码。PDF 与 DOCX 中一个成功时整体为 partial。

### 8.4 幂等与重试

- 创建生成接口以 owner_id + Idempotency-Key 建唯一索引；
- 每个 Worker 使用 snapshot_id + step_name 作为 job key；
- 输出先写临时 object key，校验后原子切换为正式 artifact；
- 外部 AI/OCR 请求携带 correlation id；
- 可重试错误使用指数退避加随机抖动；
- 校验失败、文件损坏、内容违规等确定性错误不自动重试；
- 重试只重跑失败步骤，继续引用同一快照。

## 9. AI 设计

### 9.1 两阶段策略

阶段一：岗位分析

输入确认后的岗位文本；输出标准化 JobAnalysis，包括职责、必需能力、优先能力、关键词和原文证据位置。

阶段二：简历生成

输入快照内的 Profile、JobAnalysis、模板约束；输出严格匹配 Resume Schema 的 JSON，包括各段内容、来源证据 ID、待确认项和调整说明。

模型不直接生成 HTML、PDF 或 DOCX，避免结构漂移和提示注入影响渲染。

### 9.2 事实约束

- 为每条个人经历分配稳定 source_item_id；
- 生成的每条 bullet 必须返回 source_item_ids；
- 数字、时间、组织名和职位名须逐项与来源核验；
- 新出现的实体或数字触发 fact_violation；
- 无法验证的改写进入 pending_claims，不进入最终简历；
- 生成前对岗位文本进行提示注入检测；
- 岗位描述只能作为待分析数据，不得覆盖系统规则。

### 9.3 结构化输出

Resume Schema 主要字段：

- basics
- headline
- summary
- experience[]
- projects[]
- education[]
- skills[]
- evidence_map[]
- pending_claims[]
- generation_notes[]
- layout_hints

使用 JSON Schema 严格模式。解析失败先进行一次 schema repair，仍失败则任务终止并返回安全错误。

### 9.4 提示词与模型版本

- system prompt、schema、few-shot、政策规则分别版本化；
- 快照记录 prompt_version、schema_version、model 和参数；
- 温度保持较低；
- 新版本先离线评测，再灰度 5%；
- 评测集覆盖中文简历、跨行业转岗、学生、长履历、无量化数据和恶意岗位文本。

### 9.5 对话动作协议

对话模型只负责理解、生成回复和提出动作，不持有数据库凭证，也不能直接调用 Profile、Job 或 Resume 写接口。每次响应必须通过 JSON Schema 返回：

- reply：展示给用户的自然语言；
- scope：本次请求锁定的作用范围与 revision；
- actions[]：零个或多个建议动作；
- evidence[]：动作依据的消息、文件或已确认事实 ID；
- uncertainty：不确定点及需要追问的内容。

scope_type 使用稳定枚举 DATA_PROFILE、DATA_JOB、RESUME_BLOCK、RESUME_DOCUMENT，并携带 scope_id。界面分别显示为 `@资料 · 具体对象`、`@简历 · 具体内容`、`@整份简历`；后端不得使用显示文字判断权限或目标。

scope 是写入与动作权限边界，不是读取上下文的边界。模型可读取完成当前任务所需的关联事实、同一经历、整份简历风格、当前岗位和任务内对话，但只能对锁定 scope 提出动作。

action_type 只允许以下枚举：

- NO_OP：普通问答或临时讨论；
- PROFILE_FIELD_UPDATE：明确修改基础字段；
- FACT_CANDIDATE：新增或修正经历、成果、数字、技能等事实；
- JOB_CANDIDATE：新增岗位或修改岗位关键信息；
- RESUME_REWRITE_PROPOSAL：生成简历文字修改方案；
- TEMPORARY_CONTEXT：只在当前会话中有效的假设条件。

分类器必须区分事实数字与文字结构数量：“提升 20%”“覆盖 30 家客户”属于事实信号；“改成 2 个段落”“拆成 3 段”属于表达结构，只能进入 RESUME_REWRITE_PROPOSAL，不得创建 FACT_CANDIDATE。

模型输出中的“已保存、已应用、已切换”均视为非可信文本。只有后端策略执行成功并产生 change_receipt 后，前端才能展示完成状态。

#### 多轮任务上下文与建议链

服务端不得只依赖最近若干条原始消息维持多轮关系。每个修改任务至少保存 scope、当前问题、已回答信息、相关候选事实和当前可应用建议，并为建议记录 `task_id`、`parent_proposal_id`、`base_target_hash`、`dependency_fact_ids`。

生成建议时上下文必须区分：

- `currentText`：草稿中真实生效的内容 A，用于应用时校验和替换；
- `editingBase`：上一版建议 B，用于延续已认可的表达；
- `sourceFacts`：当前已确认事实 F，是唯一事实基准；
- `pendingFacts`：尚未确认的事实，不得作为正式建议依据；
- `taskSummary`：本任务已确认的修改目标、追问答案和表达偏好。

新建议 C 应从 B 继续调整，并以 F 重新校验；B 不得成为事实来源。没有 B 时才从 A 开始。影响建议的事实未处理完时不生成正式建议；事实确认或拒绝后创建新建议，不原地修改旧建议。

每轮以最新用户指令为优先输入。已确认事实生成的新版建议立即成为下一轮 editingBase，后续不得把该事实重复描述成本轮成果。服务端确定性识别 sourceFacts 中不存在的新数字：完整数字事实进入待确认；“30+”等缺少单位或对象的片段先追问。模型建议包含未确认数字时不得创建可应用动作。

### 9.6 策略执行器

AI Gateway 与业务写服务之间设置确定性的 Policy Engine：

1. 校验响应 Schema、动作枚举、目标所有权和 scope revision；
2. 根据动作矩阵决定“仅回复 / 待确认 / 可直接执行 / 拒绝”；
3. 对可执行动作调用内部领域服务，不允许模型提供任意 API、SQL 或 JSON Patch；
4. 写入 ai_action_requests、fact_candidates、change_receipts 和 audit_logs；
5. 返回后端实际执行结果，前端不得根据模型文本乐观显示“已保存”。

直接执行白名单首期仅包含姓名、电话、邮箱、所在城市、当前职位和求职状态，并同时满足：用户表达为明确更正、值通过字段校验、expected_revision 一致、旧值可记录、动作可撤销。其他事实一律进入待确认。

策略矩阵：

| 动作 | 后端决定 | 数据影响 |
|---|---|---|
| NO_OP / TEMPORARY_CONTEXT | 仅回复 | 不持久化业务资料 |
| PROFILE_FIELD_UPDATE 且满足白名单 | 执行并生成回执 | 更新个人信息，可撤销 |
| PROFILE_FIELD_UPDATE 不满足白名单 | 转为 FACT_CANDIDATE | 等待确认 |
| FACT_CANDIDATE | 等待确认 | 不进入 confirmed facts |
| JOB_CANDIDATE | 等待确认 | 不改变 current_job_id |
| RESUME_REWRITE_PROPOSAL | 展示差异 | 未 apply 前不改变正文 |
| 未知、越权、证据不足或 Schema 非法 | 拒绝并安全返回 | 零写入 |

系统采用 fail-closed：分类失败、策略冲突、目标 revision 变化或依赖服务异常时，不执行任何业务写入。相同 action_id 与 Idempotency-Key 重试不得重复写入。

RESUME_REWRITE_PROPOSAL 被用户应用后，只更新 resume_draft 并追加 resume_change_event，不创建历史版本。用户主动保存时创建 manual 版本；生成任务成功时创建 generated 版本。

### 9.7 状态、来源与同步

- fact_candidate 状态：pending / confirmed / rejected；
- ai_action_request 状态：proposed / awaiting_confirmation / applied / rejected / failed / reverted / stale / superseded；
- 每个事实记录来源消息或文件、提取模型、prompt_version、policy_version；
- 确认事实后先更新左侧事实库，再创建受影响简历内容的 rewrite proposal；
- 岗位确认后更新 current_job_id 并重新分析匹配，不直接重写简历；
- 一一对应的基础字段可同步显示，但必须生成 before/after 回执；
- 对话请求在入队时冻结 scope_type、scope_id 和 revision，后续 UI 选择变化不影响已发送请求。
- 来源和 evidence_map 始终保留在数据与审计层；普通 UI 不提供独立来源模块，只在待确认项中显示简化的“识别自”。
- 同一任务同时只有 active_proposal_id 指向的建议可应用；应用前校验其 base_target_hash、依赖事实和岗位版本，失败则标记 stale 并重新生成。
- “是的 / 确认 / 忽略”等短句只能绑定同一任务内唯一的当前问题或待确认动作；存在歧义时返回追问，不得按用户全局最近动作猜测。
- 开始新对话时将旧 conversation 标记为 closed、未完成 task 标记为 canceled，并拒绝旧对话中的未应用改写和岗位候选；事实候选独立保留。新对话只读取自身消息和任务。
- 旧对话结束后返回的异步模型结果必须以 `CONVERSATION_ENDED` 终止，不得补写助手消息、建议或动作；之后确认旧事实只更新资料，不恢复旧 task。

系统提示词的可执行基线见 [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)。提示词只负责提高分类正确率，不能替代 Policy Engine、Schema 校验或权限控制。

## 10. OCR 与模板解析

### 10.1 OCR 管线

1. 去除 EXIF；
2. 旋转校正、裁边和清晰度检查；
3. OCR 返回文本块、坐标和置信度；
4. 多图按顺序合并；
5. 基于坐标与文本相似度去重；
6. 低置信度片段在 UI 中高亮；
7. 用户确认后生成新 revision；
8. 分析始终读取 confirmed_text。

### 10.2 自定义模板

统一内部 Template Schema：

- page：尺寸、页边距、最大页数；
- regions：区域、栏数、流向；
- typography：字体、字号、行高、颜色；
- section_rules：可见模块、顺序、标题；
- constraints：每区最大行数、分页规则；
- assets：背景图、图标、装饰元素。

图片模板：作为背景层，使用预定义安全区或用户标注文本区。

PDF：优先读取文本层和坐标；扫描件退化为图片模板。

DOC/DOCX：在隔离容器中转为 PDF 预览，同时解析段落、表格、样式和占位符。旧 DOC 先经 LibreOffice 转换。

复杂、加密、含宏或外部链接的文件应拒绝或清理。模板解析结果必须由用户预览确认。

## 11. 渲染与质量检查

### 11.1 PDF

- Resume JSON + Template Schema → HTML/CSS；
- 使用固定版本 Chromium 打印 PDF；
- 字体打包并显式声明中文字体回退；
- 禁止渲染器访问公网；
- 检测溢出、空白页、孤行和页数；
- 生成缩略图供前端预览。

### 11.2 DOCX

- 使用结构化内容映射 OOXML 模板；
- 不通过 PDF 反转 DOCX；
- 固定标题、段落、列表、页边距和字体样式；
- 清理作者、路径、修订记录等隐私元数据；
- 用 LibreOffice 无头模式转 PDF 做视觉回归比对。

### 11.3 验证

- Resume JSON 通过 schema；
- 所有 bullet 有事实证据；
- PDF 页数符合模板约束；
- 文本抽取结果与 Resume JSON 做语义和关键数字比对；
- 输出文件 SHA-256 写入 artifacts；
- 下载响应强制 attachment 和安全文件名。

## 12. 安全与隐私

- 全站 TLS；数据库磁盘和对象存储服务端加密；
- 手机、邮箱等敏感字段支持应用层信封加密；
- 对象存储私有桶，下载 URL 最长 5 分钟；
- 所有资源查询同时校验 owner_id，禁止只凭 UUID；
- PostgreSQL 可启用 Row Level Security 作为纵深防护；
- 上传文件验证扩展名、MIME、magic bytes 和解压后大小；
- 病毒扫描、压缩炸弹检测、宏和外链清理；
- 文档解析器运行在无网络、低权限、限 CPU/内存/时间的沙箱；
- 日志不记录简历正文、OCR 全文、音频和签名 URL；
- AI 供应商配置零保留/不训练，发送最小必要数据；
- 支持删除账号、导出数据、撤回处理授权；
- 原始临时上传 24 小时清理；被项目引用的文件按账号保留策略处理；
- 管理支持访问需要工单、用户授权和审计。

## 13. 可靠性与可观测性

### 13.1 SLO

- API 可用性 99.9%；
- 自动保存 P95 < 500 ms；
- OCR P95 < 20 s；
- 生成 P95 < 60 s；
- 生成成功率 ≥ 98%；
- 任务状态最终一致时间 < 10 s。

### 13.2 指标

- HTTP 请求量、错误率、延迟；
- 队列长度、等待时间、执行时间、重试次数、死信量；
- OCR 成功率和低置信度占比；
- AI schema 通过率、事实校验失败率、token 和成本；
- PDF/DOCX 成功率、页数异常率；
- 快照创建与生成任务的一致性；
- 对象存储上传、下载和扫描失败率。

Trace 从 Web request_id 贯穿 API、outbox、队列、外部模型和渲染。告警必须使用安全错误信息，详细错误仅写受限日志。

## 14. 错误码

| 错误码 | 含义 | 用户动作 |
|---|---|---|
| PROFILE_INCOMPLETE | 个人信息不完整 | 定位缺失字段 |
| REVISION_CONFLICT | 编辑版本冲突 | 比较并合并 |
| TEMPLATE_UNSUPPORTED | 模板格式或结构不支持 | 更换文件/系统模板 |
| FILE_UNSAFE | 文件未通过安全扫描 | 更换文件 |
| OCR_LOW_CONFIDENCE | OCR 置信度过低 | 修订或粘贴文本 |
| JOB_NOT_CONFIRMED | 岗位文本未确认 | 确认岗位信息 |
| FACT_VALIDATION_FAILED | 生成内容无法通过事实校验 | 查看待确认项或重试 |
| RENDER_PARTIAL | 部分格式生成失败 | 下载成功格式并重试 |
| QUOTA_EXCEEDED | 额度不足 | 等待额度恢复或升级 |
| PROVIDER_TEMPORARY | 外部服务暂时不可用 | 稍后自动/手动重试 |

客户端不展示供应商原始错误、堆栈和内部对象键。

## 15. 测试策略

### 单元测试

Schema 校验、完整度计算、revision 冲突、输入 hash、事实比对、分页规则、额度结算。

### 集成测试

数据库事务与 outbox、S3 分片上传、队列重试、OCR 适配器、AI schema 输出、PDF/DOCX 渲染。

### 端到端测试

- 新用户完整生成；
- 语音拒权后键盘输入；
- 多图岗位 OCR 与排序；
- 自定义模板解析失败后切换系统模板；
- 重复点击生成只产生一个生成快照和一个 generated 版本；
- 应用多次 AI 修改只产生草稿事件，不自动产生历史版本；
- 主动保存只产生一个 manual 版本并清空待成版标记；
- 撤销修改同步回滚草稿并标记 change event；
- 生成中刷新页面恢复状态；
- PDF 成功而 DOCX 失败；
- 版本详情可还原三类输入，两个版本可比较；
- 复制旧版本创建新草稿且不覆盖原版本；
- 跨用户访问返回 404；
- 删除账号后文件按策略清理。

### AI 评测

事实一致性、岗位相关性、简洁性、格式合规、敏感属性偏见、提示注入抵抗、中文语言质量。上线门槛以事实一致性为最高优先级。

### AI 行为契约测试

- Policy Engine 单元测试覆盖每种 action_type、白名单、revision 冲突、重复请求和 fail-closed；
- 模型契约测试校验每个响应符合 Schema，未知动作不能进入业务层；
- 集成测试验证“模型输出 → 策略判断 → 待确认/执行 → 回执/审计”完整链路；
- 端到端测试验证左侧资料、中间正文和当前岗位不会被未授权对话改变；
- Prompt、模型、Schema 或策略版本任一变化，必须重跑固定回归集；
- [AI_BEHAVIOR_TESTS.md](./AI_BEHAVIOR_TESTS.md) 中 P0 用例必须 100% 通过，且 unauthorized_mutation_count 必须为 0。

## 16. 部署与发布

环境分为 local、staging、production，数据库和对象桶完全隔离。使用迁移工具管理 schema，采用向后兼容的 expand/contract 方式。

发布顺序：

1. 数据库兼容迁移；
2. API 与 Worker；
3. Web；
4. 灰度新 prompt/model/template parser；
5. 观察错误率、任务积压和事实校验；
6. 全量或回滚。

Worker 按队列分别扩容。AI 生成和渲染设置独立并发上限，防止外部供应商或 Chromium 消耗拖垮 API。

## 17. MVP 实施拆分

### 迭代 1：可编辑工作区

账号、项目、个人信息、自动保存、简历草稿/change events、主动保存版本、三种系统模板、实时预览。

### 迭代 2：多模态输入

语音转写、上传服务、文件扫描、岗位多图 OCR、岗位文本确认与分析。

### 迭代 3：生成闭环

生成快照事务、任务编排、generated 版本、AI 结构化生成、事实校验、PDF/DOCX、进度恢复。

### 迭代 4：自定义模板与上线质量

PDF/Word/图片模板解析、版本比较/复制/导出、额度、审计、全链路监控、安全测试和灰度发布。

## 18. 关键技术决策

1. 用户版本深拷贝个人资料、岗位、模板和简历 JSON，不引用可变业务表。
2. 先提交数据库 outbox，再投递队列，避免“有快照无任务”。
3. AI 只输出严格结构化 JSON，文档由确定性渲染器生成。
4. 每条生成内容绑定来源证据，事实校验失败时不出最终文件。
5. PDF 和 DOCX 并行生成，允许部分成功并单独重试。
6. 用户文件直传私有对象存储，解析全部在无网沙箱执行。
7. 编辑使用 revision 乐观锁，生成请求显式携带用户看到的 revision。
8. AI 模型只提出结构化动作，所有资料写入由确定性 Policy Engine 执行。
9. 推断事实与岗位变化默认待确认；非法或不确定动作采用零写入的 fail-closed 策略。
10. 已应用修改先进入可撤销草稿事件；只有用户主动保存或生成成功才进入历史版本。
