'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../resume-dom');
const { compileManualNodeAction } = require('../server/lib/manual-node-actions');
const { fixture, element, paragraph } = require('./fixtures/manual-structures');

function act(doc, action, id) {
  const compiled = compileManualNodeAction(doc, action, id);
  return { ...compiled, document: R.applyDocumentOperations(doc, compiled.operations, { allowStructure: true }) };
}
function shape(node) {
  const copy = structuredClone(node);
  (function visit(n) {
    delete n.id;
    if (n.semantic) delete n.semantic.group_id;
    (n.children || []).forEach(visit);
  })(copy);
  return copy;
}
function rawNode(document, id) {
  function visit(node) {
    return node.id === id ? node : (node.children || []).map(visit).find(Boolean);
  }
  return visit(document.root);
}
test('表格编辑锚点默认复制整行，仅明确选择内部段落才在原单元格内新增', () => {
  const before = fixture();
  const originalRow = R.findNode(before, 'grid-row-2').node;
  const result = act(before, 'add_sibling', 'grid-row-2-p-2');
  const focus = R.findNode(result.document, result.focusNodeId);
  const duplicateRow = R.findNode(result.document, result.changedNodeIds[0]);
  assert.equal(duplicateRow.parent.id, 'grid-body');
  assert.deepEqual(shape(duplicateRow.node), shape(originalRow));
  assert.equal(focus.ancestors.at(-2).id, duplicateRow.node.id);
  assert.deepEqual(R.findNode(result.document, 'grid-row-2').node, originalRow);
  const inside = act(before, 'add_content_sibling', 'grid-row-2-p-2');
  assert.equal(R.findNode(inside.document, inside.focusNodeId).parent.id, 'grid-row-2-cell-2');
  assert.equal(R.findNode(inside.document, 'grid-body').node.children.length, 2);
  const removed = act(result.document, 'remove', result.focusNodeId);
  assert.deepEqual(removed.document, before);
  const contentRemoved = act(before, 'remove_content', 'grid-row-2-p-2');
  assert.ok(R.findNode(contentRemoved.document, 'grid-row-2'));
  assert.equal(R.findNode(contentRemoved.document, 'grid-row-2-p-2'), null);
});
test('多层列表复制整项、经历标题复制整个经历，不固定层数或吞并其他项', () => {
  for (const [anchor, unit, parent] of [
    ['item-text', 'item-1', 'list-1'],
    ['nested-text', 'nested-item', 'nested-list'],
    ['entry-name', 'entry-1', 'experience'],
    ['deep-text', 'nested-item', 'nested-list'],
  ]) {
    const before = fixture();
    const result = act(before, 'add_sibling', anchor);
    const added = R.findNode(result.document, result.changedNodeIds[0]);
    assert.equal(added.parent.id, parent);
    assert.deepEqual(shape(added.node), shape(R.findNode(before, unit).node));
    const ids = new Set();
    (function visit(node) {
      assert.ok(!ids.has(node.id), `重复ID：${node.id}`); ids.add(node.id);
      (node.children || []).forEach(visit);
    })(result.document.root);
  }
});
test('合并单元格按闭合行组复制与删除，不切断跨行关系', () => {
  for (const anchor of ['merged-label', 'merged-text-2']) {
    const before = fixture();
    const result = act(before, 'add_sibling', anchor);
    assert.equal(result.changedNodeIds.length, 2);
    assert.equal(R.findNode(result.document, 'merged-body').node.children.length, 5);
    const first = R.findNode(result.document, result.changedNodeIds[0]).node;
    assert.equal(first.children[0].attributes.rowspan, '2');
    assert.deepEqual(shape(first), shape(R.findNode(before, 'merged-row-1').node));
    assert.deepEqual(act(result.document, 'remove', result.focusNodeId).document, before);
  }
});
test('rowspan=0与越界跨度在复制前冻结实际跨度，防止原合并单元格延伸进副本', () => {
  for (const span of ['0', '99']) {
    const before = fixture();
    rawNode(before, 'merged-cell').attributes.rowspan = span;
    const result = act(before, 'add_sibling', 'merged-text-2');
    assert.equal(result.changedNodeIds.length, 3);
    assert.equal(R.findNode(result.document, 'merged-cell').node.attributes.rowspan, '3');
    const added = R.findNode(result.document, result.changedNodeIds[0]).node;
    assert.equal(added.children[0].attributes.rowspan, '3');
  }
});
test('最后一个表格行组删除整个空表格，其他模块与节点不变', () => {
  const before = fixture();
  rawNode(before, 'merged-body').children.pop();
  const capability = R.manualStructureCapabilities(before, 'merged-text-2');
  assert.equal(capability.remove.label, '删除整个表格');
  const result = act(before, 'remove', 'merged-text-2');
  assert.equal(R.findNode(result.document, 'merged-table'), null);
  assert.ok(R.findNode(result.document, 'merged-title'));
  assert.deepEqual(R.findNode(result.document, 'overview').node, R.findNode(before, 'overview').node);
});

test('标题有嵌套包装时增加内容仅复制完整内容分支，不再复制标题包装', () => {
  const before = fixture();
  const section = rawNode(before, 'overview');
  const [title, content, table] = section.children;
  section.children = [element('heading-content-wrapper', 'div', 'group', [
    element('heading-only-wrapper', 'div', 'group', [title]),
    element('content-wrapper', 'div', 'group', [content, table]),
  ])];
  const result = act(before, 'add_section_content', 'overview-title');
  const copy = R.findNode(result.document, result.changedNodeIds[0]);
  assert.equal(copy.parent.id, 'heading-content-wrapper');
  assert.deepEqual(shape(copy.node), shape(R.findNode(before, 'content-wrapper').node));
  const onlyHeading = fixture();
  rawNode(onlyHeading, 'overview').children = [
    element('heading-only-wrapper', 'div', 'group', [title]),
  ];
  const added = act(onlyHeading, 'add_section_content', 'overview-title');
  assert.equal(R.findNode(added.document, added.focusNodeId).parent.id, 'overview');
  assert.equal(R.semanticKind(R.findNode(added.document, added.focusNodeId).node), 'paragraph');
});

test('固定坐标文本和显式绝对定位不能复制到原坐标重叠，但可安全删除无底图文字', () => {
  for (const style of [{ position: 'absolute', top: '10px' }, {}]) {
    const doc = fixture();
    const target = rawNode(doc, 'overview-p');
    target.style = style;
    if (!style.position) doc.root.attributes.class = 'imported-positioned-resume';
    const capability = R.manualStructureCapabilities(doc, target.id);
    assert.equal(capability.fixed_layout, true);
    assert.equal(capability.add[0].enabled, false);
    assert.throws(() => act(doc, 'add_sibling', target.id), { code: 'FIXED_LAYOUT_ACTION_UNAVAILABLE' });
    assert.equal(R.findNode(act(doc, 'remove', target.id).document, target.id), null);
  }
});
