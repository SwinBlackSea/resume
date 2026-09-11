'use strict';
const test = require('node:test');
const assert = require('node:assert');

const ResumeDom = require('../resume-dom');
const {
  buildOperationPreconditions,
  validateOperationPreconditions,
} = require('../server/lib/resume-operation-preconditions');

function fixture() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root',
      type: 'element',
      tag: 'article',
      children: [
        {
          id: 'contact',
          type: 'element',
          tag: 'p',
          text: 'user@example.com',
          editable: true,
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
              text: '职业概况第一段',
              editable: true,
            },
            {
              id: 'next-section-title',
              type: 'element',
              tag: 'h2',
              text: '工作经历',
              editable: true,
            },
          ],
        },
      ],
    },
  });
}

function insertSummaryOperation(id = 'summary-2') {
  return {
    op: 'insert_node',
    parent_id: 'summary-section',
    after_node_id: 'summary-1',
    node: {
      id,
      type: 'element',
      tag: 'p',
      text: '',
      editable: true,
    },
  };
}

test('DOM 操作前置条件允许无关节点文字并行变化', () => {
  const before = fixture();
  const preconditions = buildOperationPreconditions(before, [insertSummaryOperation()]);
  const current = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'contact', text: 'new@example.com' },
  ]);

  assert.deepStrictEqual(
    validateOperationPreconditions(current, preconditions),
    { valid: true, errors: [] },
  );
  const applied = ResumeDom.applyDocumentOperations(current, [insertSummaryOperation()]);
  assert.ok(ResumeDom.findNode(applied, 'summary-2'));
  assert.strictEqual(ResumeDom.nodeText(ResumeDom.findNode(applied, 'contact').node), 'new@example.com');
});

test('DOM 操作前置条件允许目标文字和相邻结构变化后按稳定锚点执行', () => {
  const before = fixture();
  const preconditions = buildOperationPreconditions(before, [insertSummaryOperation()]);
  const changedAnchor = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'summary-1', text: '职业概况已被用户改写' },
  ]);
  assert.strictEqual(validateOperationPreconditions(changedAnchor, preconditions).valid, true);

  const occupiedBoundary = ResumeDom.applyDocumentOperations(before, [
    insertSummaryOperation('another-summary'),
  ]);
  assert.strictEqual(validateOperationPreconditions(occupiedBoundary, preconditions).valid, true);
  const applied = ResumeDom.applyDocumentOperations(
    occupiedBoundary,
    [insertSummaryOperation()],
  );
  assert.deepStrictEqual(
    ResumeDom.findNode(applied, 'summary-section').node.children.map((node) => node.id),
    ['summary-1', 'summary-2', 'another-summary', 'next-section-title'],
  );
});

test('目标、父容器或稳定锚点消失以及新增 ID 被占用时才失效', () => {
  const before = fixture();
  const operation = insertSummaryOperation();
  const preconditions = buildOperationPreconditions(before, [operation]);
  const missingAnchor = ResumeDom.applyDocumentOperations(before, [
    { op: 'remove_node', node_id: 'summary-1' },
  ]);
  assert.strictEqual(validateOperationPreconditions(missingAnchor, preconditions).valid, false);

  const occupiedId = ResumeDom.applyDocumentOperations(before, [operation]);
  assert.strictEqual(validateOperationPreconditions(occupiedId, preconditions).valid, false);

  const missingParent = ResumeDom.applyDocumentOperations(before, [
    { op: 'remove_node', node_id: 'summary-section' },
  ]);
  assert.strictEqual(validateOperationPreconditions(missingParent, preconditions).valid, false);
});

test('index 插入以应用时的最新兄弟顺序为准', () => {
  const before = fixture();
  const operation = {
    op: 'insert_node',
    parent_id: 'summary-section',
    index: 2,
    node: {
      id: 'summary-tail',
      type: 'element',
      tag: 'p',
      text: '',
      editable: true,
    },
  };
  const preconditions = buildOperationPreconditions(before, [operation]);
  const textChanged = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'summary-1', text: '文字变化但顺序没变' },
  ]);
  assert.strictEqual(
    validateOperationPreconditions(textChanged, preconditions).valid,
    true,
  );
  const orderChanged = ResumeDom.applyDocumentOperations(before, [insertSummaryOperation('middle')]);
  assert.strictEqual(
    validateOperationPreconditions(orderChanged, preconditions).valid,
    true,
  );
  const applied = ResumeDom.applyDocumentOperations(orderChanged, [operation]);
  assert.strictEqual(
    ResumeDom.findNode(applied, 'summary-section').node.children[2].id,
    'summary-tail',
  );
});

test('旧版前置条件中的内容哈希和相邻边界不再阻止用户明确应用', () => {
  const before = fixture();
  const preconditions = buildOperationPreconditions(before, [insertSummaryOperation()]);
  preconditions.format = 'resume-operation-preconditions-v1';
  preconditions.nodes.forEach((item) => {
    item.node_hash = 'legacy-content-hash';
    item.parent_id = 'legacy-parent';
  });
  preconditions.insertion_points.forEach((item) => {
    item.right_node_id = 'legacy-right-boundary';
  });
  const current = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'summary-1', text: '用户修改后的最新内容' },
    insertSummaryOperation('another-summary'),
  ]);
  assert.deepStrictEqual(
    validateOperationPreconditions(current, preconditions),
    { valid: true, errors: [] },
  );
});

test('批量操作按执行顺序校验，允许后续步骤引用前一步移动到位的锚点', () => {
  const before = fixture();
  const operations = [
    {
      op: 'move_node',
      node_id: 'summary-1',
      parent_id: 'root',
      after_node_id: 'contact',
    },
    {
      op: 'move_node',
      node_id: 'next-section-title',
      parent_id: 'root',
      after_node_id: 'summary-1',
    },
    { op: 'remove_node', node_id: 'summary-section' },
  ];

  const preconditions = buildOperationPreconditions(before, operations);
  assert.strictEqual(
    preconditions.insertion_points.some((point) =>
      point.anchor_node_id === 'summary-1' && point.parent_id === 'root'),
    false,
    '运行中才移动到位的锚点不能被错误记录成初始文档边界',
  );
  assert.deepStrictEqual(validateOperationPreconditions(before, preconditions), {
    valid: true,
    errors: [],
  });
  const after = ResumeDom.applyDocumentOperations(before, operations, { allowStructure: true });
  assert.deepStrictEqual(after.root.children.map((node) => node.id), [
    'contact',
    'summary-1',
    'next-section-title',
  ]);
});
