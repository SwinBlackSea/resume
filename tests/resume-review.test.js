'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const Review = require('../resume-review');
const R = require('../resume-dom');
const { buildChangePreview } = require('../server/lib/resume-change-preview');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const code = html.slice(html.indexOf('function proposalDiffParts('), html.indexOf('function renderProposal(a,'));
const dom = new JSDOM('<div id="review"></div>');
const ctx = { document: dom.window.document };
vm.createContext(ctx); vm.runInContext(code, ctx);
const p = (id, text, extra = {}) => ({ id, type: 'element', tag: 'p', editable: true, text, children: [], ...extra });
function doc(children) {
  return R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION, root: { id: 'root', type: 'element', tag: 'article', children } });
}
function review(before, after) {
  const host = dom.window.document.getElementById('review');
  Review.render(host, before, after, buildChangePreview(before, after), ctx.proposalDiffParts);
  return host;
}
test('完整简历审阅：未改内容一次，原位置整行替换、增加、删除，文字不成为HTML', () => {
  const before = doc([p('title', '个人简历', { tag: 'h1' }), p('same', '一直保留的经历'),
    p('edit', '负责尽职调查和管理'), p('removed', '删除的原经历'), p('end', '教育经历')]);
  const after = doc([p('title', '个人简历', { tag: 'h1' }), p('same', '一直保留的经历'),
    p('edit', '负责尽调管理'), p('inserted', '<img onerror="alert(1)">新增经历'), p('end', '教育经历')]);
  const h = review(before, after);
  assert.equal(h.querySelectorAll('.resume-review-paper').length, 1);
  assert.equal(h.textContent.split('一直保留的经历').length - 1, 1);
  assert.equal(h.querySelector('del').textContent, '负责尽职调查和管理');
  assert.equal(h.querySelector('ins').textContent, '负责尽调管理');
  assert.match(h.querySelector('[data-review-node="removed"] del').textContent, /删除的原经历/);
  assert.ok(h.querySelector('[data-review-node="removed"]').compareDocumentPosition(h.querySelector('[data-review-node="end"]')) & 4);
  assert.equal(h.querySelector('img'), null);
  assert.equal(h.querySelector('details'), null);
});
test('位置调整不复制正文，父级新增容器不误把未变正文标绿', () => {
  const before = doc([p('a', '第一段'), p('b', '第二段')]);
  const after = doc([{ id: 'wrapper', type: 'element', tag: 'section', children: [p('b', '第二段')] }, p('a', '第一段')]);
  const h = review(before, after);
  const rows = [...h.querySelectorAll('.proposal-diff-row')];
  assert.deepEqual(rows.map(r => r.textContent), ['第二段', '第一段']);
  assert.ok(rows.every(r => r.dataset.diffKind === 'same'));
  assert.match(h.querySelector('summary').textContent, /内容位置/);
});
test('样式标注对应正文且默认折叠，非editable文字和表格内容完整', () => {
  const before = doc([
    p('heading', '技能', { tag: 'h2', editable: false, style: { 'font-size': '20px' } }),
    { id: 'table', type: 'element', tag: 'table', children: [
      { id: 'row', type: 'element', tag: 'tr', children: [
        p('cell1', '数据分析', { tag: 'td' }), p('cell2', '熟悉 SQL', { tag: 'td' }),
      ] },
    ] },
  ]);
  const after = structuredClone(before);
  after.root.children[0].style['font-size'] = '16px';
  after.root.children[1].children[0].children[1].text = '熟练使用 SQL';
  const h = review(before, after);
  const heading = h.querySelector('[data-review-node="heading"]');
  assert.equal(heading.querySelector('details').open, false);
  assert.match(heading.querySelector('summary').textContent, /字号 20px → 16px/);
  assert.equal(h.querySelectorAll('.resume-review-table-cell').length, 2);
  assert.match(h.querySelector('[data-review-node="cell2"] ins').textContent, /熟练使用 SQL/);
  assert.equal(h.textContent.includes('heading'), false);
});
test('完整删除父级子树不会漏掉后代，整份新ID重构仍列出所有增删内容', () => {
  const before = doc([{ id: 'section', type: 'element', tag: 'section', children: [
    p('title', '工作经历', { tag: 'h2' }), p('body', '甲公司的完整工作内容'),
  ] }]);
  const after = doc([p('new', '乙公司的新工作内容')]);
  after.root.id = 'new-root';
  const h = review(before, after);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row del')].map(n => n.textContent), ['工作经历', '甲公司的完整工作内容']);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row ins')].map(n => n.textContent), ['乙公司的新工作内容']);
  assert.deepEqual(before.root.children[0].children[1].text, '甲公司的完整工作内容');
});
test('移出旧分组的文字不重复标删；多段编辑内容按完整行对照', () => {
  const before = doc([{ id: 'wrapper', type: 'element', tag: 'section', children: [p('keep', '保留这段')] },
    p('multi', '', { children: [p('line1', '第一段', { editable: false }), p('line2', '原第二段', { editable: false })] })]);
  const after = doc([p('keep', '保留这段'),
    p('multi', '', { children: [p('line1', '第一段', { editable: false }), p('line2', '新第二段', { editable: false })] })]);
  const h = review(before, after);
  assert.equal(h.textContent.split('保留这段').length - 1, 1);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row del')].map(n => n.textContent), ['原第二段']);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row ins')].map(n => n.textContent), ['新第二段']);
  assert.equal(h.textContent.split('第一段').length - 1, 1);
});
test('编辑容器被删但后代移出时不制造假删除；新增编辑边界同理', () => {
  const before = doc([p('editing', '删除的独立正文', { children: [p('moved', '完整保留的文字', { editable: false })] })]);
  const after = doc([p('new-editing', '新增的独立正文', { children: [p('moved', '完整保留的文字', { editable: false })] })]);
  const h = review(before, after);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row del')].map(n => n.textContent), ['删除的独立正文']);
  assert.deepEqual([...h.querySelectorAll('.proposal-diff-row ins')].map(n => n.textContent), ['新增的独立正文']);
  assert.equal(h.textContent.split('完整保留的文字').length - 1, 1);
});
test('编辑节点内的图片仍展示，根ID重建不漏掉根自身文字', () => {
  const image = { id: 'photo', type: 'element', tag: 'img', attributes: {
    src: 'data:image/png;base64,iVBORw0KGgo=', alt: '头像',
  } };
  const before = doc([p('editing', '经历说明', { children: [image] })]);
  before.root.text = '根节点的原始姓名';
  const after = structuredClone(before);after.root.id = 'new-root';after.root.text = '根节点的新姓名';
  const h = review(before, after);
  assert.equal(h.querySelectorAll('img').length, 1);
  assert.match(h.querySelector('img').getAttribute('src'), /^data:image\/png/);
  assert.ok([...h.querySelectorAll('.proposal-diff-row del')].some(n => n.textContent === '根节点的原始姓名'));
  assert.ok([...h.querySelectorAll('.proposal-diff-row ins')].some(n => n.textContent === '根节点的新姓名'));
  assert.equal(h.textContent.split('经历说明').length - 1, 1);
});
test('原编辑容器仍存在而后代移到别处，也不把移动误报为删除', () => {
  const before = doc([p('editing', '容器保留内容', {
    children: [p('child', '要移出的内容', { editable: false })],
  })]);
  const after = doc([p('editing', '容器保留内容'), p('child', '要移出的内容', { editable: false })]);
  const h = review(before, after);
  assert.equal(h.querySelectorAll('.proposal-diff-row del,.proposal-diff-row ins').length, 0);
  assert.equal(h.textContent.split('要移出的内容').length - 1, 1);
});
test('保留编辑容器内的旧图片删除必须展示，图片移出不得误报删除', () => {
  const image = { id: 'photo', type: 'element', tag: 'img', attributes: {
    src: 'data:image/png;base64,iVBORw0KGgo=', alt: '头像',
  } };
  const before = doc([p('editing', '保留的正文', { children: [
    { id: 'inline', type: 'element', tag: 'span', children: [image] },
  ] })]);
  const removed = review(before, doc([p('editing', '保留的正文')]));
  assert.equal(removed.querySelectorAll('del.resume-review-resource').length, 1);
  assert.equal(removed.querySelector('del.resume-review-resource').textContent, '删除图片');
  assert.equal(removed.querySelectorAll('img').length, 1);
  assert.equal(removed.textContent.split('保留的正文').length - 1, 1);
  const moved = review(before, doc([p('editing', '保留的正文'), image]));
  assert.equal(moved.querySelectorAll('del.resume-review-resource').length, 0);
  assert.equal(moved.querySelectorAll('ins.resume-review-resource').length, 0);
  assert.equal(moved.querySelectorAll('img').length, 1);
});
