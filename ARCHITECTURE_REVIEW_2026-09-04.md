# 简历星球架构审视报告

- 审视日期：2026-09-04
- 审视对象：当前工作区中的前端、API、数据模型、AI Harness、文档引擎、异步任务、文件处理、测试与配套文档
- 审视方式：静态代码检查、架构约束对照、完整自动化测试、只读/无敏感内容输出的最小风险复现
- 结论适用范围：当前仓库实现，不等同于 `TECH.md` 中描述的未来生产目标架构

## 1. 执行结论

当前项目已经形成一套有价值的 AI Native 领域骨架，尤其是：

- 用单一 `ResumeDocument` 表达正文、结构、样式和资源；
- AI 先提出建议，用户确认后才写入；
- Harness、修改策略、DOM 执行器和真实差异预览已有清晰分工；
- 草稿 revision、修改事件、撤销、历史版本和生成快照已经串成主链；
- 大多数资源查询带有 `owner_id`，关键写操作有幂等和审计意识；
- 测试覆盖了许多复杂的 AI 建议应用、继续调整、并发手改和撤销场景。

但当前实现仍存在会阻止公开部署的重大缺陷。综合判断如下：

> 当前架构适合作为单机产品验证版本，不具备安全上线条件，也还没有完整兑现“以当前完整简历为唯一事实、由 AI 在其上协作”的产品架构。

其中最严重的问题不是技术栈是否先进，而是四条系统边界尚未真正闭合：

1. **安全边界未闭合**：Web 服务可直接返回 `.env`、SQLite 数据库、上传文件和服务端源码；认证可由请求头冒充；上传文件名还能逃逸对象存储根目录。
2. **当前简历事实边界未闭合**：一键生成没有基于当前完整 `ResumeDocument` 修改，而是重新从资料表拼装内容，可能丢失仅存在于当前简历或对话应用结果中的内容。
3. **并发与任务边界未闭合**：生成结束时可覆盖任务期间的用户新编辑；Outbox 无租约恢复；取消不能中断正在执行的任务；重试缺少最终成版幂等。
4. **AI 可靠性边界未闭合**：非数字事实主要依赖提示词约束，长对话没有持久化摘要，AI 请求没有 turn 级幂等与串行化，也没有完善的成本、限流和隐私治理。

建议先完成 P0 止血，再继续新增产品能力。若未经整改直接对公网开放，存在简历、联系方式、模型密钥和上传原件泄露，以及用户草稿被旧任务结果覆盖的现实风险。

## 2. 风险分级

| 等级 | 含义 | 当前数量 |
|---|---|---:|
| P0 | 可导致敏感信息泄露、越权、任意文件写入或用户内容丢失；上线前必须解决 | 4 |
| P1 | 会造成任务不一致、AI 行为不可靠、系统无法稳定扩展或核心产品约束失真 | 6 |
| P2 | 主要影响维护性、演进成本、可观测性和长期稳定性 | 5 |

## 3. P0：上线阻断问题

### P0-1 静态文件服务暴露整个仓库和所有用户数据

**现状**

`server/index.js:65-95` 将项目根目录作为 `STATIC_ROOT`。除 `/api/` 外的任意路径都会被传给 `fs.readFile`，没有静态文件白名单，也没有拒绝点文件、`server/`、`data/`、`.runtime/` 等目录。

本次最小复现只输出 HTTP 状态、字节数和内容哈希，没有打印敏感内容，结果为：

```text
/.env                 -> 200，560 bytes
/server/lib/auth.js   -> 200，1693 bytes
/data/resume.db       -> 200，9220096 bytes
```

这意味着当前服务一旦被其他设备或公网访问，攻击者不需要登录即可下载：

- `.env` 中的模型 API Key、下载签名密钥等配置；
- SQLite 数据库中的个人资料、简历、对话、岗位、版本和审计记录；
- `data/objects` 中的上传原件、识别预览、PDF、DOCX 和 HTML 产物；
- 全部服务端源代码和内部文档。

现有产物下载令牌与 `owner_id` 授权会因此失去意义，因为对象文件和数据库可绕过 API 直接读取。

**整改要求**

1. 静态服务只允许显式清单，例如 `index.html`、`resume-dom.js` 和 `assets/` 中允许公开的文件。
2. 更稳妥的方式是把公开文件放入独立 `public/` 目录，服务器绝不以仓库根目录作为静态根。
3. 对规范化后的绝对路径使用 `path.relative` 做目录边界判断，拒绝 `..`、绝对路径、点文件和符号链接逃逸。
4. `data/`、`.runtime/`、`.env`、`server/`、`tests/` 和产品内部 Markdown 必须永久位于静态根之外。
5. 添加回归测试，断言上述路径全部返回 404。
6. 如果此服务曾在非可信网络中运行，应立即轮换 `.env` 中的全部密钥。

### P0-2 认证可冒充，且与宽松 CORS 组合形成完整账户接管

**现状**

`server/lib/auth.js:12-23` 直接信任客户端传入的 `x-user-id`。只要数据库里存在该用户，就会把请求当成该用户执行；没有会话、JWT、签名、过期时间或服务端身份验证。不传请求头时又会自动进入演示账号。

`server/index.js:105-108` 同时把请求中的任意 `Origin` 原样写入 `Access-Control-Allow-Origin`，并允许跨域发送 `x-user-id`。

结合 P0-1，攻击者可以先下载数据库获得全部用户 ID，再通过 `x-user-id` 读取或修改任意用户数据。即使关闭静态数据库泄露，只要用户 ID 从日志、链接或其他接口泄露，仍可被冒充。

**整改要求**

1. 默认使用真实服务端会话或经过验证的 JWT/OIDC token，业务代码只接收认证中间件解析出的主体。
2. `x-user-id` 只能在明确的测试环境注入；生产启动时检测到该模式必须拒绝启动。
3. 演示账号自动登录只能绑定 `127.0.0.1` 且由显式 `DEMO_MODE=true` 开启。
4. CORS 改为固定来源白名单；同源部署时可完全关闭跨域。
5. 增加 CSRF 策略、安全 Cookie、登录态吊销、会话过期和账户状态校验。
6. 数据库层增加租户隔离约束；迁移 PostgreSQL 后使用 RLS 或等效的强制策略作为第二道防线。

### P0-3 上传文件名可逃逸对象存储目录，形成任意文件写入

**现状**

`server/modules/uploads.js:55-68` 接受用户提交的 `original_name`，只检查最后一个扩展名。

`server/lib/storage.js:17-27` 把未经清理的原文件名拼入对象键，再直接交给 `path.join` 和 `fs.writeFileSync`。对象存储层没有验证最终路径仍位于 `OBJECTS_DIR`。

本次只计算路径、没有写文件。使用文件名 `../../../../../../outside.pdf` 时，最终路径已经落到 `data/objects` 之外：

```text
inside OBJECTS_DIR = false
resolved path = /home/ubuntu/codex/project/resume/outside.pdf
```

增加更多 `../` 后可继续向工作区之外逃逸。在 P0-2 的默认演示账户模式下，未认证访问者也能创建上传会话并触发写入。

**整改要求**

1. 对象键不得包含用户提供的文件名，只使用服务端生成的不可预测 ID，例如 `{ownerId}/{uploadId}/original.bin`。
2. 原文件名只作为数据库元数据保存，展示和下载时再进行安全清理。
3. `putObject/getObject/objectPath` 必须统一执行根目录约束：`path.relative(root, target)` 不得以 `..` 开头，也不得为绝对路径。
4. 禁止路径分隔符、控制字符、NUL 和超长文件名。
5. 上传状态必须真实流转为 `uploading -> quarantined -> scanning -> ready/failed`，不能只在响应中声称 `quarantined`。
6. MIME magic bytes 不能替代病毒扫描；Office、PDF 和图片应在低权限隔离进程中解析。

### P0-4 生成任务可能丢失当前简历内容，并覆盖任务期间的新编辑

这个问题直接违反仓库的核心产品约束。

**问题 A：生成内容没有以当前完整文档为事实**

`server/lib/queue.js:141-167` 在生成阶段从 `profilePayload.experiences` 调用 `composeResume` 重新构造简历，只把当前 `resumeInput` 的 `page_setup`、`styles` 和 `assets` 复制到新文档。

当前简历中的下列内容可能被丢弃：

- 用户只在当前简历中直接修改、但没有回填资料的内容；
- 用户在对话中提供并应用到简历、但没有另存资料的事实；
- 文件导入保留的动态模块、表格、分栏、图片和自定义结构；
- AI 新增的任意安全模块；
- 当前文档中存在但资料表没有对应字段的内容。

生成成功后，`server/lib/queue.js:322-335` 又把重建后的结果写回当前草稿。因此这不是仅影响导出，而是会实际替换用户正在维护的唯一完整文档。

**问题 B：任务完成时无条件覆盖并发编辑**

生成创建时虽然冻结了输入，但快照没有把“开始生成时的草稿 revision”作为最终采用前置条件。任务执行期间用户可以继续修改草稿；finalize 时只读取最新 draft 行，然后无条件 `revision + 1` 并覆盖正文。

因此会出现：

```text
用户从 revision 10 发起生成
→ 用户继续编辑，草稿到 revision 11
→ 旧生成任务结束
→ 服务端用基于 revision 10 的结果覆盖 revision 11
```

历史版本仍会创建，但用户的新编辑会从当前草稿消失。

**整改要求**

1. 一键生成必须以冻结的完整 `ResumeDocument` 为主输入，资料、岗位和对话要求只作为辅助上下文。
2. 模型输出应是对该文档副本的受控 operations 或完整候选文档，继续复用现有 Change Policy、DOM Engine 和 Renderer。
3. 所有未被明确授权调整的节点必须保留，尤其是动态模块和导入结构。
4. readiness 应同时读取当前文档、资料和已明确应用的对话结果，不能要求资料表必须完整。
5. 快照中记录 `base_draft_revision` 和 `base_document_hash`。
6. finalize 时：
   - 如果草稿仍等于冻结基线，可以更新当前草稿并创建版本；
   - 如果用户期间继续编辑，只创建生成版本，不覆盖当前草稿，并提示“生成结果已保存，可查看或复制继续”；
   - 不允许静默 last-write-wins。
7. 增加“资料为空但当前简历完整”“生成期间继续编辑”“包含自定义模块的导入简历生成”三组 P0 测试。

## 4. P1：高优先级架构缺陷

### P1-1 Outbox 没有租约、崩溃恢复和原子领取

`server/lib/queue.js:653-690` 先查询 `pending`，再逐条更新为 `processing`。缺少：

- 条件更新或 `SELECT ... FOR UPDATE SKIP LOCKED` 等原子领取；
- `locked_by`、`locked_at`、`lease_expires_at`；
- 进程崩溃后将过期 `processing` 任务重新入队；
- 死信队列、人工重放和积压告警；
- 多 Worker 并行时的重复消费保护。

如果进程在标记 `processing` 后退出，该事件将永久卡住，因为启动后只查询 `pending`。此外，`running` 没有放在 `finally` 中复位；循环外异常可能让本进程此后永远返回 0。

建议把当前表明确升级为“可恢复任务队列”，即使暂时不引入 Redis，也应实现带租约的数据库领取协议。

### P1-2 取消不是真正取消，重试也不是“只重跑失败步骤”

`server/modules/generations.js:356-380` 只把任务状态更新为 `canceled`。

`server/lib/queue.js:102-106` 仅在任务刚开始时检查一次取消状态。之后的分析、渲染和 finalize 都不再检查，也没有传递 `AbortSignal`。因此任务运行中点击取消，Worker 仍可能继续创建版本并覆盖草稿。

同时，`server/modules/generations.js:330-342` 的注释写“只重跑失败步骤”，实际仍重新投递整个 `generation.created`，`runGeneration` 会从头执行全部步骤。

建议：

- 在每个阶段边界检查取消；
- 对模型、OCR、LibreOffice、渲染子进程传递取消信号；
- 明确步骤产物和 step state，重试只复用已成功且校验值一致的产物；
- finalize 必须再次检查取消状态。

### P1-3 同一生成快照可以产生多个历史版本，最终提交缺少幂等键

`resume_versions.generation_snapshot_id` 只有普通外键，没有唯一约束，见 `server/schema.sql:261-279`。

`server/lib/queue.js:268-307` 每次 finalize 都直接插入新版本。重复消费、任务重试或 Worker 并发执行时，理论上可以为同一快照创建多个 generated 版本。

`generation_jobs.snapshot_id` 和 `resume_outputs.snapshot_id` 已是唯一，但最关键的最终版本没有同样的约束。

建议：

- 增加 `UNIQUE(generation_snapshot_id)` 的部分唯一索引；
- finalize 使用 upsert/compare-and-set，只允许从未完成状态进入一次终态；
- 产物登记使用稳定业务键，而不是每次生成新 UUID 后再依赖内容哈希碰撞；
- 增加重复投递、Worker 崩溃后重放、partial retry 三类测试。

### P1-4 AI 对话是长耗时同步请求，缺少 turn 级状态机、幂等与并发控制

`server/modules/ai.js:1235-1339` 的处理顺序是：

1. 写入用户消息；
2. 同步调用模型；
3. 模型完成后再写助手消息和建议。

问题包括：

- 模型超时或进程退出后会留下只有用户消息的“半轮对话”；
- 客户端重试会新增一条重复用户消息，因为该接口没有 Idempotency-Key；
- 同一会话可并发发送多轮，较晚返回的旧请求可能覆盖 active proposal 状态；
- 无 per-conversation sequence、turn status、request hash 或运行锁；
- HTTP 连接生命周期与模型任务生命周期耦合，不利于恢复、取消和流式进度；
- 大图片附件被一次性读取并转成 base64，附件数量没有单轮上限。

建议新增 `ai_turns` 或等价状态对象：

```text
accepted -> queued -> running -> validating -> awaiting_user -> completed/failed/canceled
```

每轮使用 `conversation_id + client_turn_id` 唯一；同一会话默认串行；模型调用进入独立任务；浏览器通过 SSE 获取回复进度；用户消息、助手消息和动作在最终事务中关联到同一 turn。

### P1-5 长对话会丢失关键事实，当前“摘要”接口实际上没有落地

`server/lib/resume-harness/memory-manager.js:3-36` 只保留最近 40 条、最多 24000 字。

`buildHarnessInput` 虽然接受 `conversationSummary`，但 `server/modules/ai.js:606-645` 调用时没有传入该值，数据表也没有可持续更新的对话摘要或结构化会话记忆。

当资料是可选对象、用户可以只通过对话完成简历时，较早提供的经历、数字或限制条件会随着上下文截断而消失。这会同时影响：

- 后续改写是否记得用户事实；
- 非捏造校验的允许内容集合；
- 多轮建议继续调整；
- 模型是否遵守用户早期提出的写作偏好。

建议采用“短期原文窗口 + 可审计摘要 + 明确用户约束”的三层记忆：

- 最近若干完整消息；
- 由后台任务生成、带版本号的会话摘要；
- 不自动写入资料的本会话事实与偏好，仅作为会话上下文使用；
- 每次摘要更新保留覆盖到的最后 message sequence，避免重复或遗漏。

这里不需要建立产品层面的“来源/证据映射”，只需管理模型上下文。

### P1-6 “不捏造事实”的确定性保护只覆盖部分数字

`server/lib/resume-schema.js:46-84` 的 `validateContentSafety` 主要检查带单位的数字，如人数、百分比、倍数和年/月。

它无法阻止模型新增：

- 未提供的公司、学校、客户或项目名称；
- 未提供的技能、证书、岗位和职责；
- 不带当前正则单位的日期、金额、版本号和指标；
- 把岗位要求错误写成用户已经具备的能力；
- 对已有事实作语义夸大，但不引入新数字。

当前系统提示词和修改区域策略设计较好，但提示词不是事实完整性的强制安全边界。

建议增加临时、非持久化的 claim validation：

1. 从候选改动中提取新增的命名实体、日期、数字、技能和可核验陈述；
2. 与当前简历、资料和本会话用户明确提供的文本做蕴含/冲突校验；
3. 高风险 claim 无法确认时转为追问，而不是进入可应用建议；
4. 校验结果只服务本次决策和审计摘要，不建立资料到正文的长期派生关系。

## 5. P2：中期演进问题

### P2-1 现行数据模型仍保留已废弃模板概念

项目约束明确“不建立模板、排版预设、模板版本或槽位绑定”。但当前仍存在：

- `template_definitions`、`template_versions`；
- `resume_projects.current_template_version_id`；
- `resume_versions.template_payload`；
- `generation_snapshots.template_payload`；
- `document_imports.applied_template_version_id`；
- `server/modules/templates.js` 和 `server/lib/templates.js`；
- 草稿撤销和生成链中的兼容模板逻辑。

虽然模板路由未被注册，部分字段也被写入 `{}`，但它们仍让领域模型、迁移、外键和代码阅读持续围绕已废弃概念展开。

建议把兼容读取集中到单独 adapter，在一次有版本的数据库迁移后从现行写模型移除模板表和字段。历史版本只保留完整 `resume_payload`。

### P2-2 数据库迁移和数据清理在应用启动路径同步执行

`server/lib/db.js:290-393` 在第一次打开数据库时直接执行：

- 建表；
- `ALTER TABLE` / `DROP TABLE` / `DROP COLUMN`；
- 全表 JSON 清洗；
- 全量 change event 压缩；
- 触发器删除与重建。

这会造成：

- 数据量增长后启动时间不可预测；
- 启动期间长时间持有写锁；
- 多实例滚动发布时不同版本同时改 schema；
- 迁移失败难以明确恢复；
- 迁移版本、执行记录和回滚策略不可追踪。

建议引入只向前的版本化迁移，部署阶段先执行 migration job，应用启动只校验 schema version，不自行改变历史结构。

### P2-3 同步 SQLite、同步文件 IO 和 CPU 渲染共享 API 事件循环

当前使用 `DatabaseSync`、`fs.readFileSync/fs.writeFileSync`，PDF/DOCX 渲染也与 API/Worker 同进程。单个大型导出、数据库清理或对象读取都会影响所有请求和 SSE 心跳。

短期可拆成 `api` 与 `worker` 两个进程；中期迁移 PostgreSQL、对象存储和独立渲染 Worker。即使保持单机，也应使用明确的进程隔离和资源上限。

### P2-4 缺少生产运行所需的限流、健康检查与可观测性

当前主要依赖 `console.log/error` 和 SQLite 审计表，没有发现：

- `/healthz`、`/readyz`；
- 结构化日志及稳定字段；
- 请求耗时、模型耗时、队列延迟、失败率、token 和成本指标；
- Trace ID 在 API、Outbox、Worker、模型和渲染链路中的贯通；
- 用户级与 IP 级限流；
- 模型预算、附件数量和并发任务配额；
- 优雅停机与 Worker drain。

尤其 `generation_jobs.token_usage_json` 和 `cost_amount` 已建字段，但当前一键生成不调用模型，也没有形成统一成本账本；AI 对话的模型 usage 只进入响应元数据流程，没有系统级聚合。

### P2-5 关键模块过大，契约没有独立成共享包

当前规模：

- `index.html` 约 1633 行、153 KB；
- `resume-dom.js` 约 1599 行；
- `server/modules/ai.js` 约 1492 行；
- `server/lib/queue.js` 约 718 行。

单文件本身不是问题，但 UI、状态、API client、对话状态机和导入流程集中在 `index.html`；AI route、上下文组装、建议持久化、应用与撤销集中在一个服务模块，已经增加修改时的连带风险。

建议在不改变产品结构的前提下拆出：

- `contracts`：API DTO、AI action schema、ResumeDocument schema；
- `resume-core`：DOM、diff、operations、preconditions、change policy；
- `ai-orchestration`：turn、context、memory、model adapter、validation；
- `generation`：snapshot、workflow、finalize；
- `web` 内部模块：API client、workspace store、resume canvas、AI panel、version browser。

`index.html` 仍可作为唯一真实入口，不代表所有实现必须继续放在一个文件中。

## 6. 数据一致性与多租户补强

当前很多查询已经显式带 `owner_id`，这是好的基础。但 schema 中同时在多张表重复保存 `owner_id`，外键只约束资源 ID，不约束这些资源必须属于同一个 owner/project。

例如项目的 `current_profile_id`、`current_job_id`，以及版本、快照、产物之间的 owner 一致性主要依赖业务代码。任何遗漏 owner 条件的后台任务或迁移都可能制造跨租户关联。

建议：

- PostgreSQL 使用复合唯一键和复合外键约束 `(id, owner_id)`；
- 对核心业务表启用 RLS；
- 后台 Worker 同样在租户上下文中查询，不能只按全局 UUID；
- 为状态字段增加 `CHECK`；
- 为“产物至少关联一个业务对象”增加数据库约束；
- 为版本和快照建立完整唯一关系；
- 对软删除、过期上传和孤儿对象建立定期回收任务。

## 7. 测试结果与覆盖缺口

### 7.1 当前结果

2026-09-04 执行：

```bash
npm test
```

结果：

```text
tests: 105
pass: 103
fail: 2
duration: 约 27 秒
```

失败项：

1. `tests/resume-change-policy.test.js`
   “相邻节点可以在原区域槽位内包裹成新的可选内容组”失败，策略把 `next-title` 判断为超出允许区域。
2. `tests/resume-change-preview.test.js`
   预期“将2项内容合并为1项，修改1处文字”，实际为“将2项内容合并为1项，同时调整文字”。

第二项主要是文案契约差异，第一项涉及区域授权判断，可能影响真实 AI 结构操作，应在发布前修复。

### 7.2 现有测试的优点

- AI 三类动作和用户确认边界；
- 模型输出 fail-closed；
- 结构操作内容守恒；
- DOM 稳定 ID 与前置条件；
- 手改与 AI 建议并行；
- 撤销冲突；
- 导入、版本、产物和用户隔离；
- 原型与真实页面结构一致性。

### 7.3 必须新增的测试

优先新增以下测试套件：

**安全**

- 静态路径不得读取 `.env`、数据库、对象目录和服务端源码；
- `x-user-id` 在非测试环境无效；
- 未认证请求默认 401；
- 恶意上传文件名不能逃逸对象根目录；
- 超量附件、超大 AI 请求和高频请求被拒绝；
- CORS 只允许配置来源。

**生成一致性**

- 当前完整简历内容优先于资料；
- 资料为空但当前简历完整时可生成；
- 自定义动态模块在生成后保留；
- 生成期间用户继续编辑时不覆盖新草稿；
- 同一 snapshot 重复消费只创建一个版本；
- cancel 后不会 finalize；
- partial retry 不重复生成已成功产物和版本。

**任务恢复**

- `processing` 租约过期后自动重领；
- Worker 在任意步骤退出后可恢复；
- 两个 Worker 并发只能有一个成功领取任务；
- 未知事件进入死信而不是静默 done。

**AI turn**

- 同一 client turn 重试不重复写用户消息；
- 同会话并发请求按序执行或明确拒绝；
- 模型超时后 turn 可重试并保留完整状态；
- 长对话摘要后仍记得早期用户事实；
- 新增非数字事实会触发校验或追问。

## 8. 建议的目标架构

不建议立即为了“架构高级”拆成大量微服务。当前更合适的是模块化单体加独立 Worker，先把边界做实：

```text
Browser
  └─ Web Application
       ├─ Workspace UI
       ├─ Resume Canvas
       └─ AI / Generation SSE Client

API Process
  ├─ Auth + CORS + Rate Limit + Request Validation
  ├─ Workspace / Profile / Job / Version Application Services
  ├─ Resume Command Service
  ├─ AI Turn Service
  ├─ Generation Service
  └─ Artifact Gateway

Shared Domain Core
  ├─ ResumeDocument Schema
  ├─ Resume Operations
  ├─ Change Policy
  ├─ Diff / Preview
  └─ Version / Snapshot Invariants

Worker Process
  ├─ AI Turn Worker
  ├─ Generation Worker
  ├─ Document Recognition Worker
  ├─ OCR Worker
  └─ Render Worker

Infrastructure
  ├─ PostgreSQL + Outbox + RLS
  ├─ Redis/BullMQ（达到并发需求后再引入）
  ├─ Private Object Storage
  ├─ Model Provider Adapter
  └─ Logs / Metrics / Traces
```

关键原则：

1. `ResumeDocument` 是唯一简历事实。
2. 用户资料、岗位和对话是输入上下文，不是重新生成简历的替代事实。
3. 模型永远不能直接写业务表，只产出回复或候选命令。
4. 所有简历写入都经过同一套 command、policy、revision 和 change event。
5. 长耗时工作都由可恢复任务执行。
6. 快照不可变，采用生成结果必须显式处理当前草稿是否已变化。
7. 安全授权同时存在于 API 层和数据层。

## 9. 分阶段实施建议

### 阶段 0：安全止血，1—2 天

- 静态资源改为白名单或独立 public 根目录；
- 禁用生产 `x-user-id` 和默认演示登录；
- CORS 改为固定白名单；
- 对象键改为纯服务端 ID，并加入目录边界校验；
- 生产环境缺少真实下载密钥时拒绝启动；
- 增加安全回归测试；
- 轮换可能已经暴露的密钥。

**退出标准**：敏感路径全部 404；未认证 API 全部 401；恶意文件名无法写出对象根目录。

### 阶段 1：修复简历事实与生成并发，3—5 天

- 生成链改为基于完整 `ResumeDocument`；
- readiness 同时检查当前文档和资料；
- 快照冻结 base revision/hash；
- finalize 使用 compare-and-set；
- 并发编辑时只保存生成版本，不覆盖当前草稿；
- 给 `generation_snapshot_id` 增加唯一约束；
- 补齐 P0 生成测试。

**退出标准**：任何生成、重试、重复投递和并发编辑都不会丢失用户内容，也不会重复成版。

### 阶段 2：任务与 AI turn 状态机，1—2 周

- Outbox 加原子领取、租约、心跳、恢复和死信；
- 取消信号贯穿模型、识别和渲染；
- AI 消息改为 turn 状态机；
- 加 client turn id、幂等、会话串行和任务 SSE；
- 限制消息、附件数量、总像素和 token 预算；
- 增加会话摘要和上下文版本。

**退出标准**：进程在任意步骤退出后可恢复；同一轮不会重复；取消后不会产生业务结果。

### 阶段 3：生产基础设施，2—4 周

- 版本化数据库迁移；
- PostgreSQL、复合租户约束和 RLS；
- 私有对象存储与病毒扫描；
- API/Worker 进程拆分；
- 健康检查、结构化日志、指标、Trace、告警；
- 模型成本和质量评测看板；
- 清理模板遗留模型和兼容代码。

## 10. 建议跟踪的架构指标

**安全**

- 未认证成功请求数必须为 0；
- 越权资源读取数必须为 0；
- 静态敏感路径暴露数必须为 0；
- 上传隔离失败数和恶意文件拦截数。

**一致性**

- 同 snapshot 多版本数必须为 0；
- 生成覆盖并发草稿数必须为 0；
- 卡在 processing 超过租约的任务数；
- change event 与 draft revision 不一致数。

**AI**

- 模型结构输出首次通过率与修复后通过率；
- 被 Change Policy 拦截的动作比例；
- 用户应用率、撤销率和重新生成率；
- unsupported claim 拦截率；
- 每轮 token、费用、首字延迟和总延迟；
- 长对话摘要命中率与事实遗忘回归结果。

**运行**

- API P50/P95/P99；
- 队列等待时间和任务总耗时；
- OCR、文档识别、PDF、DOCX 分步骤成功率；
- Worker 崩溃恢复时间；
- SSE 断线与状态补偿成功率。

## 11. 最终判断

### 是否存在重大缺陷？

存在，而且至少有四项属于上线阻断级：

- 敏感文件和所有业务数据可经静态路径直接下载；
- 客户端可通过用户 ID 冒充身份；
- 上传文件名可导致对象目录逃逸和任意文件写入；
- 一键生成可能丢失当前完整简历内容，并覆盖生成期间的新编辑。

### 是否有进步空间？

有较大空间，但不需要推翻重做。最值得保留的是现有 `ResumeDocument + Change Policy + DOM Operations + Revision + Version Snapshot` 主链。正确的演进方式是：

1. 先封闭安全和并发边界；
2. 让一键生成真正建立在当前完整文档上；
3. 把 AI 对话和异步任务升级为可恢复状态机；
4. 最后再替换数据库、队列和对象存储。

完成前三步后，这个项目才会从“具备 AI Native 设计思想的原型实现”进入“可以承载真实用户数据和真实 AI 协作的产品架构”。
