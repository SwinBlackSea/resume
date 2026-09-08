'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const db = require('../server/lib/db');
const { uuidv7, nowIso } = require('../server/lib/util');

let ctx;
let projectId;
let conversationId;
const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
const send = (body) => helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
  body: { scope_type: 'RESUME_DOCUMENT', conversation_id: conversationId, ...body },
});
function proposal(text = '精简后的完整建议') {
  return { output: {
    type: 'proposal', content: '修改建议已准备好。',
    proposal: {
      target_resume_fragments: {
        format: 'resume-target-fragments-v2',
        changes: [{ target_id: 'target-bullet', replacement_subtree: { id: 'target-bullet', text } }],
        insertions: [],
      },
      change_constraints: {
        content: 'modify', structure: 'preserve', style: 'preserve',
        content_order: 'preserve', allowed_region_ids: ['resume-root'],
      },
    },
  } };
}
function invalidProposal() {
  const result = proposal();
  result.output.proposal.target_resume_fragments.changes[0].target_id = 'missing-node';
  return result;
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function until(check, label = '等待页面状态') {
  for (let i = 0; i < 150; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(label);
}
async function browser(t, requests = []) {
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), {
    runScripts: 'dangerously', resources: 'usable', url: `${origin}/`, pretendToBeVisual: true,
    beforeParse(window) {
      window.sessionStorage.setItem('resumeGuideSeen', '1');
      window.fetch = (url, options = {}) => {
        const target = new URL(url, origin);
        if (target.pathname.endsWith('/ai/messages') && options.method === 'POST') {
          requests.push(JSON.parse(options.body));
        }
        return fetch(target, options);
      };
      window.EventSource = class { addEventListener() {} close() {} };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  t.after(() => dom.window.close());
  await until(() => dom.window.WS?.conversation?.id === conversationId);
  return dom.window;
}

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});
test.after(() => helpers.close(ctx));
test.beforeEach(async () => {
  const before = await workspace();
  const started = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    idemKey: `chat-regression-${before.conversation.id}`,
    body: { conversation_id: before.conversation.id },
  });
  assert.equal(started.status, 200);
  conversationId = started.body.id;
});

test('重叠修改只修复冲突区域，后端保留其余精简、删除和新增，不猜测删除与修改的取舍', async (t) => {
  const document = {
    schema_version: 'resume-document-v3',
    root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'duplicate', type: 'element', tag: 'section', children: [
        { id: 'overview', type: 'element', tag: 'p', editable: true, text: '重复介绍' },
      ] },
      { id: 'retained', type: 'element', tag: 'section', children: [
        { id: 'strength', type: 'element', tag: 'p', editable: true, text: '冗长优势' },
        { id: 'junk', type: 'element', tag: 'p', editable: true, text: '无效文字' },
      ] },
    ] },
  };
  let calls = 0;
  const restore = harness.setModelClientForTests({
    generate: async ({ messages }) => {
      calls += 1;
      const changes = [{ target_id: 'duplicate', replacement_subtree: null }];
      if (calls === 1) changes.push(
        { target_id: 'overview', replacement_subtree: { id: 'overview', text: '精简介绍' } },
        { target_id: 'strength', replacement_subtree: { id: 'strength', text: '精简优势' } },
        { target_id: 'junk', replacement_subtree: null },
      );
      else {
        assert.match(messages.at(-2).content, /ancestor_operation.*delete/);
        assert.match(messages.at(-2).content, /preserved_target_ids.*strength.*junk/);
        assert.equal(messages.at(-1).content, '按此思路去重优化');
      }
      return { output: {
        type: 'proposal', content: '已准备去重建议',
        proposal: {
          target_resume_fragments: {
            format: 'resume-target-fragments-v2', changes,
            insertions: calls === 1 ? [{
              parent_id: 'retained', after_id: 'strength',
              new_subtrees: [{ id: 'addition', type: 'element', tag: 'p', editable: true, text: '补充信息' }],
            }] : [],
          },
          change_constraints: {
            content: 'modify', structure: 'modify', style: 'preserve',
            content_order: 'preserve', allowed_region_ids: ['root'],
          },
        },
      } };
    },
  });
  t.after(restore);
  const result = await harness.complete(harness.buildHarnessInput({
    text: '按此思路去重优化', scope: { type: 'RESUME_DOCUMENT', id: null },
    task: { id: 'overlap-task', goal: '去重并精简' },
    resume: { revision: 1, content: document }, profile: {},
  }));
  const target = result.response.actions[0].payload.proposal.target_resume_document;
  assert.equal(calls, 2);
  assert.equal(ResumeDom.findNode(target, 'duplicate'), null);
  assert.equal(ResumeDom.findNode(target, 'junk'), null);
  assert.equal(ResumeDom.nodeText(ResumeDom.findNode(target, 'strength').node), '精简优势');
  assert.equal(ResumeDom.nodeText(ResumeDom.findNode(target, 'addition').node), '补充信息');
});

test('已确认思路失败后按原用户消息重试，历史不重复，不把错误提示伪装成模型对话', async (t) => {
  let calls = 0;
  const requests = [];
  t.after(harness.setModelClientForTests({
    generate: async ({ input, messages }) => {
      calls += 1; requests.push({ input, messages });
      if (calls === 1) return { output: {
        type: 'message', content: '合并重复概况并精简优势。',
        message_kind: 'plan_confirmation', awaiting_user: true,
        quick_replies: ['按此思路去重优化'],
      } };
      return calls <= 3 ? invalidProposal() : proposal();
    },
  }));
  const original = await workspace();
  const plan = await send({ content: '查看是否有重复项，有的话去重优化精简' });
  const failed = await send({
    content: '按此思路去重优化', task_id: plan.body.task_id, quick_reply_id: 'option-1',
  });
  assert.equal(failed.status, 422);
  const failedView = (await workspace()).conversation.messages.at(-1);
  assert.equal(failedView.retry_message_id, failed.body.persisted_message_id);
  const retried = await send({
    retry_message_id: failedView.retry_message_id,
    content: '客户端伪造的另一条要求', task_id: 'forged', scope_type: 'DATA_PROFILE',
  });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.task_id, plan.body.task_id);
  assert.equal(requests.at(-1).input.request.text, '按此思路去重优化');
  assert.ok(requests.at(-1).input.request.task.state.confirmed_plan);
  assert.deepEqual(requests.at(-1).input.conversation.recent_messages.map((item) => item.content),
    ['查看是否有重复项，有的话去重优化精简', '合并重复概况并精简优势。']);
  const after = await workspace();
  assert.equal(after.conversation.messages.filter((item) => item.role === 'user').length, 2);
  assert.deepEqual(after.draft.resume_json, original.draft.resume_json);
  const stale = await send({ retry_message_id: failedView.retry_message_id });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.title, 'RETRY_SUPERSEDED');
});

test('问一句解释不会作废上一版，继续调整及应用后追问保持对话并读取最新正文', async (t) => {
  let calls = 0;
  const requests = [];
  t.after(harness.setModelClientForTests({
    generate: async ({ input }) => {
      requests.push(input); calls += 1;
      if (calls === 2 || calls === 4) return {
        output: { type: 'message', content: '保留关键成果，压缩重复表达。', awaiting_user: false },
      };
      return proposal(calls === 1 ? '第一版精简建议' : '第二版精简建议');
    },
  }));
  const first = await send({ content: '精简重复内容' });
  const firstAction = first.body.actions[0];
  const explanation = await send({ content: '为什么这样改？', task_id: first.body.task_id });
  assert.equal(explanation.status, 200);
  assert.equal(db.get('SELECT status FROM ai_action_requests WHERE id = ?', [firstAction.id]).status,
    'awaiting_confirmation');
  const next = await send({ content: '保留数字，再短一点', task_id: first.body.task_id });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.match(ResumeDom.nodeText(requests[2].workspace.resume.proposal_content.root), /第一版精简建议/);
  const action = next.body.actions[0];
  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, {
    idemKey: `global-chat-apply-${action.id}`, body: { expected_revision: action.expected_revision },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const continued = await send({ content: '现在还可以怎么改？', task_id: first.body.task_id });
  assert.equal(continued.status, 200, JSON.stringify(continued.body));
  assert.match(ResumeDom.nodeText(requests[3].workspace.resume.content.root), /第二版精简建议/);
  assert.equal(requests[3].workspace.resume.proposal_content, undefined);
  assert.ok(requests[3].conversation.recent_messages.some((item) => item.content === '为什么这样改？'));
});

test('同一对话串行生成，停止后可重试；即使供应商忽略取消，旧请求也不能污染新结果', async (t) => {
  const entered = deferred();
  const late = deferred();
  let calls = 0;
  t.after(harness.setModelClientForTests({
    generate: async () => {
      calls += 1;
      if (calls === 1) { entered.resolve(); await late.promise; return proposal('不应出现的迟到内容'); }
      return proposal('重试后的建议');
    },
  }));
  const original = await workspace();
  const firstRequest = send({ content: '去重精简' });
  await entered.promise;
  const duplicate = await send({ content: '重复点击' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.title, 'TASK_BUSY');
  assert.equal(calls, 1);
  const status = await helpers.call(ctx, 'GET',
    `/projects/${projectId}/ai/status?conversation_id=${conversationId}`);
  const staleStop = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/cancel`, {
    body: { conversation_id: conversationId, run_id: 'old-run' },
  });
  assert.equal(staleStop.status, 409);
  const stopped = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/cancel`, {
    body: { conversation_id: conversationId, run_id: status.body.running_task.run_id },
  });
  assert.equal(stopped.body.stopped, true);
  const retry = await send({ retry_message_id: stopped.body.persisted_message_id });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  late.resolve();
  const oldResponse = await firstRequest;
  assert.equal(oldResponse.status, 409);
  const after = await workspace();
  assert.equal(after.conversation.messages.filter((item) => item.role === 'user').length, 1);
  assert.equal(after.conversation.messages.filter((item) => item.result_type === 'PROPOSAL').length, 1);
  assert.doesNotMatch(JSON.stringify(after.conversation), /不应出现的迟到内容/);
  assert.deepEqual(after.draft.resume_json, original.draft.resume_json);
});

test('Web 刷新后可直接重试，连续点击只发一次，保留输入草稿并自然继续同一任务', async (t) => {
  let succeed = false;
  t.after(harness.setModelClientForTests({
    generate: async () => succeed ? proposal('页面重试建议') : invalidProposal(),
  }));
  const failed = await send({ content: '优化整份简历' });
  assert.equal(failed.status, 422);
  succeed = true;
  const requests = [];
  const window = await browser(t, requests);
  const prompt = window.document.querySelector('#prompt');
  prompt.value = '我还想补充的要求';
  const button = window.document.querySelector('.ai-retry-button');
  assert.ok(button);
  button.click(); button.click();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    retry_message_id: failed.body.persisted_message_id, conversation_id: conversationId,
  });
  assert.equal(prompt.value, '我还想补充的要求');
  await until(() => !window.promptBusy && window.document.querySelector('.chat-proposal'));
  assert.equal(window.activeTaskId, failed.body.task_id);
  prompt.value = '再压缩一点';
  window.document.querySelector('.assistant-input .send').click();
  assert.equal(requests[1].task_id, failed.body.task_id);
  await until(() => !window.promptBusy);
});

test('Web 页面刷新时接管后台生成状态，锁定重复发送，停止后恢复输入和重试入口', async (t) => {
  const entered = deferred();
  const late = deferred();
  t.after(harness.setModelClientForTests({
    generate: async () => { entered.resolve(); await late.promise; return proposal(); },
  }));
  const pending = send({ content: '调整简历排版' });
  await entered.promise;
  const window = await browser(t);
  assert.equal(window.promptBusy, true);
  assert.equal(window.document.querySelector('.assistant-input .send').disabled, true);
  const stop = window.document.querySelector('#stop-ai-request');
  assert.equal(stop.hidden, false);
  stop.click();
  await until(() => !window.promptBusy && window.document.querySelector('.ai-retry-button'));
  assert.equal(stop.hidden, true);
  late.resolve();
  assert.equal((await pending).status, 409);
  assert.equal((await workspace()).conversation.messages.at(-1).error_code, 'REQUEST_CANCELED');
});

test('服务重启收口未完成请求，保留上一版并生成可重试回执，重复恢复不复制历史', async (t) => {
  let calls = 0;
  t.after(harness.setModelClientForTests({
    generate: async () => proposal(`重启恢复建议-${++calls}`),
  }));
  const first = await send({ content: '先精简一版' });
  const requestId = uuidv7();
  const task = db.get('SELECT * FROM ai_tasks WHERE id = ?', [first.body.task_id]);
  db.run(
    `INSERT INTO ai_messages
     (id, conversation_id, task_id, owner_id, role, content, scope_type, model_metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'user', ?, 'RESUME_DOCUMENT', ?, ?)`,
    [requestId, conversationId, task.id, task.owner_id, '再压缩一点',
      JSON.stringify({ task_id: task.id }), nowIso()],
  );
  db.run("UPDATE ai_tasks SET status = 'planning' WHERE id = ?", [task.id]);
  db.reconcileAiTaskLifecycle(db.getDb());
  db.reconcileAiTaskLifecycle(db.getDb());
  const recovered = await workspace();
  const errors = recovered.conversation.messages.filter((message) => message.result_type === 'ERROR');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error_code, 'REQUEST_INTERRUPTED');
  assert.ok(errors[0].retry_message_id);
  assert.equal(recovered.conversation.tasks[0].active_proposal_id, first.body.actions[0].id);
  const retry = await send({ retry_message_id: errors[0].retry_message_id });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.task_id, task.id);
  assert.equal((await workspace()).conversation.messages.filter((message) => message.role === 'user').length, 2);
});
