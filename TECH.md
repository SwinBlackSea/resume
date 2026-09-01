# 简历星球 TECH

- 版本：v1.3
- 日期：2026-09-01
- 对应产品文档：[PRD.md](./PRD.md)
- 对应交互原型：[index.prototype.backup.html](./index.prototype.backup.html)
- 系统提示词协议：[SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)
- AI 行为验收集：[AI_BEHAVIOR_TESTS.md](./AI_BEHAVIOR_TESTS.md)

## 1. 技术目标

系统需要稳定完成“可选资料 + 当前正文 + 用户沟通 + 模板与岗位 → 可编辑草稿 → AI 生成 → PDF/DOCX → 不可变版本”的闭环，并满足以下约束：

- 编辑体验低延迟，自动保存可恢复；
- 上传文件安全、可管理、可过期清理；
- OCR、模板解析、AI 生成和文档渲染异步执行；
- AI 写动作结构化、可验证且不直接操作文档；自然语言回答无需套入固定意图流程；
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
| AI | Resume Harness + DeepSeek Client | 应用管理有界会话状态，模型负责语义理解并输出结构化动作 |
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
- PostgreSQL：保存平级资料、对话、可编辑草稿、修改事件、不可变版本、生成快照、任务状态和操作审计；
- Redis：队列、短期缓存、分布式锁、限流；
- 对象存储：原始文件、转码文件、缩略图、导出文件；
- AI/OCR 适配器：屏蔽供应商差异，统一超时和错误码。

## 4. 前端设计

### 4.1 页面与路由

| 路由 | 页面 |
|---|---|
| /projects | 项目列表 |
| /projects/:id | 三栏工作区：资料、简历画布、AI 对话 |
| /projects/:id/versions | 历史版本 |
| /projects/:id/versions/:versionId | 版本详情与比较 |

个人信息、岗位信息、模板、历史版本和生成进度使用工作区内的居中 Dialog，不通过页面跳转打断当前简历与对话上下文。系统不提供内容来源页，也不在后端维护资料到正文的映射。移动端将左侧资料卡片置于画布上方，右侧 AI 对话改为可关闭浮层。

### 4.2 状态分层

- 服务端状态：TanStack Query，管理项目、模板、岗位、任务和快照；
- 表单状态：React Hook Form；
- 轻量 UI 状态：Zustand，管理当前步骤、抽屉、预览缩放；
- 临时草稿：IndexedDB，离线保存未同步字段和录音片段；
- 简历草稿：服务端保存当前 Resume JSON、revision 和 last_versioned_revision；
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
- JobModule：岗位上传文件、OCR、确认与分析；
- PolishModule：字段级 AI 润色；
- GenerationModule：校验、快照、编排和结果；
- VersionModule：主动保存、历史查询、比较、复制和导出；
- SnapshotModule：生成输入冻结与内部诊断；
- RenderModule：HTML、PDF、DOCX；
- QuotaModule：额度预占、结算和回退；
- AuditModule：敏感操作审计；只记录谁在何时执行了什么操作，不记录内容派生关系。

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

### 项目和资料

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /projects | 创建项目 |
| GET | /projects/:id | 获取工作区聚合数据 |
| PATCH | /projects/:id | 更新项目名和设置 |
| GET | /projects/:id/profile | 获取资料；允许为空 |
| PATCH | /projects/:id/profile/fields/:field | 用户直接编辑资料并自动保存 |
| POST | /projects/:id/profile/experiences | 新增经历 |
| PATCH | /experiences/:id | 修改经历 |
| DELETE | /experiences/:id | 软删除经历 |
| POST | /polish | 发起字段润色 |
| POST | /polish/:id/apply | 应用资料字段润色 |

### AI 对话与建议动作

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /projects/:id/ai/messages | 发送消息并返回自然语言回复与零个或多个建议动作 |
| POST | /projects/:id/ai/conversations | 结束当前对话和未应用建议，开始空对话 |
| POST | /ai/actions/:id/apply | 应用资料保存、岗位切换或简历修改建议 |
| POST | /ai/actions/:id/reject | 拒绝当前建议 |
| POST | /ai/actions/:id/revert | 撤销支持撤销的已执行动作 |
| GET | /projects/:id/ai/actions?status=proposed | 获取当前对话内尚未处理的建议 |

所有应用、拒绝和撤销接口必须携带 Idempotency-Key 与 expected_revision，并由 API 根据动作类型重新鉴权和校验。客户端不得直接把模型输出转换为资料、岗位或简历写请求。问答、解释和追问只返回自然语言与空 actions，不创建伪动作。

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
| POST | /jobs/:id/files | 添加岗位图片 |
| POST | /jobs/:id/ocr | 发起 OCR |
| PATCH | /jobs/:id/text | 保存用户确认文本 |
| POST | /jobs/:id/analyze | 分析岗位 |
| GET | /jobs/:id/events | 订阅任务状态 |

### 草稿、生成与版本

| 方法 | 路径 | 用途 |
|---|---|---|
| PATCH | /projects/:id/resume-draft | 自动保存当前简历草稿 |
| POST | /projects/:id/resume-draft/changes/:changeId/revert | 撤销已应用修改 |
| POST | /projects/:id/versions | 用户主动将当前草稿保存为版本 |
| GET | /projects/:id/versions | 获取用户可见历史版本 |
| GET | /versions/:id | 获取版本及当时资料、岗位、模板和简历结果 |
| GET | /versions/:id/compare?target=:targetId | 比较两个版本 |
| POST | /versions/:id/clone | 将版本内容复制为新的当前草稿，不覆盖原版本 |
| POST | /projects/:id/generations | 冻结本次输入并发起生成 |
| GET | /generations/:id | 获取状态和结果 |
| GET | /generations/:id/events | SSE 进度 |
| POST | /generations/:id/retry | 重试失败步骤 |
| POST | /generations/:id/cancel | 请求取消 |
| POST | /versions/:id/export | 导出版本数据包 |
| POST | /artifacts/:id/download-url | 获取短期下载地址 |

创建生成请求包含 project_revision、draft_revision、可空的 profile_revision、template_version_id、job_revision 和 client_request_id。任何非空 revision 不匹配时返回 409，避免用户看到的内容与本次冻结输入不一致。

主动保存版本请求包含 name、draft_revision、可空的 profile_revision、template_version_id、job_revision 和待成版 change_ids。服务端必须在一个事务内校验并深拷贝当时工作区状态，不接受客户端直接提交伪造版本内容。

## 7. 数据模型

所有业务表包含 id、owner_id、created_at、updated_at。软删除表另有 deleted_at。资料、对话、草稿和版本按对象类型分表，但不存在内容父子关系、来源关系或资料到正文的外键映射。

### 7.1 可编辑实体

users
- email、phone、display_name、status

resume_projects
- name、current_profile_id 可空、current_template_version_id、current_job_id 可空、revision、status

profiles
- project_id、basics_json、summary、revision

experiences
- profile_id、type、organization、title、start_date、end_date、is_current、description、sort_order、revision

template_definitions
- owner_id 可空；name、kind、status、template_upload_id 可空

template_versions
- template_id、version、schema_json、preview_artifact_id、parser_version、checksum

target_jobs
- project_id、title、company、confirmed_text、analysis_json、revision、status

job_files
- job_id、upload_id、sort_order、ocr_raw_text、ocr_confidence

uploads
- owner_id、object_key、original_name、mime_type、size、sha256、status、expires_at

ai_conversations
- project_id、active_scope_type、active_scope_id、status（active / closed）、created_at、updated_at

ai_messages
- conversation_id、role、content、scope_type、scope_id、model_metadata_json、created_at

ai_action_requests
- conversation_id、message_id、action_type、target_type、target_id
- payload_json、requires_user_action、status、expected_revision、policy_version
- applied_at、rejected_at、reverted_at

resume_drafts
- project_id 唯一、resume_json、revision、last_versioned_revision、has_unversioned_changes

resume_change_events
- project_id、draft_revision、change_type、scope_type、scope_id
- before_json、after_json、actor_type、mutation_id、reverted_at、created_at

### 7.2 版本、生成与冻结输入

resume_versions
- project_id、version_no、kind（manual / generated）、name
- profile_payload 可空、template_payload、job_payload 可空、resume_payload JSONB
- change_summary_json、artifact_refs_json、generation_snapshot_id 可空、status
- created_by、created_at

generation_snapshots
- project_id、generation_no
- profile_payload 可空、resume_input_payload、template_payload、job_payload 可空 JSONB
- generation_brief、generation_config、input_hash、status
- created_by、created_at

generation_jobs
- snapshot_id 唯一
- status、current_step、progress
- model_provider、model_name、prompt_version
- attempt_count、started_at、finished_at
- error_code、error_message_safe、token_usage_json、cost_amount

resume_outputs
- snapshot_id、resume_json、explanation_json、validation_json、status

artifacts
- snapshot_id 可空、version_id 可空、type
- object_key、mime_type、size、sha256、status、expires_at 可空

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
- 复制版本只深拷贝内容到当前草稿，不写版本父子字段；
- ai_action_requests 不包含 evidence、source、dependency_fact_ids 或资料到正文映射字段；
- audit_logs 只记录操作主体、目标、时间和必要前后值，不承担内容归因；
- 对象键包含 owner_id 的不可猜测前缀，但授权仍以数据库为准；
- input_hash 用于重复生成提示和冻结输入一致性检查，不能替代幂等键。

## 8. 快照与生成事务

### 8.1 创建阶段

在一个数据库事务中：

1. SELECT FOR UPDATE 锁定项目；
2. 校验 owner、project/draft revision、模板 ready；岗位存在时还需 confirmed；
3. 预占一次生成额度；
4. 读取可选资料、当前草稿、模板版本、可选岗位和本次生成要求；
5. 将这些平级输入深拷贝成规范化 JSON；
6. 分配下一个 generation_no；
7. 写入 generation_snapshots；
8. 写入 generation_jobs，状态 queued；
9. 写入 outbox_events；
10. 提交事务。

独立 outbox publisher 把事件投递到 BullMQ。这样数据库提交成功但队列暂时不可用时，任务仍不会丢失。

生成快照是内部任务记录，不立即出现在历史列表。Worker 成功产出可用简历后，finalize 事务创建 `kind=generated` 的 resume_version；失败只保留诊断快照和原因。

### 8.2 主动保存版本

在单个事务中锁定项目与草稿，校验 owner、draft、可选 profile、可选 job、template revision 和 change_ids，分配下一个项目版本号，深拷贝当时资料、岗位、模板及 Resume JSON，写入 `kind=manual` 的 resume_version，再把草稿的 last_versioned_revision 更新为当前 revision 并清除 has_unversioned_changes。重复 Idempotency-Key 不得新增版本。

### 8.3 执行阶段

Worker 按以下 DAG 执行：

- analyze_job
- compose_resume
- validate_content
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

### 9.1 生成策略

阶段一：岗位分析

输入用户确认的岗位文本；输出标准化 JobAnalysis，包括职责、必需能力、优先能力、关键词和对应原文片段位置。位置只服务本次岗位分析与界面高亮，不进入个人资料或简历内容模型。

阶段二：简历生成

输入冻结的可选 Profile、当前 Resume、用户本次生成要求、可选 JobAnalysis 和模板约束；输出严格匹配 Resume Schema 的 JSON。Profile 只是可选参考，当前正文和用户在本次沟通中明确提供的信息同样可以进入结果。

模型不直接生成 HTML、PDF 或 DOCX，避免结构漂移和提示注入影响渲染。

### 9.2 内容安全，不建立内容归因

系统不为资料条目分配 source_item_id，不要求正文 bullet 绑定资料 ID，也不保存 evidence_map。安全校验只回答“本次输出是否包含用户未提供且无法确认的具体陈述”，不回答“这句话来自哪条资料”。

- 本次可用输入是冻结的资料、当前正文、用户明确的本次要求和已确认岗位；
- 用户在当前对话中明确补充的经历、数字或技能可以直接用于简历，无需先写入资料；
- AI 推测、示例、岗位要求和自行补造的实体或数字不得进入可应用结果；
- 含义不明确时，对话场景先追问；一键生成场景返回需补充项，不产出包含推测内容的最终文件；
- 校验器按本次输入进行整体一致性检查，只保存通过、失败和问题说明，不持久化逐句归因关系；
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
- generation_notes[]
- validation_issues[]
- layout_hints

使用 JSON Schema 严格模式。解析或校验失败时任务立即终止并返回安全错误，不用第二次语义调用改判结果。

### 9.4 提示词与模型版本

- system prompt、schema、few-shot 和写入策略分别版本化；
- 生成快照记录 prompt_version、schema_version、model 和参数；
- 温度保持较低；
- 新版本先离线评测，再灰度 5%；
- 评测集覆盖中文简历、跨行业转岗、学生、长履历、空资料、纯对话写作、无量化数据和恶意岗位文本。

### 9.5 对话动作协议

对话模型负责理解、自然回复、追问和提出建议，不持有数据库凭证，也不能直接调用 Profile、Job 或 Resume 写接口。每次响应通过 JSON Schema 返回：

- reply：展示给用户的自然语言；
- scope：本次请求锁定的作用范围与 revision；
- actions[]：零个或多个建议写动作；
- uncertainty：无法安全确定的内容和需要追问的问题。

问答、解释、追问、假设和临时讨论允许自由组织 reply，actions 为空，不需要伪装成动作类型。只有会改变业务状态的建议使用稳定枚举：

- PROFILE_SAVE_PROPOSAL：把用户明确指定的信息保存到资料；
- JOB_SET_CURRENT_PROPOSAL：把新岗位设为当前岗位；
- RESUME_REWRITE_PROPOSAL：修改具体正文或整份简历。

scope_type 使用稳定枚举 DATA_PROFILE、DATA_JOB、RESUME_BLOCK、RESUME_DOCUMENT，并携带 scope_id。界面分别显示为 `@资料 · 具体对象`、`@简历 · 具体内容`、`@整份简历`；后端不得使用显示文字判断权限或目标。

scope 是写入与动作权限边界，不是读取上下文的边界。Resume Harness 每轮提供完整简历、完整资料、当前岗位、锁定内容及其相邻内容；当前有效对话按消息数和字符预算保留完整消息，避免逐条截断和上下文无限增长。模型只能对锁定 scope 提出动作。

用户在对话中明确提供的新信息可以直接进入 RESUME_REWRITE_PROPOSAL。只有用户明确要求长期保存或同意保存建议时，才另外提出 PROFILE_SAVE_PROPOSAL。两者同时出现时必须是两个独立 action，分别校验、应用和撤销。

#### 多轮任务上下文

服务端为当前修改任务保存 scope、当前问题、已回答信息、表达偏好和唯一 active_proposal_id。生成建议时区分：

- currentText：草稿中真实生效的内容 A，用于应用时校验和替换；
- editingBase：当前最新建议 B，用于延续用户尚未应用但正在调整的表达；
- referenceProfile：可选资料，只用于参考；
- conversationContext：当前对话中用户明确提供的信息与要求；
- taskSummary：已明确的修改目标和表达偏好。

新建议 C 可以从 B 继续调整，但每次只保留一条当前可应用建议。旧建议不作为内容父节点，不保存 proposal 分支树或 dependency_fact_ids。正文、岗位、scope 或 revision 变化后，旧建议标记 stale。

每轮优先处理最新用户指令。出现“30+”等含义不完整的信息时先追问；模型建议包含用户未提供的具体数字、组织、项目或技能时，内容校验拒绝该建议，不提供应用入口。

### 9.6 写入策略

AI Gateway 与业务写服务之间设置确定性的写入策略层：

1. 校验响应 Schema、动作枚举、目标所有权和 scope revision；
2. 只接受资料保存、岗位切换和简历修改三类业务动作；
3. 对用户应用的动作调用对应领域服务，不允许模型提供任意 API、SQL 或 JSON Patch；
4. 写入 ai_action_requests、resume_change_events、必要回执和 audit_logs；
5. 返回后端真实执行结果，前端不得根据模型文本乐观显示“已保存”。

策略矩阵：

| 动作 | 后端处理 | 数据影响 |
|---|---|---|
| actions 为空 | 仅回复或追问 | 不写业务数据 |
| PROFILE_SAVE_PROPOSAL | 展示保存内容；用户应用后写入 | 只更新资料，可撤销 |
| JOB_SET_CURRENT_PROPOSAL | 展示岗位；用户应用后切换 | 只更新 current_job_id 并分析，不改简历 |
| RESUME_REWRITE_PROPOSAL | 展示差异；用户应用后写入 | 只更新当前草稿和 change event |
| 未知、越权、目标过期或 Schema 非法 | 拒绝并安全返回 | 零写入 |

系统采用 fail-closed：分类不确定本身不构成错误，模型可以追问；但任何写动作在类型、目标、权限、revision 或服务状态无法确定时均不执行。相同 action_id 与 Idempotency-Key 重试不得重复写入。

RESUME_REWRITE_PROPOSAL 被用户应用后，只更新 resume_draft 并追加 resume_change_event，不创建历史版本。用户主动保存时创建 manual 版本；生成任务成功时创建 generated 版本。

### 9.7 状态与独立性

- ai_action_request 状态：proposed / applied / rejected / failed / reverted / stale / superseded；
- 对话请求入队时冻结 scope_type、scope_id 和 revision，后续 UI 选择变化不影响已发送请求；
- 资料保存后不自动修改简历；如有必要，创建新的 RESUME_REWRITE_PROPOSAL；
- 简历应用后不自动写入资料；如适合长期复用，另行提出 PROFILE_SAVE_PROPOSAL；
- 岗位切换后更新 current_job_id 并重新分析匹配，不直接重写简历；
- 同一任务只有 active_proposal_id 指向的简历建议可应用；应用前校验 base_target_hash 与当前岗位 revision；
- “应用”“确认”等短句只能绑定同一任务内唯一的当前动作；存在歧义时追问；
- 开始新对话时关闭旧 conversation，取消未完成任务并拒绝旧对话中的未应用建议；已保存资料、当前岗位、简历、模板和版本保持不变；
- 旧对话结束后返回的异步结果以 CONVERSATION_ENDED 终止，不得补写消息或动作；
- 操作审计记录 actor、action、target、time 和必要前后值，只用于安全、撤销和排错，不表达内容从哪里来。

系统提示词的可执行基线见 [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)。提示词只负责提高理解与建议质量，不能替代 Schema、权限、revision 和幂等校验。

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
- 具体数字、组织、职位、项目和技能均通过本次输入一致性校验；
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
- AI schema 通过率、内容一致性校验失败率、token 和成本；
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
| CONTENT_VALIDATION_FAILED | 生成内容包含无法确认的具体陈述 | 补充信息或调整要求后重试 |
| RENDER_PARTIAL | 部分格式生成失败 | 下载成功格式并重试 |
| QUOTA_EXCEEDED | 额度不足 | 等待额度恢复或升级 |
| PROVIDER_TEMPORARY | 外部服务暂时不可用 | 稍后自动/手动重试 |

客户端不展示供应商原始错误、堆栈和内部对象键。

## 15. 测试策略

### 单元测试

Schema 校验、完整度计算、revision 冲突、输入 hash、内容一致性检查、分页规则、额度结算。

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
- 版本详情可还原当时资料、岗位、模板和简历结果，两个版本可比较；
- 复制旧版本创建新草稿且不覆盖原版本；
- 跨用户访问返回 404；
- 删除账号后文件按策略清理。

### AI 评测

内容一致性、岗位相关性、简洁性、格式合规、敏感属性偏见、提示注入抵抗、中文语言质量。上线门槛以“不补造用户经历”为最高优先级。

### AI 行为契约测试

- 写入策略单元测试覆盖三种 action_type、revision 冲突、重复请求和 fail-closed；
- 模型契约测试校验每个响应符合 Schema，未知动作不能进入业务层；
- 集成测试验证“模型输出 → 建议展示 → 用户应用 → 领域写入 → 回执/审计”完整链路；
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
5. 观察错误率、任务积压和内容一致性校验；
6. 全量或回滚。

Worker 按队列分别扩容。AI 生成和渲染设置独立并发上限，防止外部供应商或 Chromium 消耗拖垮 API。

## 17. MVP 实施拆分

### 迭代 1：可编辑工作区

账号、项目、个人信息、自动保存、简历草稿/change events、主动保存版本、三种系统模板、实时预览。

### 迭代 2：多模态输入

语音转写、上传服务、文件扫描、岗位多图 OCR、岗位文本确认与分析。

### 迭代 3：生成闭环

生成快照事务、任务编排、generated 版本、AI 结构化生成、内容一致性校验、PDF/DOCX、进度恢复。

### 迭代 4：自定义模板与上线质量

PDF/Word/图片模板解析、版本比较/复制/导出、额度、审计、全链路监控、安全测试和灰度发布。

## 18. 关键技术决策

1. 用户版本深拷贝个人资料、岗位、模板和简历 JSON，不引用可变业务表。
2. 先提交数据库 outbox，再投递队列，避免“有快照无任务”。
3. AI 只输出严格结构化 JSON，文档由确定性渲染器生成。
4. 生成内容只做本次输入的一致性校验，不保存逐句归因；发现用户未提供的具体陈述时不出最终文件。
5. PDF 和 DOCX 并行生成，允许部分成功并单独重试。
6. 用户文件直传私有对象存储，解析全部在无网沙箱执行。
7. 编辑使用 revision 乐观锁，生成请求显式携带用户看到的 revision。
8. AI 自由组织对话回复；只有资料、岗位和简历写动作使用结构化协议，并由确定性写入策略执行。
9. AI 推测或含义不明的信息先追问；岗位变化和所有业务写动作均由用户明确应用，非法或不确定写动作采用零写入。
10. 已应用修改先进入可撤销草稿事件；只有用户主动保存或生成成功才进入历史版本。
