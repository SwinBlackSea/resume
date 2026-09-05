'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ResumeDom = require('../resume-dom');
const {
  TARGET_FRAGMENTS_FORMAT,
  LEGACY_TARGET_FRAGMENTS_FORMAT,
  materializeTargetFragments,
} = require('../server/lib/resume-harness/target-fragments');

function documentFixture() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      children: [
        {
          id: 'summary-section',
          type: 'element',
          tag: 'section',
          label: '职业概况',
          children: [
            {
              id: 'summary-title',
              type: 'element',
              tag: 'h2',
              text: '职业概况',
              editable: true,
            },
            {
              id: 'summary-body',
              type: 'element',
              tag: 'p',
              text: '原始职业概况',
              editable: true,
            },
          ],
        },
        {
          id: 'skills-section',
          type: 'element',
          tag: 'section',
          children: [{
            id: 'skills-body',
            type: 'element',
            tag: 'p',
            text: 'Excel、SQL',
            editable: true,
          }],
        },
      ],
    },
    page_setup: { size: 'A4' },
    styles: { accent: '#123456' },
    assets: [],
    annotations: [],
  });
}

test('目标子树删除现有节点，并原样保留未返回区域和文档元数据', () => {
  const before = documentFixture();
  const result = materializeTargetFragments(before, {
    format: TARGET_FRAGMENTS_FORMAT,
    changes: [{
      target_id: 'summary-section',
      replacement_subtree: null,
    }],
  });

  assert.strictEqual(ResumeDom.findNode(result.document, 'summary-section'), null);
  assert.ok(ResumeDom.findNode(result.document, 'skills-section'));
  assert.deepStrictEqual(result.document.page_setup, before.page_setup);
  assert.deepStrictEqual(result.document.styles, before.styles);
});

test('v2 强制新增内容使用 insertions，不接受重复返回整个父节点', () => {
  const before = documentFixture();
  const section = ResumeDom.findNode(before, 'skills-section').node;
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: [{
        target_id: section.id,
        replacement_subtree: {
          ...section,
          children: section.children.concat([{
            id: 'certificate-body',
            type: 'element',
            tag: 'p',
            text: 'PMP',
            editable: true,
          }]),
        },
      }],
    }),
    (error) => error.code === 'TARGET_FRAGMENT_NOT_MINIMAL',
  );

  const result = materializeTargetFragments(before, {
    format: LEGACY_TARGET_FRAGMENTS_FORMAT,
    changes: [{
      target_id: section.id,
      replacement_subtree: {
        ...section,
        children: section.children.concat([{
          id: 'certificate-body',
          type: 'element',
          tag: 'p',
          text: 'PMP',
          editable: true,
        }]),
      },
    }],
  });
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(result.document, 'certificate-body').node),
    'PMP',
  );
  assert.ok(ResumeDom.findNode(result.document, 'summary-section'));
});

test('v2 拒绝用整份根节点承载单个叶子文字变化', () => {
  const before = documentFixture();
  const target = ResumeDom.applyDocumentOperations(before, [{
    op: 'replace_text',
    node_id: 'summary-body',
    text: '更新后的概况',
  }]);

  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: [{
        target_id: 'resume-root',
        replacement_subtree: target.root,
      }],
    }),
    (error) => (
      error.code === 'TARGET_FRAGMENT_NOT_MINIMAL'
      && error.changed_child_ids.includes('summary-section')
    ),
  );
});

test('模型目标子树出现已停用的 data-ai-scope 时直接拒绝，不执行旧文档迁移', () => {
  const before = documentFixture();
  const body = ResumeDom.clone(ResumeDom.findNode(before, 'summary-body').node);
  body.attributes = { 'data-ai-scope': 'true' };
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: [{
        target_id: body.id,
        replacement_subtree: body,
      }],
    }),
    (error) => error.code === 'AI_SCOPE_ATTRIBUTE_FORBIDDEN',
  );
});

test('紧凑新增只返回父节点、稳定锚点和新子树，不重复现有父节点', () => {
  const before = documentFixture();
  const result = materializeTargetFragments(before, {
    format: TARGET_FRAGMENTS_FORMAT,
    changes: [],
    insertions: [{
      parent_id: 'resume-root',
      after_id: 'summary-section',
      new_subtrees: [
        {
          id: 'career-plan-title',
          type: 'element',
          tag: 'h2',
          text: '职业发展规划',
          editable: true,
        },
        {
          id: 'career-plan-body',
          type: 'element',
          tag: 'p',
          text: '持续深耕学生管理、党建宣传与数据分析。',
          editable: true,
        },
      ],
    }],
  });

  assert.deepStrictEqual(
    result.document.root.children.map((child) => child.id),
    [
      'summary-section',
      'career-plan-title',
      'career-plan-body',
      'skills-section',
    ],
  );
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(result.document, 'career-plan-body').node),
    '持续深耕学生管理、党建宣传与数据分析。',
  );
  assert.deepStrictEqual(
    ResumeDom.findNode(result.document, 'skills-section').node,
    ResumeDom.findNode(before, 'skills-section').node,
  );
  assert.deepStrictEqual(result.document.page_setup, before.page_setup);
});

test('多个互不重叠的目标子树可一次组装，不依赖执行顺序', () => {
  const before = documentFixture();
  const summary = ResumeDom.findNode(before, 'summary-body').node;
  const skills = ResumeDom.findNode(before, 'skills-body').node;
  const result = materializeTargetFragments(before, {
    changes: [
      {
        target_id: summary.id,
        replacement_subtree: { ...summary, text: '突出团队管理经验' },
      },
      {
        target_id: skills.id,
        replacement_subtree: { ...skills, text: 'Excel、SQL、SPSS' },
      },
    ],
  });

  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(result.document, summary.id).node),
    '突出团队管理经验',
  );
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(result.document, skills.id).node),
    'Excel、SQL、SPSS',
  );
});

test('v2 稀疏文字片段继承标题标签、样式、语义和富文本结构', () => {
  const before = ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'resume-root',
      type: 'element',
      tag: 'article',
      semantic: { kind: 'document' },
      children: [{
        id: 'styled-title',
        type: 'element',
        tag: 'h2',
        attributes: { class: 'editable imported-heading', 'data-rich-text': 'true' },
        style: { color: '#164D7A', 'font-size': '14pt', 'font-weight': '700' },
        semantic: { kind: 'section_title', level: 2 },
        editable: true,
        label: '标题',
        children: [
          {
            id: 'styled-title-strong',
            type: 'element',
            tag: 'strong',
            style: { 'font-weight': '700' },
            children: [{ id: 'styled-title-text', type: 'text', value: '工作经历' }],
          },
        ],
      }],
    },
    page_setup: { size: 'A4' },
    styles: {},
    assets: [],
    annotations: [],
  });

  const result = materializeTargetFragments(before, {
    format: TARGET_FRAGMENTS_FORMAT,
    changes: [{
      target_id: 'styled-title',
      replacement_subtree: {
        id: 'styled-title',
        text: '项目经历',
      },
    }],
  });
  const changed = ResumeDom.findNode(result.document, 'styled-title').node;
  assert.strictEqual(changed.tag, 'h2');
  assert.strictEqual(changed.style.color, '#164D7A');
  assert.strictEqual(changed.style['font-size'], '14pt');
  assert.strictEqual(changed.semantic.kind, 'section_title');
  assert.strictEqual(changed.semantic.level, 2);
  assert.strictEqual(changed.editable, true);
  assert.strictEqual(changed.children[0].tag, 'strong');
  assert.strictEqual(changed.children[0].id, 'styled-title-strong');
  assert.strictEqual(ResumeDom.exportNodeText(changed), '项目经历');
});

test('跨父节点移动通过同时替换两个父子树完成，不产生中间重复或丢失', () => {
  const before = documentFixture();
  const summarySection = ResumeDom.findNode(before, 'summary-section').node;
  const skillsSection = ResumeDom.findNode(before, 'skills-section').node;
  const movedNode = ResumeDom.findNode(before, 'summary-body').node;
  const result = materializeTargetFragments(before, {
    changes: [
      {
        target_id: summarySection.id,
        replacement_subtree: {
          ...summarySection,
          children: summarySection.children.filter((child) => child.id !== movedNode.id),
        },
      },
      {
        target_id: skillsSection.id,
        replacement_subtree: {
          ...skillsSection,
          children: skillsSection.children.concat([movedNode]),
        },
      },
    ],
  });

  const moved = ResumeDom.findNode(result.document, movedNode.id);
  assert.ok(moved);
  assert.strictEqual(moved.parent.id, skillsSection.id);
  assert.strictEqual(
    ResumeDom.findNode(result.document, summarySection.id).node.children
      .some((child) => child.id === movedNode.id),
    false,
  );
});

test('目标子树拒绝嵌套区域、未知节点和替换根 ID 漂移', () => {
  const before = documentFixture();
  assert.throws(
    () => materializeTargetFragments(before, {
      changes: [
        {
          target_id: 'summary-section',
          replacement_subtree: ResumeDom.findNode(before, 'summary-section').node,
        },
        {
          target_id: 'summary-body',
          replacement_subtree: ResumeDom.findNode(before, 'summary-body').node,
        },
      ],
    }),
    /不能相互嵌套/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      changes: [{ target_id: 'missing-node', replacement_subtree: null }],
    }),
    /节点不存在/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      changes: [{
        target_id: 'summary-body',
        replacement_subtree: {
          ...ResumeDom.findNode(before, 'summary-body').node,
          id: 'new-id',
        },
      }],
    }),
    /必须沿用目标节点 ID/,
  );
});

test('紧凑新增拒绝未知父节点、非直接锚点、被占用 ID 和替换范围重叠', () => {
  const before = documentFixture();
  const subtree = {
    id: 'career-plan',
    type: 'element',
    tag: 'section',
    children: [],
  };
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      insertions: [{
        parent_id: 'missing-parent',
        after_id: null,
        new_subtrees: [subtree],
      }],
    }),
    /父节点不存在/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      insertions: [{
        parent_id: 'resume-root',
        after_id: 'summary-body',
        new_subtrees: [subtree],
      }],
    }),
    /不是父节点的直接子节点/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      insertions: [{
        parent_id: 'resume-root',
        after_id: 'summary-section',
        new_subtrees: [{ ...subtree, id: 'skills-section' }],
      }],
    }),
    /ID 已存在或重复/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: [{
        target_id: 'resume-root',
        replacement_subtree: before.root,
      }],
      insertions: [{
        parent_id: 'resume-root',
        after_id: 'summary-section',
        new_subtrees: [subtree],
      }],
    }),
    /不能位于被整体替换的目标子树中/,
  );
});

test('目标子树协议拒绝错误的 changes 或 insertions 容器类型', () => {
  const before = documentFixture();
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: {
        target_id: 'summary-section',
        replacement_subtree: null,
      },
    }),
    /changes 必须是数组/,
  );
  assert.throws(
    () => materializeTargetFragments(before, {
      format: TARGET_FRAGMENTS_FORMAT,
      changes: [],
      insertions: {
        parent_id: 'resume-root',
        after_id: 'summary-section',
        new_subtrees: [],
      },
    }),
    /insertions 必须是数组/,
  );
});
