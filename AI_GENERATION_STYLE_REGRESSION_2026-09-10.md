# 局部／全局生成态统一 · 2026-09-10

## 变更

- 两类 AI 共用生成按钮函数、生成状态渲染函数和 CSS，统一 32px 高度、10px 字号、配色、旋转图标及动态圆点；生成态不再用局部原来的灰色禁用按钮。
- 共用无障碍状态与减少动态效果支持，成功、失败、关闭恢复原按钮；仅复用视觉，不改模型、请求、作用范围和取消机制。
- 生成态不对尺寸与字号作过渡动画，避免生成开始瞬间两边的计算样式不一致。
- 真实入口、AGENTS、PRD、TECH、行为验收同步；历史原型未修改。

## 验证

```sh
node --test tests/ai-generation-style-browser.test.js tests/ai-ui.test.js tests/workspace-ui.test.js tests/local-ai-qa.test.js tests/global-chat-browser.test.js tests/chat-context-mode.test.js tests/global-continuity-browser.test.js tests/editor-dismiss-browser.test.js
```

58 项通过，0 失败、0 跳过。日志：`/tmp/resume-generation-style-verified-20260910.log`。

新增真实 Chromium 测试通过隔离服务延迟模型结果，分别覆盖局部及全局的成功、失败；核对按钮、提示和动画的计算样式完全一致，320px 不越界，减少动态效果时停止动画，恢复后不残留生成状态。未点击应用，草稿保持不变。既有继续调整、关闭后迟到响应、全局恢复与重试测试一并通过。

确认无运行中任务后重启 PM2 `resume`。线上入口 HTTP 200；重启前后 9 张业务表内容一致，只读浏览器复查前后 10 张表内容一致、浏览器异常 0。线上额外以临时 DOM 验证已部署公共样式，两按钮高度、字号、渐变与旋转动画一致，不发送 AI 请求。部署日志：`/tmp/resume-generation-style-production-20260910.log`。

本轮为相关模块回归，未重新运行整个项目全量，也未新增真实 Astra 调用。

## 并行诊断边界

用户指定子代理检查独立头像插入问题，子代理仅做只读排查：独立 PNG 已上传，模型成功返回 message；附件未提供可嵌入文档的稳定资源协议，且模型建议了不存在的正文“插入图片”入口。本次没有实施图片资源、裁剪或导出改造，之前的方案仍为评估结果。
