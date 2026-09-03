'use strict';
const test = require('node:test');
const assert = require('node:assert');

const ResumeDom = require('../resume-dom');
const { renderHtml } = require('../server/lib/render/html');
const { buildDocumentXml } = require('../server/lib/render/docx');
const { validateResumeJson } = require('../server/lib/resume-schema');
const helpers = require('./helpers');

const legacyResume = {
  basics: { name: '测试用户', city: '上海', phone: '13800000000', email: 'test@example.com' },
  headline: '产品经理',
  summary: '善于把复杂问题拆成可执行方案。',
  experience: [
    {
      id: 'work-1',
      organization: '示例公司',
      title: '产品经理',
      start: '2022.01',
      end: '',
      bullets: [{ id: 'target-bullet', text: '负责产品规划与落地。' }],
    },
  ],
  projects: [],
  education: [],
  skills: ['产品规划'],
  generation_notes: [],
  validation_issues: [],
  layout_hints: { layout: 'classic' },
};

const template = {
  schema: {
    typography: { accent: '#1d1d1f' },
    section_rules: { title_style: { rule: true } },
  },
};

function overseasOperation(text = '曾参与跨国团队协作。') {
  return {
    op: 'insert_node',
    parent_id: 'resume-root',
    after_node_id: 'section-summary',
    node: {
      id: 'section-overseas',
      type: 'element',
      tag: 'section',
      attributes: { class: 'resume-section' },
      children: [
        {
          id: 'section-overseas-title',
          type: 'element',
          tag: 'h2',
          text: '海外经历',
          editable: true,
        },
        {
          id: 'overseas-content-1',
          type: 'element',
          tag: 'p',
          text,
          editable: true,
        },
      ],
    },
  };
}

test('通用 Resume DOM 可在旧简历上新增任意模块并供所有渲染器读取', () => {
  const document = ResumeDom.applyOperations(
    ResumeDom.ensureDocument(legacyResume),
    [overseasOperation()],
    { allowStructure: true },
  );
  const blocks = ResumeDom.toRenderBlocks(document);
  assert.ok(blocks.blocks.some((block) => block.type === 'heading' && block.text === '海外经历'));
  assert.ok(blocks.blocks.some((block) => block.text === '曾参与跨国团队协作。'));

  const resume = ResumeDom.syncLegacyBindings(legacyResume, document);
  assert.strictEqual(validateResumeJson({ dom_document: document }).valid, true);
  const html = renderHtml({ resume, template });
  const docxXml = buildDocumentXml(resume, template);
  assert.match(html, /海外经历/);
  assert.match(html, /曾参与跨国团队协作/);
  assert.match(docxXml, /海外经历/);
  assert.match(docxXml, /曾参与跨国团队协作/);
});

test('DOM 操作使用稳定节点 ID，同步修改旧字段且拒绝危险结构', () => {
  const document = ResumeDom.applyOperations(
    ResumeDom.ensureDocument(legacyResume),
    [{ op: 'replace_text', node_id: 'target-bullet', text: '负责从规划到上线的完整闭环。' }],
    { lockedNodeId: 'target-bullet', allowStructure: false },
  );
  const synced = ResumeDom.syncLegacyBindings(legacyResume, document);
  assert.strictEqual(synced.experience[0].bullets[0].text, '负责从规划到上线的完整闭环。');

  assert.throws(
    () => ResumeDom.applyOperations(document, [{
      op: 'insert_node',
      parent_id: 'resume-root',
      node: { id: 'unsafe-script', type: 'element', tag: 'script', text: 'alert(1)' },
    }]),
    /不支持的 DOM 标签/,
  );

  const safe = ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: {
      id: 'safe-root',
      type: 'element',
      tag: 'article',
      children: [{
        id: 'safe-link',
        type: 'element',
        tag: 'a',
        attributes: { href: 'javascript:alert(1)', onclick: 'alert(1)' },
        text: '作品集',
      }],
    },
  });
  assert.deepStrictEqual(safe.root.children[0].attributes, {});
});

test('通用差异引擎识别动态模块、文本和样式变化，不把固定区块写死', () => {
  const before = ResumeDom.ensureDocument(legacyResume);
  const afterAdded = ResumeDom.applyOperations(before, [overseasOperation()]);
  const after = ResumeDom.applyOperations(afterAdded, [
    { op: 'replace_text', node_id: 'target-bullet', text: '负责产品规划、验证与上线闭环。' },
    { op: 'set_style', node_id: 'section-summary-title', style: { color: '#0066cc' } },
  ]);
  const diff = ResumeDom.compareDocuments(before, after);

  assert.strictEqual(diff.equal, false);
  assert.ok(diff.changes.some(
    (change) => change.type === 'added' && change.node_id === 'section-overseas',
  ));
  assert.ok(!diff.changes.some(
    (change) => change.type === 'added' && change.node_id === 'overseas-content-1',
  ), '新增模块只应报告最外层节点');
  assert.ok(diff.changes.some(
    (change) => change.type === 'text' && change.node_id === 'target-bullet',
  ));
  assert.ok(diff.changes.some(
    (change) => change.type === 'style' && change.node_id === 'section-summary-title',
  ));
  assert.strictEqual(diff.counts.moved, 0, '插入新模块不应把后续原有模块误判为移动');
});

test('导入简历保存为单一完整文档，页面、样式与可编辑内容一起保留', () => {
  const importedDocument = ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: ResumeDom.elementNode('resume-root', 'article', {}, [
      ResumeDom.elementNode(
        'imported-page-1',
        'section',
        { class: 'imported-document-page' },
        [
          ResumeDom.elementNode(
            'imported-background-1',
            'img',
            { class: 'imported-scene-background', src: '/preview/page-1.png' },
          ),
          ResumeDom.elementNode(
            'imported-summary',
            'p',
            { class: 'imported-scene-text' },
            [],
            { text: '负责产品规划与增长实验。', editable: true, label: '个人总结' },
          ),
        ],
      ),
    ]),
  });
  const document = ResumeDom.toResumeDocument({
    dom_document: importedDocument,
    page_setup: { size: 'A4', max_pages: 1 },
    styles: { '--accent': '#0066cc' },
    assets: [{ id: 'page-1', type: 'preview' }],
  });

  assert.strictEqual(document.schema_version, ResumeDom.RESUME_DOCUMENT_VERSION);
  assert.ok(ResumeDom.findNode(document, 'imported-summary'));
  assert.ok(
    ResumeDom.findNode(document, 'imported-background-1'),
    '完整文档必须直接保留页面视觉结构',
  );
  assert.match(ResumeDom.plainText(document), /增长实验/);
  assert.deepStrictEqual(document.page_setup, { size: 'A4', max_pages: 1 });
  assert.deepStrictEqual(document.styles, { '--accent': '#0066cc' });
  assert.strictEqual(document.assets[0].id, 'page-1');
  assert.strictEqual(Object.hasOwn(document, 'content_document'), false);
  assert.strictEqual(Object.hasOwn(document, 'template_document'), false);
  assert.strictEqual(Object.hasOwn(document, 'layout_bindings'), false);
});

test('直接编辑事务修改同一文档，并保留页面、样式和资源', () => {
  const document = ResumeDom.toResumeDocument({
    ...legacyResume,
    page_setup: { size: 'A4', orientation: 'portrait', max_pages: 2 },
    styles: { '--accent': '#1d1d1f' },
    assets: [{ id: 'avatar', type: 'image' }],
  });
  const changed = ResumeDom.applyDocumentOperations(document, [
    { op: 'replace_text', node_id: 'target-bullet', text: '负责产品规划、验证和上线。' },
    { op: 'set_style', node_id: 'target-bullet', style: { 'font-weight': '700' } },
  ]);

  assert.strictEqual(changed.schema_version, ResumeDom.RESUME_DOCUMENT_VERSION);
  assert.match(ResumeDom.plainText(changed), /规划、验证和上线/);
  assert.strictEqual(ResumeDom.findNode(changed, 'target-bullet').node.style['font-weight'], '700');
  assert.deepStrictEqual(changed.page_setup, document.page_setup);
  assert.deepStrictEqual(changed.styles, document.styles);
  assert.deepStrictEqual(changed.assets, document.assets);
});

test('整份简历可由 AI 新增动态模块，新增内容可继续选中改写并撤销', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  let before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  if (ResumeDom.findNode(before.draft.resume_json, 'section-overseas')) {
    const cleaned = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/transactions`,
      {
        body: {
          expected_revision: before.draft.revision,
          mutation_id: `remove-existing-overseas-${Date.now()}`,
          operations: [{ op: 'remove_node', node_id: 'section-overseas' }],
          label: '清理已有海外经历测试模块',
          input_type: 'structure',
        },
      },
    );
    assert.strictEqual(cleaned.status, 200, JSON.stringify(cleaned.body));
    before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  }

  const proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '新增一个海外经历模块，内容：曾参与跨国团队协作',
      scope_type: 'RESUME_DOCUMENT',
      scope_id: null,
    },
  });
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `apply-dynamic-${action.id}`,
    body: { expected_revision: before.draft.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));

  const after = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const added = ResumeDom.findNode(after.draft.resume_json, 'overseas-content-1');
  assert.ok(added);
  assert.strictEqual(ResumeDom.nodeText(added.node), '曾参与跨国团队协作');
  assert.strictEqual(Object.hasOwn(after.draft.resume_json, 'overseas'), false);

  const followup = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '写得更精炼',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'overseas-content-1',
    },
  });
  assert.strictEqual(followup.status, 200, JSON.stringify(followup.body));
  assert.ok(followup.body.actions.some(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  ));

  const change = after.draft.pending_changes[after.draft.pending_changes.length - 1];
  const reverted = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/changes/${change.id}/revert`,
    { idemKey: `revert-dynamic-${change.id}` },
  );
  assert.strictEqual(reverted.status, 200, JSON.stringify(reverted.body));
  const restored = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.strictEqual(
    ResumeDom.findNode(restored.draft.resume_json, 'section-overseas'),
    null,
  );
});
