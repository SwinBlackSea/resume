'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const { uuidv7 } = require('../server/lib/util');
const { openBrowser, available } = require('./browser-driver');

let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => helpers.close(ctx));
async function workspace(id) {
  return (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
}
async function project() {
  const source = await workspace(await helpers.defaultProject(ctx));
  const created = await helpers.call(ctx, 'POST', '/projects', { body: {
    name: '恢复回归', copy_project_id: source.project.id, copy_draft_revision: source.draft.revision,
  } });
  assert.equal(created.status, 200);
  return workspace(created.body.id);
}
function output(input, mode = 'root') {
  const document = structuredClone(input.workspace.resume.content);
  if (mode === 'root') {
    document.root.style = { ...document.root.style, color: '#17365d', 'font-size': '13px' };
    document.root.children.reverse();
  } else {
    ResumeDom.findNode(document, 'target-bullet').node.text = '已调整成果文字';
    document.styles = { ...document.styles, '--regression': '#17365d' };
    document.page_setup = { ...document.page_setup, margin_top: '19mm' };
  }
  return { output: { type: 'proposal', content: '修改建议已准备好。', proposal: {
    target_resume_document: document,
    change_constraints: { content: 'modify', structure: 'modify', style: 'modify',
      content_order: 'reorder', allowed_region_ids: [document.root.id] },
  } } };
}

for (const mode of ['root', 'metadata-and-text']) {
  test(`完整文档应用、幂等、撤销重做不丢根节点或元数据：${mode}`, async (t) => {
    const before = await project(), id = before.project.id;
    t.after(harness.setModelClientForTests({ async generate({ input }) { return output(input, mode); } }));
    const generated = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, {
      body: { content: '调整整份简历内容、结构和样式', client_request_id: uuidv7() },
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    const action = generated.body.actions.find((item) => item.action_type === 'RESUME_REWRITE_PROPOSAL');
    assert.ok(action);
    assert.deepEqual((await workspace(id)).draft, before.draft);
    const applyOptions = { body: {}, idemKey: `apply-${action.id}` };
    const applied = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, applyOptions);
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.resume_json, action.payload.proposal.target_resume_document);
    const again = await helpers.call(ctx, 'POST', `/ai/actions/${action.id}/apply`, applyOptions);
    assert.equal(again.status, 200);
    const after = await workspace(id);
    assert.equal(after.draft.undo_stack.length, 1);
    assert.deepEqual(after.profile, before.profile);
    assert.deepEqual(after.versions, before.versions);
    const undone = await helpers.call(ctx, 'POST', `/projects/${id}/resume-draft/undo`);
    assert.equal(undone.status, 200, JSON.stringify(undone.body));
    assert.deepEqual(undone.body.resume_json, before.draft.resume_json);
    const redone = await helpers.call(ctx, 'POST', `/projects/${id}/resume-draft/redo`);
    assert.equal(redone.status, 200);
    assert.deepEqual(redone.body.resume_json, applied.body.resume_json);
  });
}

test('请求状态按会话与请求身份隔离，不返回正文', async (t) => {
  const before = await project(), id = before.project.id, requestId = uuidv7();
  t.after(harness.setModelClientForTests({ async generate({ input }) { return output(input); } }));
  const result = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, {
    body: { content: '调整排版', client_request_id: requestId },
  });
  assert.equal(result.status, 200);
  const path = `/projects/${id}/ai/status?conversation_id=${before.conversation.id}&client_request_id=`;
  const status = await helpers.call(ctx, 'GET', path + requestId);
  assert.equal(status.status, 200);
  assert.ok(status.body.request_message_id);
  assert.equal(status.body.running_task, null);
  assert.deepEqual(Object.keys(status.body).sort(),
    ['conversation_id', 'latest_message_id', 'request_message_id', 'running_task']);
  assert.equal((await helpers.call(ctx, 'GET', path + 'unknown')).body.request_message_id, null);
  const another = await project();
  assert.equal((await helpers.call(ctx, 'GET',
    `/projects/${another.project.id}/ai/status?client_request_id=${requestId}`)).body.request_message_id, null);
});

test('真实浏览器：生成响应丢失后恢复建议，根节点重排可应用及撤销重做', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await project();
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate({ input }) { calls++; return output(input); } }));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  const { evaluate, until, click } = browser;
  await evaluate(`window.realFetch=window.fetch;window.postAttempts=0;
    window.fetch=async function(url,options){
      var response=await realFetch(url,options);
      if(String(url).endsWith('/ai/messages')&&options.method==='POST'){
        postAttempts++;throw new TypeError('Failed to fetch');
      }
      return response;
    };
    document.querySelector('#prompt').value='整份重排并调整根节点样式';sendPrompt();`);
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(calls, 1);
  assert.equal(await evaluate('postAttempts'), 1);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '');
  assert.equal(await evaluate('document.querySelectorAll(".bubble.thinking").length'), 0);
  assert.equal(await evaluate('document.querySelector("#chat-messages").textContent.includes("这次请求没有成功")'), false);
  await click('.chat-proposal .replace');
  await until(`WS.draft.revision>${before.draft.revision}`);
  const applied = await evaluate('WS.draft.resume_json');
  await click('#undo-step');
  await until(`JSON.stringify(WS.draft.resume_json)===${JSON.stringify(JSON.stringify(before.draft.resume_json))}`);
  await click('#redo-step');
  await until(`JSON.stringify(WS.draft.resume_json)===${JSON.stringify(JSON.stringify(applied))}`);
  assert.deepEqual(browser.errors, []);
});

test('真实浏览器：请求仍在后台执行时断线，恢复等待且不重发模型', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await project();
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  t.after(harness.setModelClientForTests({ async generate({ input }) {
    calls++; await pending; return output(input);
  } }));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  const { evaluate, until } = browser;
  await evaluate(`window.realFetch=window.fetch;window.postAttempts=0;
    window.fetch=async function(url,options){
      if(String(url).endsWith('/ai/messages')&&options.method==='POST'){
        postAttempts++;window.backgroundRequest=realFetch(url,options).catch(function(){});
        while(true){
          var status=await (await realFetch(API+'/projects/'+PROJECT_ID+'/ai/status')).json();
          if(status.running_task)break;
          await new Promise(function(resolve){setTimeout(resolve,20)});
        }
        return new Response('',{status:504});
      }
      return realFetch(url,options);
    };
    document.querySelector('#prompt').value='生成整份重排建议';sendPrompt();`);
  await until('remoteChatBusy && promptBusy && WS.conversation.messages.length===1');
  await evaluate(`document.querySelector('#prompt').value='等待期间不能重复发送';sendPrompt();`);
  assert.equal(calls, 1);
  release();
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(await evaluate('postAttempts'), 1);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '等待期间不能重复发送');
  assert.deepEqual(browser.errors, []);
});

test('真实浏览器：状态查询也断线时有界停止，可手动检查而不重复提交', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await project();
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate({ input }) { calls++; return output(input); } }));
  const { evaluate, until, click, errors } = await openBrowser(t,
    ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  await evaluate(`window.realFetch=window.fetch;window.blockStatus=true;window.statusAttempts=0;window.postAttempts=0;
    window.fetch=async function(url,options){
      if(String(url).includes('/ai/status')&&blockStatus){
        statusAttempts++;throw new TypeError('Failed to fetch');
      }
      var response=await realFetch(url,options);
      if(String(url).endsWith('/ai/messages')&&options.method==='POST'){
        postAttempts++;throw new TypeError('Failed to fetch');
      }
      return response;
    };
    document.querySelector('#prompt').value='重排';sendPrompt();`);
  await until('!promptBusy && Boolean(document.querySelector(".ai-check-status"))');
  assert.equal(await evaluate('statusAttempts'), 3);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '');
  await evaluate('blockStatus=false');
  await click('.ai-check-status');
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(calls, 1);
  assert.equal(await evaluate('postAttempts'), 1);
  assert.deepEqual(errors, []);
});

test('真实浏览器：请求未发送成功时保留原文，状态查询不盲目重新生成', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await project();
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate({ input }) { calls++; return output(input); } }));
  const { evaluate, until, errors } = await openBrowser(t,
    ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  await evaluate(`window.realFetch=window.fetch;window.postAttempts=0;
    window.fetch=function(url,options){
      if(String(url).endsWith('/ai/messages')&&options.method==='POST'){
        postAttempts++;return Promise.reject(new TypeError('Failed to fetch'));
      }
      return realFetch(url,options);
    };
    document.querySelector('#prompt').value='未送达的原始要求';sendPrompt();`);
  await until('!promptBusy && document.querySelector("#prompt").value==="未送达的原始要求"');
  assert.equal(calls, 0);
  assert.equal(await evaluate('postAttempts'), 1);
  assert.equal((await workspace(before.project.id)).conversation.messages.length, 0);
  assert.deepEqual(errors, []);
});

test('真实浏览器：失败重试的响应丢失，按原失败消息恢复，不复制用户历史', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const before = await project();
  let fail = true, calls = 0;
  t.after(harness.setModelClientForTests({ async generate({ input }) {
    calls++;
    if (!fail) return output(input);
    return { output: { type: 'proposal', content: '无效目标', proposal: {
      target_resume_fragments: { format: 'resume-target-fragments-v2',
        changes: [{ target_id: 'missing-node', replacement_subtree: null }] },
    } } };
  } }));
  await helpers.call(ctx, 'POST', `/projects/${before.project.id}/ai/messages`, {
    body: { content: '保留我的原始要求并重排' },
  });
  const failed = await workspace(before.project.id);
  const error = failed.conversation.messages.at(-1);
  assert.equal(error.result_type, 'ERROR');
  const callsBeforeRetry = calls;
  fail = false;
  const { evaluate, until, click, errors } = await openBrowser(t,
    ctx.base.replace('/api/v1', '/') + '?project=' + before.project.id);
  await evaluate(`window.realFetch=window.fetch;window.postAttempts=0;
    window.fetch=async function(url,options){
      var response=await realFetch(url,options);
      if(String(url).endsWith('/ai/messages')&&options.method==='POST'){
        postAttempts++;throw new TypeError('Failed to fetch');
      }
      return response;
    };
    document.querySelector('#prompt').value='还未发送的另一条要求';`);
  await click('.ai-retry-button');
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(calls, callsBeforeRetry + 1);
  assert.equal(await evaluate('postAttempts'), 1);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '还未发送的另一条要求');
  const after = await workspace(before.project.id);
  assert.equal(after.conversation.messages.filter((message) => message.role === 'user').length, 1);
  const status = await helpers.call(ctx, 'GET',
    `/projects/${before.project.id}/ai/status?retry_message_id=${error.id}`);
  assert.equal(status.body.request_message_id, after.conversation.messages.find((message) => message.role === 'user').id);
  assert.deepEqual(errors, []);
});
