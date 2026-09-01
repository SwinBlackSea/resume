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
    body: {
      content,
      scope_type: scope.type || 'RESUME_DOCUMENT',
      scope_id: scope.id || null,
      ...extra,
    },
  });

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});
test.after(() => helpers.close(ctx));

test('数据模型不包含内容来源、证据映射或候选事实表', async () => {
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  assert.ok(!tables.includes('fact_candidates'));
  const actionColumns = db.all('PRAGMA table_info(ai_action_requests)').map((row) => row.name);
  assert.ok(!actionColumns.includes('evidence_json'));
  assert.ok(!actionColumns.includes('confidence'));

  const ws = await workspace();
  assert.strictEqual(Object.hasOwn(ws, 'pending_facts'), false);
  assert.strictEqual(JSON.stringify(ws.draft.resume_json).includes('source_item_ids'), false);
  assert.strictEqual(JSON.stringify(ws.draft.resume_json).includes('evidence_map'), false);
});

test('用户在对话中明确提供的新数据可直接进入简历建议，资料不自动变化', async () => {
  const before = await workspace();
  const res = await send(
    '我带领 20 人团队，把它写进简历',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const rewrite = res.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(rewrite);
  assert.match(rewrite.payload.proposal.suggestion, /20\s*人/);
  assert.ok(!res.body.actions.some((item) => item.action_type === 'PROFILE_SAVE_PROPOSAL'));
  assert.deepStrictEqual((await workspace()).profile, before.profile);
});

test('“改成 2 个段落”由模型理解为结构改写，不触发资料动作', async () => {
  const res = await send(
    '我是说把当前一个段落改成 2 个段落',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(res.body.actions.map((item) => item.action_type), ['RESUME_REWRITE_PROPOSAL']);
  assert.match(res.body.actions[0].payload.proposal.suggestion, /\n/);
});

test('保存到资料需要明确的独立提案和用户确认', async () => {
  const before = await workspace();
  const res = await send('把所在城市改为杭州并保存到资料', { type: 'DATA_PROFILE' });
  const action = res.body.actions.find((item) => item.action_type === 'PROFILE_SAVE_PROPOSAL');
  assert.ok(action, JSON.stringify(res.body));
  assert.strictEqual((await workspace()).profile.basics.city, before.profile.basics.city);

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `profile-save-${action.id}`,
    body: { expected_revision: before.profile.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual((await workspace()).profile.basics.city, '杭州');
});

test('同一轮可同时提出资料保存和简历修改，但二者互不代替', async () => {
  const before = await workspace();
  const res = await send(
    '写得更专业，并把城市改为北京保存到资料',
    { type: 'RESUME_BLOCK', id: 'target-bullet' },
  );
  const types = res.body.actions.map((item) => item.action_type).sort();
  assert.deepStrictEqual(types, ['PROFILE_SAVE_PROPOSAL', 'RESUME_REWRITE_PROPOSAL']);
  assert.strictEqual((await workspace()).profile.basics.city, before.profile.basics.city);
  assert.strictEqual((await workspace()).draft.revision, before.draft.revision);

  const rewrite = res.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
  await helpers.call(ctx, 'POST', `/ai/actions/${rewrite.id}/apply`, {
    idemKey: `rewrite-only-${rewrite.id}`,
    body: { expected_revision: before.draft.revision },
  });
  const afterRewrite = await workspace();
  assert.ok(afterRewrite.draft.revision > before.draft.revision);
  assert.strictEqual(afterRewrite.profile.basics.city, before.profile.basics.city);
});

test('岗位变化是独立提案，确认前不切换当前岗位', async () => {
  const before = await workspace();
  const res = await send(
    '设为当前岗位，岗位内容：负责 AI 产品规划与商业化落地，要求 5 年产品经验。',
    { type: 'DATA_JOB' },
  );
  const action = res.body.actions.find((item) => item.action_type === 'JOB_SET_CURRENT_PROPOSAL');
  assert.ok(action, JSON.stringify(res.body));
  assert.strictEqual((await workspace()).job.id, before.job.id);

  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `job-set-${action.id}`,
    body: { expected_revision: before.project.revision },
  });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.notStrictEqual((await workspace()).job.id, before.job.id);
});

test('持久化动作中不出现被禁止的关系字段', () => {
  const rows = db.all('SELECT payload_json FROM ai_action_requests');
  rows.forEach((row) => {
    const payload = JSON.parse(row.payload_json || '{}');
    const text = JSON.stringify(payload);
    for (const key of ['evidence', 'source_item_id', 'source_item_ids', 'dependency_fact_ids']) {
      assert.strictEqual(text.includes(`"${key}"`), false, key);
    }
  });
});
