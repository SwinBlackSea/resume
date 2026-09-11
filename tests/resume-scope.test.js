'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { resolveResumeScope } = require('../server/lib/resume-scope');

function node(id, tag, text, children = [], editable = true) {
  return {
    id,
    type: 'element',
    tag,
    text,
    children,
    ...(editable ? { editable: true } : {}),
  };
}

const resume = {
  schema_version: 'resume-document-v3',
  root: node('resume-root', 'article', '', [
    node('summary-title', 'h2', '专业能力'),
    node('summary-one', 'p', '办公与分析'),
    node('summary-subtitle', 'h3', '语言能力'),
    node('summary-two', 'p', '英语六级'),
    node('next-title', 'h2', '教育经历'),
    node('education-one', 'p', '某大学'),
  ], false),
};

test('标题焦点覆盖当前语义区域，并在下一个同级标题前结束', () => {
  const region = resolveResumeScope(resume, 'summary-title');
  assert.strictEqual(region.kind, 'heading_region');
  assert.deepStrictEqual(region.root_node_ids, [
    'summary-title',
    'summary-one',
    'summary-subtitle',
    'summary-two',
  ]);
  assert.strictEqual(region.boundary_node_id, 'next-title');
  assert.ok(region.node_ids.includes('summary-two'));
  assert.ok(!region.node_ids.includes('education-one'));
});

test('普通节点焦点只描述自身，不限制模型显式操作其他节点', () => {
  const region = resolveResumeScope(resume, 'summary-one');
  assert.strictEqual(region.kind, 'node');
  assert.deepStrictEqual(region.root_node_ids, ['summary-one']);
  assert.deepStrictEqual(region.node_ids, ['summary-one']);
});

test('单一编辑节点内部格式段落只规范到唯一的父编辑节点', () => {
  const groupedResume = {
    schema_version: 'resume-document-v3',
    root: node('resume-root', 'article', '', [
      {
        id: 'summary-group',
        type: 'element',
        tag: 'div',
        editable: true,
        label: '职业概况模块',
        children: [
          node('summary-group-one', 'p', '第一段保留格式', [], false),
          node('summary-group-two', 'p', '第二段保留格式', [], false),
        ],
      },
    ], false),
  };

  const childRegion = resolveResumeScope(groupedResume, 'summary-group-one');
  assert.strictEqual(childRegion.scope_id, 'summary-group');
  assert.strictEqual(childRegion.requested_scope_id, 'summary-group-one');
  assert.strictEqual(childRegion.canonicalized, true);
  assert.strictEqual(childRegion.kind, 'subtree');
  assert.deepStrictEqual(childRegion.root_node_ids, ['summary-group']);
  assert.deepStrictEqual(
    childRegion.node_ids.sort(),
    ['summary-group', 'summary-group-one', 'summary-group-two'].sort(),
  );
  assert.match(childRegion.text, /第一段保留格式/);
  assert.match(childRegion.text, /第二段保留格式/);

  const groupRegion = resolveResumeScope(groupedResume, 'summary-group');
  assert.strictEqual(groupRegion.scope_id, 'summary-group');
  assert.strictEqual(groupRegion.canonicalized, false);
});
