'use strict';
/**
 * 真实工作区行为测试。原型不再是测试依赖；保留正文、编辑、
 * 缩放、历史比较、资料隔离、响应式和聊天收缩的行为断言。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');

const ROOT = path.join(__dirname, '..');
const APP_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ResumeDom = require('../resume-dom');

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
let app;

test.before(async () => {
  ctx = await helpers.boot();
  origin = ctx.base.replace('/api/v1', '');
  app = await loadApp(origin, await helpers.defaultProject(ctx));
});

test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (app) app.defaultView.close();
  helpers.close(ctx);
});

function loadApp(base, projectId) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(APP_HTML, {
      runScripts: 'dangerously',
      resources: 'usable',
      url: base + '/?project=' + projectId,
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

test('顶栏提供已有简历、独立制作、保存、历史和下载入口', () => {
  assert.equal(app.querySelector('.brand').textContent, 'resume');
  assert.equal(app.querySelector('#resume-list-button'), null);
  for (const id of ['account-button', 'another-resume', 'save-version-button', 'preview-current']) {
    assert.ok(app.querySelector('#' + id));
  }
  assert.match(app.querySelector('.history-open').textContent, new RegExp(String(app.defaultView.WS.versions.length)));
});

test('首页、编辑页和标签页统一使用纯文字 resume 标识', () => {
  assert.equal(app.title, 'resume');
  assert.equal(app.querySelector('.home-brand').textContent, 'resume');
  assert.equal(app.querySelector('.brand').tagName, 'BUTTON');
  assert.equal(app.querySelector('.brand').getAttribute('aria-label'), 'resume，返回首页');
  assert.equal(app.querySelector('.brand-mark'), null);
  for (const selector of ['.brand', '.home-brand']) {
    assert.equal(app.querySelector(selector).children.length, 0);
    // JSDOM may represent the initial background-image value as an empty
    // string; the Chromium regression also checks the actual computed value.
    assert.ok(['', 'none'].includes(app.defaultView.getComputedStyle(app.querySelector(selector)).backgroundImage));
  }
});

test('资料不再占据固定左栏，聊天区不重复展示岗位和补充材料工具条', () => {
  assert.equal(app.defaultView.getComputedStyle(app.querySelector('.context')).display, 'none');
  assert.equal(app.querySelector('#current-target-job'), null);
  assert.equal(app.querySelector('#assistant-panel .material-tools'), null);
  assert.ok(app.querySelector('#composer .attach'));
  assert.ok(app.defaultView.WS.job.title, '隐藏固定提示不删除已确认岗位');
});

test('中央画布保留实际文档的正文、节点身份和根样式', () => {
  const appResume = app.querySelector('#resume-document');
  assert.ok(appResume, '前端必须渲染简历正文');
  const documentClasses = app.defaultView.WS.draft.resume_json.root.attributes.class || '';
  assert.ok(appResume.classList.contains('resume'));
  for (const name of documentClasses.split(/\s+/).filter(Boolean)) assert.ok(appResume.classList.contains(name));
  const doc = app.defaultView.WS.draft.resume_json;
  const expected = new JSDOM('<article></article>');
  new ResumeDom.Renderer(expected.window.document.querySelector('article')).render(doc);
  assert.equal(appResume.textContent, expected.window.document.querySelector('article').textContent);
  assert.deepEqual(Array.from(appResume.querySelectorAll('[data-node-id]'), (node) => node.dataset.nodeId),
    Array.from(expected.window.document.querySelectorAll('[data-node-id]'), (node) => node.dataset.nodeId));
  expected.window.close();
});

test('每个文字编辑入口对应真实 editable 节点，不能嵌套', () => {
  const nodes = app.querySelectorAll('#resume-document [data-resume-editable=true]');
  assert.ok(nodes.length > 0);
  for (const node of nodes) {
    assert.equal(ResumeDom.findNode(app.defaultView.WS.draft.resume_json, node.dataset.nodeId).node.editable, true);
    assert.equal(node.querySelector('[data-resume-editable=true]'), null);
  }
});

test('个人信息浮层不再展示来源或待确认事实关系', () => {
  assert.strictEqual(app.querySelector('#profile-pending-panel'), null);
  assert.doesNotMatch(app.querySelector('#profile-modal').textContent, /识别自|当前简历使用/);
});

test('存量个人信息按需界面仍显示真实经历', () => {
  const text = app.querySelector('#profile-modal').textContent;
  for (const experience of app.defaultView.WS.profile.experiences.filter((item) => item.type === 'work')) {
    assert.ok(text.includes(experience.organization));
  }
  assert.ok(app.querySelectorAll('#profile-modal .record-title b').length >= 3);
});

test('存量岗位浮层读取当前岗位的关键词与要求', () => {
  const analysis = app.defaultView.WS.job.analysis;
  assert.deepEqual(texts(app, '#job-modal .keyword-chips span'), Array.from(analysis.keywords));
  assert.ok(app.querySelector('#job-modal .coverage-summary'));
  for (const item of analysis.responsibilities) assert.ok(app.querySelector('#job-modal').textContent.includes(item.text));
});

test('简历画布无需编辑模式切换，历史版本入口保持一致', () => {
  assert.strictEqual(app.querySelector('#edit-document-button'), null);
  assert.strictEqual(app.querySelector('#manual-edit-toolbar'), null);
  assert.strictEqual(app.querySelector('#inline-edit-hint'), null);
  assert.ok(app.querySelector('#inline-edit-status.visually-hidden'));
  assert.equal(app.querySelector('#account-menu .history-open').textContent, '历史版本 · ' + app.defaultView.WS.versions.length);
});

test('个人中心承载历史和设置，工具栏保存图标位于撤销旁边', () => {
  const mobileEntry = app.querySelector('#account-menu .history-open');
  assert.ok(mobileEntry);
  assert.equal(app.querySelectorAll('.history-open').length, 1);
  assert.match(mobileEntry.textContent, /^历史版本 · \d+$/);
  app.querySelector('#account-button').click();
  assert.equal(app.querySelector('#account-menu').hidden, false);
  assert.ok(app.querySelector('#account-menu #settings-button'));
  mobileEntry.click();
  assert.ok(app.querySelector('#history-modal').classList.contains('show'));
  assert.ok(app.querySelector('#history-list').classList.contains('active'));
  assert.ok(app.querySelector('#doc-toolbar #save-version-button svg'));
  assert.equal(app.querySelector('#save-version-button').nextElementSibling.id, 'undo-step');
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
  assert.ok(toolbar.querySelector('#preview-current'), '预览下载统一放在文档工具栏');
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

test('历史版本列表显示真实版本与状态', () => {
  assert.ok(texts(app, '#history-list .history-day').length >= 1);
  assert.deepStrictEqual(texts(app, '#history-list .version-row-copy b'),
    Array.from(app.defaultView.WS.versions, (version) => version.name));
  assert.equal(texts(app, '#history-list .version-row-copy em').length, app.defaultView.WS.versions.length);
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

test('不弹出建档引导，首页三类材料独立上传且未就绪不能生成', () => {
  assert.equal(app.querySelector('#guide-modal').classList.contains('show'), false);
  assert.equal(app.querySelectorAll('[data-home-role]').length, 3);
  for (const role of ['personal', 'job', 'layout']) {
    const input = app.querySelector(`[data-home-file="${role}"]`);
    assert.ok(input.accept.includes('.docx') && input.accept.includes('.pdf'));
  }
  assert.equal(app.querySelector('#home-submit').disabled, true);
  assert.ok(app.querySelector('#home-job-link'));
  assert.ok(app.querySelector('#home-layout-toggle'));
  assert.equal(app.querySelector('#resume-list'), null);
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
    ['更简洁', '突出工作成果', '更符合岗位', '检查是否夸张'],
  );
  assert.deepStrictEqual(
    texts(app, '#selection-label'),
    ['@整份简历'],
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

test('尚未保存正文时关闭或刷新页面必须提醒，已保存不拦截', () => {
  const element = app.querySelector('#resume-document [data-resume-editable=true]');
  const original = element.innerHTML, saved = element.dataset.savedText;
  try {
    element.dataset.savedText = app.defaultView.directElementText(element);
    const clean = new app.defaultView.Event('beforeunload', { cancelable: true });
    app.defaultView.dispatchEvent(clean);
    assert.equal(clean.defaultPrevented, false);
    element.appendChild(app.createTextNode('尚未保存的新输入'));
    const dirty = new app.defaultView.Event('beforeunload', { cancelable: true });
    app.defaultView.dispatchEvent(dirty);
    assert.equal(dirty.defaultPrevented, true);
  } finally {
    element.innerHTML = original; element.dataset.savedText = saved;
  }
});

test('真实页面保留核心文档组件样式且不含旧内容关系选择器', () => {
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
    assert.ok(appCss.includes(selector), `必须保留真实文档组件样式 ${selector}`);
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
