# 简历星球 · AI Native 简历工作台

产品与技术基线已更新为 **PRD v1.4**、**TECH v1.4**：资料、简历和 AI 对话是平级对象；资料是可选参考，简历可以结合资料和当前沟通完成，保存后形成不可变版本。

当前实现已迁移到 v1.4：不保存内容来源或证据映射；对话中用户明确提供的信息可直接进入简历建议；保存资料、设置岗位和应用简历修改是三个独立动作。简历正文由独立的 `resume-dom.js` 通用组件渲染，支持任意模块、稳定节点定位和完整历史差异比较。

- 前端：`index.html`（单一 HTML，页面设计唯一来源，见 `AGENTS.md`）
- 后端：`server/`（Node.js 24，零第三方运行时依赖）
- 测试：`tests/`（覆盖 v1.4 AI 行为契约、Harness、DeepSeek 客户端、策略边界、版本闭环与原型结构一致性）

---

## 1. 快速开始

```bash
node -v            # 需要 >= 22.5（内置 node:sqlite）
npm start          # 启动服务：http://localhost:8787
npm test           # 运行全部测试（需先 npm install 安装 jsdom，仅测试用）
npm run reset      # 重置演示数据库
```

首次启动会自动初始化三款系统模板与演示数据（陈知行 · 高级产品经理岗位，
与 `AI_BEHAVIOR_TESTS.md` 的测试夹具一致：城市上海、客户激活率 26%/付费转化率 18%，
并包含 3 个历史版本）。

打开 <http://localhost:8787> 即可看到与原型一致的界面；所有操作都写入数据库，刷新不丢。

---

## 2. 架构总览

```
浏览器 index.html
   │  嵌入 resume-dom.js（动态正文树渲染与节点定位）
   │  /api/v1/*（REST + SSE）
   ▼
server/index.js ── 路由分发、静态服务、错误处理（RFC 7807）
   │
   ├─ modules/   业务模块（项目/资料/岗位/模板/上传/草稿/AI/版本/生成/产物）
   ├─ lib/       基础设施（db、policy、resume-harness、deepseek-client、queue、render、storage…）
   └─ schema.sql 数据模型（业务表 + 冻结触发器 + 唯一约束）

异步链路：业务事务 → outbox_events → Worker → 对象存储/数据库 → SSE → 浏览器
```

| 层 | 实现 | 说明 |
|---|---|---|
| Web | `index.html` | 三栏工作台，CSS 与结构直接沿用原型 |
| API | 内置 `http` + 自研路由 | REST `/api/v1`，支持 `Idempotency-Key` |
| 数据库 | `node:sqlite`（SQLite） | 承载 TECH §7 全部表与约束，生产可换 PostgreSQL |
| 队列 | 进程内 Worker + `outbox_events` | 先落库再投递，避免「有快照无任务」 |
| 对象存储 | `data/objects` 本地目录 | 私有桶语义，下载走短期签名 URL |
| AI 编排 | `lib/resume-harness/` | 组织完整工作区、锁定焦点与有界会话记忆，校验结构化输出 |
| 模型客户端 | `lib/deepseek-client/` | 直接调用 DeepSeek 流式 Chat Completions，支持图片与超时控制 |
| 正文组件 | `resume-dom.js` | 安全动态 DOM、稳定节点 ID、通用操作、旧草稿转换 |
| 渲染 | `lib/render/{pdf,docx,html}.js` | Resume DOM + 模板 Schema → PDF/DOCX/HTML |

---

## 3. 前端：沿用原型布局并落实 v1.4

实现方式：

- **样式**：沿用 `index.prototype.backup.html` 的核心布局，并移除已废弃业务区域的样式。
- **结构**：顶栏 / 左栏资料卡 / 中央画布 / 右栏 AI 面板 / 各浮层沿用原型布局。
- **内容**：初始数据由后端 seed 提供（陈知行、3 个版本、8/11 项要求覆盖）；
  旧原型中的来源、待确认事实和资料到正文使用关系不再展示。
- **交互**：选区工具、`@作用范围` 切换、改写方案卡片、撤销栏、版本浏览器、
  生成进度、模板切换、缩放、拖拽导入等行为与原型一致，底层改为真实 API 调用。
- **动态正文**：不再由前端写死工作、项目、教育等模块；通用组件遍历正文树，
  姓名、联系方式、技能、模块标题和“海外经历”等自定义模块均可按节点定位和修改。
- **历史版本**：详情复用通用正文渲染器；比较默认覆盖历史版本与当前实时草稿全文，
  从旧版本继续时先保护未保存修改，并可选择是否恢复当时岗位和模板。
- **验证**：`tests/prototype-parity.test.js` 用 jsdom 同时解析「原型静态 DOM」与
  「前端加载真实数据后的 DOM」，对简历画布、资料浮层、岗位浮层、版本列表、
  模板、进度浮层、助手面板生成结构签名，并额外断言页面不出现旧内容关系。

---

## 4. v1.4 实现状态

### 4.1 三个平级工作空间

| v1.4 能力 | 规则 | 当前实现状态 |
|---|---|---|
| 资料可选 | 资料、简历和对话是平级输入 | 已实现上下文分离 |
| 对话内容可直接用于简历 | 用户明确提供的信息无需先保存资料即可进入修改建议 | 已实现 |
| 保存资料与应用简历独立 | 同一消息可以产生两个建议，分别应用 | 已实现三动作协议 |
| 资料与简历不自动同步 | 修改任一侧都不静默改变另一侧 | 已实现 |
| 无内容来源模型 | 不保存证据映射、条目来源或资料到正文依赖 | 已实现并提供旧库迁移 |
| 草稿与版本分离 | 应用修改只更新可撤销草稿；主动保存或生成成功才成版 | 已实现 |
| 版本保持平级 | 复制版本只生成新草稿，不覆盖原版本 | 已实现 |
| 动态简历结构 | 模板不限定模块，任意安全节点可渲染、修改、撤销和导出 | 已实现 |
| 完整历史比较 | 版本详情和比较复用动态正文树，默认对比实时草稿 | 已实现 |
| 安全继续修改 | 未保存修改先保存或明确放弃；资料不被历史版本覆盖 | 已实现 |

### 4.2 AI 写入边界

自然语言问答、解释和追问保持开放，`actions` 可以为空。只有三类业务写入建议使用结构化协议：

1. `PROFILE_SAVE_PROPOSAL`：保存到资料；
2. `JOB_SET_CURRENT_PROPOSAL`：设为当前岗位；
3. `RESUME_REWRITE_PROPOSAL`：修改当前简历。

模型不能直接写数据库。用户应用建议后，服务端仍需校验目标所有权、锁定 scope、revision、幂等键和动作 Schema。未知、越权、过期或非法动作一律零写入。操作日志只服务撤销、安全和排错，不承担内容归因。

### 4.3 生成与版本

```text
资料（可空）＋ 当前草稿 ＋ 本次沟通要求 ＋ 岗位（可空）＋ 模板
                              ↓
                        冻结本次输入
                              ↓
          compose_resume → validate_content → render → finalize
                              ↓
                     不可变 generated 版本
```

- 用户主动“保存为版本”时，深拷贝当时资料、岗位、模板和简历结果；
- 一键生成成功自动创建 generated 版本；
- 普通 AI 修改只进入草稿和撤销记录；
- 复制历史版本只把内容复制为当前草稿，不覆盖原版本，也不建立版本树；
- 内容校验只判断是否补造用户未提供的具体陈述，不保存逐句依据关系。

## 5. v1.4 主要 API（TECH §6）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/projects/:id` | 工作区聚合（三栏一次加载） |
| PATCH | `/projects/:id/profile/fields/:field` | 字段级自动保存 |
| POST/PATCH/DELETE | `/projects/:id/profile/experiences`、`/experiences/:id` | 经历增删改（软删可恢复） |
| POST | `/polish`、`/polish/:id/apply` | 字段润色方案与应用 |
| POST | `/uploads`、`/uploads/:id/content`、`/uploads/:id/complete` | 上传会话与校验 |
| GET/PUT | `/templates/system`、`/projects/:id/template` | 模板列表与选择 |
| POST | `/templates/custom` | 自定义模板（JPG/PNG/PDF/Word） |
| POST | `/projects/:id/jobs`、`/jobs/:id/files`、`/jobs/:id/ocr` | 岗位导入与 OCR |
| PATCH/POST | `/jobs/:id/text`、`/jobs/:id/analyze`、`/jobs/:id/set-current` | 确认、分析、切换岗位 |
| POST | `/projects/:id/ai/messages` | AI 对话（返回冻结范围与动作） |
| POST | `/projects/:id/ai/conversations` | 开始新对话 |
| POST | `/ai/actions/:id/apply`、`/reject`、`/revert` | 建议应用 / 拒绝 / 撤销 |
| PATCH | `/projects/:id/resume-draft`、changes revert | 草稿保存与撤销 |
| POST/GET | `/projects/:id/versions`、`/versions/:id`、`/compare`、`/clone`、`/export` | 版本保存、详情、比较、复制、导出 |
| POST/GET | `/projects/:id/generations`、`/generations/:id`、`/events`(SSE)、`/retry`、`/cancel` | 生成与进度 |
| POST | `/artifacts/:id/download-url`、`/download` | 短期下载地址与附件下载 |

---

## 6. 测试

`AI_BEHAVIOR_TESTS.md` v4 已落实为自动化发布门槛。

```bash
npm install     # 安装 jsdom（仅测试依赖）
npm test
```

| 文件 | 覆盖 |
|---|---|
| `tests/policy.test.js` | 三类写动作、禁用关系字段、幂等、撤销和 fail-closed |
| `tests/ai-behavior.test.js` | 平级资料、对话直接写作、独立应用和无内容来源模型 |
| `tests/versions.test.js` | 草稿/版本/生成闭环：发布验收 3、9、18、19、20，冻结约束，产物下载 |
| `tests/resume-dom.test.js` | 动态模块、稳定节点、安全白名单、AI 应用/继续修改/撤销和跨格式渲染 |
| `tests/prototype-parity.test.js` | 前端渲染 DOM 与原型逐结构比对，并阻止旧内容关系样式回归 |

每个测试文件使用独立数据库与独立端口，互不干扰。

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 服务端口 |
| `RESUME_DB_PATH` | `data/resume.db` | SQLite 文件位置 |
| `RESUME_FONT_PATH` | `/home/ubuntu/.fonts/NotoSansSC.ttf` | PDF 中文字体 |
| `RESUME_LLM_PROVIDER` | — | AI 对话设为 `deepseek`；未配置时明确报错 |
| `RESUME_LLM_ENDPOINT` | `https://api.deepseek.com/chat/completions` | DeepSeek Chat Completions 地址 |
| `RESUME_LLM_API_KEY` | — | DeepSeek API Key |
| `RESUME_LLM_MODEL` | `deepseek-v4-flash-vision-exp` | 对话与图片理解模型 |
| `RESUME_OCR_ENDPOINT` / `RESUME_OCR_API_KEY` | — | 云 OCR；未配置时图片需粘贴文本兜底 |
| `RESUME_DOWNLOAD_SECRET` | 本地默认 | 下载令牌签名密钥 |

---

## 8. 与 PRD/TECH 的对应与生产演进

已实现：三栏信息架构、自动保存与乐观锁、AI 润色、三种系统模板与自定义模板、
岗位多图导入/OCR/分析、一键生成 PDF/DOCX、主动保存版本、不可变版本、
历史详情/比较/复制/导出、失败重试与部分成功、审计日志、跨用户隔离、幂等。

当前工程已完成 v1.4 语义迁移；生产基础设施仍可按下表演进：

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
