'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const code = html.slice(html.indexOf('function proposalDiffParts('), html.indexOf('function renderProposal(a,'));
const dom = new JSDOM('<div id="diff"></div>');
const context = { document: dom.window.document };
vm.createContext(context); vm.runInContext(code, context);
for (const [before, after] of [
  ['负责尽职调查、风险评估。', '负责尽调、风险评估。'],
  ['', '新增一段'], ['删除整段', ''], ['首行\n\n旧内容\n尾行', '首行\n\n新内容\n尾行'],
  ['前文😀后文', '前文🧑‍💻后文'], ['a'.repeat(1500), 'b'.repeat(1500)],
]) {
  test(`差异完整保留原文与建议：${before.slice(0, 16)}`, () => {
    const parts = context.proposalDiffParts(before, after);
    assert.equal(parts.filter(p => p.kind !== 'add').map(p => p.text).join('\n'), before);
    assert.equal(parts.filter(p => p.kind !== 'remove').map(p => p.text).join('\n'), after);
  });
}
test('差异只折叠未改动行，恶意文字不能成为HTML，样式修改不重复全文', () => {
  const host = dom.window.document.getElementById('diff');
  const unchanged = Array.from({ length: 20 }, (_, i) => '原文' + i).join('\n');
  context.renderProposalDiff(host, unchanged + '\n旧', unchanged + '\n<img onerror="alert(1)">');
  assert.equal(host.querySelector('details').open, false);
  assert.match(host.querySelector('details').textContent, /原文19/);
  assert.match(host.querySelector('ins').textContent, /<img/);
  assert.equal(host.querySelector('img'), null);
  context.renderProposalDiff(host, unchanged, unchanged);
  assert.match(host.textContent, /文字未变化/);
  assert.doesNotMatch(host.textContent, /原文/);
});
test('改动一个字也显示完整删除行与新增行，不做逐字混排', () => {
  const host = dom.window.document.getElementById('diff');
  context.renderProposalDiff(host, '负责尽职调查、风险评估。', '负责尽调、风险评估。');
  assert.equal(host.querySelectorAll('.proposal-diff-row').length, 2);
  assert.equal(host.querySelector('del').textContent, '负责尽职调查、风险评估。');
  assert.equal(host.querySelector('ins').textContent, '负责尽调、风险评估。');
});
test('纯排版建议展示属性前后整行差异；混合修改保留正文差异且不注入 HTML', () => {
  const host = dom.window.document.getElementById('diff');
  const changes = [{ label: '标题<img onerror=alert(1)>', property: 'font-size', before: '20px', after: '16px' },
    { label: '页面', property: 'padding', before: '40px', after: null }];
  context.renderProposalDiff(host, '相同文字', '相同文字', changes);
  assert.equal(host.querySelectorAll('del').length, 2);
  assert.equal(host.querySelectorAll('ins').length, 2);
  assert.match(host.querySelector('del').textContent, /字号：20px/);
  assert.match(host.textContent, /继承默认/);
  assert.equal(host.querySelector('img'), null);
  context.renderProposalDiff(host, '旧正文', '新正文', changes);
  assert.equal(host.querySelectorAll('ins').length, 3);
  assert.equal(host.querySelector('ins').textContent, '新正文');
});
