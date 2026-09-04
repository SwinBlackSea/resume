'use strict';
const test = require('node:test');
const assert = require('node:assert');

// 必须先初始化隔离测试数据库；render/html 会间接加载数据库模块。
const helpers = require('./helpers');
const ResumeDom = require('../resume-dom');
const { renderHtml } = require('../server/lib/render/html');
const { buildDocumentXml } = require('../server/lib/render/docx');
const { validateResumeJson } = require('../server/lib/resume-schema');

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

test('文档引擎可组合文字与 AI 样式操作，并保留页面、样式和资源', () => {
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

test('内容分组与 AI 编辑粒度使用可逆语义操作，子节点 ID 和文字保持稳定', () => {
  const before = ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root',
      type: 'element',
      tag: 'article',
      children: [{
        id: 'section',
        type: 'element',
        tag: 'section',
        children: [
          { id: 'title', type: 'element', tag: 'h2', text: '职业概况', editable: true },
          { id: 'item-1', type: 'element', tag: 'p', text: '第一段。', editable: true },
          { id: 'item-2', type: 'element', tag: 'p', text: '第二段。', editable: true },
          { id: 'item-3', type: 'element', tag: 'p', text: '第三段。', editable: true },
        ],
      }],
    },
  });
  const grouped = ResumeDom.applyDocumentOperations(before, [{
    op: 'merge_editable_nodes',
    parent_id: 'section',
    node_ids: ['item-1', 'item-2', 'item-3'],
    node: {
      id: 'summary-group',
      type: 'element',
      tag: 'div',
      label: '职业概况',
      children: [],
    },
  }], { allowStructure: true });
  assert.strictEqual(ResumeDom.resolveAiScopeNode(grouped, 'item-2').node.id, 'summary-group');
  assert.strictEqual(ResumeDom.findNode(grouped, 'summary-group').node.editable, true);
  assert.strictEqual(
    ResumeDom.findNode(grouped, 'summary-group').node.children.every((node) => !node.editable),
    true,
  );
  assert.strictEqual(ResumeDom.nodeText(ResumeDom.findNode(grouped, 'summary-group').node), '第一段。\n第二段。\n第三段。');

  const independent = ResumeDom.applyDocumentOperations(grouped, [{
    op: 'split_editable_node',
    node_id: 'summary-group',
  }], { allowStructure: true });
  assert.strictEqual(ResumeDom.resolveAiScopeNode(independent, 'item-2').node.id, 'item-2');
  assert.strictEqual(ResumeDom.findNode(independent, 'summary-group').node.editable, undefined);
  assert.strictEqual(
    ResumeDom.findNode(independent, 'summary-group').node.children.every((node) => node.editable),
    true,
  );

  const unwrapped = ResumeDom.applyDocumentOperations(independent, [{
    op: 'unwrap_node',
    node_id: 'summary-group',
  }], { allowStructure: true });
  assert.deepStrictEqual(
    ResumeDom.findNode(unwrapped, 'section').node.children.map((node) => node.id),
    ['title', 'item-1', 'item-2', 'item-3'],
  );
  assert.strictEqual(ResumeDom.plainText(unwrapped), ResumeDom.plainText(before));
});

test('旧版双重 AI 范围无损升级为一个编辑节点，新的嵌套编辑身份被强制拒绝', () => {
  const legacy = ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root',
      type: 'element',
      tag: 'article',
      children: [{
        id: 'legacy-group',
        type: 'element',
        tag: 'div',
        attributes: { 'data-ai-scope': 'true' },
        children: [
          { id: 'legacy-one', type: 'element', tag: 'p', text: '第一段。', editable: true },
          { id: 'legacy-two', type: 'element', tag: 'p', text: '第二段。', editable: true },
        ],
      }],
    },
  });
  const group = ResumeDom.findNode(legacy, 'legacy-group').node;
  assert.strictEqual(group.editable, true);
  assert.strictEqual(group.attributes['data-ai-scope'], undefined);
  assert.strictEqual(group.children.every((node) => !node.editable), true);
  assert.strictEqual(ResumeDom.nodeText(group), '第一段。\n第二段。');

  assert.throws(() => ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: 'root',
      type: 'element',
      tag: 'article',
      editable: true,
      children: [{ id: 'child', type: 'element', tag: 'p', text: '内容', editable: true }],
    },
  }), (error) => error.code === 'NESTED_EDITABLE_NODE');
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
