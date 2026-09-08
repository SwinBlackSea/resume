# 简历星球 · AI Native 简历工作台

产品与技术基线已更新为 **PRD v2.15.0**、**TECH v2.15.0**：首页统一输入，编辑页围绕当前简历与 AI 对话；资料和岗位按需补充，不要求先建档或选模板。完整文档、既有资料、导入、局部/全局 AI、五步撤销、历史和下载继续复用。

v2.15.0：附件上传后待提交，首次空白生成直接展示成稿并自动保存不可变版本；已有/复用简历仍需应用修改。制作另一份使用独立项目，完整复制文档与独立岗位，不复制聊天或覆盖原稿；首页可返回既有简历。PDF/Word 在发送时识别一次并用于后续对话，不写个人档案。公开岗位链接真实读取，失败提示粘贴描述或截图；岗位搜索明确打开外部搜索页，未集成站内招聘搜索 API。停止维护独立原型，真实页面与自动化测试为准。

v2.14.1：`+/-` 以完整列表项、经历块、表格行/合并行组为默认边界，内部段落增删显式选择，完整保留子树。聊天支持选图、粘贴、拖入、纯图发送及后续多轮看图，不自动写入资料；新对话清理旧聊天专用图片。真实 Chromium 回归包含嵌套结构、全部缩放、连续点击、自动保存、撤销重做，以及可选的公开 DOCX/PDF 文件样本。

v2.14.0全局聊天：明确要求直接生成可预览建议，取消按修改复杂度强制确认思路；自然追问、解释和应用后的对话持续承接。失败可直接重试原要求，后台状态可跨刷新恢复，支持停止生成并阻止迟到回写；重叠片段恢复保留独立修改，最终建议原子提交。所有正文变更仍需用户点击应用。

v2.13.2存储治理：全局新对话创建成功即删除项目此前聊天、任务和建议；局部应用成功或放弃后清空该任务历史，失败保留重试链。幂等缓存不重复保存整份简历，过期撤销只保留操作摘要；当前草稿、资料、版本和有效五步撤销/重做独立保留。新旧请求并发时通过取消信号与数据库状态双重阻止回写。

局部AI用Flash处理纯文本，保持轻量且不推理；全局AI及恢复使用Pro与low推理强度，读取整份简历的真实节点、文字、样式和页面设置，不降低文档能力。旧对话滚动整理并复用任务记忆，最近对话和本轮原话完整保留。模型默认返回最小修改，后端继承未返回字段；已有简历的正文变更仍需用户应用。server/harness/model-gateway/供应商adapter职责分离，重试诊断不得替换最后一条用户要求。

画布现在读取根节点样式及完整页面设置，HTML/PDF/DOCX共用页面尺寸与边距换算。静态服务只公开前端入口与必需脚本，不公开仓库文件。PDF/DOCX仍使用语义导出引擎，尚不能宣称任意CSS效果都与浏览器完全一致。

- 前端：`index.html`（单一 HTML，页面设计唯一来源，见 `AGENTS.md`）
- 后端：`server/`（Node.js 24，依赖见 `package.json`）
- 测试：`tests/`（统一语义树、语义增删、局部多轮承接、全局完整上下文、三方合并、文件导入、文档事务、版本闭环，以及真实首页/编辑页/多份简历流程）

文档分工：

- [PRD.md](./PRD.md)：当前产品规则和发布验收，正文只保留现行口径；
- [TECH.md](./TECH.md)：目标架构、数据协议、接口和技术不变量；
- [SYSTEM_PROMPT.md](./SYSTEM_PROMPT.md)：AI 理解与动作输出协议；
- [AI_BEHAVIOR_TESTS.md](./AI_BEHAVIOR_TESTS.md)：AI 行为发布门槛；
- [AGENTS.md](./AGENTS.md)：仓库内长期有效的实现约束；
- 本 README：启动方式、当前实现状态和生产演进。

---

## 1. 快速开始

```bash
node -v                           # 需要 >= 22.5（内置 node:sqlite）
npm install
npm run setup:document-recognition # 首次启用 PDF/Word/图片识别时执行
npm start                         # 启动服务：http://localhost:8787
npm test                          # 运行全部测试
npm run reset                     # 重置演示数据库
```

完整文档识别还需要系统提供 LibreOffice 与 Poppler 命令行工具。Ubuntu 可安装
`libreoffice` 和 `poppler-utils`；OCR 与页面场景所需的 Python 依赖由上述 setup
脚本安装到项目内 `.runtime/document-recognition/venv`，不要求 Docker。

首次启动会自动初始化演示简历与数据（陈知行 · 高级产品经理岗位，
与 `AI_BEHAVIOR_TESTS.md` 的测试夹具一致：城市上海、客户激活率 26%/付费转化率 18%，
并包含 3 个历史版本）。

打开 <http://localhost:8787> 进入统一输入首页；下方可返回已有简历。编辑地址为 `/?project=项目ID`。

---

## 2. 架构总览

```
浏览器 index.html
   │  嵌入 resume-dom.js（完整文档渲染、编辑事务与节点定位）
   │  /api/v1/*（REST + SSE）
   ▼
server/index.js ── 路由分发、静态服务、错误处理（RFC 7807）
   │
   ├─ modules/   业务模块（项目/资料/岗位/上传/文档草稿/AI/版本/生成/产物）
   ├─ lib/       基础设施（db、policy、resume-harness、model-client、queue、render、storage…）
   └─ schema.sql 数据模型（业务表 + 冻结触发器 + 唯一约束）

异步链路：业务事务 → outbox_events → Worker → 对象存储/数据库 → SSE → 浏览器
```

| 层 | 实现 | 说明 |
|---|---|---|
| Web | `index.html` | 统一输入首页、当前简历与对话、已有简历导航 |
| API | 内置 `http` + 自研路由 | REST `/api/v1`，支持 `Idempotency-Key` |
| 数据库 | `node:sqlite`（SQLite） | 承载 TECH §7 全部表与约束，生产可换 PostgreSQL |
| 队列 | 进程内 Worker + `outbox_events` | 先落库再投递，避免「有快照无任务」 |
| 对象存储 | `data/objects` 本地目录 | 私有桶语义，下载走短期签名 URL |
| AI 编排 | `lib/resume-harness/` | 共用自然会话骨架；全局读取精简语义树并装配完整 B，局部读取纯文本并只生成锁定文字 |
| 模型客户端 | `lib/model-client/` | 供应商无关调用契约；DeepSeek 适配器使用 Responses API、严格 Schema、流式解析与分级超时 |
| 文档组件 | `resume-dom.js` | 完整 ResumeDocument、语义类型、真实父子树、文字事务、稳定节点 ID、AI 投影与旧草稿转换 |
| 渲染 | `lib/render/{pdf,docx,html}.js` | ResumeDocument → PDF/DOCX/HTML |

---

## 3. 前端：直接迭代真实产品

实现方式：

- **样式**：`index.html` 为真实入口；`index.prototype.backup.html` 仅保留历史参考，不维护、不参与验收。
- **结构**：首页统一输入及简历列表；编辑页为画布与 AI 对话，材料按需补充，不再固定显示左栏资料卡。
- **内容**：初始数据由后端 seed 提供（陈知行、3 个版本、8/11 项要求覆盖）；
  旧原型中的来源、待确认事实和资料到正文使用关系不再展示。
- **交互**：现有文字直改、正文旁就地改写、右侧全局 AI、`@作用范围`、改写方案卡片、撤销栏、版本浏览器、
  生成进度、缩放、拖拽导入均调用真实接口；简历编辑栏在画布内吸附，滚动后自动收紧。切换简历前等待文字保存，失败留在原页。
- **动态正文**：不再由前端写死工作、项目、教育等模块；通用组件遍历正文树。
  现有文字可按节点直改；光标指向可编辑 DOM 时，简历页面内才显示 `+/-`，可递归复制完整参考子树或删除当前完整语义单元；模块标题会区分增加内容与新增同级模块。移动、合并、拆分、样式和页面调整仍由 AI 表达最小变化区域。
- **历史版本**：详情复用通用文档渲染器；比较默认覆盖历史版本与当前实时草稿；
  从旧版本继续时复制完整文档，并先保护未保存修改。
- **验证**：`tests/workspace-ui.test.js` 将旧原型比对中有效的行为迁移为真实 DOM 与服务端文档断言；
  `tests/resume-first-flow.test.js` 通过 API 和真实 Chromium 验证首页提交、预览、独立复制、返回、保存、链接失败及附件隔离。

---

## 4. 延续保留的能力

### 4.1 简历、可选材料与对话的独立边界

| v2.13.1 能力 | 规则 | 当前实现状态 |
|---|---|---|
| 资料可选 | 资料、简历和对话是平级输入 | 已实现上下文分离 |
| 对话内容可直接用于简历 | 用户明确提供的信息无需先保存资料即可进入修改建议 | 已实现 |
| 保存资料与应用简历独立 | 同一消息可以产生两个建议，分别应用 | 已实现三动作协议 |
| 资料与简历不自动同步 | 修改任一侧都不静默改变另一侧 | 已实现 |
| 无内容来源模型 | 不保存证据映射、条目来源或资料到正文依赖 | 已实现并提供旧库迁移 |
| 草稿与版本分离 | 普通修改只更新草稿；主动保存、生成成功和完整文件导入按规则成版 | 已实现 |
| 版本保持平级 | 复制版本只生成新草稿，不覆盖原版本 | 已实现 |
| 动态简历结构 | 任意安全节点可渲染、修改、撤销和导出 | 已实现 |
| 完整历史比较 | 版本详情和比较复用动态正文树，默认对比实时草稿 | 已实现 |
| 真实历史缩略图 | 每个版本按冻结完整文档展示第一页，旧版本按需补生成 | 已实现 |
| 安全继续修改 | 未保存修改先保存或明确放弃；资料不被历史版本覆盖 | 已实现 |
| 单一完整文档 | 正文、页面、样式、资源和语义标记由 ResumeDocument 一体保存 | 已实现 |
| 统一语义树 | DOCX/PDF 等导入结果使用相同 semantic kind；父子关系只由 children 表达 | 已实现 |
| 分层 AI 上下文 | 局部只发纯文本；全局保留原生节点字段、全文、富文本、样式、布局、页面和资源描述 | 已实现；输入输出同形，正文不摘要 |
| 长任务记忆 | 旧对话滚动摘要，最近原话不截断，缓存按任务和消息前缀校验 | 活跃任务保留原文，结束后按生命周期清理 |
| 模型基础设施边界 | gateway只放行模型协议字段，adapter不处理业务，harness有界恢复 | 已实现；计量不记录正文 |
| 会话式模型输入 | 系统规则、只读上下文、任务内 `user/assistant` 历史、本轮 user 依次发送；局部用 working set 聚焦当前文字与原始指令 | 已实现；前端只传动作或任务 ID，后端重建 |
| 稀疏变化继承 | 模型只返回改变字段；标题标签、富文本、样式与资源由服务端继承 | 已实现 |
| 现有文字直改 | 无需模式切换；停顿或失焦后自动保存，可撤销但不自动成版 | 已实现 |
| 语义节点增删 | 正文旁 `+/-` 按真实父子关系新增同级内容或删除当前单元；标题增加提供两种明确结果 | 已实现；固定坐标页面不直接新增，底图含原文字时也不直接删除 |
| AI 结构调整 | 模块、段落、样式和页面操作只在应用建议后写入 | 已实现 |
| 正文旁就地改写 | 只修改当前文字或选区，不调整结构、不进入右侧会话 | 已实现 |
| 双入口状态隔离 | 点击正文不暗中切换右侧作用范围；转到对话时才显式切换 | 已实现 |
| 局部确认顺序 | 同位置以后发起请求为准；不同入口以最后确认结果为准 | 已实现 |
| 局部并发恢复 | 换位置、关闭、超时和迟到结果均可安全回收或重试 | 已实现 |
| 局部确定性约束 | 明确字数上限由服务端按真实字符数校验；超限或无变化自动恢复一次 | 已实现；再次不合格不进入待应用 |
| AI 双结果协议 | 沟通过程统一为 `message`，最终可应用结果统一为 `proposal` | 已实现；旧四态仅用于历史消息兼容 |
| 任务上下文隔离 | 用户、项目、会话、任务四级归属；任务只读取自己的消息 | 已实现 |
| 继续调整 | 全局 AI 提供 A/B/C 与任务对话；局部 AI 以上一版候选文字为直接输入并读取最新完整简历 | 已实现 |
| 目标片段 v2 | 现有内容返回目标子树；新增内容只返回父位置、稳定锚点和新子树，服务端形成完整 B | 已实现；兼容读取 v1，完整目标文档只用于元数据和整份重构 |
| 严格输出恢复 | 顶层 JSON 截断时不误收内层对象；协议字段不完整与无效 JSON 均只恢复一次 | 已实现；失败类型与服务不可用、执行失败分离 |
| 动态输出预算 | 首次预算随简历复杂度增长并受软上限保护；恢复预算可提高但不突破绝对硬上限 | 已实现；默认软上限 16384、硬上限 32768 |
| 三方合并 | A→B 的 AI 变化合并到应用时 C，未涉及内容保留 C | 已实现，客观冲突可重新生成 |
| 五级撤销/重做 | 文字与 AI 增删、移动、结构调整共用事务栈；新修改清空重做分支 | 已实现 |
| AI 真实差异预览 | 建议卡片由执行前后 ResumeDocument 自动生成修改摘要和真实内容，不展示底层操作名称 | 已实现 |
| 无 Word 编辑器 | 不建立编辑会话或 DOCX 草稿修订；只提供与语义节点贴合的轻量增删控件 | 已实现并提供旧库清理迁移 |
| 无模板模型 | 不建立模板、预设、模板版本或槽位绑定 | 已实现；旧字段仅用于读取兼容 |

### 4.2 AI 写入边界

自然语言问答、解释和追问保持开放，`actions` 可以为空。只有三类业务写入建议使用结构化协议：

1. `PROFILE_SAVE_PROPOSAL`：保存到资料；
2. `JOB_SET_CURRENT_PROPOSAL`：设为当前岗位；
3. `RESUME_REWRITE_PROPOSAL`：修改当前简历。

模型不能直接写数据库。每轮由服务端按任务重建所需上下文；选中节点用于表达本轮焦点，不限制用户明确要求的跨节点调整。`message` 可直接回答、追问或确认理解，不经过文档执行校验；`proposal` 默认带现有目标子树和紧凑新增声明，服务端校验并装配完整 B，再经过单一编辑节点和变化策略校验进入应用确认。用户点击“应用修改”时，服务端把 AI 从 A 到 B 的变化合并到最新草稿 C；同一目标采用 B，未涉及处保留 C。

### 4.3 生成与版本

```text
资料（可空）＋ 当前完整草稿 ＋ 本次沟通要求 ＋ 岗位（可空）
                              ↓
                        冻结本次输入
                              ↓
          compose_resume → validate_content → render → finalize
                              ↓
                     不可变 generated 版本
```

- 用户主动“保存为版本”时，深拷贝当时资料、岗位和完整简历文档；
- 一键生成成功自动创建 generated 版本；
- 文件导入确认应用时自动创建且只创建一个 imported 版本；
- 普通 AI 修改只进入草稿和撤销记录；
- 复制历史版本只把内容复制为当前草稿，不覆盖原版本，也不建立版本树；
- AI 建议不做事实真实性校验；所有内容先展示差异，由用户决定是否应用。

## 5. v2.13.1 主要 API（TECH §6）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/projects/:id?conversation_id=...` | 工作区聚合；可显式恢复当前标签页会话 |
| PATCH | `/projects/:id/profile/fields/:field` | 字段级自动保存 |
| POST/PATCH/DELETE | `/projects/:id/profile/experiences`、`/experiences/:id` | 经历增删改（软删可恢复） |
| POST | `/polish`、`/polish/:id/apply` | 字段润色方案与应用 |
| POST | `/uploads`、`/uploads/:id/content`、`/uploads/:id/complete` | 上传会话与校验 |
| POST | `/projects/:id/document-imports`、`/document-imports/:id/review`、`/apply` | 文件识别、预览确认与完整简历应用 |
| POST | `/projects/:id/jobs`、`/jobs/:id/files`、`/jobs/:id/ocr` | 岗位导入与 OCR |
| PATCH/POST | `/jobs/:id/text`、`/jobs/:id/analyze`、`/jobs/:id/set-current` | 确认、分析、切换岗位 |
| POST | `/projects/:id/ai/messages` | 发送 `conversation_id` 与可选 `task_id`；返回 `message` 或 `proposal` |
| POST | `/projects/:id/ai/inline-rewrites` | 读取完整简历，为当前文字或选区生成局部建议 |
| POST | `/ai/inline-rewrites/:id/apply`、`/reject` | 应用或放弃局部文字建议 |
| POST | `/projects/:id/ai/conversations` | 创建新对话并删除项目此前会话、消息、任务和建议 |
| POST | `/ai/actions/:id/apply`、`/reject`、`/revert` | 建议应用 / 拒绝 / 撤销 |
| GET/POST | `/projects/:id/resume-draft/history`、`/undo`、`/redo` | 最近五步撤销/重做 |
| POST/PATCH | `/projects/:id/resume-draft/transactions`、`/resume-draft`、changes revert | 文档事务与兼容草稿保存 |
| POST | `/projects/:id/resume-draft/node-actions` | 服务端按语义树执行受限 `+/-` 增删 |
| POST/GET | `/projects/:id/versions`、`/versions/:id`、`/compare`、`/clone`、`/export` | 版本保存、详情、比较、复制完整文档、导出 |
| POST/GET | `/projects/:id/generations`、`/generations/:id`、`/events`(SSE)、`/retry`、`/cancel` | 生成与进度 |
| POST | `/artifacts/:id/download-url`、`/download` | 短期下载地址与附件下载 |

---

## 6. 测试

`AI_BEHAVIOR_TESTS.md` v21 是自动化发布门槛。

```bash
npm install
npm test
```

| 文件 | 覆盖 |
|---|---|
| `tests/policy.test.js` | 三类写动作、禁用关系字段、幂等、撤销和 fail-closed |
| `tests/ai-behavior.test.js` | 平级资料、对话直接写作、独立应用和无内容来源模型 |
| `tests/versions.test.js` | 草稿/版本/生成闭环、真实缩略图、冻结约束、访问隔离与产物下载 |
| `tests/resume-dom.test.js` | 动态模块、稳定节点、安全白名单、AI 应用/继续修改/撤销和跨格式渲染 |
| `tests/resume-change.test.js` | 节点差量、结构差量、局部撤销冲突和旧记录压缩 |
| `tests/manual-node-actions.test.js` | 语义 `+/-` 能力、服务端结构生成、固定页面保护和统一撤销重做 |
| `tests/document-imports.test.js` | 导入完整文档、自动版本、资料隔离和幂等 |
| `tests/workspace-ui.test.js` | 真实画布、编辑入口、历史详情与比较、缩放、收缩、按需资料、移动端 |
| `tests/resume-first-flow.test.js` | 统一输入、首次生成、项目复制与隔离、文件材料、链接安全、下载和真实浏览器回归 |

每个测试文件使用独立数据库与独立端口，互不干扰。

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 服务端口 |
| `RESUME_DB_PATH` | `data/resume.db` | SQLite 文件位置 |
| `RESUME_CHANGE_PAYLOAD_RETENTION_DAYS` | `7` | 已成版或已撤销的完整变更内容保留天数；到期后保留操作摘要 |
| `RESUME_FONT_PATH` | `/home/ubuntu/.fonts/NotoSansSC.ttf` | PDF 中文字体 |
| `RESUME_MODEL_PROVIDER` | — | 模型供应商；当前生产适配器为 `deepseek` |
| `RESUME_MODEL_ENDPOINT` | `https://api.deepseek.com/responses` | 模型 Responses API 地址 |
| `RESUME_MODEL_API_KEY` | — | 模型 API Key；只在服务端读取 |
| `RESUME_MODEL_TEXT_MODEL` | `deepseek-v4-flash` | 普通问答、单点文字修改和局部首轮改写 |
| `RESUME_MODEL_COMPLEX_MODEL` | `deepseek-v4-pro` | 全局整份文档、结构、样式及协议恢复；complex 表示能力，型号可配置 |
| `RESUME_GLOBAL_AI_REASONING_EFFORT` | `low` | 仅全局AI；none/low/medium/high，预算预留推理空间并受硬上限保护；不影响局部速度 |
| `RESUME_MODEL_VISION_MODEL` | `deepseek-v4-flash-vision-exp` | 仅图片请求与文档视觉识别使用 |
| `RESUME_MODEL_MAX_TOKENS` | `4096` | 未指定请求级预算时的模型输出上限 |
| `RESUME_MODEL_MIN_OUTPUT_TOKENS` | `4096` | 全局 AI 动态输出预算下限 |
| `RESUME_MODEL_INITIAL_MAX_TOKENS` | `16384` | 全局 AI 首次请求的动态预算软上限 |
| `RESUME_MODEL_MAX_TOKENS_LIMIT` | `32768` | 所有模型请求的绝对输出硬上限 |
| `RESUME_DOCUMENT_AI_ENABLED` | `true` | 是否用视觉模型辅助判断导入文件的阅读顺序和模块关系 |
| `RESUME_DOCUMENT_OCR_ENABLED` | `true` | 是否启用文档识别服务的本地图片 OCR |
| `RESUME_DOCUMENT_OCR_PYTHON` | 项目内识别 venv | 自定义文档识别 Python 路径 |
| `RESUME_DOCUMENT_RUNTIME_DIR` | `.runtime/document-recognition/jobs` | 文档识别临时任务目录 |
| `RESUME_OCR_ENDPOINT` / `RESUME_OCR_API_KEY` | — | 云 OCR；未配置时图片需粘贴文本兜底 |
| `RESUME_DOWNLOAD_SECRET` | 本地默认 | 下载令牌签名密钥 |

旧版 `RESUME_LLM_*` 变量仍可被服务端读取，用于现有部署平滑迁移；新部署统一使用
`RESUME_MODEL_*`。旧的单模型配置不会覆盖新的文本/复杂结构默认路由。

---

## 8. 与 PRD/TECH 的对应与生产演进

已实现：统一输入首页、简历与聊天编辑页、独立制作和返回、自动保存与乐观锁、AI 润色、文件文档识别、
岗位多图导入/OCR/分析、一键生成 PDF/DOCX、主动保存版本、不可变版本、
历史详情/比较/复制/导出、失败重试与部分成功、审计日志、跨用户隔离、幂等。

当前工程已完成 v2.13.1 统一语义树、局部纯文本会话、全局完整文档上下文、语义节点增删、局部多轮承接、稀疏目标片段、严格输出恢复、动态预算以及全局/局部 AI 双入口收口；生产基础设施仍可按下表演进：

| 项 | 当前实现 | 生产建议 |
|---|---|---|
| 主数据库 | SQLite（含相同表/约束/触发器） | PostgreSQL 16 |
| 队列 | 进程内 Worker + outbox 表 | Redis + BullMQ |
| 对象存储 | 本地目录 | S3 兼容私有桶 |
| 上传 | 整体直传 + magic bytes 校验 | 预签名分片直传 + 病毒扫描沙箱 |
| PDF 渲染 | 内置 writer（嵌入 Noto Sans SC，字体未子集化，约 8 MB） | 固定版本 Chromium 打印 + 字体子集化 |
| OCR | 未配置云服务时对图片返回空文本，需粘贴兜底（不臆造） | 云 OCR Provider |
| 语音 | 录音状态机与交互完成，未接入 ASR | 流式 ASR + 分片上传 |
| AI 模型 | Resume Harness + DeepSeek 直连；测试注入离线模型 | 增加模型评测、限流与成本监控 |

> 安全说明：用户在对话中明确提供的内容可以直接用于简历建议，但不会自动保存到资料；
> 未点击“应用修改”正文不变，未应用“保存到资料”建议时资料不变，未点击“设为当前岗位”时岗位不变。
