'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const R = require('../resume-dom');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：刷新后自然续聊、解释后继续、应用后续聊、新对话隔离', {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const before = await ws(), requests = [];
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    if (request.input.text === '为什么这样改？') return { output: { type: 'message', content: '保留要点，减少重复。' } };
    return { output: { type: 'proposal', content: '第' + requests.length + '轮建议已准备好。' + '保留已有要点，调整表达与顺序。'.repeat(12), proposal: {
      target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [],
        changes: [{ target_id: 'target-bullet', replacement_subtree: { id: 'target-bullet', text: '第' + requests.length + '版内容' } }] },
      change_constraints: { content: 'modify', structure: 'preserve', style: 'preserve',
        content_order: 'preserve', allowed_region_ids: [before.draft.resume_json.root.id] },
    } } };
  } }));
  const first = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, { body: {
    content: '保留数字，精简重复内容', conversation_id: before.conversation.id,
  } });
  assert.equal(first.status, 200);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { evaluate, click, until, cdp } = browser;
  async function send(text) {
    const count = await evaluate("WS.conversation.messages.filter(m=>m.role==='user').length");
    await evaluate(`document.querySelector('#prompt').value=${JSON.stringify(text)}`);
    await click('.assistant-input .send');
    await until(`!promptBusy && ${count}<WS.conversation.messages.filter(m=>m.role==='user').length`);
  }
  async function reload() {
    await evaluate('window.__continuityOldPage=true');
    await cdp('Page.reload');
    await until('!window.__continuityOldPage && Boolean(window.WS&&WS.draft) && !promptBusy');
  }
  // Refresh normally restores the task, but leaving a temporary block scope
  // clears that in-memory identity. It must not silently start a new dialogue.
  await evaluate("setScope(findResumeTarget('target-bullet'))");
  await evaluate('refresh()');
  assert.equal(await evaluate('activeContext.scopeType'), 'RESUME_BLOCK',
    '后台刷新不能覆盖用户刚选的范围');
  await click('#clear-selection');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'continue');
  assert.match(await evaluate('document.querySelector("#conversation-continuity").title'), /接着上一版建议调整/);
  await send('继续调整');
  assert.equal(requests[1].input.request.task.id, first.body.task_id);
  assert.match(R.plainText(requests[1].input.workspace.resume.proposal_content), /第1版内容/);
  assert.ok(requests[1].messages.some(m => m.role === 'user' && m.content === '保留数字，精简重复内容'));
  assert.equal(requests[1].messages.at(-1).content, '继续调整');
  assert.deepEqual((await ws()).draft.resume_json, before.draft.resume_json);
  await send('为什么这样改？');
  await reload();
  // Clicking a global suggestion's continue button must also clear any old block scope.
  await evaluate("setScope(findResumeTarget('target-bullet'))");
  await click('#chat-messages .chat-proposal .continue');
  assert.equal(await evaluate('activeContext'), null);
  await send('继续调整，语气自然一点');
  assert.match(R.plainText(requests[3].input.workspace.resume.proposal_content), /第2版内容/);
  assert.ok(requests[3].messages.some(m => m.role === 'assistant' && m.content === '保留要点，减少重复。'));
  const action = (await ws()).conversation.messages.flatMap(m => m.actions || []).find(a => a.is_active_proposal);
  await click(`.chat-proposal[data-action="${action.id}"] .replace`);
  await until('document.querySelector("#toast").textContent.includes("已应用修改")');
  await reload();
  await send('继续调整');
  assert.equal(requests[4].input.request.task.id, first.body.task_id);
  assert.equal(requests[4].input.workspace.resume.proposal_content, undefined);
  assert.match(R.plainText(requests[4].input.workspace.resume.content), /第4版内容/);
  assert.ok(requests[4].messages.some(m => m.role === 'user' && m.content === '继续调整，语气自然一点'));
  await evaluate(`(() => {const box=document.querySelector('#chat-messages');
    box.scrollTop=35;document.querySelector('#prompt').value='尚未发送的补充';
    return new Promise(resolve=>requestAnimationFrame(resolve));})()`);
  const reading = await evaluate(`(() => {const box=document.querySelector('#chat-messages');
    return {top:box.scrollTop,overflow:box.scrollHeight-box.clientHeight};})()`);
  assert.ok(reading.overflow > 100, '用真实长对话验证阅读位置，而不是不可滚动的短列表');
  await evaluate('refresh()');
  assert.ok(Math.abs(await evaluate("document.querySelector('#chat-messages').scrollTop") - reading.top) < 2,
    '被动刷新不能把正在阅读的历史消息强制滚到底部');
  assert.equal(await evaluate("document.querySelector('#prompt').value"), '尚未发送的补充');
  await click('#new-chat-button');
  await click('#confirm-new-chat');
  await until('WS.conversation.messages.length===0');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'continue');
  await send('重新看看当前简历');
  assert.notEqual(requests[5].input.request.task.id, first.body.task_id);
  assert.equal(requests[5].input.workspace.resume.proposal_content, undefined);
  assert.equal(requests[5].input.conversation.recent_messages.length, 0);
  assert.equal(await evaluate('chatFollowLatest'), true, '显式发送应重新跟随最新回复');
  assert.deepEqual(browser.errors, []);
});
