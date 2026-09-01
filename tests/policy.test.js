'use strict';
/**
 * Policy Engine 单元测试（TECH §15「AI 行为契约测试」）。
 * 使用固定结构化动作，不调用模型，验证动作矩阵、字段白名单、证据要求、
 * revision、幂等、撤销和 fail-closed。
 */
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

test('白名单字段：明确更正且校验通过时执行并生成回执', () => {
  const { profile, basics } = policy.loadProfileBasics(projectId, user);
  const decision = policy.decideAction(
    {
      type: 'PROFILE_FIELD_UPDATE',
      field_path: 'city',
      payload: { field: 'city', value: '杭州', explicit: true },
      expected_revision: profile.revision,
    },
    { profileRevision: profile.revision, profileBefore: basics },
  );
  assert.strictEqual(decision.outcome, 'execute');
  assert.strictEqual(decision.field, 'city');
  assert.strictEqual(decision.value, '杭州');

  // 执行并校验回执
  const actionId = insertAction({ action_type: 'PROFILE_FIELD_UPDATE' });
  const result = policy.executeProfileFieldUpdate({
    user,
    project: db.get('SELECT * FROM resume_projects WHERE id = ?', [projectId]),
    profile,
    field: 'city',
    value: '杭州',
    actionRequestId: actionId,
  });
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.before, '上海');
  assert.strictEqual(result.after, '杭州');

  // 撤销恢复旧值
  const reverted = policy.revertAction({ user, actionRequestId: actionId });
  assert.strictEqual(reverted.status, 'reverted');
  assert.strictEqual(reverted.before, '上海');
  const after = policy.loadProfileBasics(projectId, user);
  assert.strictEqual(after.basics.city, '上海');
});

test('非白名单字段：转为待确认事实，不直接写入', () => {
  const { profile, basics } = policy.loadProfileBasics(projectId, user);
  const decision = policy.decideAction(
    {
      type: 'PROFILE_FIELD_UPDATE',
      field_path: 'years',
      payload: { field: 'years', value: 8, explicit: true },
      expected_revision: profile.revision,
    },
    { profileRevision: profile.revision, profileBefore: basics },
  );
  assert.strictEqual(decision.outcome, 'await_confirm');
  assert.strictEqual(decision.convertTo, 'FACT_CANDIDATE');
});

test('未知动作类型：拒绝且零写入（fail-closed，P0-12）', () => {
  const { profile, basics } = policy.loadProfileBasics(projectId, user);
  const decision = policy.decideAction(
    { type: 'DELETE_EVERYTHING', payload: {} },
    { profileRevision: profile.revision, profileBefore: basics },
  );
  assert.strictEqual(decision.outcome, 'reject');

  const validation = policy.validateModelResponse({
    reply: '已保存',
    actions: [{ type: 'DROP_TABLE', payload: {} }],
  });
  assert.strictEqual(validation.rejected.length, 1);
  assert.strictEqual(validation.actions.length, 0);
});

test('事实类动作缺少证据：拒绝，不进入业务层', () => {
  const validation = policy.validateModelResponse({
    reply: 'ok',
    actions: [{ type: 'FACT_CANDIDATE', payload: { value: '1' }, evidence_ids: [] }],
  });
  assert.strictEqual(validation.actions.length, 0);
  assert.strictEqual(validation.rejected.length, 1);
});

test('requires_confirmation 被模型置为 false 时强制纠正', () => {
  const validation = policy.validateModelResponse({
    reply: 'ok',
    actions: [
      { type: 'FACT_CANDIDATE', payload: {}, requires_confirmation: false, evidence_ids: ['msg-1'] },
    ],
  });
  assert.strictEqual(validation.actions.length, 1);
  assert.strictEqual(validation.actions[0].requires_confirmation, true);
});

test('expected_revision 冲突：拒绝并要求重新确认（P0-14）', () => {
  const { profile, basics } = policy.loadProfileBasics(projectId, user);
  const decision = policy.decideAction(
    {
      type: 'PROFILE_FIELD_UPDATE',
      field_path: 'city',
      payload: { field: 'city', value: '北京', explicit: true },
      expected_revision: profile.revision + 99,
    },
    { profileRevision: profile.revision, profileBefore: basics },
  );
  assert.strictEqual(decision.outcome, 'reject');
  assert.strictEqual(decision.reason, 'REVISION_CONFLICT');
});

test('动作矩阵：NO_OP 与 TEMPORARY_CONTEXT 仅回复，不持久化', () => {
  const { profile, basics } = policy.loadProfileBasics(projectId, user);
  const noop = policy.decideAction({ type: 'NO_OP' }, { profileRevision: profile.revision, profileBefore: basics });
  const temp = policy.decideAction({ type: 'TEMPORARY_CONTEXT' }, { profileRevision: profile.revision, profileBefore: basics });
  assert.strictEqual(noop.outcome, 'reply_only');
  assert.strictEqual(temp.outcome, 'reply_only');
});

test('幂等：相同 Idempotency-Key 只执行一次（P0-15）', () => {
  let calls = 0;
  const first = withIdempotency(user, 'unit-test-key', 'test', () => {
    calls += 1;
    return { id: 'fixed-id', calls };
  });
  const second = withIdempotency(user, 'unit-test-key', 'test', () => {
    calls += 1;
    return { id: 'another-id', calls };
  });
  assert.strictEqual(calls, 1, '第二次调用不应执行');
  assert.strictEqual(first.id, second.id);
  assert.strictEqual(second.idempotent_replay, true);
});

test('字段校验：手机号与邮箱格式', () => {
  assert.strictEqual(policy.validateFieldValue('phone', '13800008899').ok, true);
  assert.strictEqual(policy.validateFieldValue('phone', '123').ok, false);
  assert.strictEqual(policy.validateFieldValue('email', 'a@b.com').ok, true);
  assert.strictEqual(policy.validateFieldValue('email', 'not-an-email').ok, false);
  assert.strictEqual(policy.validateFieldValue('city', '上海').ok, true);
});

/** 插入一条测试用动作请求。 */
function insertAction({ action_type, target_id = null }) {
  const id = `test-action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  db.run(
    `INSERT INTO ai_action_requests (id, conversation_id, message_id, owner_id, action_type, target_type, target_id, payload_json, evidence_json, requires_confirmation, status, policy_version, created_at)
     VALUES (?, NULL, NULL, ?, ?, 'profile_basics', ?, '{}', '[]', 0, 'proposed', ?, ?)`,
    [id, user.id, action_type, target_id, policy.POLICY_VERSION, db.nowIso()],
  );
  return id;
}
