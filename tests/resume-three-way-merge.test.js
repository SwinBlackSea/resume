'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ResumeDom = require('../resume-dom');
const {
  mergeResumeDocuments,
  canMergeResumeDocuments,
} = require('../server/lib/resume-three-way-merge');

function fixture() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root',
      type: 'element',
      tag: 'article',
      attributes: { class: 'resume' },
      children: [
        {
          id: 'contact',
          type: 'element',
          tag: 'p',
          text: 'old@example.com',
          editable: true,
          attributes: { class: 'contact', title: '联系方式' },
        },
        {
          id: 'summary-section',
          type: 'element',
          tag: 'section',
          children: [
            {
              id: 'summary-1',
              type: 'element',
              tag: 'p',
              text: '原职业概况',
              editable: true,
            },
            {
              id: 'summary-2',
              type: 'element',
              tag: 'p',
              text: '原管理经历',
              editable: true,
            },
          ],
        },
        {
          id: 'experience',
          type: 'element',
          tag: 'section',
          children: [{
            id: 'experience-1',
            type: 'element',
            tag: 'p',
            text: '原工作经历',
            editable: true,
          }],
        },
      ],
    },
  });
}

function text(document, nodeId) {
  return ResumeDom.nodeText(ResumeDom.findNode(document, nodeId).node);
}

test('当前草稿未变化时，三方合并结果严格等于模型目标文档', () => {
  const base = fixture();
  const target = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'summary-1', text: '突出团队管理的职业概况' },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-2',
      node: {
        id: 'summary-3',
        type: 'element',
        tag: 'p',
        text: '新增项目推进能力',
        editable: true,
      },
    },
  ], { allowStructure: true });

  const merged = mergeResumeDocuments({ base, target, current: base });
  assert.deepStrictEqual(merged.document, target);
  assert.strictEqual(merged.rebased, false);
});

test('AI 修改应用到最新草稿时保留未涉及的用户修改', () => {
  const base = fixture();
  const target = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'summary-1', text: 'AI 修改后的职业概况' },
  ]);
  const current = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'contact', text: 'new@example.com' },
  ]);

  const merged = mergeResumeDocuments({ base, target, current });
  assert.strictEqual(text(merged.document, 'summary-1'), 'AI 修改后的职业概况');
  assert.strictEqual(text(merged.document, 'contact'), 'new@example.com');
  assert.strictEqual(merged.rebased, true);
});

test('用户确认应用时，同一字段采用 AI 目标值并保留同节点其他手工属性', () => {
  const base = fixture();
  const target = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'contact', text: 'ai@example.com' },
    {
      op: 'set_attributes',
      node_id: 'contact',
      attributes: { title: 'AI 调整的联系方式' },
    },
  ], { allowStructure: true });
  const current = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'contact', text: 'user@example.com' },
    {
      op: 'set_attributes',
      node_id: 'contact',
      attributes: { 'data-user-format': 'compact' },
    },
  ], { allowStructure: true });

  const merged = mergeResumeDocuments({ base, target, current });
  const contact = ResumeDom.findNode(merged.document, 'contact').node;
  assert.strictEqual(ResumeDom.nodeText(contact), 'ai@example.com');
  assert.strictEqual(contact.attributes.title, 'AI 调整的联系方式');
  assert.strictEqual(contact.attributes['data-user-format'], 'compact');
  assert.ok(merged.overridden_paths.some((path) => path.endsWith('.text')));
});

test('目标文档新增和移动节点时，后端生成最终结构并保留并发新增内容', () => {
  const base = fixture();
  const target = ResumeDom.applyDocumentOperations(base, [
    {
      op: 'insert_node',
      parent_id: 'root',
      after_node_id: 'summary-section',
      node: {
        id: 'certificates',
        type: 'element',
        tag: 'section',
        children: [{
          id: 'certificate-1',
          type: 'element',
          tag: 'p',
          text: 'PMP',
          editable: true,
        }],
      },
    },
    {
      op: 'move_node',
      node_id: 'experience',
      parent_id: 'root',
      after_node_id: 'contact',
    },
  ], { allowStructure: true });
  const current = ResumeDom.applyDocumentOperations(base, [{
    op: 'insert_node',
    parent_id: 'root',
    after_node_id: 'experience',
    node: {
      id: 'user-note',
      type: 'element',
      tag: 'p',
      text: '用户同期新增内容',
      editable: true,
    },
  }], { allowStructure: true });

  const merged = mergeResumeDocuments({ base, target, current });
  const ids = merged.document.root.children.map((node) => node.id);
  assert.ok(ids.includes('certificates'));
  assert.ok(ids.includes('user-note'));
  assert.ok(ids.indexOf('experience') < ids.indexOf('summary-section'));
  assert.strictEqual(text(merged.document, 'user-note'), '用户同期新增内容');
});

test('模型可用目标结构表达包裹关系，不需要自己返回操作顺序', () => {
  const base = fixture();
  const target = JSON.parse(JSON.stringify(base));
  const section = target.root.children.find((node) => node.id === 'summary-section');
  section.children = [{
    id: 'summary-group',
    type: 'element',
    tag: 'div',
    attributes: { class: 'summary-group' },
    children: section.children,
  }];
  const normalizedTarget = ResumeDom.toResumeDocument(target);

  const merged = mergeResumeDocuments({
    base,
    target: normalizedTarget,
    current: base,
  });
  const group = ResumeDom.findNode(merged.document, 'summary-group');
  assert.ok(group);
  assert.deepStrictEqual(
    group.node.children.map((node) => node.id),
    ['summary-1', 'summary-2'],
  );
});

test('目标节点缺失或新增 ID 被占用时返回可重新生成的客观冲突', () => {
  const base = fixture();
  const target = ResumeDom.applyDocumentOperations(base, [
    { op: 'replace_text', node_id: 'summary-1', text: 'AI 修改' },
  ]);
  const missing = ResumeDom.applyDocumentOperations(base, [
    { op: 'remove_node', node_id: 'summary-1' },
  ], { allowStructure: true });
  const missingResult = canMergeResumeDocuments({ base, target, current: missing });
  assert.strictEqual(missingResult.valid, false);
  assert.strictEqual(missingResult.errors[0].code, 'CHANGED_NODE_MISSING');

  const withAddedTarget = ResumeDom.applyDocumentOperations(base, [{
    op: 'insert_node',
    parent_id: 'summary-section',
    node: {
      id: 'summary-new',
      type: 'element',
      tag: 'p',
      text: 'AI 新增',
      editable: true,
    },
  }], { allowStructure: true });
  const occupied = ResumeDom.applyDocumentOperations(base, [{
    op: 'insert_node',
    parent_id: 'summary-section',
    node: {
      id: 'summary-new',
      type: 'element',
      tag: 'p',
      text: '另一项新增内容',
      editable: true,
    },
  }], { allowStructure: true });
  const occupiedResult = canMergeResumeDocuments({
    base,
    target: withAddedTarget,
    current: occupied,
  });
  assert.strictEqual(occupiedResult.valid, false);
  assert.strictEqual(occupiedResult.errors[0].code, 'ADDED_NODE_ID_OCCUPIED');
});
