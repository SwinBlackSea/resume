'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ResumeDom = require('../resume-dom');
const {
  normalizeChangeConstraints,
  evaluateChange,
  authorizeChange,
  validateAuthorizedChange,
  describeAllowedRegions,
} = require('../server/lib/resume-change-policy');
const { resolveResumeScope } = require('../server/lib/resume-scope');

function document() {
  return ResumeDom.toResumeDocument({
    schema_version: 'resume-document-v3',
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'main',
      children: [
        {
          id: 'summary-section',
          type: 'element',
          tag: 'section',
          children: [
            {
              id: 'summary-title',
              type: 'element',
              tag: 'h2',
              text: '职业概况',
              editable: true,
            },
            {
              id: 'summary',
              type: 'element',
              tag: 'p',
              text: '第一段完整内容。第二段不能丢失。',
              editable: true,
            },
          ],
        },
        {
          id: 'skills-section',
          type: 'element',
          tag: 'section',
          children: [{
            id: 'skills',
            type: 'element',
            tag: 'p',
            text: 'Excel、SQL',
            editable: true,
          }],
        },
      ],
    },
  });
}

function structureOnly(extra = {}) {
  return {
    content: 'preserve',
    content_order: 'preserve',
    structure: 'modify',
    style: 'preserve',
    allowed_region_ids: ['summary-section'],
    ...extra,
  };
}

test('纯结构拆分保留全部文字时通过一致性策略', () => {
  const before = document();
  const operations = [
    { op: 'remove_node', node_id: 'summary' },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-title',
      node: {
        id: 'summary-1',
        type: 'element',
        tag: 'p',
        text: '第一段完整内容。',
        editable: true,
      },
    },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-1',
      node: {
        id: 'summary-2',
        type: 'element',
        tag: 'p',
        text: '第二段不能丢失。',
        editable: true,
      },
    },
  ];
  const after = ResumeDom.applyDocumentOperations(before, operations, { allowStructure: true });
  const constraints = normalizeChangeConstraints(structureOnly(), before, {
    scopeType: 'RESUME_BLOCK',
    scopeId: 'summary-title',
  });
  assert.strictEqual(evaluateChange(before, after, constraints).valid, true);
});

test('纯结构调整遗漏原文时以通用内容守恒规则拒绝', () => {
  const before = document();
  const after = ResumeDom.applyDocumentOperations(before, [
    { op: 'remove_node', node_id: 'summary' },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-title',
      node: {
        id: 'summary-1',
        type: 'element',
        tag: 'p',
        text: '第一段完整内容。',
        editable: true,
      },
    },
  ], { allowStructure: true });
  const result = evaluateChange(
    before,
    after,
    normalizeChangeConstraints(structureOnly(), before),
  );
  assert.strictEqual(result.valid, false);
  assert.deepStrictEqual(result.errors.map((item) => item.code), ['CONTENT_NOT_PRESERVED']);
});

test('仅改文字的授权不能顺带改变结构或其他区域', () => {
  const before = document();
  const after = ResumeDom.applyDocumentOperations(before, [
    { op: 'replace_text', node_id: 'summary', text: '更专业的职业概况。' },
    { op: 'remove_node', node_id: 'skills' },
  ], { allowStructure: true });
  const constraints = normalizeChangeConstraints({
    content: 'modify',
    structure: 'preserve',
    style: 'preserve',
    allowed_region_ids: ['summary-section'],
  }, before);
  const result = evaluateChange(before, after, constraints);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.some((item) => item.code === 'STRUCTURE_NOT_ALLOWED'));
  assert.ok(result.errors.some((item) => item.code === 'OUTSIDE_ALLOWED_REGION'));
});

test('结构重排可显式允许顺序变化但仍不允许文字增删', () => {
  const before = document();
  const after = ResumeDom.applyDocumentOperations(before, [{
    op: 'move_node',
    node_id: 'skills-section',
    parent_id: 'resume-root',
    index: 0,
  }], { allowStructure: true });
  const constraints = normalizeChangeConstraints(structureOnly({
    content_order: 'reorder',
    allowed_region_ids: ['resume-root'],
  }), before);
  assert.strictEqual(evaluateChange(before, after, constraints).valid, true);
});

test('用户同时授权内容和结构调整时允许混合修改', () => {
  const before = document();
  const after = ResumeDom.applyDocumentOperations(before, [
    { op: 'remove_node', node_id: 'summary' },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-title',
      node: {
        id: 'summary-rewritten-1',
        type: 'element',
        tag: 'li',
        text: '聚焦核心经历。',
        editable: true,
      },
    },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-rewritten-1',
      node: {
        id: 'summary-rewritten-2',
        type: 'element',
        tag: 'li',
        text: '表达更加精炼。',
        editable: true,
      },
    },
  ], { allowStructure: true });
  const constraints = normalizeChangeConstraints({
    content: 'modify',
    structure: 'modify',
    style: 'preserve',
    allowed_region_ids: ['summary-section'],
  }, before);
  assert.strictEqual(evaluateChange(before, after, constraints).valid, true);
});

test('相邻节点可以在原区域内形成普通视觉分组而不改变编辑身份', () => {
  const before = ResumeDom.toResumeDocument({
    schema_version: 'resume-document-v3',
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      children: [
        { id: 'summary-title', type: 'element', tag: 'h2', text: '职业概况', editable: true },
        { id: 'summary-1', type: 'element', tag: 'p', text: '第一点。', editable: true },
        { id: 'summary-2', type: 'element', tag: 'p', text: '第二点。', editable: true },
        { id: 'next-title', type: 'element', tag: 'h2', text: '工作经历', editable: true },
      ],
    },
  });
  const operations = [
    {
      op: 'insert_node',
      parent_id: 'resume-root',
      after_node_id: 'summary-title',
      node: {
        id: 'summary-group',
        type: 'element',
        tag: 'div',
        children: [],
      },
    },
    {
      op: 'move_node',
      node_id: 'summary-1',
      parent_id: 'summary-group',
      index: 0,
    },
    {
      op: 'move_node',
      node_id: 'summary-2',
      parent_id: 'summary-group',
      index: 1,
    },
  ];
  const after = ResumeDom.applyDocumentOperations(before, operations, { allowStructure: true });
  const scopeRegion = resolveResumeScope(before, 'summary-title');
  const constraints = normalizeChangeConstraints({
    content: 'preserve',
    structure: 'modify',
    style: 'preserve',
    allowed_region_ids: ['summary-title'],
  }, before, {
    scopeType: 'RESUME_BLOCK',
    scopeId: 'summary-title',
    scopeRegion,
  });

  const result = evaluateChange(before, after, constraints);
  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(
    constraints.allowed_region_ids,
    ['summary-title', 'summary-1', 'summary-2'],
  );
});

test('已校验操作被替换时应用前拒绝，用户期间改字不改变原建议授权', () => {
  const before = document();
  const operations = [
    { op: 'remove_node', node_id: 'summary' },
    {
      op: 'insert_node',
      parent_id: 'summary-section',
      after_node_id: 'summary-title',
      node: {
        id: 'summary-1',
        type: 'element',
        tag: 'p',
        text: '第一段完整内容。第二段不能丢失。',
        editable: true,
      },
    },
  ];
  const proposed = ResumeDom.applyDocumentOperations(before, operations, { allowStructure: true });
  const constraints = normalizeChangeConstraints(structureOnly(), before);
  const authorization = authorizeChange({
    before,
    after: proposed,
    constraints,
    operations,
    revision: 3,
  });
  const changedByUser = ResumeDom.applyDocumentOperations(before, [{
    op: 'replace_text',
    node_id: 'summary',
    text: '用户等待期间写入的新内容。',
  }], { allowStructure: true });
  const applied = ResumeDom.applyDocumentOperations(changedByUser, operations, {
    allowStructure: true,
  });
  const allowed = validateAuthorizedChange({
    authorization,
    before: changedByUser,
    after: applied,
    operations,
    revision: 4,
    allowUserContentOverride: true,
  });
  assert.strictEqual(allowed.valid, true);
  assert.strictEqual(allowed.content_override, true);

  const tampered = validateAuthorizedChange({
    authorization,
    before,
    after: proposed,
    operations: operations.concat([{
      op: 'replace_text',
      node_id: 'skills',
      text: '被篡改',
    }]),
    revision: 3,
  });
  assert.strictEqual(tampered.valid, false);
  assert.strictEqual(tampered.errors[0].code, 'AUTHORIZED_CHANGE_MISMATCH');
});

test('AI 编辑粒度属于文档结构语义，不会被误判为样式修改', () => {
  const before = document();
  const independent = ResumeDom.applyDocumentOperations(before, [{
    op: 'insert_node',
    parent_id: 'summary-section',
    after_node_id: 'summary',
    node: {
      id: 'summary-extra',
      type: 'element',
      tag: 'p',
      text: '第二段完整内容。',
      editable: true,
    },
  }], { allowStructure: true });
  const grouped = ResumeDom.applyDocumentOperations(independent, [{
    op: 'merge_editable_nodes',
    parent_id: 'summary-section',
    node_ids: ['summary', 'summary-extra'],
    node: {
      id: 'summary-group',
      type: 'element',
      tag: 'div',
      children: [],
    },
  }], { allowStructure: true });
  const after = ResumeDom.applyDocumentOperations(grouped, [{
    op: 'split_editable_node',
    node_id: 'summary-group',
  }], { allowStructure: true });
  const result = evaluateChange(grouped, after, {
    content: 'preserve',
    content_order: 'preserve',
    structure: 'modify',
    style: 'preserve',
    allowed_region_ids: ['summary-section'],
    allowed_regions: describeAllowedRegions(grouped, ['summary-section']),
  });

  assert.strictEqual(result.valid, true, JSON.stringify(result.errors));
  assert.strictEqual(result.dimensions.structure, 'modified');
  assert.strictEqual(result.dimensions.style, 'preserved');
});
