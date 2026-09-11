'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../resume-dom');
const { materializeTargetFragments } = require('../server/lib/resume-harness/target-fragments');
const base = () => R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION, root: {
  id: 'resume', type: 'element', tag: 'article', children: [
    { id: 'header', type: 'element', tag: 'header', style: { padding: '12px' }, children: [
      { id: 'name', type: 'element', tag: 'h1', text: '虚构求职者', editable: true, children: [] },
      { id: 'contact', type: 'element', tag: 'p', text: '虚构联系方式', editable: true, children: [] },
    ] },
  ],
} });
const insertion = () => ({ parent_id: 'header', after_id: 'name',
  new_subtrees: [{ id: 'photo', type: 'element', tag: 'img', style: { width: '90px' }, children: [] }] });
const patch = (target_id, replacement_subtree) => ({ target_id, replacement_subtree });
const fragments = (changes, insertions = [insertion()]) => ({
  format: 'resume-target-fragments-v2', changes, insertions,
});

test('container presentation and child image insertion are merged without a second model call or dropped child', () => {
  const result = materializeTargetFragments(base(), fragments([
    patch('header', { id: 'header', style: { display: 'flex', gap: '16px' } }),
  ]));
  const header = R.findNode(result.document, 'header').node;
  assert.equal(header.style.padding, '12px');
  assert.equal(header.style.display, 'flex');
  assert.deepEqual(header.children.map(node => node.id), ['name', 'photo', 'contact']);
  assert.equal(R.plainText(result.document), R.plainText(base()));
});

test('ancestor presentation, descendant text and insertion remain independent and retain every requested change', () => {
  const changes = [
    patch('resume', { id: 'resume', style: { color: '#123456' } }),
    patch('header', { id: 'header', attributes: { class: 'with-photo' }, style: { display: 'grid' } }),
    patch('contact', { id: 'contact', text: '新的虚构联系方式' }),
  ];
  const forward = materializeTargetFragments(base(), fragments(changes)).document;
  const reverse = materializeTargetFragments(base(), fragments(changes.slice().reverse())).document;
  assert.deepEqual(forward, reverse);
  assert.equal(forward.root.style.color, '#123456');
  assert.equal(R.findNode(forward, 'header').node.style.display, 'grid');
  assert.equal(R.findNode(forward, 'contact').node.text, '新的虚构联系方式');
  assert.ok(R.findNode(forward, 'photo'));
});

test('real subtree replacement/text rewrite/deletion and insertion conflicts are still rejected', () => {
  for (const replacement of [
    { id: 'header', children: [] }, { id: 'header', text: '整体替换' }, null,
  ]) {
    assert.throws(() => materializeTargetFragments(base(), fragments([patch('header', replacement)])),
      /新增位置不能|目标|父节点/);
  }
  assert.throws(() => materializeTargetFragments(base(), fragments([
    patch('header', { id: 'header', style: { display: 'flex' } }), patch('name', null),
  ])), /锚点同时被删除/);
});
