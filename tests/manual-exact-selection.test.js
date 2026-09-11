'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../resume-dom');
const { fixture } = require('./fixtures/manual-structures');
const { compileManualNodeAction } = require('../server/lib/manual-node-actions');
function count(n) { return 1 + (n.children || []).reduce((sum, c) => sum + count(c), 0); }
test('选中哪个子树就完整复制哪个子树，不从段落或标题自动升级父层级', () => {
  for (const id of ['overview-title', 'overview-p', 'overview', 'entry-name', 'entry-1', 'item-1', 'deep-text', 'grid-row-2']) {
    const before = fixture(), selected = R.findNode(before, id);
    const cap = R.manualSelectionCapabilities(before, id);
    assert.equal(cap.target_id, id);
    const compiled = compileManualNodeAction(before, 'duplicate_node', id);
    const inserted = compiled.operations.filter(op => op.op === 'insert_node');
    assert.equal(inserted.length, 1);
    assert.equal(count(inserted[0].node), count(selected.node));
    const after = R.applyDocumentOperations(before, compiled.operations, { allowStructure: true });
    const copy = R.findNode(after, inserted[0].node.id);
    assert.equal(copy.parent.id, selected.parent.id);
    assert.equal(copy.index, selected.index + 1);
    assert.equal(R.nodeText(copy.node), R.nodeText(selected.node));
  }
});
test('删除标题或末项不会额外删除父容器，合并表格行明确框住闭合行组', () => {
  for (const id of ['overview-title', 'item-2', 'deep-text']) {
    const before = fixture(), parent = R.findNode(before, id).parent.id;
    const after = R.applyDocumentOperations(before, compileManualNodeAction(before, 'delete_node', id).operations, { allowStructure: true });
    assert.equal(R.findNode(after, id), null);
    assert.ok(R.findNode(after, parent));
  }
  assert.deepEqual(R.manualSelectionCapabilities(fixture(), 'merged-row-2').target_ids, ['merged-row-1', 'merged-row-2']);
  assert.equal(R.manualSelectionCapabilities(fixture(), 'grid-row-1-cell-0'), null);
  assert.equal(R.manualSelectionCapabilities(fixture(), 'manual-root'), null);
});
