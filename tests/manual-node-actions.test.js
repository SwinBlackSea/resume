'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const ResumeDom = require('../resume-dom');
const { compileManualNodeAction } = require('../server/lib/manual-node-actions');

function fixture(suffix) {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: {
      id: `root-${suffix}`,
      type: 'element',
      tag: 'article',
      semantic: { kind: 'document' },
      children: [{
        id: `header-${suffix}`,
        type: 'element',
        tag: 'header',
        semantic: { kind: 'header' },
        children: [{
          id: `name-${suffix}`,
          type: 'element',
          tag: 'h1',
          text: '测试用户',
          editable: true,
          semantic: { kind: 'document_title' },
        }],
      }, {
        id: `section-${suffix}`,
        type: 'element',
        tag: 'section',
        semantic: { kind: 'section' },
        children: [{
          id: `title-${suffix}`,
          type: 'element',
          tag: 'h2',
          text: '职业概况',
          editable: true,
          semantic: { kind: 'section_title' },
        }, {
          id: `paragraph-${suffix}`,
          type: 'element',
          tag: 'p',
          text: '负责项目推进。',
          editable: true,
          semantic: { kind: 'paragraph' },
        }, {
          id: `list-${suffix}`,
          type: 'element',
          tag: 'ul',
          semantic: { kind: 'list' },
          children: [{
            id: `item-${suffix}`,
            type: 'element',
            tag: 'li',
            text: '服务120家客户。',
            editable: true,
            semantic: { kind: 'list_item' },
          }],
        }],
      }],
    },
  });
}

function subtreeShape(node) {
  if (!node) return null;
  return {
    type: node.type,
    tag: node.tag,
    value: node.value,
    text: node.text,
    editable: node.editable,
    label: node.label,
    semantic_kind: ResumeDom.semanticKind(node),
    attributes: node.attributes || {},
    style: node.style || {},
    children: (node.children || []).map(subtreeShape),
  };
}

function subtreeIds(node, ids = []) {
  if (!node) return ids;
  ids.push(node.id);
  (node.children || []).forEach((child) => subtreeIds(child, ids));
  return ids;
}

async function createProject(ctx, suffix) {
  const created = await helpers.call(ctx, 'POST', '/projects', {
    body: { name: `人工结构 ${suffix}` },
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  const initialized = await helpers.call(
    ctx,
    'PATCH',
    `/projects/${created.body.id}/resume-draft`,
    {
      body: {
        expected_revision: 1,
        resume_json: fixture(suffix),
      },
    },
  );
  assert.strictEqual(initialized.status, 200, JSON.stringify(initialized.body));
  return created.body.id;
}

test('语义能力明确区分标题、正文、列表与不可增删的页眉字段', () => {
  const document = fixture('capability');
  const title = ResumeDom.manualStructureCapabilities(document, 'title-capability');
  const paragraph = ResumeDom.manualStructureCapabilities(document, 'paragraph-capability');
  const item = ResumeDom.manualStructureCapabilities(document, 'item-capability');

  assert.deepStrictEqual(
    title.add.map((entry) => entry.action),
    ['add_section_content', 'add_section_after'],
  );
  assert.deepStrictEqual(
    title.add.map((entry) => entry.label),
    ['增加模块内容', '新增同级模块'],
  );
  assert.strictEqual(title.remove.target_id, 'section-capability');
  assert.strictEqual(paragraph.add[0].action, 'add_sibling');
  assert.strictEqual(paragraph.remove.target_id, 'paragraph-capability');
  assert.strictEqual(item.remove.target_id, 'list-capability');
  assert.strictEqual(
    ResumeDom.manualStructureCapabilities(document, 'name-capability'),
    null,
  );
});

test('固定坐标导入页只允许安全删除，不直接新增造成文字重叠', () => {
  const document = fixture('fixed');
  const root = document.root;
  root.attributes = { class: 'imported-scene-resume' };
  const capability = ResumeDom.manualStructureCapabilities(document, 'paragraph-fixed');

  assert.strictEqual(capability.fixed_layout, true);
  assert.strictEqual(capability.add[0].enabled, false);
  assert.strictEqual(capability.remove.action, 'remove');
  assert.strictEqual(capability.remove.enabled, true);

  const pageDocument = fixture('background-text');
  const section = pageDocument.root.children[1];
  pageDocument.root.children[1] = {
    id: 'fixed-page-background-text',
    type: 'element',
    tag: 'section',
    attributes: {
      class: 'imported-document-page imported-scene-page',
      'data-background-contains-text': 'true',
    },
    semantic: { kind: 'page' },
    children: [section],
  };
  const protectedCapability = ResumeDom.manualStructureCapabilities(
    pageDocument,
    'paragraph-background-text',
  );
  assert.strictEqual(protectedCapability.add[0].enabled, false);
  assert.strictEqual(protectedCapability.remove.enabled, false);
  assert.throws(
    () => compileManualNodeAction(
      pageDocument,
      'remove',
      'paragraph-background-text',
    ),
    (error) => error && error.code === 'FIXED_LAYOUT_ACTION_UNAVAILABLE',
  );
});

test('人工 + 复制完整同级节点，并与文字和 AI 修改共用撤销重做栈', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await createProject(ctx, `add-${Date.now()}`);
  let workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const paragraphId = workspace.draft.resume_json.root.children[1].children[1].id;

  const mutationId = `manual-add-${Date.now()}`;
  const added = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/node-actions`,
    {
      body: {
        expected_revision: workspace.draft.revision,
        mutation_id: mutationId,
        node_id: paragraphId,
        action: 'add_sibling',
      },
    },
  );
  assert.strictEqual(added.status, 200, JSON.stringify(added.body));
  assert.ok(added.body.focus_node_id);
  const inserted = ResumeDom.findNode(added.body.resume_json, added.body.focus_node_id);
  assert.ok(inserted);
  assert.strictEqual(ResumeDom.nodeText(inserted.node), '负责项目推进。');
  assert.strictEqual(inserted.node.semantic.kind, 'paragraph');
  assert.notStrictEqual(inserted.node.id, paragraphId);
  assert.strictEqual(inserted.node.binding, undefined);

  const replayed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/node-actions`,
    {
      body: {
        expected_revision: added.body.revision,
        mutation_id: mutationId,
        node_id: paragraphId,
        action: 'add_sibling',
      },
    },
  );
  assert.strictEqual(replayed.status, 200, JSON.stringify(replayed.body));
  assert.strictEqual(replayed.body.idempotent_replay, true);
  assert.strictEqual(replayed.body.revision, added.body.revision);
  assert.strictEqual(replayed.body.focus_node_id, added.body.focus_node_id);

  const undone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/undo`,
    { idemKey: `manual-add-undo-${Date.now()}` },
  );
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  assert.strictEqual(ResumeDom.findNode(undone.body.resume_json, added.body.focus_node_id), null);

  const redone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/redo`,
    { idemKey: `manual-add-redo-${Date.now()}` },
  );
  assert.strictEqual(redone.status, 200, JSON.stringify(redone.body));
  assert.ok(ResumeDom.findNode(redone.body.resume_json, added.body.focus_node_id));
});

test('标题 - 删除整个模块，标题 + 可新增内容或完整同级模块', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const suffix = `section-${Date.now()}`;
  const projectId = await createProject(ctx, suffix);
  let workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const sectionId = `section-${suffix}`;
  const titleId = `title-${suffix}`;
  const sectionBeforeContent = ResumeDom.findNode(
    workspace.draft.resume_json,
    sectionId,
  ).node;
  const referenceContent = sectionBeforeContent.children.at(-1);

  const content = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/node-actions`,
    {
      body: {
        expected_revision: workspace.draft.revision,
        mutation_id: `manual-section-content-${Date.now()}`,
        node_id: titleId,
        action: 'add_section_content',
      },
    },
  );
  assert.strictEqual(content.status, 200, JSON.stringify(content.body));
  const sectionAfterContent = ResumeDom.findNode(content.body.resume_json, sectionId).node;
  const insertedContent = sectionAfterContent.children.at(-1);
  assert.deepStrictEqual(subtreeShape(insertedContent), subtreeShape(referenceContent));
  assert.strictEqual(
    subtreeIds(insertedContent).some((id) => subtreeIds(referenceContent).includes(id)),
    false,
  );
  assert.strictEqual(
    subtreeIds(insertedContent).includes(content.body.focus_node_id),
    true,
  );

  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const sibling = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/node-actions`,
    {
      body: {
        expected_revision: workspace.draft.revision,
        mutation_id: `manual-section-sibling-${Date.now()}`,
        node_id: titleId,
        action: 'add_section_after',
      },
    },
  );
  assert.strictEqual(sibling.status, 200, JSON.stringify(sibling.body));
  const newTitle = ResumeDom.findNode(sibling.body.resume_json, sibling.body.focus_node_id);
  assert.ok(newTitle);
  assert.strictEqual(newTitle.node.semantic.kind, 'section_title');
  assert.notStrictEqual(newTitle.parent.id, sectionId);
  const sourceSection = ResumeDom.findNode(sibling.body.resume_json, sectionId).node;
  assert.deepStrictEqual(subtreeShape(newTitle.parent), subtreeShape(sourceSection));
  assert.strictEqual(
    subtreeIds(newTitle.parent).some((id) => subtreeIds(sourceSection).includes(id)),
    false,
  );

  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const removed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/node-actions`,
    {
      body: {
        expected_revision: workspace.draft.revision,
        mutation_id: `manual-section-remove-${Date.now()}`,
        node_id: titleId,
        action: 'remove',
      },
    },
  );
  assert.strictEqual(removed.status, 200, JSON.stringify(removed.body));
  assert.strictEqual(ResumeDom.findNode(removed.body.resume_json, sectionId), null);

  const undone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/undo`,
    { idemKey: `manual-section-remove-undo-${Date.now()}` },
  );
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  assert.ok(ResumeDom.findNode(undone.body.resume_json, sectionId));
});

test('新增同级模块递归复制任意深度的文字、样式和结构，并刷新全部节点 ID', () => {
  const document = fixture('recursive-section');
  const section = document.root.children[1];
  section.children[1].style = { color: '#164D7A', 'font-size': '10pt' };
  section.children[2].children[0].children = [{
    id: 'recursive-inline',
    type: 'element',
    tag: 'span',
    text: '服务120家客户。',
    style: { 'font-weight': '700' },
  }];
  delete section.children[2].children[0].text;
  const compiled = compileManualNodeAction(
    document,
    'add_section_after',
    'title-recursive-section',
  );
  const duplicate = compiled.operations[0].node;
  assert.deepStrictEqual(subtreeShape(duplicate), subtreeShape(section));
  const sourceIds = new Set(subtreeIds(section));
  assert.strictEqual(subtreeIds(duplicate).some((id) => sourceIds.has(id)), false);
  assert.strictEqual(
    ResumeDom.nodeText(duplicate),
    ResumeDom.nodeText(section),
  );
});
