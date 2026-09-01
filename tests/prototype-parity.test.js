'use strict';
/**
 * 原型结构一致性测试。
 * v1.3 已按最新 PRD 移除“来源/待确认事实/资料到正文使用关系”，
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
  assert.strictEqual(
    appResume.getAttribute('class'),
    protoResume.getAttribute('class'),
    '简历根元素的模板 class 必须一致',
  );
  assert.strictEqual(
    signature(appResume),
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

test('模板选择与历史版本入口一致', () => {
  assert.deepStrictEqual(
    texts(app, '#template-button'),
    texts(proto, '#template-button'),
  );
  assert.deepStrictEqual(
    texts(app, '.history-open'),
    texts(proto, '.history-open'),
  );
});

test('历史版本列表：分组、标题与摘要一致', () => {
  assert.deepStrictEqual(
    texts(app, '#history-list .history-day'),
    texts(proto, '#history-list .history-day'),
    '日期分组必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#history-list .version-row-copy'),
    texts(proto, '#history-list .version-row-copy'),
    '版本行内容必须一致',
  );
  assert.deepStrictEqual(
    texts(app, '#history-list .current-version'),
    texts(proto, '#history-list .current-version'),
  );
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

test('AI 助手面板：初始气泡与快捷指令一致', () => {
  assert.deepStrictEqual(
    texts(app, '#chat-messages .bubble'),
    texts(proto, '#chat-messages .bubble'),
    '初始欢迎气泡必须一致',
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
