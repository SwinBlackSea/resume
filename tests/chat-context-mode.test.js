'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const { uuidv7, nowIso } = require('../server/lib/util');
const R = require('../resume-dom');
const sharp = require('sharp');
const { openBrowser, available } = require('./browser-driver');

async function setup(t) {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  await helpers.call(ctx, 'POST', `/projects/${id}/ai/conversations`, {
    body: { conversation_id: (await ws()).conversation.id },
  });
  const before = await ws();
  const send = body => helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, {
    body: { conversation_id: before.conversation.id, ...body },
  });
  return { ctx, id, ws, before, send };
}
function proposal(text, root) {
  return { output: { type: 'proposal', content: '修改建议', proposal: {
    target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [], changes: [
      { target_id: 'target-bullet', replacement_subtree: { id: 'target-bullet', text } },
    ] },
    change_constraints: { content: 'modify', structure: 'preserve', style: 'preserve',
      content_order: 'preserve', allowed_region_ids: [root] },
  } } };
}
function material(state, text) {
  const upload = uuidv7(), id = uuidv7(), stamp = nowIso();
  const doc = R.toResumeDocument(state.before.draft.resume_json);
  doc.root.children = [{ id: 'material-text', type: 'element', tag: 'p', text, editable: true }];
  helpers.db.run(`INSERT INTO uploads (id,owner_id,object_key,original_name,mime_type,size,sha256,
    status,created_at,updated_at,chat_conversation_id)
    VALUES (?,?,?,'resume.docx','application/test',1,'','ready',?,?,?)`,
  [upload, state.before.user.id, 'test/' + upload, stamp, stamp, state.before.conversation.id]);
  helpers.db.run(`INSERT INTO document_imports (id,project_id,upload_id,owner_id,entry_context,
    status,content_candidate,quality_report,created_at,updated_at)
    VALUES (?,?,?,?,'chat','ready',?,'{"safe_to_review":true}',?,?)`,
  [id, state.id, upload, state.before.user.id, JSON.stringify({ resume_json: doc }), stamp, stamp]);
  return id;
}
async function image(state, color) {
  const bytes = await sharp({ create: { width: 20, height: 20, channels: 3, background: color } }).png().toBuffer();
  const up = await helpers.call(state.ctx, 'POST', '/uploads', { body: {
    original_name: 'context.png', mime_type: 'image/png', size: bytes.length,
    chat_conversation_id: state.before.conversation.id,
  } });
  assert.equal(up.status, 200);
  await fetch(state.ctx.base + `/uploads/${up.body.id}/content`, { method: 'POST', body: bytes });
  assert.equal((await helpers.call(state.ctx, 'POST', `/uploads/${up.body.id}/complete`, { body: {} })).status, 200);
  return up.body.id;
}

test('不延续只建立独立任务：隔离旧建议、记忆、文字、图片、文件和链接，重试/续聊不丢新材料', async t => {
  const state = await setup(t), { send, ws, before } = state, requests = [];
  const oldDoc = material(state, '旧附件专有经历'), newDoc = material(state, '新附件专有经历');
  const oldImage = await image(state, '#123456'), newImage = await image(state, '#abcdef');
  let fail = false;
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    if (fail) throw Object.assign(new Error('测试首次响应超时'), { code: 'MODEL_TIMEOUT' });
    if (requests.length === 1) return proposal('尚未应用的旧版建议', before.draft.resume_json.root.id);
    return { output: { type: 'message', content: '已按本轮要求处理。' } };
  } }));
  const first = await send({ content: '旧任务要求保留全部数字', attachment_ids: [oldImage], document_import_ids: [oldDoc] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const oldUser = (await ws()).conversation.messages.find(m => m.role === 'user');
  helpers.db.run(`UPDATE ai_messages SET model_metadata_json=json_set(model_metadata_json,'$.link_materials',json(?)) WHERE id=?`,
    [JSON.stringify([{ url: 'https://example.org/old-job', text: '旧链接专有岗位要求' }]), oldUser.id]);
  helpers.db.run(`UPDATE ai_tasks SET state_json=json_set(state_json,'$.conversation_memory',json(?)) WHERE id=?`,
    [JSON.stringify({ summary: '旧任务专有记忆' }), first.body.task_id]);
  const continuing = await send({ content: '解释一下之前的思路' });
  assert.equal(continuing.status, 200);
  assert.equal(continuing.body.task_id, first.body.task_id);
  assert.match(R.plainText(requests.at(-1).input.workspace.resume.proposal_content), /尚未应用的旧版建议/);
  assert.equal(requests.at(-1).input.workspace.materials.documents.length, 1);
  assert.equal(requests.at(-1).input.workspace.materials.links.length, 1);
  assert.equal(requests.at(-1).capability, 'vision');
  const preserved = await ws();
  const oldAction = preserved.conversation.messages.flatMap(m => m.actions || []).find(a => a.is_active_proposal);
  assert.ok(oldAction);
  const countTasks = () => helpers.db.get('SELECT count(*) n FROM ai_tasks').n;
  const taskCount = countTasks();
  for (const invalid of [
    { context_mode: 'unknown' }, { context_mode: 'fresh', task_id: first.body.task_id },
    { context_mode: 'fresh', parent_proposal_id: oldAction.id },
    { context_mode: 'fresh', quick_reply_id: 'old-answer' },
  ]) assert.equal((await send({ content: '这条不应生成', ...invalid })).status, 400);
  assert.equal(countTasks(), taskCount);
  fail = true;
  const freshBody = { content: '只按新附件重新考虑', context_mode: 'fresh',
    client_request_id: uuidv7(), attachment_ids: [newImage], document_import_ids: [newDoc] };
  const failed = await send(freshBody);
  assert.ok(failed.status >= 400);
  const freshRequest = requests.at(-1), newTask = freshRequest.input.request.task.id;
  assert.notEqual(newTask, first.body.task_id);
  function assertFresh(request) {
    assert.equal(request.input.request.task.id, newTask);
    assert.equal(request.input.workspace.resume.proposal_content, undefined);
    assert.deepEqual(request.input.workspace.resume.content, requests[0].input.workspace.resume.content);
    assert.equal(request.input.workspace.materials.documents.length, 1);
    assert.equal(request.input.workspace.materials.documents[0].id, newDoc);
    assert.deepEqual(request.input.workspace.materials.links, []);
    assert.doesNotMatch(JSON.stringify(request.messages), /旧任务要求|尚未应用的旧版建议|旧附件专有|旧链接专有|旧任务专有记忆/);
    assert.equal(request.capability, 'vision');
  }
  assertFresh(freshRequest);
  assert.equal(freshRequest.input.conversation.recent_messages.length, 0);
  assert.equal(freshRequest.input.image_history.length, 0);
  const failedWs = await ws(), failedMessage = failedWs.conversation.messages.at(-1);
  const userCount = failedWs.conversation.messages.filter(m => m.role === 'user').length;
  const calls = requests.length;
  assert.equal((await send(freshBody)).body.replayed, true);
  assert.equal(requests.length, calls, '同一提交标识不能重复创建 fresh 任务');
  fail = false;
  const retry = await send({ retry_message_id: failedMessage.retry_message_id, context_mode: 'fresh' });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assertFresh(requests.at(-1));
  assert.equal((await ws()).conversation.messages.filter(m => m.role === 'user').length, userCount);
  assert.equal((await send({ content: '继续解释新附件' })).body.task_id, newTask);
  assertFresh(requests.at(-1));
  assert.ok(requests.at(-1).messages.some(m => m.role === 'user' &&
    JSON.stringify(m.content).includes('只按新附件重新考虑')));
  const after = await ws();
  assert.equal(after.conversation.id, before.conversation.id);
  assert.deepEqual(after.draft, before.draft);
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.job, before.job);
  assert.deepEqual(after.versions, before.versions);
  for (const m of preserved.conversation.messages) assert.ok(after.conversation.messages.some(row => row.id === m.id));
  const retained = after.conversation.messages.flatMap(m => m.actions || []).find(a => a.id === oldAction.id);
  assert.equal(retained.status, oldAction.status);
  assert.equal((await helpers.call(state.ctx, 'GET', `/ai/actions/${oldAction.id}/preview`)).status, 200);
  assert.equal(helpers.db.get('SELECT id FROM uploads WHERE id=?', [oldImage]).id, oldImage);
});

test('带图片的相同提交并发解码后只创建一项任务，即使另一请求已生成完成', async t => {
  const state = await setup(t);
  const attachment = await image(state, '#123456');
  let calls = 0;
  t.after(harness.setModelClientForTests({ async generate() {
    calls++;
    return { output: { type: 'message', content: '已处理。' } };
  } }));
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  // Pause the request boundary, not Sharp internals: immutable-image caching
  // may legitimately avoid another JPEG encode for this upload's bytes.
  const documentAssets = require('../server/lib/document-assets');
  const original = documentAssets.modelImage;
  let first = true;
  t.mock.method(documentAssets, 'modelImage', async function (...args) {
    if (first) {
      first = false;
      enter();
      await gate;
    }
    return original.apply(this, args);
  });
  t.after(release);
  const body = { content: '独立查看图片', context_mode: 'fresh',
    client_request_id: uuidv7(), attachment_ids: [attachment] };
  const pending = state.send(body);
  await entered;
  const completed = await state.send(body);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  release();
  const replay = await pending;
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.task_id, completed.body.task_id);
  assert.equal(calls, 1);
  assert.equal((await state.ws()).conversation.messages.filter(m => m.role === 'user').length, 1);
});

test('真实浏览器：延续下拉框单次生效、刷新/失败重试、无底色按钮和精简聊天入口', {
  skip: !available, timeout: 60000,
}, async t => {
  const { ctx, before, ws, send } = await setup(t), requests = [];
  let release, block = false, fail = false;
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    if (block) await new Promise(resolve => { release = resolve; });
    if (fail) throw Object.assign(new Error('测试超时'), { code: 'MODEL_TIMEOUT' });
    return requests.length === 1 ? proposal('旧任务尚未应用建议', before.draft.resume_json.root.id)
      : { output: { type: 'message', content: '本轮回答。' } };
  } }));
  const first = await send({ content: '旧对话要求' });
  assert.equal(first.status, 200);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, evaluate, until, cdp } = browser;
  async function chooseFresh() {
    await click('#conversation-continuity');
    for (const key of ['End', 'Enter']) {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
    }
    await until('document.querySelector("#conversation-continuity").value==="fresh"');
  }
  async function reload() {
    await evaluate('window.__oldContextPage=true'); await cdp('Page.reload');
    await until('!window.__oldContextPage&&Boolean(window.WS&&WS.draft)');
  }
  for (const width of [1440, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate('focusAssistant()');
    await until('document.querySelector("#conversation-continuity").getBoundingClientRect().width>0');
    for (const selector of ['#new-chat-button', width > 1160 ? '#assistant-collapse' : '.assistant-close']) {
      await browser.hover(selector);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`), 'rgba(0, 0, 0, 0)');
    }
    assert.equal(await evaluate(`(() => {const r=document.querySelector('#conversation-continuity').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`), true);
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.querySelector("#current-target-job")'), null);
  assert.equal(await evaluate('document.querySelector("#assistant-panel .material-tools")'), null);
  assert.equal(await evaluate('document.querySelector("#chat-messages .chat-proposal .cancel")'), null);
  assert.equal(await evaluate('Boolean(document.querySelector("#composer .attach"))'), true);
  await chooseFresh();
  await evaluate('refresh()');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'fresh');
  await reload();
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'fresh');
  await evaluate(`window.__contextFetch=window.fetch;window.fetch=function(url,options){
    if(String(url).endsWith('/ai/messages')&&options&&options.method==='POST'){
      window.fetch=window.__contextFetch;
      return Promise.resolve(new Response(JSON.stringify({title:'INVALID_REQUEST',detail:'测试受理前失败'}),
        {status:400,headers:{'content-type':'application/json'}}));
    }return window.__contextFetch.apply(this,arguments);
  };document.querySelector('#prompt').value='受理前失败仍保留单次选择';`);
  await click('.assistant-input .send');
  await until('!promptBusy&&document.querySelector("#prompt").value==="受理前失败仍保留单次选择"');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'fresh');
  const beforeSend = await ws();
  assert.equal(beforeSend.conversation.messages.length, 2, '切换不能删除对话或生成新消息');
  block = true;
  await evaluate('document.querySelector("#prompt").value="独立一轮，使用当前正文"');
  await click('.assistant-input .send');
  await until('document.querySelector("#conversation-continuity").disabled');
  for (let i = 0; !release && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(release);
  const secondTask = requests.at(-1).input.request.task.id;
  assert.notEqual(secondTask, first.body.task_id);
  assert.equal(requests.at(-1).input.conversation.recent_messages.length, 0);
  assert.equal(requests.at(-1).input.workspace.resume.proposal_content, undefined);
  await reload();
  await until('document.querySelector("#conversation-continuity").value==="continue"&&promptBusy');
  block = false; release();
  await until('!promptBusy&&WS.conversation.messages.length===4');
  fail = true; await chooseFresh();
  await evaluate('document.querySelector("#prompt").value="这次模拟失败"');
  await click('.assistant-input .send');
  await until('!promptBusy&&Boolean(document.querySelector(".ai-retry-button"))');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'continue');
  const failedTask = requests.at(-1).input.request.task.id, count = (await ws()).conversation.messages.filter(m => m.role === 'user').length;
  assert.notEqual(failedTask, secondTask);
  fail = false;
  await click('.ai-retry-button');
  await until('!promptBusy&&!document.querySelector(".ai-retry-button")');
  assert.equal(requests.at(-1).input.request.task.id, failedTask);
  assert.equal((await ws()).conversation.messages.filter(m => m.role === 'user').length, count);
  await evaluate('document.querySelector("#prompt").value="继续刚才这一轮"');
  await click('.assistant-input .send');
  await until(`!promptBusy&&WS.conversation.messages.filter(m=>m.role==='user').length>${count}`);
  assert.equal(requests.at(-1).input.request.task.id, failedTask);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /旧对话要求|独立一轮，使用当前正文/);
  await chooseFresh();
  await click('.chat-proposal .continue');
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'continue',
    '显式继续旧建议应恢复延续方式');
  assert.equal(await evaluate('activeTaskId'), first.body.task_id);
  assert.deepEqual((await ws()).draft, before.draft);
  assert.deepEqual(browser.errors, []);
});

test('真实浏览器：独立一轮已完成但HTTP响应丢失，恢复后自动继续新任务而非旧任务', {
  skip: !available, timeout: 30000,
}, async t => {
  const { ctx, before, send, ws } = await setup(t), requests = [];
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    return { output: { type: 'message', content: '正常回答。' } };
  } }));
  const old = await send({ content: '不应带回的旧任务要求' });
  assert.equal(old.status, 200);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { evaluate, click, until } = browser;
  await evaluate(`setChatContextMode('fresh');
    const realFetch=window.fetch;
    window.fetch=async function(url,options){
      const response=await realFetch.apply(this,arguments);
      if(String(url).endsWith('/ai/messages')&&options&&options.method==='POST'){
        window.fetch=realFetch;await response.text();throw new TypeError('模拟响应在传回时丢失');
      }return response;
    };
    document.querySelector('#prompt').value='独立的新要求';`);
  await click('.assistant-input .send');
  await until('!promptBusy&&WS.conversation.messages.length===4');
  const fresh = requests[1].input.request.task.id;
  assert.notEqual(fresh, old.body.task_id);
  assert.equal(requests.length, 2, '恢复丢失响应不能重发生成请求');
  assert.equal(await evaluate('activeTaskId'), fresh);
  assert.equal(await evaluate('document.querySelector("#conversation-continuity").value'), 'continue');
  await evaluate('document.querySelector("#prompt").value="继续独立的新要求"');
  await click('.assistant-input .send');
  await until('!promptBusy&&WS.conversation.messages.length===6');
  assert.equal(requests[2].input.request.task.id, fresh);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /不应带回的旧任务要求/);
  assert.deepEqual((await ws()).draft, before.draft);
  assert.deepEqual(browser.errors, []);
});
