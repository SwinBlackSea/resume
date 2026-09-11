'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const db = helpers.db;
const harness = require('../server/lib/resume-harness');
const fakeModel = require('./fakes/resume-model-client');
const { compactStorage, compactInlineHistory, RECEIPT } = require('../server/lib/ai-storage');
const { uuidv7, nowIso } = require('../server/lib/util');
let ctx;
let projectId;
let ownerId;
const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
const inline = (extra = {}) => helpers.call(ctx, 'POST', `/projects/${projectId}/ai/inline-rewrites`, {
  body: { target_node_id: 'target-bullet', target_mode: 'node', instruction: '写得更专业', ...extra },
});
function saved(id) {
  return JSON.parse(db.get('SELECT payload_json FROM ai_action_requests WHERE id = ?', [id]).payload_json);
}
test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
  ownerId = db.get('SELECT owner_id FROM resume_projects WHERE id = ?', [projectId]).owner_id;
});
test.after(() => helpers.close(ctx));

test('局部应用后删除完整会话链，保留最小幂等回执和独立撤销/重做', async () => {
  const before = await workspace();
  const first = await inline();
  const second = await inline({ previous_action_id: first.body.action.id, instruction: '继续精简' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  compactInlineHistory(db.getDb());
  assert.ok(saved(first.body.action.id).suggestion, '未完成时保留有效祖先');
  const applied = await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${second.body.action.id}/apply`, {
    idemKey: 'storage-inline-apply',
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  for (const action of [first.body.action, second.body.action]) {
    const payload = saved(action.id);
    assert.equal(payload.format, RECEIPT);
    assert.equal(payload.instruction, undefined);
    assert.equal(payload.suggestion, undefined);
    assert.equal(payload.conversation_memory, undefined);
  }
  const cached = JSON.parse(db.get(
    "SELECT response_json FROM idempotency_keys WHERE key = 'storage-inline-apply'",
  ).response_json);
  assert.equal(cached.resume_json, undefined);
  assert.ok(applied.body.resume_json, '首次响应保持原有完整结果');
  const replay = await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${second.body.action.id}/apply`, {
    idemKey: 'storage-inline-apply',
  });
  assert.equal(replay.body.idempotent_replay, true);
  assert.equal((await workspace()).draft.revision, applied.body.revision);
  const undo = await helpers.call(ctx, 'POST', `/projects/${projectId}/resume-draft/undo`);
  assert.equal(undo.status, 200);
  assert.deepEqual(undo.body.resume_json, before.draft.resume_json);
  const redo = await helpers.call(ctx, 'POST', `/projects/${projectId}/resume-draft/redo`);
  assert.equal(redo.status, 200);
  assert.deepEqual(redo.body.resume_json, applied.body.resume_json);
});

test('关闭局部任务清理历史，重复关闭不报错', async () => {
  const first = await inline();
  const second = await inline({ previous_action_id: first.body.action.id, instruction: '继续调整' });
  const before = await workspace();
  for (let i = 0; i < 2; i += 1) {
    const rejected = await helpers.call(ctx, 'POST', `/ai/inline-rewrites/${second.body.action.id}/reject`);
    assert.equal(rejected.status, 200);
  }
  assert.equal(saved(first.body.action.id).format, RECEIPT);
  assert.equal(saved(second.body.action.id).format, RECEIPT);
  assert.deepEqual((await workspace()).draft, before.draft);
});

test('局部取消先到达时不生成任务，也不调用模型', async () => {
  const token = 'cancel-before-generation';
  const cancel = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/inline-rewrites/cancel`, {
    body: { client_request_id: token },
  });
  assert.equal(cancel.status, 200);
  const result = await inline({ client_request_id: token });
  assert.equal(result.status, 409);
  assert.equal(result.body.title, 'INLINE_REQUEST_CANCELED');
  assert.equal(db.get(
    "SELECT COUNT(*) AS n FROM ai_action_requests WHERE json_extract(payload_json, '$.client_request_id') = ?",
    [token],
  ).n, 0);
});

test('生成中关闭局部任务即删除输入，忽略不响应取消的模型迟到结果', async () => {
  let release;
  let started;
  let signal;
  const ready = new Promise((resolve) => { started = resolve; });
  harness.setModelClientForTests({
    generate(request) {
      signal = request.signal;
      started();
      return new Promise((resolve) => {
        release = async () => resolve(await fakeModel.generate(request));
      });
    },
  });
  try {
    const pending = inline({ client_request_id: 'cancel-during-generation' });
    await ready;
    const action = db.get(
      "SELECT * FROM ai_action_requests WHERE json_extract(payload_json, '$.client_request_id') = 'cancel-during-generation'",
    );
    const canceled = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/inline-rewrites/cancel`, {
      body: { client_request_id: 'cancel-during-generation' },
    });
    assert.equal(canceled.status, 200);
    assert.equal(signal.aborted, true);
    assert.equal(saved(action.id).format, RECEIPT);
    await release();
    const result = await pending;
    assert.equal(result.body.discarded, true);
    assert.equal(saved(action.id).suggestion, undefined);
  } finally {
    harness.setModelClientForTests(fakeModel);
  }
});

test('全局生成期间新建对话，旧输入、任务、迟到输出均不留下', async () => {
  let release;
  let started;
  let signal;
  const ready = new Promise((resolve) => { started = resolve; });
  const before = await workspace();
  harness.setModelClientForTests({
    generate(request) {
      signal = request.signal;
      started();
      return new Promise((resolve) => {
        release = async () => resolve(await fakeModel.generate(request));
      });
    },
  });
  try {
    const pending = helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: { conversation_id: before.conversation.id,
        content: '写得更专业', scope_type: 'RESUME_BLOCK', scope_id: 'target-bullet' },
    });
    await ready;
    const start = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
      body: { conversation_id: before.conversation.id },
    });
    assert.equal(start.status, 200);
    assert.equal(signal.aborted, true);
    await release();
    const late = await pending;
    assert.equal(late.status, 409);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = ?',
      [before.conversation.id]).n, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM ai_tasks WHERE conversation_id = ?',
      [before.conversation.id]).n, 0);
    assert.deepEqual((await workspace()).draft, before.draft);
    assert.deepEqual((await workspace()).versions, before.versions);
  } finally {
    harness.setModelClientForTests(fakeModel);
  }
});

test('存量清理删除关闭会话，保留当前会话、资料撤销回执和有效重做，即使已过七天', async () => {
  const before = await workspace();
  const closedId = uuidv7();
  const actionId = uuidv7();
  const receiptId = uuidv7();
  const eventId = uuidv7();
  db.run(`INSERT INTO ai_conversations(id,project_id,owner_id,status,created_at,updated_at)
    VALUES(?,?,?,'closed',?,?)`, [closedId, projectId, ownerId, nowIso(), nowIso()]);
  db.run(`INSERT INTO ai_action_requests(id,conversation_id,owner_id,action_type,status,payload_json,created_at)
    VALUES(?,?,?,'PROFILE_SAVE_PROPOSAL','applied',?,?)`,
  [actionId, closedId, ownerId, JSON.stringify({ values: { city: '待删除的聊天载荷' } }), nowIso()]);
  db.run(`INSERT INTO change_receipts(id,action_request_id,owner_id,resource_type,resource_id,before_json,after_json,mutation_id,created_at)
    VALUES(?,?,?,'profile_field',?,'{"city":"北京"}','{"city":"上海"}',?,?)`,
  [receiptId, actionId, ownerId, `${before.profile.id}:city`, uuidv7(), nowIso()]);
  // 旧的已撤销记录仍在重做窗口中，不能因为时间过去而删除正文。
  db.run(`INSERT INTO resume_change_events(id,project_id,owner_id,draft_revision,change_type,before_json,after_json,
    mutation_id,created_at,reverted_at) VALUES(?,?,?,999,'document_transaction',?,?,?,'2020-01-01','2020-01-02')`,
  [eventId, projectId, ownerId, '{"text":"保留重做前"}', '{"text":"保留重做后"}', uuidv7()]);
  const protectedEvent = db.get('SELECT * FROM resume_change_events WHERE id = ?', [eventId]);
  const counts = compactStorage(db.getDb());
  assert.equal(counts.conversations, 1);
  db.compactResumeChangeEvents(db.getDb());
  assert.deepEqual(db.get('SELECT * FROM resume_change_events WHERE id = ?', [eventId]), protectedEvent);
  assert.equal(db.get('SELECT conversation_id FROM ai_action_requests WHERE id = ?', [actionId]).conversation_id, null);
  assert.ok(db.get('SELECT * FROM change_receipts WHERE id = ?', [receiptId]));
  assert.equal((await workspace()).conversation.id, before.conversation.id);
  assert.deepEqual((await workspace()).draft.resume_json, before.draft.resume_json);
  assert.deepEqual((await workspace()).versions, before.versions);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  const again = compactStorage(db.getDb());
  assert.equal(again.conversations, 0);
  assert.equal(again.inline_histories, 0);
});

test('超出五步撤销窗口和废弃重做内容清空，但操作行不删除', async () => {
  const firstId = uuidv7();
  for (let i = 0; i < 7; i += 1) {
    db.run(`INSERT INTO resume_change_events(id,project_id,owner_id,draft_revision,change_type,before_json,
      after_json,mutation_id,created_at) VALUES(?,?,?,?,'document_transaction',?,?,?,?)`,
    [i === 0 ? firstId : uuidv7(), projectId, ownerId, 2000 + i,
      '{"text":"旧正文"}', '{"text":"新正文","label":"文字修改"}', uuidv7(), nowIso()]);
  }
  const expired = db.get('SELECT * FROM resume_change_events WHERE id = ?', [firstId]);
  assert.ok(expired.undo_expired_at);
  assert.equal(JSON.parse(expired.before_json).text, undefined);
  assert.equal(JSON.parse(expired.after_json).label, '文字修改');
  const current = db.all(`SELECT * FROM resume_change_events WHERE owner_id = ? AND project_id = ?
    AND undo_expired_at IS NULL AND reverted_at IS NULL AND snapshot_version_id IS NULL`, [ownerId, projectId]);
  assert.equal(current.length, 5);
  assert.ok(current.every((row) => JSON.parse(row.before_json).text === '旧正文'));
});
