'use strict';
const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = require('../server/lib/db');

let ctx;
let projectId;
const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});
test.after(() => helpers.close(ctx));

test('开始新对话保留三类工作区对象，并使旧未应用动作失效', async () => {
  const before = await workspace();
  const oldConversationId = before.conversation.id;
  const proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '写得更专业',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'target-bullet',
      conversation_id: oldConversationId,
    },
  });
  const action = proposed.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(action);
  const immediatelyBefore = await workspace();

  const started = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    idemKey: `new-chat-${oldConversationId}`,
    body: { conversation_id: oldConversationId },
  });
  assert.strictEqual(started.status, 200, JSON.stringify(started.body));
  assert.notStrictEqual(started.body.id, oldConversationId);
  assert.strictEqual(started.body.pending_actions_discarded, 1);

  const after = await workspace();
  assert.deepStrictEqual(after.conversation.messages, []);
  assert.deepStrictEqual(after.conversation.tasks, []);
  assert.deepStrictEqual(after.profile, immediatelyBefore.profile);
  assert.deepStrictEqual(after.draft, immediatelyBefore.draft);
  assert.deepStrictEqual(after.versions, immediatelyBefore.versions);
  assert.strictEqual(after.job.id, immediatelyBefore.job.id);
  assert.strictEqual(db.get('SELECT status FROM ai_conversations WHERE id = ?', [oldConversationId]).status, 'closed');
  assert.strictEqual(db.get('SELECT status FROM ai_action_requests WHERE id = ?', [action.id]).status, 'rejected');

  const oldView = await helpers.call(
    ctx,
    'GET',
    `/projects/${projectId}?conversation_id=${encodeURIComponent(oldConversationId)}`,
  );
  assert.strictEqual(oldView.status, 200, JSON.stringify(oldView.body));
  assert.strictEqual(oldView.body.conversation.id, oldConversationId);
  assert.strictEqual(oldView.body.conversation.status, 'closed');
  assert.ok(oldView.body.conversation.messages.length >= 2);

  const cannotContinueClosed = await helpers.call(
    ctx,
    'POST',
    `/projects/${projectId}/ai/messages`,
    {
      body: {
        conversation_id: oldConversationId,
        content: '继续旧对话',
        scope_type: 'RESUME_DOCUMENT',
      },
    },
  );
  assert.strictEqual(cannotContinueClosed.status, 409);
  assert.strictEqual(cannotContinueClosed.body.title, 'CONVERSATION_ENDED');

  const replay = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    idemKey: `new-chat-${oldConversationId}`,
    body: { conversation_id: oldConversationId },
  });
  assert.strictEqual(replay.body.id, started.body.id);
  assert.strictEqual(replay.body.idempotent_replay, true);
});
