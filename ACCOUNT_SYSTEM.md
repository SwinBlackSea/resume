# 账号系统：架构、运行与发布边界

更新：2026-09-10。用户已确认首期使用账号密码、独立登录页、开放注册；旧共享账号的全部资料归 `admin`。

## 当前交付与边界

已实现真实密码、会话、账号页面和服务端鉴权，不依赖模型。原有 `users.id` 继续是项目、文档、上传、聊天及历史的所有者；账号系统不复制业务正文、不迁移到第二套资料模型，也不改变 AI 生成、事实规则或应用确认边界。

代码可验证不等于当前部署已启用。公开切换的前提是本机完成管理员绑定、设置强密码、配置独立安全参数并完成账号专项验收。`admin/admin` 仅作为受控初始化状态；它带有 `must_change_password=1`，HTTP 永远不能据此建立业务会话，服务也拒绝在此状态公开启动。不能为了方便测试而保留弱口令后门。

2026-09-10 中断续接：`npm run test:accounts` 的 21 项全部通过，无跳过，包含真实 Chromium；按用户要求停止全量回归。补齐账号设置请求的失效清理、取消与迟到响应拦截，以及启动配置说明。实际数据库已通过 SQLite 一致性备份并绑定 `admin`，保留原 owner 下 6 个项目、6 个草稿、20 个版本、26 个上传和 11 个文档资源。备份为 `.runtime/backups/accounts/before-accounts-2026-09-10T08-31-05-945Z.db`（权限 600，quick_check 通过）。此为首次续接时的备份与绑定记录，后续上线状态见下段。

2026-09-10 17:01（北京时间）上线：用户已本机设置管理员强密码，`must_change_password=false`。已配置生产账号模式、HTTPS Origin、`/resume/` Cookie 路径、实际 loopback 代理及两个独立随机密钥；PM2 `resume` 已重启，Caddy 已改为由应用处理整个 `/resume/*`，`/resume` 重定向到 `/resume/`。配置及包含新密码的数据库备份位于 `.runtime/backups/accounts/release-20260910T090106Z/`，私有文件权限 600。公开 HTTPS 检查通过：登录入口、匿名 API 401、私有响应禁止缓存、仓库文件 404、Secure Cookie、登录 CSRF；真实 Chromium 确认首页跳转可用登录页，注册表单可打开且无页面异常。本次线上检查未输入用户的管理员密码，实际管理员登录由用户使用自设密码完成。

2026-09-10 17:23（北京时间）账号管理已上线：schema v2 迁移和 PM2 重启完成；迁移前备份为 `.runtime/backups/accounts/before-management-2026-09-10T09-23-32-808Z.db`，对用户、简历、草稿、版本、上传、文档资源、密码和会话逐表摘要核验，全部保持原样。22 项账号专项通过，并补跑新增管理按钮的真实浏览器操作；桌面和窄屏已查看实际截图。线上确认管理 API 匿名访问返回 401、新界面脚本已生效。

2026-09-10 账号管理追加：个人中心改为圆形头像入口；修改密码和登录设备默认折叠，个人设置不再展示登录时间。`admin` 的持久角色为 `superadmin`，可搜索、分页查看账号，启用/停用普通账号及强制退出其全部登录；管理员列表显示最近成功登录时间。普通账号不能调用管理接口，超级管理员不能在列表中被停用或强制退出，管理权限不扩大简历 owner 边界。

首期不提供邮箱/短信、第三方登录、MFA、团队权限或在线找回密码。没有邮件基础设施时不会展示虚假的“邮件已发送”；忘记密码由有数据库文件访问权限的运维在本机受控重置。`admin` 是接收旧资料的保留账号名，不意味着能够越权读取新用户资料。

## 组件与职责

```text
login.html / account-workspace.js
                 │
        account-client.js
       Cookie + CSRF + owner fence
                 │
    server/index.js / modules/accounts.js
       认证、Origin、路由、私有响应
                 │
        accounts/password-service.js
          密码登录、注册、改密编排
                 │
           accounts/service.js
       一次性挑战、会话、身份与撤销
                 │
         accounts/repository.js
      SQLite 存储接口与短同步事务
                 │
          users.id → 既有业务 owner
```

- `config.js`：显式配置与严格边界；不读取 `.env`，不连接数据库。
- `schema.js`：只有调用 `migrateAccounts(database)` 才执行增量 DDL；不修改既有业务表。
- `crypto.js` / `passwords.js`：令牌、CSRF、隐私限流键和有界异步密码计算。
- `repository.js`：会话、身份、一次性挑战、限流、最小审计和有界留存清理；不依赖应用数据库单例。
- `service.js`：供应商无关账号身份与会话。扩展身份方式通过适配器验证，不能直接相信客户端 `subject`，不能按邮箱静默合并用户。
- `password-service.js`：首期密码适配器；注册的用户、身份、密码和首个会话在一个事务提交。KDF 在事务外完成，禁止跨异步数据库事务。
- `runtime.js`：组合配置、可信代理、限流范围、启动就绪检查；无生产 demo 回退。
- `admin.js` / `scripts/accounts-admin.js`：显式本机预检、旧 owner 绑定、受控密码重置；不从网络开放管理员初始化。
- `account-client.js`：认证状态、CSRF、旧页账号身份防护、fetch/XHR/EventSource 生命周期与跨标签页登出通知。
- `account-workspace.js`：登录后才启动业务页面，右侧个人中心、账号设置、退出前保存、退出后数据清理。登录账号与简历个人资料是两个不同概念。

替换为 PostgreSQL 或共享会话存储时保持 service 的事务和 repository 契约；不能仅将 SQL 字符串替换而忽略原子挑战消费、限流递增与并发撤销。

## 数据流

1. 匿名访问 `/auth/session`：返回未登录状态和防 CSRF 值，浏览器绑定令牌只放 HttpOnly Cookie。
2. 注册：同源/CSRF 校验 → 限流 → 用户名/密码校验 → 异步 scrypt → 单事务创建账号、身份、凭证、会话 → Set-Cookie。`admin` 不允许公开注册。
3. 登录：同源/CSRF → 持久化限流和一次性挑战 → scrypt → 事务内再核对凭证版本和用户状态 → 消费挑战并创建新会话。验证过程中发生改密/停用时，迟到结果不能登录。
4. 业务操作：Cookie 解析 → 会话闲置/绝对过期、撤销及用户状态检查 → `X-Account-Id` 旧页防护 → 所有写入校验 Origin + CSRF → 既有 owner 查询。用户 ID 绝不来自客户端请求头。
5. 改密：近期密码验证 → 新 KDF → 事务重新检查凭证和会话 → 更新密码、轮转当前 Cookie、撤销其他会话；错误的当前密码返回 `422 PASSWORD_INCORRECT`，不是账号失效。
6. 退出：先保存当前账号的未提交文字；保存失败时保留当前页面并报告。退出成功撤销会话、清 Cookie，清空当前页面业务状态及附件对象 URL，停止旧请求和 SSE，进入登录页。不能把旧页待保存文字提交到新账号。

## API

以下路径均位于 `/api/v1`；经网关挂载时，浏览器使用相应 `/resume/api/v1` 前缀。

| 方法与路径 | 请求 | 结果 |
| --- | --- | --- |
| `GET /auth/session` | Cookie（可无） | `{authenticated:false,csrf_token}` 或账号会话视图 |
| `POST /auth/register` | `{username,password}` + 匿名 CSRF | 新账号会话视图，设置 HttpOnly Cookie |
| `POST /auth/login` | `{username,password}` + 匿名 CSRF | 账号会话视图，设置 HttpOnly Cookie |
| `POST /auth/logout` | 会话 CSRF | `{ok:true}`，撤销当前会话、清 Cookie |
| `POST /auth/password` | `{current_password,new_password}` + 会话 CSRF | 轮转后的账号会话视图 |
| `GET /auth/sessions` | 会话 Cookie | `{items:[{id,current,provider,created_at,last_seen_at,expires_at}]}` |
| `DELETE /auth/sessions/:id` | 会话 CSRF | `{ok:true,current:boolean}`，归属不符返回 404 |
| `POST /auth/logout-all` | `{password}` + 会话 CSRF | 校验当前密码后撤销全部会话、清 Cookie |
| `GET /auth/admin/accounts` | 超级管理员 Cookie，`q` / `offset` | 最多 50 条账号身份、状态与最近登录时间；无凭据或简历 |
| `PATCH /auth/admin/accounts/:id` | 超级管理员 CSRF + `{status:"active"或"disabled"}` | 启停普通账号，并撤销旧会话 |
| `POST /auth/admin/accounts/:id/revoke-sessions` | 超级管理员 CSRF | 撤销普通账号全部会话 |

账号会话视图为 `{authenticated:true,user:{id,username,display_name,role},session,csrf_token}`。不返回 Cookie 令牌、密码哈希、私有挑战或其他用户资料。`401` 表示未登录/会话失效，密码登录失败也返回统一 401 文案但由独立登录表单处理；改密及退出全部设备的密码错误使用 422。公开 API 不允许按传入 user ID 认领旧数据。

浏览器返回地址仅允许同源、同部署目录内的非 API 页面，禁止 `//host`、外部 URL 和反复跳回登录页。页面与 API 使用禁止嵌框、同源 Referrer 和私有响应策略。

## 数据库

| 表 | 作用 / 关键约束 |
| --- | --- |
| `users`（已有） | 永久业务 owner，保持旧记录不变 |
| `account_schema_versions` | 显式迁移版本；不允许旧代码操作未来版本 |
| `account_identities` | `(provider,subject)` 唯一，关联 `users.id` |
| `account_password_credentials` | `user_id` 主键，`username` 唯一，KDF 编码和必须本机改密标记 |
| `account_sessions` | 256-bit 随机令牌仅保存 SHA-256，闲置/绝对到期、认证时间、撤销原因 |
| `account_challenges` | 哈希令牌/浏览器绑定、目的、供应商、过期、次数预算及单次消费 |
| `account_rate_limits` | HMAC 后的限流键、窗口、计数及到期时间；不存明文用户名/IP |
| `account_security_events` | 最小事件类型、user ID 和时间，不记录密码、正文、请求头或令牌 |
| `account_metadata` | 持久角色、最近成功登录时间、`auth_revision` 撤销计数；不随会话/审计清理删除 |
| `account_admin_actions` | 管理操作的操作者、目标账号、动作与时间，按审计保留期有界清理 |

默认闲置 30 分钟、绝对 12 小时、每人最多 10 个活跃会话；Cookie 轮转不能无限延长绝对寿命。挑战默认 5 分钟/最多 5 次，登录默认每个受控限流身份 5 分钟 10 次，注册为 5 次。密码 KDF 同进程最多 2 个并行，最多等待 8 个请求、队列 10 秒超时，避免内存耗尽。

密码使用 Node 原生异步 scrypt，`N=2^17,r=8,p=1`、16-byte 随机盐和 32-byte 派生密钥。编码带算法版本，禁止由不可信输入控制 KDF 参数。普通密码 15–128 个 Unicode 码点，NFC 规范化，允许粘贴与密码管理器，不强制特殊字符，不定期强制改密；有小型常见密码拒绝集，不宣称覆盖所有泄露密码。未来接入更完整离线词库或隐私保护泄露检测，应作为密码策略组件独立扩展。

## 缓存与留存

- 不缓存“登录成功/授权成功”结果；每次请求都核实数据库，踢设备、改密、停用立即对新请求生效。
- SSE 最多 30 秒重新验证一次，不用心跳延长闲置寿命；前端退出/切账号立即关闭本页 EventSource。
- 私有 API、图片和下载统一 `private,no-store`，不能继续沿用旧图片的浏览器缓存授权。公开静态代码只 `no-cache`。
- 限流在数据库中持久化，跨同一数据库的进程一致；以后可用 Redis 原子脚本替换，不能换成各 worker 独立内存计数。
- 服务启动及每 5 分钟做一次有界清理，每类最多 250 条；到期挑战/限流清除，过期或撤销会话和最小审计默认保留 30 天。身份、活跃会话、业务资料不按这个周期清理。
- 前端 owner 变化时清理旧 resume 会话缓存、内存文档、聊天与图片 URL，不自动将旧匿名首页材料认领给新用户。浏览器偏好（如增删按钮开关）可保留，但不保留他人正文。
- 页面离开或隐藏时先遮住业务区；BFCache 恢复、重新聚焦或重新可见时，用 `/auth/session?touch=0` 只读核验账号后再展示，不通过后台检查延长闲置寿命。同账号另一标签页登录/改密通知仅传事件和 owner ID，接收页重新读取 CSRF，不广播 Cookie 或令牌。旧会话读取失败不得通过迟到 `Set-Cookie` 清除新会话。

## 旧资料初始化与上线

先制作可恢复的一致性数据库备份。不能在 SQLite 活跃 WAL 写入时只随手复制主 `.db` 文件当作完整备份。以下命令必须由有本机数据库权限的运维执行，代码不会代替用户选择新强密码：

```bash
# 只读预检；无 --apply 不进行账号迁移或绑定
node server/scripts/accounts-admin.js status --database /home/ubuntu/codex/project/resume/data/resume.db
node server/scripts/accounts-admin.js bootstrap --database /home/ubuntu/codex/project/resume/data/resume.db

# 确认唯一旧共享 owner 后，增量建表并绑定保留用户名 admin
node server/scripts/accounts-admin.js bootstrap --database /home/ubuntu/codex/project/resume/data/resume.db --apply

# 本机交互终端输入两次强密码，不放 argv、环境变量、日志或 URL
node server/scripts/accounts-admin.js set-password --database /home/ubuntu/codex/project/resume/data/resume.db --username admin --apply
```

已有账号部署升级到 schema v2 时先备份，再执行下面显式迁移，然后重启。迁移为原 password/admin 身份授予超级管理员角色，并从保留的成功登录事件补记最近登录时间，不根据活跃时间猜测登录；停用及强制退出递增撤销计数，KDF 完成后再次校验以阻止迟到登录。

```bash
node server/scripts/accounts-admin.js migrate --database /home/ubuntu/codex/project/resume/data/resume.db
node server/scripts/accounts-admin.js migrate --database /home/ubuntu/codex/project/resume/data/resume.db --apply
```

若无法唯一识别旧共享账号，预检失败停止；可在人工核实后显式增加 `--owner-id`。已有 `admin` 属于不同 owner 时拒绝合并。绑定重复执行幂等，不重设已有管理员密码；重置密码的操作独立且会撤销该账号全部会话。原简历、草稿、上传、图片、对话、有效撤销与历史保持原 owner，不批量改写。

上线配置由部署环境注入：

```text
RESUME_AUTH_MODE=accounts
RESUME_AUTH_PUBLIC_ORIGIN=https://chat150.xiaoxi.online
RESUME_AUTH_BASE_PATH=/resume
RESUME_AUTH_RATE_SECRET=独立生成的至少32字节随机密钥
RESUME_DOWNLOAD_SECRET=另一份至少32字节随机密钥
RESUME_AUTH_TRUSTED_PROXIES=仅填写实际反向代理IP，以逗号分隔
```

公开部署不启用 `RESUME_AUTH_ALLOW_LOOPBACK_HTTP`。本地隔离测试可以显式开启，它只接受 loopback HTTP。`X-Forwarded-For` 仅在连接来自配置的可信代理时从右向左解析，不相信攻击者附加的第一个 IP；代理列表必须根据实际网络核实，不能填任意网段或照抄示例。

Caddy 已将原 `/resume/api/*` 和直接提供仓库文件的 `/resume/*` 两个 handle 合并为下面配置，使页面经过服务端的账号启动注入和静态文件白名单。配置已验证并重载。

```caddyfile
redir /resume /resume/ 308
handle /resume/* {
    uri strip_prefix /resume
    reverse_proxy 127.0.0.1:8787
}
```

旧进程静态入口不会自行开启新账号 UI；新 accounts 进程返回 `index.html` 时注入账号启动标志并在鉴权完成前隐藏业务区。该标志只负责前端发布兼容，不是鉴权：删除标志不能绕过后端 Cookie/owner 校验。生产启动拒绝缺失账号模式/Origin/密钥、未完成管理员强密码设置或开发下载密钥。

唯一测试替身必须同时满足 `NODE_ENV=test` 和 `RESUME_TEST_AUTH=1`；原有回归的默认测试用户和 `x-user-id` 仅在此路径存在。真实账号 HTTP/浏览器测试注入独立 runtime，不依赖此替身。发布环境严禁配置这组测试开关。

## 验收与安全依据

测试覆盖显式/重复迁移、旧 owner 保留、弱初始化拒绝公开登录、原子注册及失败回滚、scrypt、过期/轮转/会话数、并发挑战消费、旧密码迟到结果、停用和跨 owner、CSRF/CORS、原始上传、可信代理、有限留存；真实 Chromium 覆盖登录注册、表单错误、窄屏、安全回跳、HttpOnly Cookie。工作区浏览器覆盖旧资料访问、设备踢除、改密、退出前保存和新账号隔离。

使用 OWASP Authentication、Session Management、Password Storage、CSRF Prevention Cheat Sheets 和 NIST SP 800-63B-4 作为安全设计依据。单密码账号不宣称抗钓鱼认证或达到 MFA/AAL2。独立真实模型测试与账号安全回归是两件事，不能将没有执行的模型测试计入通过。

账号系统已在当前生产部署启用。21 项隔离账号专项已通过，实际地址的入口与匿名访问保护已检查；线上未执行管理员密码登录或真实资料上传下载，不将隔离测试报告为这些线上操作已完成。本轮按用户要求不跑全量回归。
