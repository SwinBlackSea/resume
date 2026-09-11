'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const R = require('../resume-dom');
const { uuidv7 } = require('../server/lib/util');
const { retainReapply, readReapply } = require('../server/lib/proposal-reapply');
const { fictionalDocument } = require('../server/scripts/global-ai-cases');

test('再次应用执行材料压缩保存且校验完整性', () => {
  const proposal = { base_resume_json: fictionalDocument(), target_resume_document: fictionalDocument() };
  retainReapply(proposal);
  assert.ok(proposal.reapply_material.data.length < JSON.stringify(proposal.base_resume_json).length);
  const expected = { base: proposal.base_resume_json, target: proposal.target_resume_document };
  delete proposal.base_resume_json; delete proposal.target_resume_document;
  assert.deepEqual(readReapply(proposal), expected);
  proposal.reapply_material.digest = 'bad';
  assert.throws(() => readReapply(proposal), /校验/);
  assert.equal(readReapply({}), null);
});

test('已应用建议超过五步仍可再次应用；保留独立手改、幂等、撤销及会话隔离', async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const workspace = async () => (await helpers.call(ctx, 'GET', '/projects/' + id)).body;
  const original = await workspace();
  t.after(harness.setModelClientForTests({ async generate() {
    return { output: { type: 'proposal', content: '准备好了', proposal: {
      target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [],
        changes: [{ target_id: 'target-bullet', replacement_subtree: { id: 'target-bullet', text: '保留这版建议' } }] },
      change_constraints: { content: 'modify', structure: 'preserve', style: 'preserve',
        content_order: 'preserve', allowed_region_ids: [original.draft.resume_json.root.id] },
    } } };
  } }));
  const generated = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, { body: {
    content: '把目标段落改成保留这版建议', conversation_id: original.conversation.id,
  } });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  const action = generated.body.actions.find(a => a.action_type === 'RESUME_REWRITE_PROPOSAL');
  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, { body: {}, idemKey: uuidv7() });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const independent = [];
  (function visit(n) { if (n.editable && n.id !== 'target-bullet') independent.push(n.id); (n.children || []).forEach(visit); })(original.draft.resume_json.root);
  const independentId = independent.find(node => R.findNode(original.draft.resume_json, node).node.tag === 'p') || independent[0];
  for (let i = 0; i < 7; i++) {
    const ws = await workspace();
    const changed = await helpers.call(ctx, 'POST', `/projects/${id}/resume-draft/transactions`, { body: {
      expected_revision: ws.draft.revision, mutation_id: uuidv7(),
      operations: [{ op: 'replace_text', node_id: i === 6 ? independentId : 'target-bullet', text: '新的手改' + i }],
    } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  const before = await workspace();
  assert.equal(before.draft.undo_stack.length, 5);
  const view = before.conversation.messages.flatMap(m => m.actions).find(a => a?.id === action.id);
  assert.equal(view.can_reapply, true);
  assert.equal(view.payload.proposal.reapply_material, undefined);
  const preview = await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(R.plainText(preview.body.target_resume_document), /保留这版建议/);
  assert.match(R.plainText(preview.body.target_resume_document), /新的手改6/);
  assert.equal(preview.body.preview_revision, before.draft.revision);
  const outdated = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reapply`, {
    body: { expected_revision: before.draft.revision, preview_revision: before.draft.revision - 1 }, idemKey: uuidv7(),
  });
  assert.equal(outdated.status, 409);
  assert.equal(outdated.body.title, 'PREVIEW_OUTDATED');
  assert.deepEqual((await workspace()).draft.resume_json, before.draft.resume_json);
  const key = uuidv7();
  const reapplied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reapply`, {
    body: { expected_revision: before.draft.revision, preview_revision: preview.body.preview_revision }, idemKey: key,
  });
  assert.equal(reapplied.status, 200, JSON.stringify(reapplied.body));
  const after = await workspace();
  assert.deepEqual(after.draft.resume_json, preview.body.target_resume_document);
  assert.equal(R.nodeText(R.findNode(after.draft.resume_json, 'target-bullet').node), '保留这版建议');
  assert.equal(R.nodeText(R.findNode(after.draft.resume_json, independentId).node), '新的手改6');
  assert.equal(after.draft.revision, before.draft.revision + 1);
  const replay = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reapply`, {
    body: { expected_revision: before.draft.revision }, idemKey: key,
  });
  assert.equal(replay.status, 200);
  assert.equal((await workspace()).draft.revision, after.draft.revision);
  const undo = await helpers.call(ctx, 'POST', `/projects/${id}/resume-draft/undo`, { body: {} });
  assert.equal(undo.status, 200);
  assert.deepEqual((await workspace()).draft.resume_json, before.draft.resume_json);
  const stale = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reapply`, {
    body: { expected_revision: 0 }, idemKey: uuidv7(),
  });
  assert.equal(stale.status, 409);
  const forbidden = await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview`, { user: 'not-owner' });
  assert.ok([401, 404].includes(forbidden.status));
  // An old compacted suggestion must fail explicitly, never reconstruct layout from text.
  const raw = helpers.db.get('SELECT payload_json FROM ai_action_requests WHERE id = ?', [action.id]);
  const payload = JSON.parse(raw.payload_json); delete payload.proposal.reapply_material;
  helpers.db.run('UPDATE ai_action_requests SET payload_json = ? WHERE id = ?', [JSON.stringify(payload), action.id]);
  const expired = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/reapply`, {
    body: { expected_revision: (await workspace()).draft.revision }, idemKey: uuidv7(),
  });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.title, 'PROPOSAL_MATERIAL_EXPIRED');
});
