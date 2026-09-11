# 系统样式图库

2026-09-10。真实首页实现，不涉及历史原型。

## 内容与许可

本地共有 20 份不同的上游简历样式参考，不是将原有 3 款只换颜色扩充。2026-09-10 清晰度修复后，原生 PDF、显示图片、缩略图及保留的旧下载文件共约 20 MB。它们是版式参考，不是可直接下载的 Word 模板包，也不是新的模板绑定系统。

| 上游 | 固定提交 | 样式 |
| --- | --- | --- |
| Reactive Resume | `730f795073126e850cab348038f9557da6f810fd` | Azurill、Bronzor、Chikorita、Ditgar、Ditto、Gengar、Glalie、Kakuna、Lapras、Leafish、Meowth、Onyx、Pikachu、Rhyhorn、Scizor |
| Reactive Resume v3 | `a293d209de5dbafeba2c587cb85b5fca2e225cdb` | Castform |
| Reactive Resume v4 | `91c8624d8043fdb78424d4a1641b2fc3efdbd016` | Nosepass |
| Resumake | `078e8a1f660a57ced716c3d38888f1b164d188ac` | Template 1、Template 3、Template 9 |

- 原始下载、派生显示图和 WebP 缩略图、完整来源清单位于 `assets/builtin-layouts/`。
- `manifest.json` 逐项保留仓库、固定 commit、原始下载地址、上游名称、许可证文件、原始 PDF/显示图/缩略图 SHA-256、尺寸及转换参数。
- 15 款当前 Reactive Resume 样式改为下载同一提交的原生 PDF，经 Poppler `pdftoppm` 以 200 DPI 渲染第一页，提供 1654–1656 像素宽的大图；这不是把旧 510 像素图片放大或用 AI 猜测文字。上游 PDF 为 1–6 页，页数记入清单；图库和模型使用同一第一页参考，不声称完整导入所有 PDF 页面。
- 其余 5 款仍使用上游原图：Castform 724×1024、Nosepass 1133×1600、Resumake 三款 1700×2200。没有找到 Castform 更高分辨率的同款源，因此保留真实分辨率，不伪造高清。
- 列表仍使用最大 440 像素宽的轻量缩略图；大图和缩略图 URL 包含各自内容哈希，发布高清资源后不会继续命中旧模糊图的浏览器缓存。
- `licenses/` 保留上游原文 MIT 许可及版权归属，包括 Reactive Resume 的 2022、2023、2026 年许可和 Resumake 的 2017 年客户端许可。图库每张卡片也标注项目归属与 MIT。
- 下载的是项目本身用于展示样式的样例图片和原生 PDF，没有搜集私人真实求职者简历，没有安装或执行上游软件、npm 脚本、LaTeX 代码。
- `scripts/import-builtin-layouts.js` 是显式执行的固定版本导入工具，不在服务启动或用户浏览时联网执行。运行时不依赖外网图片。

## 用户流程

首页第三张“简历模板”卡片 → “系统样式” → 20 款缩略图 → 点击预览 → 大图弹框中的“应用”。

只浏览、返回、关闭或按 Escape 不改变已选材料。应用成功后关闭图库，在第三张卡片展示实际已选样式的缩略图和名称。只选择样式不会触发简历生成；另外两份材料未准备好时仍不能生成。

原生模态对话框提供焦点约束及背景隔离。大图在同一模态中可滚动；返回列表恢复到实际触发按钮。Escape 先退出大图，再退出图库；关闭后焦点回到“系统样式”。窄屏改为两列；图片加载失败不能应用，可以返回重试。应用过程中以同一个 busy 门闩防止并发提交。

## API 与完整文档边界

- `GET /api/v1/home/layouts`：返回 20 项受控描述、预览及原图地址，不返回本机路径。
- `GET /api/v1/home/layouts/:id/image?size=preview`：派生缩略图；省略 size 为原图。只接受 catalog ID，返回正确图片 MIME、内容哈希 ETag 和安全响应头，不接受任意路径或外网 URL。
- `PUT /api/v1/home/intakes/:id/materials/layout`，body `{ "layout_id": "rr-azurill" }`：复用既有材料保存、归属、识别状态及生成门槛。
- 旧 `quiet`、`editorial`、`modern` ID 继续兼容已存材料和旧任务，不出现在 20 项列表中。
- 新款在授权并冻结的 `home_materials.roles.layout` 中携带 `builtin_reference_id`；不继续发送旧 3 款 `reference_document` 冒充新选择。
- `readBuiltinReferenceImage(id)` 只读取 manifest 控制的本地原图，首次读取校验 SHA-256，进程内缓存不可变图片。
- AI 组装由既有 `ai.js` 完成：读取同一原图，受控视觉转码，携带 `builtin-layout:<ID>:<原图hash>`、`material_role:layout`、`reference_only:true`。模型看到的是用户预览的同一原图，不仅是样式名称。
- 参考图的人物、照片、经历、联系方式不可当作用户事实；参考图不能借图片资源请求整体贴入正文，也不能从中复制头像。最终生成结果仍是唯一、完整、可编辑的 `ResumeDocument`。
- 未创建平行模板表、槽位关系或版本树，没有删除已有简历、个人资料或任何生产数据。

## 验证

`tests/builtin-layouts.test.js`：

- 20 项独立内容哈希、固定上游提交、MIT 许可文件，40 张原图/缩略图均经 sharp 解码并经真实 API 返回相同哈希。
- 真实 Chromium 逐一打开、预览、应用全部 20 款；核对首页图片、名称、服务端材料 ID，且不自动生成。
- 已应用 A → 预览 B → 返回仍 A → 再次预览并应用 B 才改变。
- 1440、768、390、320 像素视口无图库横向溢出。
- 大图失败不允许应用，Escape/返回/关闭不改变已选材料。

`tests/home-redesign-browser.test.js`：

- 继续验证上传、真实浏览器拖拽、岗位状态、三材料门槛、生成等待刷新、就地预览、独立重新生成和返回详情等保留流程。
- 捕获模型客户端请求，断言选中 `rr-azurill` 的 ID、原图哈希、layout/reference-only 标记及实际消息中的图片编码；不传旧样式文档。识别和模型响应使用隔离测试桩，不冒充真实模型质量评估。

`tests/brand-browser.test.js` 已迁移为预览后明确应用；首页返回当前简历及已提供材料的行为保留。

本次没有真实 Astra 调用，因此这里只确认图库、材料身份及视觉协议实际接通，不声称 20 款已逐款通过真实模型版式复刻质量测试。

## 材料图片预览模块

`home-image-preview.js` 导出：

```js
const viewer = ResumeImagePreview.create({ apiBase: '/resume/api/v1' });
viewer.open({ uploadId, name: 'image.png', opener: clickedButton });
// 或使用同源受控私有预览地址、当前页面产生的 blob 地址：
viewer.open({ url, name: '截图.png', opener: clickedButton });
viewer.close();
viewer.destroy();
```

模块只有查看能力，不上传、不应用、不导入正文。支持受控 `uploads/:id/preview`、`document-assets/:id/content`、`home/layouts/:id/image` 路径；带 `same-origin` 凭据及 `no-store` 读取，不接受外网地址、SVG、任意同源页面。子路径部署使用传入 `apiBase`，不硬编码根路径。

原生只读模态支持加载/解码失败、重新加载、原始大小/适应窗口、滚动、Escape 关闭及焦点返回。每次切图及关闭中止旧请求、撤销临时对象 URL，迟到结果不能替换当前图。

`tests/home-image-preview-browser.test.js` 使用真实 Chromium 和实际私有上传接口，验证 1200×1900 原图而非缩略图、本地 Blob、尺寸切换、Escape、焦点、不可用图片、外网拒绝；子路径请求拼接在隔离响应桩中验证，不冒充部署环境测试。
