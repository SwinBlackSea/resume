# 简历星球 · AI Native 简历工作台

依据 **PRD v1.2**、**TECH v1.2** 与交互原型 **index.prototype.backup.html** 实现的完整可运行系统：
前端 100% 还原原型，后端实现资料/模板/岗位分离、AI 策略安全边界、生成快照与不可变版本的完整闭环。

- 前端：`index.html`（单一 HTML，页面设计唯一来源，见 `AGENTS.md`）
- 后端：`server/`（Node.js 24，零第三方运行时依赖）
- 测试：`tests/`（49 项，覆盖 P0 AI 行为契约、策略矩阵、版本闭环与原型一致性）

---

## 1. 快速开始

```bash
node -v            # 需要 >= 22.5（内置 node:sqlite）
npm start          # 启动服务：http://localhost:8787
npm test           # 运行全部测试（需先 npm install 安装 jsdom，仅测试用）
npm run reset      # 重置演示数据库
```

首次启动会自动初始化三款系统模板与演示数据（陈知行 · 高级产品经理岗位，
与 `AI_BEHAVIOR_TESTS.md` 的测试夹具一致：城市上海、客户激活率 26%/付费转化率 18%、
项目覆盖规模与团队人数保持「待确认」、3 个历史版本、1 条已拒绝候选）。

打开 <http://localhost:8787> 即可看到与原型一致的界面；所有操作都写入数据库，刷新不丢。

---

## 2. 架构总览

```
浏览器 index.html
   │  /api/v1/*（REST + SSE）
   ▼
server/index.js ── 路由分发、静态服务、错误处理（RFC 7807）
   │
   ├─ modules/   业务模块（项目/资料/岗位/模板/上传/草稿/AI/版本/生成/产物）
   ├─ lib/       基础设施（db、policy、ai-adapter、queue、render、storage…）
   └─ schema.sql 数据模型（21 张表 + 冻结触发器 + 唯一约束）

异步链路：业务事务 → outbox_events → Worker → 对象存储/数据库 → SSE → 浏览器
```

| 层 | 实现 | 说明 |
|---|---|---|
| Web | `index.html` | 三栏工作台，CSS 与结构直接沿用原型 |
| API | 内置 `http` + 自研路由 | REST `/api/v1`，支持 `Idempotency-Key` |
| 数据库 | `node:sqlite`（SQLite） | 承载 TECH §7 全部表与约束，生产可换 PostgreSQL |
| 队列 | 进程内 Worker + `outbox_events` | 先落库再投递，避免「有快照无任务」 |
| 对象存储 | `data/objects` 本地目录 | 私有桶语义，下载走短期签名 URL |
| AI | `lib/ai-adapter.js` | 默认本地规则引擎；可切换远程模型 |
| 渲染 | `lib/render/{pdf,docx,html}.js` | Resume JSON + 模板 Schema → PDF/DOCX/HTML |

---

## 3. 前端：100% 还原原型

实现方式：

- **样式**：`<style>` 与 `index.prototype.backup.html` 逐字符一致（由测试断言）。
- **结构**：顶栏 / 左栏资料卡 / 中央画布 / 右栏 AI 面板 / 各浮层的 DOM 结构与原型一致。
- **内容**：初始数据由后端 seed 提供（陈知行、3 个版本、2 项待确认、8/11 项要求覆盖），
  渲染结果与原型静态 HTML 一致。
- **交互**：选区工具、`@作用范围` 切换、改写方案卡片、撤销栏、版本浏览器、
  生成进度、模板切换、缩放、拖拽导入等行为与原型一致，底层改为真实 API 调用。
- **验证**：`tests/prototype-parity.test.js` 用 jsdom 同时解析「原型静态 DOM」与
  「前端加载真实数据后的 DOM」，对简历画布、资料浮层、岗位浮层、版本列表、
  模板、进度浮层、助手面板生成结构签名并逐项比对（12 项断言全部通过）。

---

## 4. 后端：核心约束的落点

### 4.1 资料 / 简历 / 岗位三者分离

| 约束 | 落点 |
|---|---|
| AI 只提出方案，应用后才改正文 | `modules/ai.js` 的 `RESUME_REWRITE_PROPOSAL` → `applyRewriteProposal`（只更新草稿与 change event） |
| 新事实先待确认 | `fact_candidates`，确认后经 `persistConfirmedFact` 写入左侧资料 |
| 岗位变化需「设为当前岗位」 | `JOB_CANDIDATE` + `POST /jobs/:id/set-current` |
| 资料变化不静默改写简历 | `modules/profile.js` 只写 profile；白名单字段同步由回执显式呈现 |
| 应用修改不自动成版 | 草稿层 `resume_change_events`，成版需 `POST /projects/:id/versions` |
| 多轮建议不丢上下文 | `ai_tasks` 保存任务范围与当前建议；建议记录父建议、正文指纹和事实依赖 |
| 对话可安全重新开始 | 旧任务和未应用建议结束；待确认资料、正文、模板及历史版本保持不变 |

### 4.2 AI 安全边界（Policy Engine）

`server/lib/policy.js` 是模型与业务写入之间唯一的确定性边界：

1. 校验响应 Schema、动作枚举、目标所有权、scope revision；
2. 依据动作矩阵决定「仅回复 / 待确认 / 直接执行 / 拒绝」；
3. 直接执行白名单仅含：姓名、手机、邮箱、所在城市、当前职位、求职状态，
   且必须同时满足：明确更正 + 值校验通过 + `expected_revision` 一致 + 旧值可记录 + 可撤销；
4. 未知动作、证据不足、Schema 非法、revision 冲突一律 **零写入**（fail-closed）；
5. 只有产生 `change_receipt` 后，接口才返回 `saved: true`，前端据此展示完成状态。

作用范围使用稳定枚举 `DATA_PROFILE / DATA_JOB / RESUME_BLOCK / RESUME_DOCUMENT`，
界面显示 `@资料 · 个人信息 / @资料 · 岗位信息 / @简历 · 具体内容 / @整份简历`；
请求进入服务端即冻结 scope，后续界面切换不影响已发送请求（P0-17）。scope 只限制动作目标；
模型仍可读取当前任务所需的关联资料、同段内容、岗位和简历风格。多轮改写区分真实正文 A、
上一版建议 B 和事实基准 F，新建议 C 从 B 继续，但只能使用 F 中的事实。
每轮必须优先处理最新用户要求；新数字先确认，缺少单位或对象的“30+”先追问，模型擅自加入的未确认数字不会生成可应用建议。

### 4.3 生成闭环

```
POST /projects/:id/generations
  └─ 事务：锁项目 → 校验 revision/模板/岗位 → 分配 generation_no
            → 冻结三类输入（深拷贝 + input_hash）→ 写快照与任务 → 写 outbox
  └─ Worker DAG：analyze_job → compose_resume → validate_facts → render_html
                  →（render_pdf ∥ render_docx）→ validate_artifacts → finalize
  └─ finalize 事务：创建 kind=generated 的不可变版本 + 登记产物 + 采用生成结果
```

- PDF 与 DOCX 并行；一个成功即整体 `partial`，仍可下载成功格式并单独重试；
- 失败只保留诊断快照，绝不伪装成成功版本；
- 重复点击（幂等键）只产生一个快照与一个版本。

---

## 5. 主要 API（TECH §6）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/projects/:id` | 工作区聚合（三栏一次加载） |
| PATCH | `/projects/:id/profile/fields/:field` | 字段级自动保存 |
| POST/PATCH/DELETE | `/projects/:id/profile/experiences`、`/experiences/:id` | 经历增删改（软删可恢复） |
| POST | `/polish`、`/polish/:id/apply` | 字段润色方案与应用 |
| POST | `/uploads`、`/uploads/:id/content`、`/uploads/:id/complete` | 上传会话与校验 |
| GET/PUT | `/templates/system`、`/projects/:id/template` | 模板列表与选择 |
| POST | `/templates/custom` | 自定义模板（JPG/PNG/PDF/Word） |
| POST | `/projects/:id/jobs`、`/jobs/:id/sources`、`/jobs/:id/ocr` | 岗位导入与 OCR |
| PATCH/POST | `/jobs/:id/text`、`/jobs/:id/analyze`、`/jobs/:id/set-current` | 确认、分析、切换岗位 |
| POST | `/projects/:id/ai/messages` | AI 对话（返回冻结范围与动作） |
| POST | `/projects/:id/ai/conversations` | 开始新对话 |
| POST | `/ai/actions/:id/confirm`、`/reject`、`/revert` | 动作确认 / 拒绝 / 撤销 |
| POST | `/projects/:id/ai/facts/:factId/confirm`、`/reject` | 左侧待确认资料确认 / 忽略 |
| PATCH | `/projects/:id/resume-draft`、changes revert | 草稿保存与撤销 |
| POST/GET | `/projects/:id/versions`、`/versions/:id`、`/compare`、`/clone`、`/export` | 版本保存、详情、比较、复制、导出 |
| POST/GET | `/projects/:id/generations`、`/generations/:id`、`/events`(SSE)、`/retry`、`/cancel` | 生成与进度 |
| POST | `/artifacts/:id/download-url`、`/download` | 短期下载地址与附件下载 |

---

## 6. 测试

```bash
npm install     # 安装 jsdom（仅测试依赖）
npm test
```

| 文件 | 覆盖 |
|---|---|
| `tests/policy.test.js` | 策略矩阵、白名单、证据要求、revision 冲突、幂等、撤销、fail-closed（含 P0-12） |
| `tests/ai-behavior.test.js` | `AI_BEHAVIOR_TESTS.md` 的 P0-01～P0-20（P0-12 在 policy 覆盖） |
| `tests/versions.test.js` | 草稿/版本/生成闭环：发布验收 3、9、18、19、20，冻结约束，产物下载 |
| `tests/prototype-parity.test.js` | 前端渲染 DOM 与原型逐结构比对、样式逐字符比对 |

每个测试文件使用独立数据库与独立端口，互不干扰。

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 服务端口 |
| `RESUME_DB_PATH` | `data/resume.db` | SQLite 文件位置 |
| `RESUME_FONT_PATH` | `/home/ubuntu/.fonts/NotoSansSC.ttf` | PDF 中文字体 |
| `RESUME_LLM_PROVIDER` | `local-rule-engine` | 设为 `http` 时调用远程模型 |
| `RESUME_LLM_ENDPOINT` / `RESUME_LLM_API_KEY` / `RESUME_LLM_MODEL` | — | 远程模型配置 |
| `RESUME_OCR_ENDPOINT` / `RESUME_OCR_API_KEY` | — | 云 OCR；未配置时图片需粘贴文本兜底 |
| `RESUME_DOWNLOAD_SECRET` | 本地默认 | 下载令牌签名密钥 |

---

## 8. 与 PRD/TECH 的对应与当前降级

已实现：三栏信息架构、自动保存与乐观锁、AI 润色、三种系统模板与自定义模板、
岗位多图导入/OCR/分析、一键生成 PDF/DOCX、主动保存版本、不可变版本、
历史详情/比较/复制/导出、失败重试与部分成功、审计日志、跨用户隔离、幂等。

MVP 阶段的工程降级（接口与语义保持与 TECH 一致，替换为生产组件即可）：

| 项 | 当前实现 | 生产建议 |
|---|---|---|
| 主数据库 | SQLite（含相同表/约束/触发器） | PostgreSQL 16 |
| 队列 | 进程内 Worker + outbox 表 | Redis + BullMQ |
| 对象存储 | 本地目录 | S3 兼容私有桶 |
| 上传 | 整体直传 + magic bytes 校验 | 预签名分片直传 + 病毒扫描沙箱 |
| PDF 渲染 | 内置 writer（嵌入 Noto Sans SC，字体未子集化，约 8 MB） | 固定版本 Chromium 打印 + 字体子集化 |
| OCR | 未配置云服务时对图片返回空文本，需粘贴兜底（不臆造） | 云 OCR Provider |
| 语音 | 录音状态机与交互完成，未接入 ASR | 流式 ASR + 分片上传 |
| AI 模型 | 本地确定性规则引擎（离线可测） | 远程 LLM（严格 JSON Schema） |

> 安全说明：任何情况下都不因「用户要求」或「模型文本」写入未确认事实；
> 未点击「应用修改」正文不变，未点击「设为当前岗位」岗位不变，AI 声称的「已保存」不作为成功依据。
