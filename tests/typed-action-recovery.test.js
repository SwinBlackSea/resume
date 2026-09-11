'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const { GLOBAL_RESPONSE_SCHEMA } = require('../server/lib/resume-harness/output-json-schema');
const { decodeGlobalStructuredOutput } = require('../server/lib/resume-harness/structured-envelope');
const { normalizeModelOutput } = require('../server/lib/resume-harness/output-schema');
const { buildActionRecovery, restoreIndependentActions } = require('../server/lib/resume-harness/action-recovery');
const { openBrowser, available } = require('./browser-driver');

function envelope(resume = null, actions = []) {
  return { type: 'proposal', content: '中文修改建议已准备好。', awaiting_user: false,
    message_kind: null, quick_replies: [], resume_proposal: resume, data_actions: actions };
}
function job(payload = { title: '产品经理', company: '测试公司', confirmed_text: '负责产品需求、跨团队协作与交付。' }) {
  return { type: 'JOB_SET_CURRENT_PROPOSAL', target_id: null, payload };
}
function profile(payload = { field: 'city', value: '上海' }) {
  return { type: 'PROFILE_SAVE_PROPOSAL', target_id: null, payload };
}
function resume() {
  return { changes: [{ target_id: 'target-bullet',
    replacement_json: JSON.stringify({ id: 'target-bullet', text: '负责产品规划与团队协作，推动项目交付。' }) }],
  insertions: [], target_document_json: null, change_constraints: {
    content: 'modify', structure: 'preserve', style: 'preserve',
    content_order: 'preserve', allowed_region_ids: ['resume-root'],
  } };
}

test('供应商 Schema 在字段层约束岗位正文和资料字段，不再接受任意 payload_json 字符串', () => {
  assert.equal(GLOBAL_RESPONSE_SCHEMA.name, 'resume_assistant_response_v3');
  const variants = GLOBAL_RESPONSE_SCHEMA.schema.properties.data_actions.items.anyOf;
  for (const type of variants) {
    assert.equal(type.additionalProperties, false);
    assert.equal(type.properties.payload.type, 'object');
    assert.equal(type.properties.payload.additionalProperties, false);
    assert.equal(type.properties.payload_json, undefined);
  }
  assert.ok(variants[0].properties.payload.required.includes('confirmed_text'));
  assert.equal(variants[0].properties.payload.properties.confirmed_text.minLength, 1);
  const decoded = decodeGlobalStructuredOutput(envelope(null, [job(), profile()]));
  assert.equal(decoded.actions[0].payload.confirmed_text, job().payload.confirmed_text);
  assert.deepEqual(decoded.actions[1].payload, { operation: 'update_basics', values: { city: '上海' } });
});

test('独立动作恢复拒绝丢弃、更改已通过动作或新增动作，不猜测用户意图', () => {
  const response = normalizeModelOutput(decodeGlobalStructuredOutput(envelope(resume(), [job({})])),
    { type: 'RESUME_DOCUMENT', id: null });
  const recovery = buildActionRecovery(response, [{ code: 'ACTION_INVALID', action_index: 0 }]);
  assert.ok(recovery);
  assert.equal(recovery.schema.schema.properties.resume_proposal.type, 'null');
  const fixed = normalizeModelOutput(decodeGlobalStructuredOutput(envelope(null, [job()])),
    { type: 'RESUME_DOCUMENT', id: null });
  assert.deepEqual(restoreIndependentActions(fixed, recovery), []);
  assert.deepEqual(fixed.actions[1], response.actions[1]);
  const dropped = { result_type: 'MESSAGE', actions: [] };
  assert.match(restoreIndependentActions(dropped, recovery)[0], /不能丢弃/);
  const changed = structuredClone(response);
  changed.actions[1].payload.proposal.target_resume_fragments.changes[0].replacement_subtree.text = '改坏已保留的中文';
  assert.match(restoreIndependentActions(changed, recovery)[0], /改写/);
  const extra = { result_type: 'PROPOSAL', actions: [...fixed.actions, fixed.actions[0]] };
  assert.match(restoreIndependentActions(extra, recovery)[0], /遗漏或增加/);
});

let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => helpers.close(ctx));
async function setup() {
  const id = await helpers.defaultProject(ctx);
  const source = (await helpers.call(ctx, 'GET', '/projects/' + id)).body;
  const created = await helpers.call(ctx, 'POST', '/projects', {
    body: { copy_project_id: id, copy_draft_revision: source.draft.revision },
  });
  return (await helpers.call(ctx, 'GET', '/projects/' + created.body.id)).body;
}

for (const broken of ['missing', 'empty', 'wrong-type', 'profile', 'resume']) {
  test(`失败动作单独恢复：${broken}；正确动作不重生成，最终批次原子保存`, async (t) => {
    const before = await setup(), requests = [];
    const badJobs = { missing: { title: '产品经理', company: '' },
      empty: { title: '', company: '', confirmed_text: '  ' },
      'wrong-type': { title: '', company: '', confirmed_text: { text: '岗位描述' } } };
    let firstResume = resume();
    if (broken === 'resume') firstResume.changes[0].target_id = 'missing-node';
    const first = envelope(firstResume, [broken === 'profile'
      ? profile({ field: 'city' }) : job(badJobs[broken] || undefined)]);
    t.after(harness.setModelClientForTests({ async generate(options) {
      requests.push(options);
      return { output: requests.length === 1 ? structuredClone(first)
        : broken === 'resume' ? envelope(resume())
          : envelope(null, [broken === 'profile' ? profile() : job()]),
      strict_schema: true, finish_reason: 'stop' };
    } }));
    const result = await helpers.call(ctx, 'POST', `/projects/${before.project.id}/ai/messages`, {
      body: { content: '中英混杂？全部改成中文', conversation_id: before.conversation.id },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].outputSchema.name, 'resume_assistant_action_repair_v1');
    assert.equal(requests[1].messages.at(-1).content, '中英混杂？全部改成中文');
    const diagnostic = requests[1].messages.filter((message) => message.role === 'system').at(-1).content;
    if (broken !== 'resume') assert.ok(!diagnostic.includes('负责产品规划与团队协作'), '修复输入不重复已生成简历');
    const actions = result.body.actions;
    assert.equal(actions.length, 2);
    const rewrite = actions.find((action) => action.action_type === 'RESUME_REWRITE_PROPOSAL');
    assert.equal(ResumeDom.nodeText(ResumeDom.findNode(rewrite.payload.proposal.target_resume_document, 'target-bullet').node),
      '负责产品规划与团队协作，推动项目交付。');
    const after = (await helpers.call(ctx, 'GET', '/projects/' + before.project.id)).body;
    assert.deepEqual(after.draft, before.draft);
    assert.deepEqual(after.job, before.job);
    assert.deepEqual(after.profile, before.profile);
    assert.equal(after.conversation.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(after.conversation.messages.filter((message) => message.result_type === 'ERROR').length, 0);
  });
}

test('修复再次无效时整批不写入，不把部分成功假装成整轮完成，也不无限重试', async (t) => {
  const before = await setup();
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate() {
    calls++;
    return { output: envelope(calls === 1 ? resume() : null, [job({ title: '', company: '' })]) };
  } }));
  const result = await helpers.call(ctx, 'POST', `/projects/${before.project.id}/ai/messages`, {
    body: { content: '请修改简历，并提供岗位建议' },
  });
  assert.equal(result.status, 422);
  assert.equal(calls, 2);
  assert.equal(result.body.title, 'PROPOSAL_NOT_EXECUTABLE');
  assert.match(result.body.detail, /岗位建议不完整/);
  const after = (await helpers.call(ctx, 'GET', '/projects/' + before.project.id)).body;
  assert.deepEqual(after.draft, before.draft);
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.job, before.job);
  assert.equal(after.conversation.messages.flatMap((message) => message.actions).filter(Boolean).length, 0);
  const failed = helpers.db.get(`SELECT model_metadata_json FROM ai_messages WHERE conversation_id=?
    AND json_extract(model_metadata_json,'$.result_type')='ERROR'`, [before.conversation.id]);
  const diagnostic = JSON.parse(failed.model_metadata_json).failure_diagnostics;
  assert.equal(diagnostic.repair_count, 1);
  assert.ok(diagnostic.issues.some((item) => item.action_type === 'JOB_SET_CURRENT_PROPOSAL'));
  assert.ok(!JSON.stringify(diagnostic).includes('完整岗位描述'), '故障记录仅保存无正文诊断');
});

test('真实浏览器：翻译建议附带不完整岗位动作，自动恢复后一次预览、应用、撤销', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await setup();
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate() {
    return { output: ++calls === 1 ? envelope(resume(), [job({ title: '产品经理', company: '' })])
      : envelope(null, [job()]), strict_schema: true };
  } }));
  const { evaluate, until, click, errors } = await openBrowser(t,
    ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  await evaluate(`document.querySelector('#prompt').value='中英混杂？全部改成中文';sendPrompt();`);
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(calls, 2, '一次用户发送，内部只补全失败岗位动作');
  assert.equal(await evaluate('WS.conversation.messages.filter(m=>m.role==="user").length'), 1);
  assert.equal(await evaluate('document.querySelector("#chat-messages").textContent.includes("这次请求没有成功")'), false);
  await click('.chat-proposal .replace');
  await until(`WS.draft.revision>${before.draft.revision}`);
  assert.deepEqual((await helpers.call(ctx, 'GET', '/projects/' + before.project.id)).body.job, before.job);
  await click('#undo-step');
  await until(`JSON.stringify(WS.draft.resume_json)===${JSON.stringify(JSON.stringify(before.draft.resume_json))}`);
  assert.deepEqual(errors, []);
});
