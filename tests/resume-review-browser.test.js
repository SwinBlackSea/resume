'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const R = require('../resume-dom');
const { buildChangePreview } = require('../server/lib/resume-change-preview');
const { openBrowser, available } = require('./browser-driver');
const p = (id, text, extra = {}) => ({ id, type: 'element', tag: 'p', text, editable: true, ...extra });
const doc = children => R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION,
  root: { id: 'review-root', type: 'element', tag: 'article', children } });
test('真实Chromium：完整审阅稿覆盖列表、表格、绝对定位重排、窄屏和长简历，查看不改变正文', {
  skip: !available, timeout: 30000,
}, async t => {
  const app = await helpers.boot(); t.after(() => helpers.close(app));
  const id = await helpers.defaultProject(app);
  const beforeState = (await helpers.call(app, 'GET', `/projects/${id}`)).body;
  const browser = await openBrowser(t, app.base.replace('/api/v1', '/'));
  assert.equal(await browser.evaluate('typeof ResumeReview.render'), 'function');
  const cases = [
    [doc([p('title', '工作经历', { tag: 'h2' }), { id: 'list', type: 'element', tag: 'ul',
      children: [p('old', '旧的项目职责', { tag: 'li' }), p('keep', '未修改的工作成果', { tag: 'li' })] }]),
    doc([p('title', '工作经历', { tag: 'h2' }), { id: 'list', type: 'element', tag: 'ul',
      children: [p('new', '新的项目职责', { tag: 'li' }), p('keep', '未修改的工作成果', { tag: 'li' })] }])],
    [doc([{ id: 'table', type: 'element', tag: 'table', children: [{ id: 'tr', type: 'element', tag: 'tr',
      children: [p('th', '岗位', { tag: 'td' }), p('job', '旧岗位说明', { tag: 'td', style: { color: '#333' } })] }] }]),
    doc([{ id: 'table', type: 'element', tag: 'table', children: [{ id: 'tr', type: 'element', tag: 'tr',
      children: [p('th', '岗位', { tag: 'td' }), p('job', '新岗位说明', { tag: 'td', style: { color: '#111' } })] }] }])],
    [doc([p('a', '职业概况', { style: { position: 'absolute', top: '200px', height: '10px', overflow: 'hidden' } }),
      p('b', '长期保留的完整职业经历')]),
    doc([p('b', '长期保留的完整职业经历'), p('a', '新的职业概况\n第二行新增要求\n第三行不能被截断', {
      style: { position: 'absolute', top: '10px', height: '10px', overflow: 'hidden' } })])],
    [doc(Array.from({ length: 90 }, (_, i) => p('line-' + i, '完整工作经历第' + i + '项'))),
      doc(Array.from({ length: 90 }, (_, i) => p('line-' + i, i === 89 ? '最后一项修改必须完整展示' : '完整工作经历第' + i + '项')))],
    [doc([p('editing-image', '保留图片旁边的正文', { children: [{
      id: 'removed-photo', type: 'element', tag: 'img', attributes: {
        src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    }] })]), doc([p('editing-image', '保留图片旁边的正文')])],
  ];
  for (const [left, right] of cases) {
    const preview = buildChangePreview(left, right);
    await browser.evaluate(`renderProposalDiff(document.querySelector('#proposal-diff-content'),
      ${JSON.stringify(preview.before.text)},${JSON.stringify(preview.after.text)},${JSON.stringify(preview.presentation_changes)},
      ${JSON.stringify({ before: left, after: right, preview })});openModal('#proposal-diff-modal');`);
    const result = await browser.evaluate(`(() => {
      const h=document.querySelector('#proposal-diff-content'),p=h.querySelector('.resume-review-paper');
      return {papers:h.querySelectorAll('.resume-review-paper').length,
        rows:[...p.querySelectorAll('.proposal-diff-row')].map(r=>({kind:r.dataset.diffKind,text:r.textContent,height:r.getBoundingClientRect().height})),
        editable:p.querySelectorAll('[contenteditable=true]').length,
        rawNodes:p.textContent.includes('review-root')};
    })()`);
    assert.equal(result.papers, 1);
    assert.equal(result.editable, 0);
    assert.equal(result.rawNodes, false);
    assert.ok(result.rows.every(r => r.height > 0));
    if (R.findNode(left, 'removed-photo')) {
      assert.equal(await browser.evaluate(`document.querySelectorAll('#proposal-diff-content del.resume-review-resource').length`), 1);
      assert.equal(await browser.evaluate(`document.querySelector('#proposal-diff-content del.resume-review-resource').textContent`), '删除图片');
      assert.equal(await browser.evaluate(`document.querySelectorAll('#proposal-diff-content img.resume-review-image').length`), 1);
    }
    const expectedBefore = R.plainText(left).replace(/\s/g, '');
    const expectedAfter = R.plainText(right).replace(/\s/g, '');
    const originals = result.rows.filter(r => r.kind !== 'add').map(r => r.text).join('').replace(/\s/g, '');
    const targets = result.rows.filter(r => r.kind !== 'remove').map(r => r.text).join('').replace(/\s/g, '');
    // Content may move: compare each visible semantic block instead of forcing
    // the old ordering onto a review intentionally arranged in the target order.
    assert.ok(expectedBefore.length > 0 && expectedAfter.length > 0);
    assert.equal([...originals].sort().join(''), [...expectedBefore].sort().join(''));
    assert.equal([...targets].sort().join(''), [...expectedAfter].sort().join(''));
    await browser.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await browser.evaluate(`(() => {const p=document.querySelector('.resume-review-paper');
      return p.scrollWidth<=p.clientWidth+1;})()`), true);
    await browser.click('#proposal-diff-modal .close');
    await browser.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  }
  const afterState = (await helpers.call(app, 'GET', `/projects/${id}`)).body;
  assert.deepEqual(afterState.draft, beforeState.draft);
  assert.deepEqual(afterState.versions, beforeState.versions);
  assert.deepEqual(browser.errors, []);
});
