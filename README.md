# 简历星球 · AI Native 简历工作台

当前编辑入口：详情页 resume 返回首页，首页 resume 返回刚才编辑的简历，删除重复“我的简历”按钮；个人中心固定顶栏最右侧，提供制作另一份、历史版本和设置。工具栏保存图标直接保存历史版本，预览/下载也在工具栏。“显示内容增删按钮”默认关闭并记忆显式选择，关闭不影响文字编辑和 AI。聊天建议通过弹框展示整行红删绿增（删除带删除线），整份预览与首次/再次应用使用同一合并结果。

聊天范围旁支持“延续当前对话 / 不延续当前对话”。不延续仅下一次发送建立独立任务，不读取旧聊天、旧建议或旧附件，不删除历史、不改正文；受理后恢复延续。简历建议卡片移除“暂不使用”，聊天头部不再常驻岗位提示和重复补充入口，附件仍通过输入框添加。

产品与技术基线更新为 **PRD v2.16.0**、**TECH v2.16.0**：首页提供个人信息、岗位信息、简历模板三个材料区，三项可用后生成并在首页预览，再选择重新上传、下载或继续编辑。取消“我的简历”独立界面但保留已有数据。编辑页继续围绕当前简历与 AI 对话；完整文档、既有资料、导入、局部/全局 AI、五步撤销、历史和下载继续复用。

v2.16.0：材料按个人事实、岗位要求、版式参考分开传递；20 款本地系统样式支持缩略图、大图预览与确认应用，选中后在第三材料卡展示，不建立模板绑定系统。首次空白生成自动保存不可变版本；已有/复用简历仍需应用修改，新制作不覆盖旧稿。Word/PDF/截图识别结果复用，不写个人档案。公开岗位链接真实读取，失败提示改用文件或截图。头像使用私有不可变资源，支持原生图片提取与截图裁剪，预览和 PDF/Word 导出同链路保留。停止维护独立原型，真实页面与自动化测试为准。

v2.14.1：`+/-` 以完整列表项、经历块、表格行/合并行组为默认边界，内部段落增删显式选择，完整保留子树。聊天支持选图、粘贴、拖入、纯图发送及后续多轮看图，不自动写入资料；新对话清理旧聊天专用图片。真实 Chromium 回归包含嵌套结构、全部缩放、连续点击、自动保存、撤销重做，以及可选的公开 DOCX/PDF 文件样本。

v2.14.0全局聊天：明确要求直接生成可预览建议，取消按修改复杂度强制确认思路；自然追问、解释和应用后的对话持续承接。失败可直接重试原要求，后台状态可跨刷新恢复，支持停止生成并阻止迟到回写；重叠片段恢复保留独立修改，最终建议原子提交。所有正文变更仍需用户点击应用。

v2.13.2存储治理：全局新对话创建成功即删除项目此前聊天、任务和建议；局部应用成功或放弃后清空该任务历史，失败保留重试链。幂等缓存不重复保存整份简历，过期撤销只保留操作摘要；当前草稿、资料、版本和有效五步撤销/重做独立保留。新旧请求并发时通过取消信号与数据库状态双重阻止回写。

当前局部与全局 AI 均使用 Astra。局部保持纯文本轻量协议；网关最低支持 low 推理，adapter 显式配置，不改用户要求。全局默认 low，读取整份简历的真实节点、文字、样式和页面设置，不降低文档能力。旧对话滚动整理并复用任务记忆，最近对话和本轮原话完整保留。模型默认返回最小修改，后端继承未返回字段；已有简历的正文变更仍需用户应用。server/harness/model-gateway/供应商adapter职责分离，重试诊断不得替换最后一条用户要求。

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
- [ACCOUNT_SYSTEM.md](./ACCOUNT_SYSTEM.md)：账号初始化、旧资料归属与发布步骤；
- 本 README：启动方式、当前实现状态和生产演进。

---

## 1. 快速开始

```bash
node -v                           # 需要 >= 22.5（内置 node:sqlite）
npm install
npm run setup:document-recognition # 首次启用 PDF/Word/图片识别时执行
npm start                         # 完成下述账号初始化与配置后启动
npm test                          # 运行全部测试
npm run test:accounts              # 账号接口、隔离与真实浏览器回归
```

完整文档识别还需要系统提供 LibreOffice 与 Poppler 命令行工具。Ubuntu 可安装
`libreoffice` 和 `poppler-utils`；OCR 与页面场景所需的 Python 依赖由上述 setup
脚本安装到项目内 `.runtime/document-recognition/venv`，不要求 Docker。

公开启动前，按 [账号初始化步骤](./ACCOUNT_SYSTEM.md#旧资料初始化与上线) 备份数据库、
将旧共享 owner 绑定为 `admin`，并在本机交互终端设置强密码；再填写 `.env.example`
中的账号 Origin、部署路径与两个独立随机密钥。`admin/admin` 无法网页登录。
生产不再自动建立演示数据，不接受 `x-user-id`。演示夹具只用于显式隔离测试；
不要对现有资料运行 `npm run reset`。

打开 <http://localhost:8787> 进入三类材料首页；编辑地址为 `/?project=项目ID`。已有地址和数据保留，首页 resume 标识可返回当前简历。

---

### 全局 AI 配置与候选模型对照测试

已接入独立 OpenAI Responses 适配器。2026-09-09 对照测试后，按用户确认将全局文字、图片及恢复切换为 `gpt-6-astra`；随后局部也按用户要求切换同一模型。局部三轮真实浏览器验收可运行 `RESUME_LOCAL_ASTRA_QA=1 node --test tests/local-astra-live.test.js`，只发送虚构简历，使用隔离测试数据库。
网关为 `https://api.info52.top/v1`；不将“Astra”等昵称自动映射为其他型号。
第三方网关的实际模型映射、账号可用性、计费和接口兼容性仍需有效 Key 实测。

测试命令不会自动修改线上配置。显式部署命令 `npm run ai:activate-astra -- --apply --include-local` 读取已配置的私有测试 Key，备份旧 `.env` 后更新全局与局部供应商、独立 OpenAI 配置及最低推理强度 low（网关不支持 none）；不加 `--include-local` 则保留局部路由。随后执行 `pm2 restart resume --update-env`。启动日志显示实际能力路由，不输出密钥。已完成的浏览器对照见 `AI_COMPARISON_2026-09-09.md`。

```bash
npm run ai:configure-openai          # 交互输入 Key，不回显、不进入命令历史
npm run ai:compare -- --dry-run      # 仅展示计划，不读密钥、不联网
npm run ai:compare -- --live --rounds 5
```

- Key 只保存到 Git 忽略的 `.env.openai-qa`（权限 600）。线上只自动读取 `.env`，不会加载测试配置；不读取或改写 `~/.codex/auth.json`。
- 9 个场景 × 5 轮 × 2 个模型，共 90 个场景执行，每个最多一次自动恢复。默认不联网，必须显式 `--live`。可用 `--rounds 1` 先检查兼容性。
- 使用虚构简历与测试图片；覆盖纯文字翻译、历史含图翻译、精简与继续精简、样式、带图样式、模块排序、岗位建议和只讨论。测试进程不加载生产数据库，不应用任何建议。
- 候选的全局 `complex` 与 `vision` 都使用 `gpt-6-astra`；局部 `text` 与记忆模型仍为原 DeepSeek 配置。两组使用相同任务基线、用户原话、Schema 与 `low` 推理；连续追问自然使用各自的上一轮建议。
- 输出首次通过、恢复后通过、失败、跳过、耗时和累计 token 用量；报告在 `.runtime/ai-comparison/`，不记录 Key、正文或原始模型输出。用量不是费用，有限自动断言不是全面人工质量验收。
- 认证、限流、模型不存在或请求协议不兼容时停止测试；不隐式降级为另一个模型。Ctrl+C 取消当前请求并保留已完成报告。
- 请求携带 `store:false`，不依赖供应商会话状态；该参数不代表第三方网关承诺不保留日志。有效 Key 配置前，只能验收离线接入，不能声称候选准确率更高。

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
| Web | `index.html`、`home-controller.js` | 三类材料首页、就地生成预览、当前简历与对话 |
| API | 内置 `http` + 自研路由 | REST `/api/v1`，支持 `Idempotency-Key` |
| 数据库 | `node:sqlite`（SQLite） | 承载 TECH §7 全部表与约束，生产可换 PostgreSQL |
| 队列 | 进程内 Worker + `outbox_events` | 先落库再投递，避免「有快照无任务」 |
| 对象存储 | `data/objects` 本地目录 | 私有桶语义，下载走短期签名 URL |
| AI 编排 | `lib/resume-harness/` | 共用自然会话骨架；全局读取精简语义树并装配完整 B，局部读取纯文本并只生成锁定文字 |
| 模型客户端 | `lib/model-client/` | DeepSeek/OpenAI 独立配置，共用 Responses 流传输、严格 Schema、分级超时与取消；全局供应商可独立选择 |
| 文档组件 | `resume-dom.js` | 完整 ResumeDocument、语义类型、真实父子树、文字事务、稳定节点 ID、AI 投影与旧草稿转换 |
| 渲染 | `lib/render/{pdf,docx,html}.js` | ResumeDocument → PDF/DOCX/HTML |

---

## 3. 前端：直接迭代真实产品

实现方式：

- **样式**：`index.html` 为真实入口；`index.prototype.backup.html` 仅保留历史参考，不维护、不参与验收。
- **结构**：首页个人信息、岗位信息、简历模板三区与生成预览；编辑页为画布与 AI 对话，材料按需补充，不固定显示左栏资料卡，不提供独立“我的简历”列表。
- **内容**：初始数据由后端 seed 提供（陈知行、3 个版本、8/11 项要求覆盖）；
  旧原型中的来源、待确认事实和资料到正文使用关系不再展示。
- **交互**：现有文字直改、正文旁就地改写、右侧全局 AI、`@作用范围`、改写方案卡片、撤销栏、版本浏览器、
  生成进度、缩放、拖拽导入均调用真实接口；简历编辑栏在画布内吸附，滚动后自动收紧。切换简历前等待文字保存，失败留在原页。
- **动态正文**：不再由前端写死工作、项目、教育等模块；通用组件遍历正文树。
  现有文字可按节点直改；悬停文字或父容器边缘时，页面内显示一个范围框和一对 `+/-`，完整复制或直接删除框内子树，不再使用层级菜单或从标题自动升级模块。移动、合并、拆分、样式和页面调整仍由 AI 表达最小变化区域。
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
| 完整文档模型 | 首页版式参考不建立模板版本或槽位绑定 | 页面、内容、样式与图片归于同一文档；旧字段仅用于读取兼容 |

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
| `RESUME_MODEL_PROVIDER` | — | 基础供应商；当前部署为 `openai`，兼容 `RESUME_LLM_PROVIDER` |
| `RESUME_GLOBAL_MODEL_PROVIDER` | 基础供应商 | 当前部署为 `openai`，同时覆盖全局 complex/vision 及恢复 |
| `RESUME_OPENAI_BASE_URL` | `https://api.openai.com/v1` | 独立 Responses 网关；当前部署使用已配置的第三方网关 |
| `RESUME_OPENAI_MODEL` | `gpt-5.5`（适配器回退值） | 当前部署显式配置为 `gpt-6-astra`，不依赖回退值 |
| `RESUME_OPENAI_API_KEY` | — | 独立服务端密钥，不复用 DeepSeek 或 Codex 凭据 |
| `RESUME_OPENAI_MIN_REASONING_EFFORT` | `none` | adapter 最低推理兼容配置；当前 Astra 网关必须显式设为 `low` |
| `RESUME_MODEL_ENDPOINT` | `https://api.deepseek.com/responses` | 模型 Responses API 地址 |
| `RESUME_MODEL_API_KEY` | — | 模型 API Key；只在服务端读取 |
| `RESUME_MODEL_TEXT_MODEL` | `deepseek-v4-flash` | 仅 DeepSeek text 路由生效；当前局部由 OpenAI 配置覆盖 |
| `RESUME_MODEL_COMPLEX_MODEL` | `deepseek-v4-pro` | 仅 DeepSeek 路由生效；当前全局由 OpenAI 配置覆盖 |
| `RESUME_GLOBAL_AI_REASONING_EFFORT` | `low` | 仅全局AI；none/low/medium/high，预算预留推理空间并受硬上限保护；不影响局部速度 |
| `RESUME_MODEL_VISION_MODEL` | `deepseek-v4-flash-vision-exp` | 仅 DeepSeek 视觉路由生效；当前 vision 由 OpenAI 配置覆盖 |
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

真实浏览器候选对照（独立测试数据库、虚构简历、真实链接和图片、付费模型调用）：

```bash
npm run ai:compare-browser -- --dry-run
npm run ai:compare-browser -- --live --rounds 3
# 仅复测完整换版，使用当前协议
npm run ai:compare-browser -- --live --rounds 1 --only-layout
node server/scripts/audit-global-ai-browser.js .runtime/ai-comparison/browser-运行编号
```

报告和虚构结果截图位于 `.runtime/ai-comparison/`；浏览器复核将可见内容、布局、可编辑性分开计分，不把接口成功等同于通过。`RESUME_OBJECTS_DIR` 可隔离测试附件目录，线上不设置时保留原路径。

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

建议预览内支持直接应用，以及导出当前所见建议的 PDF/Word；导出不会应用正文或创建历史版本。差异弹框同时列出文字、结构与排版明细。

超时按能力可覆盖通用配置：`RESUME_MODEL_TEXT_FIRST_TOKEN_MS`、`RESUME_MODEL_COMPLEX_FIRST_TOKEN_MS`、`RESUME_MODEL_VISION_FIRST_TOKEN_MS`（另支持同前缀的 `IDLE_MS` / `TOTAL_MS`）。当前部署全局首响应 90000ms、局部 40000ms；空闲 60000ms、总时限 360000ms。失败可按原要求及附件重试，不自动重复用户消息。
