'use strict';

const test = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
const ResumeDom = require('../resume-dom');

test('当前简历统一支持最近五步撤销与重做，并在新修改后清空重做分支', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  let workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const nodeId = 'target-bullet';
  const original = ResumeDom.nodeText(
    ResumeDom.findNode(workspace.draft.resume_json, nodeId).node,
  );

  for (let step = 1; step <= 6; step += 1) {
    const result = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/transactions`,
      {
        body: {
          expected_revision: workspace.draft.revision,
          mutation_id: `history-edit-${step}-${Date.now()}`,
          operations: [{
            op: 'replace_text',
            node_id: nodeId,
            text: `${original} · 第${step}次`,
          }],
          scope_id: nodeId,
          label: `第${step}次修改`,
        },
      },
    );
    assert.strictEqual(result.status, 200, JSON.stringify(result.body));
    workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  }

  assert.strictEqual(workspace.draft.undo_stack.length, 5);
  assert.strictEqual(workspace.draft.undo_stack[0].label, '第6次修改');
  assert.strictEqual(workspace.draft.undo_stack[4].label, '第2次修改');

  for (let step = 0; step < 5; step += 1) {
    const undone = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/undo`,
      { idemKey: `history-undo-${step}-${Date.now()}` },
    );
    assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  }
  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(workspace.draft.resume_json, nodeId).node),
    `${original} · 第1次`,
  );
  assert.strictEqual(workspace.draft.undo_stack.length, 0);
  assert.strictEqual(workspace.draft.redo_stack.length, 5);

  const beyondLimit = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/undo`,
    { idemKey: `history-undo-limit-${Date.now()}` },
  );
  assert.strictEqual(beyondLimit.status, 409);
  assert.strictEqual(beyondLimit.body.title, 'NOTHING_TO_UNDO');

  for (let step = 0; step < 5; step += 1) {
    const redone = await helpers.call(
      ctx,
      'POST',
      `/projects/${projectId}/resume-draft/redo`,
      { idemKey: `history-redo-${step}-${Date.now()}` },
    );
    assert.strictEqual(redone.status, 200, JSON.stringify(redone.body));
  }
  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.strictEqual(
    ResumeDom.nodeText(ResumeDom.findNode(workspace.draft.resume_json, nodeId).node),
    `${original} · 第6次`,
  );

  const undone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/undo`,
    { idemKey: `history-branch-undo-${Date.now()}` },
  );
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const branched = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/transactions`,
    {
      body: {
        expected_revision: workspace.draft.revision,
        mutation_id: `history-branch-edit-${Date.now()}`,
        operations: [{
          op: 'replace_text',
          node_id: nodeId,
          text: `${original} · 新分支`,
        }],
        scope_id: nodeId,
        label: '新分支修改',
      },
    },
  );
  assert.strictEqual(branched.status, 200, JSON.stringify(branched.body));
  workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.strictEqual(workspace.draft.redo_stack.length, 0);
  const invalidRedo = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/redo`,
    { idemKey: `history-invalid-redo-${Date.now()}` },
  );
  assert.strictEqual(invalidRedo.status, 409);
  assert.strictEqual(invalidRedo.body.title, 'NOTHING_TO_REDO');
});

test('AI 新增和删除类结构事务可以通过同一撤销/重做入口双向恢复', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '新增一个海外经历模块，内容：参与跨国团队协作',
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
    idemKey: `history-structure-apply-${action.id}`,
    body: { expected_revision: action.expected_revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.ok(ResumeDom.findNode(applied.body.resume_json, 'section-overseas'));

  const undone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/undo`,
    { idemKey: `history-structure-undo-${Date.now()}` },
  );
  assert.strictEqual(undone.status, 200, JSON.stringify(undone.body));
  assert.strictEqual(ResumeDom.findNode(undone.body.resume_json, 'section-overseas'), null);

  const redone = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/resume-draft/redo`,
    { idemKey: `history-structure-redo-${Date.now()}` },
  );
  assert.strictEqual(redone.status, 200, JSON.stringify(redone.body));
  assert.ok(ResumeDom.findNode(redone.body.resume_json, 'section-overseas'));
});
