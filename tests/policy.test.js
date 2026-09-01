'use strict';
const test = require('node:test');
const assert = require('node:assert');

const helpers = require('./helpers');
const db = require('../server/lib/db');
const policy = require('../server/lib/policy');
const { withIdempotency } = require('../server/lib/idempotency');

let ctx;
let user;
let projectId;

test.before(async () => {
  ctx = await helpers.boot();
  user = db.get("SELECT * FROM users WHERE email = 'demo@resume-planet.local'");
  projectId = await helpers.defaultProject(ctx);
});
test.after(() => helpers.close(ctx));

test('动作协议只接受三种独立提案', () => {
  assert.deepStrictEqual([...policy.ACTION_TYPES].sort(), [
    'JOB_SET_CURRENT_PROPOSAL',
    'PROFILE_SAVE_PROPOSAL',
    'RESUME_REWRITE_PROPOSAL',
  ]);
  const validation = policy.validateModelResponse({
    reply: '已准备好。',
    actions: [
      {
        type: 'RESUME_REWRITE_PROPOSAL',
        requires_user_action: false,
        payload: { proposal: { original: 'A', suggestion: 'B' } },
      },
    ],
  });
  assert.strictEqual(validation.actions.length, 1);
  assert.strictEqual(validation.actions[0].requires_user_action, true);
  assert.strictEqual(policy.decideAction(validation.actions[0]).outcome, 'await_confirm');
});

test('未知动作与旧候选事实动作均 fail-closed', () => {
  for (const type of ['FACT_CANDIDATE', 'PROFILE_FIELD_UPDATE', 'NO_OP', 'DROP_TABLE']) {
    const validation = policy.validateModelResponse({
      reply: 'ok',
      actions: [{ type, payload: {} }],
    });
    assert.strictEqual(validation.actions.length, 0);
    assert.strictEqual(validation.rejected.length, 1);
  }
});

test('来源、证据和依赖字段在任意层级都被拒绝', () => {
  for (const forbidden of ['evidence', 'source_item_id', 'dependency_fact_ids']) {
    const validation = policy.validateModelResponse({
      reply: 'ok',
      actions: [{
        type: 'RESUME_REWRITE_PROPOSAL',
        payload: { proposal: { original: 'A', suggestion: 'B', [forbidden]: ['x'] } },
      }],
    });
    assert.strictEqual(validation.actions.length, 0, forbidden);
    assert.match(validation.rejected[0].reason, /不允许的内容关系字段/);
  }
});

test('资料保存提案确认后才写入，并可撤销', () => {
  const { profile } = policy.loadProfileBasics(projectId, user);
  const actionId = insertAction('PROFILE_SAVE_PROPOSAL');
  const applied = policy.executeProfileFieldUpdate({
    user,
    profile,
    field: 'city',
    value: '杭州',
    actionRequestId: actionId,
  });
  assert.strictEqual(applied.changed, true);
  assert.strictEqual(policy.loadProfileBasics(projectId, user).basics.city, '杭州');

  const reverted = policy.revertAction({ user, actionRequestId: actionId });
  assert.strictEqual(reverted.status, 'reverted');
  assert.strictEqual(policy.loadProfileBasics(projectId, user).basics.city, '上海');
});

test('字段值仍由后端做确定性校验', () => {
  assert.strictEqual(policy.validateFieldValue('phone', '13800008899').ok, true);
  assert.strictEqual(policy.validateFieldValue('phone', '123').ok, false);
  assert.strictEqual(policy.validateFieldValue('email', 'a@b.com').ok, true);
  assert.strictEqual(policy.validateFieldValue('email', 'not-an-email').ok, false);
  assert.strictEqual(policy.validateFieldValue('unknown', 'x').ok, false);
});

test('幂等键不会重复执行', () => {
  let calls = 0;
  const first = withIdempotency(user, 'policy-v2-idem', 'test', () => ({ calls: ++calls }));
  const second = withIdempotency(user, 'policy-v2-idem', 'test', () => ({ calls: ++calls }));
  assert.strictEqual(calls, 1);
  assert.strictEqual(first.calls, second.calls);
  assert.strictEqual(second.idempotent_replay, true);
});

function insertAction(type) {
  const id = `policy-action-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.run(
    `INSERT INTO ai_action_requests
     (id, owner_id, action_type, target_type, payload_json, requires_user_action, status, policy_version, created_at)
     VALUES (?, ?, ?, 'profile_basics', '{}', 1, 'awaiting_confirmation', ?, ?)`,
    [id, user.id, type, policy.POLICY_VERSION, db.nowIso()],
  );
  return id;
}
