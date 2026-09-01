'use strict';

const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = require('../server/lib/db');

let ctx;
let projectId;

const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
const send = (content, scope = {}, extra = {}) =>
  helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: { content, scope_type: scope.type || 'RESUME_DOCUMENT', scope_id: scope.id || null, ...extra },
  });

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});

test.after(() => helpers.close(ctx));

test('P0-28 开始新对话：保留资料和简历，结束旧任务与未应用建议', async () => {
  const before = await workspace();
  const oldConversationId = before.conversation.id;
  const proposalResponse = await send('写得更专业', { type: 'RESUME_BLOCK', id: 'target-bullet' });
  const proposal = proposalResponse.body.actions.find((action) => action.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(proposal);

  const factResponse = await send(
    '这项工作覆盖了 776 家付费客户',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
    { task_id: proposalResponse.body.task_id },
  );
  const factAction = factResponse.body.actions.find((action) => action.action_type === 'FACT_CANDIDATE');
  assert.ok(factAction);
  const factId = factAction.payload.fact_id;

  const jobResponse = await send('我上传了一份新的岗位 JD', { type: 'DATA_JOB' });
  const jobAction = jobResponse.body.actions.find((action) => action.action_type === 'JOB_CANDIDATE');
  assert.ok(jobAction);

  const immediatelyBefore = await workspace();
  const oldMessageCount = db.get(
    'SELECT COUNT(*) AS total FROM ai_messages WHERE conversation_id = ?',
    [oldConversationId],
  ).total;
  const conversationCount = db.get(
    'SELECT COUNT(*) AS total FROM ai_conversations WHERE project_id = ?',
    [projectId],
  ).total;

  const started = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    idemKey: `new-chat-${oldConversationId}`,
  });
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert.notStrictEqual(started.body.id, oldConversationId);
  assert.strictEqual(started.body.pending_facts_preserved >= 1, true);
  assert.strictEqual(started.body.proposals_discarded, 1);
  assert.strictEqual(started.body.job_candidates_discarded, 1);

  const after = await workspace();
  assert.strictEqual(after.conversation.id, started.body.id);
  assert.deepStrictEqual(after.conversation.messages, []);
  assert.deepStrictEqual(after.conversation.tasks, []);
  assert.deepStrictEqual(after.profile, immediatelyBefore.profile);
  assert.deepStrictEqual(after.draft, immediatelyBefore.draft);
  assert.deepStrictEqual(after.versions, immediatelyBefore.versions);
  assert.strictEqual(after.job.id, immediatelyBefore.job.id);
  assert.ok(after.pending_facts.some((fact) => fact.id === factId));

  assert.strictEqual(db.get('SELECT status FROM ai_conversations WHERE id = ?', [oldConversationId]).status, 'closed');
  const task = db.get('SELECT status, active_proposal_id FROM ai_tasks WHERE id = ?', [proposalResponse.body.task_id]);
  assert.strictEqual(task.status, 'canceled');
  assert.strictEqual(task.active_proposal_id, null);
  assert.strictEqual(db.get('SELECT status FROM ai_action_requests WHERE id = ?', [proposal.id]).status, 'rejected');
  assert.strictEqual(db.get('SELECT status FROM ai_action_requests WHERE id = ?', [jobAction.id]).status, 'rejected');
  assert.strictEqual(db.get('SELECT status FROM target_jobs WHERE id = ?', [jobAction.target_id]).status, 'discarded');
  assert.strictEqual(db.get('SELECT status FROM ai_action_requests WHERE id = ?', [factAction.id]).status, 'awaiting_confirmation');
  assert.strictEqual(
    db.get('SELECT COUNT(*) AS total FROM ai_messages WHERE conversation_id = ?', [oldConversationId]).total,
    oldMessageCount,
    '旧消息应保留，不做物理删除',
  );

  const replay = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    idemKey: `new-chat-${oldConversationId}`,
  });
  assert.strictEqual(replay.body.id, started.body.id);
  assert.strictEqual(replay.body.idempotent_replay, true);
  assert.strictEqual(
    db.get('SELECT COUNT(*) AS total FROM ai_conversations WHERE project_id = ?', [projectId]).total,
    conversationCount + 1,
  );

  const confirmed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/facts/${factId}/confirm`, {
    idemKey: `confirm-after-new-chat-${factId}`,
    body: { expected_revision: after.profile.revision },
  });
  assert.strictEqual(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.strictEqual(confirmed.body.proposal, null, '旧对话的表达任务不得被重新唤醒');
  assert.deepStrictEqual((await workspace()).conversation.messages, []);
});
