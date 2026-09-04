'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ResumeDom = require('../resume-dom');
const {
  buildChangePreview,
  previewProposalOnResume,
} = require('../server/lib/resume-change-preview');

function documentWithItems() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      attributes: {},
      children: [{
        id: 'experience',
        type: 'element',
        tag: 'section',
        attributes: {},
        children: [
          {
            id: 'experience-title',
            type: 'element',
            tag: 'h2',
            text: '工作经历',
            editable: true,
          },
          {
            id: 'item-1',
            type: 'element',
            tag: 'p',
            text: '负责客户需求分析。',
            editable: true,
          },
          {
            id: 'item-2',
            type: 'element',
            tag: 'p',
            text: '推动跨部门项目落地。',
            editable: true,
          },
        ],
      }],
    },
  });
}

test('结构建议预览从真实文档差异提取内容，不暴露底层操作名称', () => {
  const before = documentWithItems();
  const proposal = {
    operations: [
      {
        op: 'insert_node',
        parent_id: 'experience',
        after_node_id: 'experience-title',
        node: {
          id: 'merged-item',
          type: 'element',
          tag: 'p',
          text: '负责客户需求分析，并推动跨部门项目落地。',
          editable: true,
        },
      },
      { op: 'remove_node', node_id: 'item-1' },
      { op: 'remove_node', node_id: 'item-2' },
    ],
  };
  const preview = previewProposalOnResume(proposal, before, 7);

  assert.strictEqual(preview.summary, '将2项内容合并为1项，同时调整文字');
  assert.strictEqual(
    preview.before.text,
    '负责客户需求分析。\n推动跨部门项目落地。',
  );
  assert.strictEqual(
    preview.after.text,
    '负责客户需求分析，并推动跨部门项目落地。',
  );
  assert.doesNotMatch(JSON.stringify(preview), /新增模块或内容|删除内容、删除内容/);
  assert.strictEqual(preview.based_on_revision, 7);
});

test('文字、位置和显示效果可以在同一个通用预览中并存', () => {
  const before = documentWithItems();
  const after = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'item-1', text: '深入分析客户需求。' },
    {
      op: 'move_node',
      node_id: 'item-2',
      parent_id: 'experience',
      after_node_id: 'experience-title',
    },
    { op: 'set_style', node_id: 'experience-title', style: { color: '#0066cc' } },
  ], { allowStructure: true });
  const preview = buildChangePreview(before, after);

  assert.match(preview.summary, /修改1处文字/);
  assert.match(preview.summary, /调整\d+项内容的位置/);
  assert.match(preview.summary, /调整1处显示效果/);
  assert.match(preview.before.text, /负责客户需求分析/);
  assert.match(preview.after.text, /深入分析客户需求/);
  assert.strictEqual(preview.changes.some((change) => change.type === 'text'), true);
  assert.strictEqual(preview.changes.some((change) => change.type === 'moved'), true);
  assert.strictEqual(preview.changes.some((change) => change.type === 'style'), true);
});

test('把多个子项包裹进同一区域时仍按原有子项数量描述', () => {
  const before = documentWithItems();
  const after = ResumeDom.applyDocumentOperations(before, [
    {
      op: 'insert_node',
      parent_id: 'experience',
      after_node_id: 'experience-title',
      node: {
        id: 'experience-group',
        type: 'element',
        tag: 'div',
        children: [],
      },
    },
    {
      op: 'move_node',
      node_id: 'item-1',
      parent_id: 'experience-group',
      index: 0,
    },
    {
      op: 'move_node',
      node_id: 'item-2',
      parent_id: 'experience-group',
      index: 1,
    },
  ], { allowStructure: true });
  const preview = buildChangePreview(before, after, {
    constraints: {
      content: 'preserve',
      content_order: 'preserve',
      structure: 'modify',
      style: 'preserve',
    },
  });

  assert.strictEqual(preview.summary, '将2项内容归入同一区域，文字保持不变');
  assert.strictEqual(preview.semantics.before_item_count, 2);
  assert.strictEqual(preview.semantics.after_item_count, 2);
  assert.strictEqual(preview.semantics.grouping, 'grouped');
  assert.strictEqual(
    preview.after.text,
    '负责客户需求分析。\n推动跨部门项目落地。',
  );
});

test('最新草稿已经符合建议时返回明确状态而不是空白预览', () => {
  const before = documentWithItems();
  const preview = previewProposalOnResume({
    scope_id: 'item-1',
    operations: [{
      op: 'replace_text',
      node_id: 'item-1',
      text: '负责客户需求分析。',
    }],
  }, before, 9);

  assert.strictEqual(preview.already_satisfied, true);
  assert.strictEqual(preview.summary, '当前内容已符合建议');
  assert.strictEqual(preview.before.text, '负责客户需求分析。');
  assert.strictEqual(preview.after.text, '负责客户需求分析。');
});

test('拆分整体编辑节点按编辑语义展示，不误报为显示效果变化', () => {
  const base = documentWithItems();
  const grouped = ResumeDom.applyDocumentOperations(base, [{
    op: 'merge_editable_nodes',
    parent_id: 'experience',
    node_ids: ['item-1', 'item-2'],
    node: {
      id: 'experience-ai-group',
      type: 'element',
      tag: 'div',
      label: '工作要点',
      children: [],
    },
  }], { allowStructure: true });
  const after = ResumeDom.applyDocumentOperations(grouped, [{
    op: 'split_editable_node',
    node_id: 'experience-ai-group',
  }], { allowStructure: true });
  const preview = buildChangePreview(grouped, after, {
    constraints: {
      content: 'preserve',
      content_order: 'preserve',
      structure: 'modify',
      style: 'preserve',
    },
  });

  assert.strictEqual(
    preview.summary,
    '将1个 AI 编辑节点拆分为2个，文字保持不变',
  );
  assert.strictEqual(preview.semantics.editing_nodes, 'modified');
  assert.doesNotMatch(preview.summary, /显示效果/);
  assert.strictEqual(preview.before.text, preview.after.text);
});
