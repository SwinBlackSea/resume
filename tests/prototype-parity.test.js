'use strict';
/**
 * 原型结构一致性测试。
 * v2.2 已按最新 PRD 移除“来源/待确认事实/资料到正文使用关系”，
 * 当前简历支持现有文字轻量直改，结构和样式调整交由 AI 提案，
 * 因此只比对仍然有效的布局、正文和稳定交互，不再要求旧业务文案逐字相同。
 * 做法：分别解析「原型静态 DOM」与「前端加载真实数据后渲染的 DOM」，
 * 对关键区域生成结构签名（标签 + id + class + 文本）并逐项比对。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');

const ROOT = path.join(__dirname, '..');
const PROTOTYPE_HTML = fs.readFileSync(path.join(ROOT, 'index.prototype.backup.html'), 'utf8');
const APP_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 原型中存在的关键 id；其余 id 属于实现增强（用于精确定位内容），比对时忽略。 */
const KEY_IDS = new Set(['target-bullet', 'scale-bullet']);

/** 生成结构签名：标签 + id + class + 文本，忽略空白与内联样式值。 */
function signature(node) {
  if (node.nodeType === 3) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    return text ? `t(${text})` : '';
  }
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  let id = node.getAttribute('id');
  if (id && !KEY_IDS.has(id)) id = null;
  const cls = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const head = [tag, id ? `#${id}` : '', cls.length ? `.${cls.join('.')}` : ''].join('');
  const children = Array.from(node.childNodes).map(signature).filter(Boolean);
  return children.length ? `${head}[${children.join(',')}]` : head;
}

/** 取容器下所有匹配元素的签名列表。 */
function signatures(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map(signature);
}

function texts(root, selector) {
  return Array.from(root.querySelectorAll(selector)).map((el) =>
    el.textContent.replace(/\s+/g, ' ').trim(),
  );
}

async function waitFor(predicate, timeout = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待前端状态更新超时');
}

let ctx;
let origin;
let proto;
let app;

test.before(async () => {
  ctx = await helpers.boot();
  origin = ctx.base.replace('/api/v1', '');
  proto = new JSDOM(PROTOTYPE_HTML).window.document;
  app = await loadApp(origin);
});

test.after(() => helpers.close(ctx));

function loadApp(base) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(APP_HTML, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: base + '/',
      pretendToBeVisual: true,
      beforeParse(window) {
        window.fetch = (u, o) => fetch(new URL(u, base), o);
        window.EventSource = class {
          addEventListener() {}
          close() {}
        };
        window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
      },
    });
    setTimeout(() => resolve(dom.window.document), 2500);
    setTimeout(() => reject(new Error('前端加载超时')), 12000);
  });
}

test('顶栏与品牌区文案一致', () => {
  assert.deepStrictEqual(texts(app, '.brand'), texts(proto, '.brand'));
  assert.deepStrictEqual(texts(app, '.top-actions .btn, .top-actions .soft-btn, .top-actions .icon-btn'),
    texts(proto, '.top-actions .btn, .top-actions .soft-btn, .top-actions .icon-btn'));
});

test('左侧资料卡片文案与状态一致', () => {
  assert.deepStrictEqual(
    texts(app, '#profile-card strong, #profile-card p'),
    texts(proto, '#profile-card strong, #profile-card p'),
    '个人信息摘要必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#job-card strong, #job-card p, #job-card .info-status'),
    texts(proto, '#job-card strong, #job-card p, #job-card .info-status'),
    '岗位信息卡片必须一致',
  );
});

test('中央简历画布：结构与正文 100% 一致', () => {
  const protoResume = proto.querySelector('#resume-document');
  const appResume = app.querySelector('#resume-document');
  assert.ok(appResume, '前端必须渲染简历正文');
  const documentClasses = app.defaultView.WS.draft.resume_json.root.attributes.class || '';
  assert.deepStrictEqual(
    new Set(appResume.classList),
    new Set([...protoResume.classList, ...documentClasses.split(/\s+/).filter(Boolean)]),
    '画布保留宿主 class，同时应用当前文档的根 class',
  );
  const canvas = appResume.cloneNode(true);
  canvas.className = protoResume.className;
  assert.strictEqual(
    signature(canvas),
    signature(protoResume),
    '简历画布结构与正文必须与原型逐字一致',
  );
});

test('AI 建议标记与可编辑段落一致', () => {
  assert.deepStrictEqual(
    signatures(app, '#resume-document .ai-marker'),
    signatures(proto, '#resume-document .ai-marker'),
  );
  assert.strictEqual(
    app.querySelectorAll('#resume-document .editable').length,
    proto.querySelectorAll('#resume-document .editable').length,
    '可编辑段落数量必须一致',
  );
});

test('个人信息浮层不再展示来源或待确认事实关系', () => {
  assert.strictEqual(app.querySelector('#profile-pending-panel'), null);
  assert.doesNotMatch(app.querySelector('#profile-modal').textContent, /识别自|当前简历使用/);
});

test('个人信息浮层：分类与经历条目一致', () => {
  assert.deepStrictEqual(
    texts(app, '#profile-modal .record-title b'),
    texts(proto, '#profile-modal .record-title b'),
    '资料分类必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#profile-modal .experience-head b'),
    texts(proto, '#profile-modal .experience-head b'),
    '经历条目必须一致',
  );
});

test('岗位浮层：覆盖情况与要求条目一致', () => {
  assert.deepStrictEqual(
    texts(app, '#job-modal .coverage-summary'),
    texts(proto, '#job-modal .coverage-summary'),
    '覆盖度摘要必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#job-modal .record-title'),
    texts(proto, '#job-modal .record-title'),
  );
  assert.deepStrictEqual(
    texts(app, '#job-modal .requirement-list li'),
    texts(proto, '#job-modal .requirement-list li'),
    '岗位要求条目与状态必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#job-modal .keyword-chips span'),
    texts(proto, '#job-modal .keyword-chips span'),
  );
});

test('简历画布无需编辑模式切换，历史版本入口保持一致', () => {
  assert.strictEqual(app.querySelector('#edit-document-button'), null);
  assert.strictEqual(app.querySelector('#manual-edit-toolbar'), null);
  assert.strictEqual(app.querySelector('#inline-edit-hint'), null);
  assert.ok(app.querySelector('#inline-edit-status.visually-hidden'));
  assert.deepStrictEqual(
    texts(app, '.top-actions .history-open'),
    texts(proto, '.top-actions .history-open'),
  );
});

test('移动端在简历工具栏提供可见的历史版本入口', () => {
  const mobileEntry = app.querySelector('.mobile-history-open.history-open');
  assert.ok(mobileEntry, '移动端必须存在独立历史版本入口');
  assert.match(mobileEntry.textContent, /^历史 · \d+$/);
  assert.match(
    APP_HTML,
    /@media\(max-width:760px\)[\s\S]*?\.doc-tools \.mobile-history-open\{display:inline-flex!important\}/,
    '移动端媒体查询必须显示历史版本入口',
  );
  mobileEntry.click();
  assert.ok(app.querySelector('#history-modal').classList.contains('show'));
  assert.ok(app.querySelector('#history-list').classList.contains('active'));
});

test('简历编辑栏在画布内保持悬浮，并在滚动后进入紧凑状态', async () => {
  const toolbar = app.querySelector('#doc-toolbar');
  const canvas = app.querySelector('.canvas');
  assert.ok(toolbar);
  assert.strictEqual(toolbar.getAttribute('role'), 'toolbar');
  assert.match(APP_HTML, /\.doc-toolbar\{position:sticky;top:var\(--doc-toolbar-top,12px\)/);
  assert.match(
    APP_HTML,
    /\.app\{height:100vh;min-height:0;[^}]*overflow:hidden\}/,
    '桌面工作区必须锁定视口高度，避免正文把网格整体撑高',
  );
  assert.match(
    APP_HTML,
    /\.canvas\{[^}]*min-height:0;[^}]*overflow:auto;/,
    '中间画布必须成为真实滚动容器，sticky 才能跟随简历滚动',
  );
  assert.match(
    APP_HTML,
    /@media\(max-width:760px\)\{\.app\{height:auto;[^}]*overflow:visible\}/,
    '移动端必须恢复页面滚动，不能沿用桌面锁屏布局',
  );
  assert.ok(toolbar.querySelector('#undo-step svg'));
  assert.ok(toolbar.querySelector('#redo-step svg'));
  assert.ok(toolbar.querySelector('#zoom-button svg'));
  assert.strictEqual(toolbar.querySelector('#zoom-value').textContent, '100%');
  assert.strictEqual(app.querySelector('#resume-zoom-stage').dataset.zoom, '1');
  assert.strictEqual(
    app.querySelector('#resume-document').parentElement,
    app.querySelector('#resume-zoom-stage'),
  );
  assert.deepStrictEqual(
    texts(app, '#zoom-menu button'),
    ['75%', '90%', '100%', '110%', '125%', '150%', '适应宽度'],
  );
  assert.ok(toolbar.querySelector('#zoom-menu [data-zoom="1"]').classList.contains('active'));
  assert.ok(toolbar.querySelector('#document-import-button svg'));
  assert.ok(toolbar.querySelector('.mobile-history-open svg'), '刷新历史数量后不应丢失图标');
  assert.match(
    APP_HTML,
    /\.doc-toolbar-mark\{[^}]*background:transparent/,
    '文档图标不应使用容易误解为状态的常驻灰底',
  );
  assert.match(
    APP_HTML,
    /\.history-step-controls\{[^}]*background:transparent/,
    '撤销与重做只在可用按钮悬停时显示背景',
  );

  canvas.scrollTop = 64;
  canvas.dispatchEvent(new app.defaultView.Event('scroll', { bubbles: false }));
  await waitFor(() => toolbar.classList.contains('is-floating'));
  assert.strictEqual(toolbar.dataset.state, 'floating');

  canvas.scrollTop = 0;
  canvas.dispatchEvent(new app.defaultView.Event('scroll', { bubbles: false }));
  await waitFor(() => !toolbar.classList.contains('is-floating'));
  assert.strictEqual(toolbar.dataset.state, 'expanded');

  const zoom = toolbar.querySelector('#zoom-button');
  zoom.click();
  assert.strictEqual(zoom.getAttribute('aria-expanded'), 'true');
  toolbar.querySelector('#zoom-menu [data-zoom=".75"]').click();
  assert.strictEqual(toolbar.querySelector('#zoom-value').textContent, '75%');
  assert.ok(zoom.querySelector('svg'), '切换缩放后不应销毁按钮图标');
  assert.strictEqual(zoom.getAttribute('aria-expanded'), 'false');
  zoom.click();
  toolbar.querySelector('#zoom-menu [data-zoom="1.5"]').click();
  assert.strictEqual(toolbar.querySelector('#zoom-value').textContent, '150%');
  assert.ok(toolbar.querySelector('#zoom-menu [data-zoom="1.5"]').classList.contains('active'));
  assert.strictEqual(app.querySelector('#resume-zoom-stage').dataset.zoom, '1.5');
  assert.strictEqual(app.querySelector('#resume-document').style.transform, 'scale(1.5)');
  const page = app.defaultView.ResumeDom.resolvePageLayout(app.defaultView.WS.draft.resume_json);
  assert.strictEqual(app.querySelector('#resume-zoom-stage').style.width,
    Math.ceil(page.width * 96 / 72 * 1.5) + 'px');
});

test('历史版本列表：保留原型内容并补充明确版本状态', () => {
  assert.deepStrictEqual(
    texts(app, '#history-list .history-day'),
    texts(proto, '#history-list .history-day'),
    '日期分组必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#history-list .version-row-copy b'),
    texts(proto, '#history-list .version-row-copy b'),
    '版本标题必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#history-list .version-row-copy em'),
    texts(proto, '#history-list .version-row-copy em'),
    '版本摘要必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#history-list .version-kind'),
    ['手动保存', '手动保存', 'AI 生成'],
    '版本创建方式必须明确展示',
  );
  assert.strictEqual(texts(app, '#history-list .current-version').length, 1);
  assert.match(texts(app, '#history-list .current-version')[0], /当前草稿|草稿基于此版/);
  const rows = app.querySelectorAll('#history-list .version-row');
  const thumbnails = app.querySelectorAll('#history-list .version-thumb img');
  assert.strictEqual(thumbnails.length, rows.length, '每个历史版本都应提供真实缩略图');
  assert.strictEqual(
    new Set(Array.from(thumbnails).map((image) => image.getAttribute('src'))).size,
    rows.length,
    '每个历史版本必须使用自己的缩略图地址',
  );
  assert.match(
    APP_HTML,
    /toApiUrl\(v\.thumbnail_url\)/,
    '缩略图地址必须适配网关子目录，不能固定请求站点根路径',
  );
  assert.match(
    APP_HTML,
    /api\('\/projects\/'\+PROJECT_ID\+'\/versions'\)/,
    '每次打开历史版本都必须重新读取列表，不能一直显示页面启动时的缓存',
  );
});

test('历史详情与比较复用完整 Resume DOM，并提供安全继续选项', async () => {
  const rows = app.querySelectorAll('#history-list .version-row');
  rows[rows.length - 1].click();
  await waitFor(() =>
    app.querySelector('#history-detail').classList.contains('active')
    && app.querySelector('#snapshot-resume [data-node-id]'));
  assert.ok(app.querySelector('#snapshot-resume [data-node-id="resume-name"]'));
  assert.strictEqual(app.querySelector('#snapshot-name'), null, '不得继续依赖固定历史字段');

  app.querySelector('#compare-version').click();
  await waitFor(() =>
    app.querySelector('#history-compare').classList.contains('active')
    && app.querySelector('#compare-old-copy [data-node-id]')
    && app.querySelector('#compare-current-copy [data-node-id]'));
  assert.ok(app.querySelector('#compare-change-list').children.length >= 1);

  app.querySelector('#history-back').click();
  await waitFor(() => app.querySelector('#history-detail').classList.contains('active'));
  app.querySelector('#copy-version').click();
  assert.ok(app.querySelector('#restore-version-modal').classList.contains('show'));
  assert.strictEqual(
    app.querySelectorAll('#restore-version-modal input[name="restore-scope"]').length,
    0,
  );
  assert.match(app.querySelector('#restore-version-modal').textContent, /完整简历/);
  assert.match(app.querySelector('#restore-version-modal').textContent, /当前岗位和个人资料/);
  app.querySelector('#cancel-restore-version').click();
});

test('生成进度浮层与引导浮层文案一致', () => {
  assert.deepStrictEqual(
    texts(app, '.run-log .run-step'),
    texts(proto, '.run-log .run-step'),
  );
  assert.deepStrictEqual(
    texts(app, '#guide-modal .guide-step'),
    texts(proto, '#guide-modal .guide-step'),
  );
});

test('AI 助手面板：保留全局入口并说明就地改写边界', () => {
  assert.match(
    texts(app, '#chat-messages .bubble').join(' '),
    /直接询问整份简历/,
    '全局 AI 的原有入口承诺必须保留',
  );
  assert.match(
    texts(app, '#chat-messages .bubble').join(' '),
    /就地改写.*调整结构或联动其他内容/,
    '新增入口必须向新手说明局部与全局的分工',
  );
  assert.deepStrictEqual(
    texts(app, '.assistant-quick button'),
    texts(proto, '.assistant-quick button'),
  );
  assert.deepStrictEqual(
    texts(app, '#selection-label'),
    texts(proto, '#selection-label'),
  );
});

test('所有 AI 星光图标使用固定容器内的静态自包含 SVG', () => {
  const icons = Array.from(app.querySelectorAll('.ai-spark-icon'));
  assert.ok(icons.length >= 8, '主要 AI 入口都应使用统一星光图标');
  icons.forEach((icon) => {
    const svg = icon.querySelector(':scope > svg[viewBox="0 0 24 24"]');
    assert.ok(svg, `图标缺少固定 viewBox：${icon.className}`);
    assert.ok(svg.querySelector('.spark-main'));
    assert.ok(svg.querySelector('.spark-mini'));
    assert.strictEqual(svg.querySelector('use'), null, '不得再通过共享 symbol 渲染图形');
  });
  assert.strictEqual(app.querySelector('#ai-spark-symbol'), null);
  assert.strictEqual(app.querySelector('.assistant-messages .ai-spark-icon'), null);
  assert.ok(app.querySelector('.selection-ai-icon > svg[viewBox="0 0 24 24"]'));
  assert.doesNotMatch(APP_HTML, /aiSparkBreathe|aiSparkTwinkle|selectionStarPulse|selectionStarTwinkle/);
  assert.match(
    APP_HTML,
    /\.ai-spark-icon svg \*,\.selection-ai-icon svg \*\{animation:none!important;transform:none!important\}/,
    '所有 AI 星光图标都必须保持静态',
  );
  assert.match(APP_HTML, /\.doc-toolbar button\{border:0!important\}/);
});

test('样式保留原型布局且不含旧内容关系选择器', () => {
  const appCss = APP_HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const selector of [
    '.pending-panel',
    '.pending-item',
    '.pending-copy',
    '.pending-actions',
    '.panel-count',
    '.usage-pill',
    '.fact-meta',
    '.fact-warning',
  ]) {
    assert.ok(!appCss.includes(selector), `不得保留旧内容关系样式 ${selector}`);
  }
  for (const selector of ['.app{', '.context{', '.canvas{', '.assistant-panel{', '.resume{']) {
    assert.ok(appCss.includes(selector), `必须保留原型核心布局样式 ${selector}`);
  }
});

test('右侧 AI 区域可收缩为窄侧栏并记住选择', () => {
  const panel = app.querySelector('#assistant-panel');
  const button = app.querySelector('#assistant-collapse');
  const shell = app.querySelector('.app');
  assert.ok(button);
  button.click();
  assert.strictEqual(panel.classList.contains('collapsed'), true);
  assert.strictEqual(shell.classList.contains('assistant-collapsed'), true);
  assert.strictEqual(button.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(app.defaultView.localStorage.getItem('resumeAssistantCollapsed'), '1');
  button.click();
  assert.strictEqual(panel.classList.contains('collapsed'), false);
  assert.strictEqual(shell.classList.contains('assistant-collapsed'), false);
  assert.strictEqual(button.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(app.defaultView.localStorage.getItem('resumeAssistantCollapsed'), '0');
});
