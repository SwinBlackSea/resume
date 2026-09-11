# 简历图片与头像子系统

2026-09-10。此模块复用当前 ResumeDocument、建议、应用事务、版本和对象存储，不建立个人头像档案、模板绑定或第二份文档。

## 目标与职责

模型理解材料用途、选择照片和目标位置。确定性程序负责文件读取、坐标转换、裁剪、资源授权、持久化与导出。头像只是 `purpose=portrait` 的一种图片用途，基础设施支持一般文档图片。

```
附件上传 → 一次内容识别 → 当前任务材料
               ↓              ↓
         图片候选解析缓存 → 全局视觉输入（稳定图片 ID＋尺寸＋用途）
                              ↓
              message 或 proposal.asset_requests
                              ↓
           harness 校验声明／物化目标文档＋私有图片
                              ↓
             原有预览 → 用户应用 → 同一草稿事务
                              ↓
           撤销／历史版本／复制／再次应用／导出
```

### 组件

| 组件 | 职责 |
| --- | --- |
| `server/lib/document-assets/index.js` | 私有资源、内容去重、候选缓存、方向和裁剪、授权读取、引用回收 |
| `native-extractor.js` | DOCX 嵌入图及显示裁剪/旋转、VML、DOC 兼容转换、工具边界 |
| `pdf_images.py` | PDF 原生图/透明蒙版、原页面位置及可见页参考，支持扫描 PDF |
| `server/modules/document-assets.js` | 私有图片读取及按需候选 API |
| `chat-images.js`、`ai.js` | 当前及任务历史图片/文件汇集，不从旧独立任务借图 |
| `resume-harness/image-materializer.js` | 解析图片声明、锁定目标 img、裁剪并生成普通完整目标文档 |
| `output-json-schema.js`、`conversation-protocol.js` | 供应商无关的严格输出及每图稳定引用标记 |
| 原有渲染与导出模块 | 消费普通 img/assets，授权读取原字节，不访问任意外网图片 |

业务 server 保持归属与事务职责；harness 不将文件字节写入建议 JSON；gateway/供应商 adapter 不执行裁剪、不访问业务数据库。

## 各输入格式的数据流

- 独立 PNG/JPEG/WEBP：直接注册已有上传对象，原字节不重复存储。模型输入自动纠正 EXIF 方向并限制长边 2560；原图不缩小。
- 截图：整张图作为候选。模型返回完整照片区域的归一化矩形，后端从原始方向纠正后的像素裁剪为不可变 PNG。
- DOCX：读取内部关系，不访问外部链接；提取实际被 DrawingML/VML 引用的图片。DrawingML 原有裁剪、旋转先作用于图片；给模型传入可见图片候选和显示尺寸/文档顺序。
- DOC：沿用已安装 LibreOffice 的兼容转换，再走 DOCX 适配器；转换临时目录每次完成或失败后清理。
- PDF：优先保留原生图片及透明蒙版，附实际页面矩形；同时提供页面渲染参考，让模型区分装饰、头像、扫描页及被旋转/遮挡的区域。扫描页照片可直接从页参考裁剪。
- 完成后的图片候选按上传内容 SHA256 与解析版本缓存，后续对话复用，不重新识别正文。

直接导入也复用这条链路：含嵌入图的 DOCX/DOC 采用已识别的保真页面背景＋真实可编辑文字，避免纯文字原生树丢失照片；不将背景中的照片虚报为可独立编辑的头像节点。PDF/PNG 沿用同一页面场景。导入成功后预热原生图片候选，后续 AI 可以选择并提取为独立图片；若原生图形不受支持，复用本次识别已生成的页图并给出降级提示，不再次 OCR、不因装饰图片失败而破坏整个导入。Word 含图且无法保留有效页面场景时明确失败，不能静默丢图。

原生 PDF 图片并不总等于页面上最终可见区域。复杂剪裁、旋转或重叠时，模型可改用页面参考中的实际可见区域，不能将原生抽取成功等同于版式和照片选择完全正确。

## 文档及模型协议

文档图片继续使用普通节点：

```json
{
  "id": "portrait-node",
  "type": "element",
  "tag": "img",
  "attributes": {
    "data-document-asset-id": "immutable-asset-id",
    "src": "/api/v1/document-assets/immutable-asset-id/content",
    "alt": "求职者照片"
  },
  "style": { "width": "90px", "height": "120px", "object-fit": "cover" },
  "children": []
}
```

`document.assets` 保存 `{id,mime_type,width,height,url}` 描述，不保存 Base64、原附件内容或短效签名 URL。img 不可 editable，图片替换/新增与相关布局进入同一建议、同一可逆事务。

每张视觉图片前有 `image_reference`，与上下文 `image_candidates` 一致，包含 `input_image_id`、方向纠正后的原图尺寸、模型输入尺寸、类别、页面/位置及可选 `material_role`。坐标系统统一为方向纠正后的归一化 0–1，不随视觉输入缩放改变。

严格 `resume_proposal` 新增：

```json
{
  "asset_requests": [
    {
      "input_image_id": "upload-id:1",
      "target_node_id": "portrait-node",
      "purpose": "portrait",
      "crop": { "x": 0.7, "y": 0.05, "width": 0.15, "height": 0.18 }
    }
  ]
}
```

独立完整照片使用 `crop:null`；无图片变更使用空数组。图片目标必须出现在同批 changes/insertions 或目标文档中，或为当前已有 img。仅替换已有图片资源可使用空 changes/insertions，不要求伪造文字变化。禁止模型编造 URL、输出二进制、询问内部节点 ID 或声称存在未实现的按钮。

模型仍只产生 message/proposal 两种顶层结果。图片失败进入原有有界恢复；混合动作不能静默遗失已通过的独立动作。

首页材料显式分为 personal/job/layout 时，候选保留用途，job/layout 不授权充当求职者头像；排版参考中的姓名、经历和照片不代表本人资料。普通聊天无显式用途时依据当前用户原话及有效对话判断，真实歧义短追问，不做关键词权限匹配。

内置图库通过受控目录和 SHA256 校验读取选中参考图，传入 `builtin-layout:ID:hash` 及 `reference_only:true` 的视觉输入，不伪装成另一份结构样例、不建立用户头像资源。模型只能参考其排版；harness 拒绝以任意 `purpose` 将只读参考图物化为正文图片。任务冻结所选 ID，继续对话仍使用同一参考。

## API

- `POST /api/v1/projects/:id/image-candidates`：`{conversation_id,upload_id}`。验证 owner、项目、活动对话及附件归属；返回候选描述与私有预览 URL。只解析，不改正文、不建立个人资料。
- `GET /api/v1/document-assets/:id/content`：按 owner 授权读取，返回真实 MIME、私有缓存与 nosniff；不允许跨用户读取。
- 内部 `readDocumentAsset(assetId, ownerId)`：同步返回 `{buffer,mime_type,width,height,id,url}`，对文件 SHA256 校验。导出调用者仍先验证完整文档及所属项目。
- `validateDocumentAssets(document, ownerId)`：在草稿/版本/AI 目标写入边界验证显式 ID 和只有 src 的私有 URL；src 与 ID 不一致拒绝，不能通过删除 data 属性绕过授权。

不额外建立“应用头像”接口：照片与文本/版式一起使用既有建议预览、revision 校验、三方合并和应用接口。

### 正文图片直接更换（不调用模型）

`resume-image-edit.js` 负责正文内独立 `img` 的鼠标/键盘入口、选择新文件、取消和上传状态。它与服务端共享目标资格检查；整页扫描、页面场景背景不能被当成头像替换，继续使用全局 AI 处理。客户端先等待未保存文字完成，再锁定项目、节点 ID 与草稿 revision。

`POST /api/v1/projects/:id/resume-draft/images/:nodeId` 接收 `{upload_id,expected_revision,mutation_id}`。只接收本用户新上传、已通过类型校验的图片，注册不可变资源后调用既有草稿事务的 `replace_image` 操作；异步读图之后再次校验 revision，防止其他操作被覆盖。仅替换 `src`、资源 ID 和对应资源描述，保留节点 ID、原位置、尺寸及 `object-fit`，不默认裁剪新图。

该操作仍是 `document_transaction`，复用自动保存与五步撤销/重做。节点差量额外保留前后资源描述，不增加双份完整正文、不新增撤销栈、不自动保存版本。已保存版本和有效撤销记录继续保护旧图片。完成后可删除一次性上传身份，但上传删除接口不得删除仍属于文档资源的原字节；重复提交返回原操作回执而不再次更换。

## 数据库与迁移

- `document_assets`：UUID、owner、SHA256、对象键、MIME、原图方向纠正后尺寸、字节数、创建时间；`UNIQUE(owner_id,sha256)`。不可变图片，替换产生新 ID；同用户复制简历复用同一对象。
- `document_image_cache`：owner、upload、输入 SHA256、解析版本、候选 JSON、创建及访问时间；主键 owner/upload/version。它是可重建的解析索引，不是第二份文档。
- 启动时 `CREATE TABLE IF NOT EXISTS`，向后兼容，不改写旧文档、不删除个人资料/原简历/版本。
- 不增加易漏维护的双写资源引用表。当前草稿、版本、建议、撤销、压缩再次应用材料中的真实引用才是资源存活依据。

## 缓存、生命周期与并发

- 解析请求以 owner/upload/hash/version 合并在途请求，最多 32 个在途键；原生解析最多 2 个同时执行，最多 16 个等待，超限明确提示繁忙。
- 视觉 JPEG 派生图仅内存 LRU，总量最多 16 MiB；不持久化每轮模型输入。原图单文件最大 20 MiB、64M 像素；原生候选最多 24、PDF 最多 12 页、候选总图像字节最多 80 MiB，工具最长 90 秒。
- 临时转换目录由 `mkdtemp` 创建，只清理该确定目录，不递归删除上传目录。
- 新对话移除聊天上传身份时，如果原对象同时为文档资源，不删除该对象。既有草稿、版本、复制、五步撤销/重做、未应用和已应用的再次应用材料均能继续读图。
- 每轮完成、失败或取消后按真实持久引用回收无引用图片；活动生成/解析存在则延后。常规清理有 24 小时宽限，已结束生成的安全检查可以立即清理无引用裁剪产物。
- 回收读取失败或 JSON/压缩材料损坏时 fail-closed，保留对象后重试，不把解析失败当作“无引用”。仅最小 ID 描述随工作区传输，图片按需私有获取。

## 验证及可靠性边界

`tests/document-assets.test.js` 覆盖不可变原字节、归属、去重、EXIF 坐标、越界裁剪、DOCX 原生裁剪/旋转、PDF 原生/页参考、真实 DOCX/DOC 导入→预览→应用（检查照片实际像素与可编辑文字）、稀疏插图→预览→应用→新对话后保留、压缩再次应用引用保护、无引用回收。浏览器和 PDF/Word 导出验收由整项目真实链路测试覆盖。

`tests/document-image-edit.test.js` 覆盖直接替图的归属、并发 revision、幂等、无模型调用、原尺寸与原比例字节、紧凑撤销记录、上传清理和整页背景拒绝；真实 Chromium 覆盖本地文件选择、取消、替换、未保存文字、撤销/重做与刷新。

`RESUME_LIVE_PORTRAIT_QA=1 node --test tests/document-assets-live.test.js` 是显式启用的真实 Astra 测试，使用隔离数据库、独立 QA 配置与虚构截图，不读取 Codex 凭据或真实用户简历。记录照片矩形 IoU、调用次数、可执行建议和原像素嵌入。

2026-09-10 的两种不同截图位置实测均为单次模型请求、无恢复重试，照片框 IoU=1.0，原文字保留；这只是两种合成样本的实际结果，不代表任意用户截图的准确率保证。另有稀疏父样式＋子节点插入的组合回归，避免正常布局调整因操作顺序被误拒绝。

模型理解与空间定位不能承诺每张截图都完美。后端能确定性保证原字节、不越界、位置 ID、权限、应用一致性和资源不因聊天清理丢失；“选对人像、完整框住照片”需实际样本评估与预览，低清、多头像和用途歧义不能假装成功。
