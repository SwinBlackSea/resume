'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');
const { publicAddress, readableText, fetchPage } = require('../server/lib/job-links');
const { loadDocumentMaterials } = require('../server/lib/input-materials');
const { uuidv7, nowIso } = require('../server/lib/util');
const { openBrowser, available } = require('./browser-driver');
const recognition = require('../server/lib/document-recognition');

let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => helpers.close(ctx));
const ws = async (id) => (await helpers.call(ctx, 'GET', '/projects/' + id)).body;
async function create(body = {}, idemKey) {
  const result = await helpers.call(ctx, 'POST', '/projects', { body, idemKey });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
function generationModel(requests) {
  return { async generate({ input, messages }) {
    requests.push({ input, messages });
    const document = structuredClone(input.workspace.resume.content);
    document.root.children = [{
      id: 'new-intro', type: 'element', tag: 'p', editable: true,
      semantic: { kind: 'paragraph' }, text: '王青，负责企业服务产品需求与交付。',
      style: { 'font-size': '12pt', color: '#253858' },
    }];
    return { output: { type: 'proposal', content: '修改建议已准备好。',
      proposal: { target_resume_document: document,
        change_constraints: { content: 'modify', structure: 'modify', style: 'modify',
          content_order: 'reorder', allowed_region_ids: [document.root.id] } } } };
  } };
}

test('不建资料或岗位也可生成预览；首次应用与不可变版本原子保存', async (t) => {
  const project = await create();
  const before = await ws(project.id), requests = [];
  t.after(harness.setModelClientForTests(generationModel(requests)));
  assert.deepEqual(before.profile.basics, {});
  assert.equal(before.job, null);
  assert.equal(ResumeDom.plainText(before.draft.resume_json), '');
  const body = { content: '我叫王青，负责企业服务产品需求与交付，请制作简历。',
    conversation_id: before.conversation.id, client_request_id: uuidv7() };
  const generated = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, { body });
  assert.equal(generated.status, 200, JSON.stringify(generated.body));
  assert.equal(requests[0].messages.at(-1).content, body.content, '本轮要求不被服务端改写');
  const proposal = generated.body.actions.find((action) => action.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(proposal?.payload.proposal.target_resume_document);
  assert.deepEqual((await ws(project.id)).draft, before.draft, '首次预览也不偷偷写正文');
  const duplicate = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, { body });
  assert.equal(duplicate.body.replayed, true);
  assert.equal(requests.length, 1);
  const applied = await helpers.call(ctx, 'POST', `/ai/actions/${proposal.id}/apply`, {
    body: {}, idemKey: 'first-apply-' + project.id,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.version_created, true);
  const after = await ws(project.id);
  assert.equal(after.versions.length, 1);
  assert.equal(after.versions[0].kind, 'generated');
  assert.equal(after.draft.undo_stack.length, 1);
  assert.deepEqual(after.profile, before.profile);
  const frozen = helpers.db.get('SELECT * FROM resume_versions WHERE id = ?', [after.versions[0].id]);
  assert.deepEqual(JSON.parse(frozen.resume_payload), after.draft.resume_json);
  await helpers.call(ctx, 'POST', `/projects/${project.id}/resume-draft/undo`, { body: {} });
  assert.equal(ResumeDom.plainText((await ws(project.id)).draft.resume_json), '');
  assert.equal(helpers.db.get('SELECT resume_payload FROM resume_versions WHERE id = ?', [frozen.id]).resume_payload, frozen.resume_payload);
  await helpers.call(ctx, 'POST', `/projects/${project.id}/resume-draft/redo`, { body: {} });
  assert.deepEqual((await ws(project.id)).draft.resume_json, after.draft.resume_json);
});

test('制作另一份复制完整文档和独立岗位，不复制对话、不覆盖原稿；并发及幂等保护', async () => {
  const originalId = await helpers.defaultProject(ctx);
  const before = await ws(originalId);
  const body = { name: '另一份简历', copy_project_id: originalId, copy_draft_revision: before.draft.revision };
  const key = uuidv7();
  const clone = await create(body, key), repeat = await create(body, key);
  assert.equal(clone.id, repeat.id);
  const copied = await ws(clone.id);
  assert.deepEqual(copied.draft.resume_json, before.draft.resume_json);
  assert.notEqual(copied.job.id, before.job.id);
  assert.equal(copied.job.confirmed_text, before.job.confirmed_text);
  assert.deepEqual(copied.job.files.map(({ id: _id, ...file }) => file),
    before.job.files.map(({ id: _id, ...file }) => file));
  assert.ok(copied.job.files.every((file) => !before.job.files.some((original) => original.id === file.id)));
  assert.notEqual(copied.conversation.id, before.conversation.id);
  assert.deepEqual(copied.conversation.messages, []);
  assert.deepEqual(copied.versions, []);
  assert.deepEqual((await ws(originalId)).draft, before.draft);
  const stale = await helpers.call(ctx, 'POST', '/projects', { body: { ...body, copy_draft_revision: 0 } });
  assert.equal(stale.status, 409);
  const forbidden = await helpers.call(ctx, 'POST', '/projects', { body: { ...body, copy_project_id: 'not-owned' } });
  assert.equal(forbidden.status, 404);
  const changed = await helpers.call(ctx, 'POST', `/projects/${clone.id}/resume-draft/transactions`, {
    body: { expected_revision: copied.draft.revision, mutation_id: uuidv7(),
      operations: [{ op: 'replace_text', node_id: 'target-bullet', text: '只修改另一份简历。' }] },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual((await ws(originalId)).draft, before.draft);
});

test('首页缺信息追问后继续成稿；已有正文或生成中手改均不自动覆盖', async (t) => {
  const project = await create(), before = await ws(project.id), requests = [];
  let count = 0;
  const generator = generationModel(requests);
  t.after(harness.setModelClientForTests({ async generate(options) {
    if (++count === 1) return { output: { type: 'message', content: '请告诉我你的主要经历。', quick_replies: [] } };
    const result = await generator.generate(options);
    if (count > 2) result.output.proposal.target_resume_document.root.children[0].text += '熟悉跨团队协作。';
    return result;
  } }));
  const first = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '帮我制作简历', initial_generation: true },
  });
  assert.equal(first.status, 200);
  assert.deepEqual((await ws(project.id)).draft, before.draft);
  const second = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '我叫王青，负责企业服务产品需求与交付', task_id: first.body.task_id },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const generated = await ws(project.id);
  assert.equal(generated.versions.length, 1);
  assert.match(ResumeDom.plainText(generated.draft.resume_json), /王青/);
  const further = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '继续调整', initial_generation: true },
  });
  assert.equal(further.status, 200);
  assert.deepEqual((await ws(project.id)).draft, generated.draft);

  const blank = await create();
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const restore = harness.setModelClientForTests({ async generate(options) {
    started(); await waiting; return generator.generate(options);
  } });
  t.after(restore);
  const pending = helpers.call(ctx, 'POST', `/projects/${blank.id}/ai/messages`, {
    body: { content: '我叫王青，请生成简历', initial_generation: true },
  });
  await ready;
  // Concurrent direct editing uses the same draft transaction store.
  const draft = await ws(blank.id);
  const manuallyEdited = structuredClone(draft.draft.resume_json);
  manuallyEdited.root.children.push({ id: 'manual-text', type: 'element', tag: 'p',
    editable: true, semantic: { kind: 'paragraph' }, text: '我刚刚补充的正文' });
  helpers.db.run('UPDATE resume_drafts SET resume_json = ?, revision = revision + 1 WHERE project_id = ?',
    [JSON.stringify(manuallyEdited), blank.id]);
  release();
  const late = await pending;
  assert.equal(late.status, 200, JSON.stringify(late.body));
  const after = await ws(blank.id);
  assert.deepEqual(after.draft.resume_json, ResumeDom.toResumeDocument(manuallyEdited));
  assert.equal(after.versions.length, 0);
  assert.ok(late.body.actions.some((action) => action.status !== 'applied'));
});

test('链接读取拒绝内网、异常端口和跳转；失败不生成、不改正文并提示当前流程补充', async (t) => {
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '172.16.1.1', '192.168.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(publicAddress(address), false, address);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(readableText('<script>bad()</script><h1>产品经理</h1><p>A &amp; B</p>'), '产品经理\nA & B');
  await assert.rejects(fetchPage('http://example.test', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request() { assert.fail('不得连接内网'); },
  }));
  await assert.rejects(fetchPage('http://example.test:8787'));
  let connections = 0;
  function transport(status, headers, text) {
    return (_url, options, callback) => {
      connections++;
      options.lookup('example.test', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
      const req = new EventEmitter();
      req.destroy = (error) => { req.emit('error', error); req.emit('close'); };
      req.end = () => queueMicrotask(() => {
        const res = new PassThrough();
        res.statusCode = status; res.headers = headers;
        callback(res); res.end(text); req.emit('close');
      });
      return req;
    };
  }
  const text = '产品经理，负责需求调研、产品设计、研发协作和客户交付。'.repeat(5);
  const page = await fetchPage('https://example.test/job', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: transport(200, { 'content-type': 'text/html' }, '<p>' + text + '</p>'),
  });
  assert.equal(page.text, text);
  connections = 0;
  await assert.rejects(fetchPage('https://example.test/job', {
    lookup: async (host) => [{ address: host === 'example.test' ? '8.8.8.8' : '127.0.0.1', family: 4 }],
    request: transport(302, { location: 'http://127.0.0.1/private' }, ''),
  }));
  assert.equal(connections, 1, '跳转目标必须重新校验，不能连接内网');
  await assert.rejects(fetchPage('https://example.test/job', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: transport(200, { 'content-type': 'text/html' }, Buffer.alloc(1024 * 1024 + 1)),
  }), /网页过大/);
  const project = await create(), before = await ws(project.id), requests = [];
  t.after(harness.setModelClientForTests(generationModel(requests)));
  const result = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '请参考 http://127.0.0.1/private' },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.title, 'JOB_LINK_UNREADABLE');
  assert.match(result.body.detail, /粘贴岗位描述.*截图/);
  assert.equal(requests.length, 0);
  assert.deepEqual((await ws(project.id)).draft, before.draft);
});

test('文件识别结果跨轮复用且只读，不写个人档案，不能混用项目或对话', async (t) => {
  const project = await create(), before = await ws(project.id), user = { id: before.user.id };
  const uploadId = uuidv7(), importId = uuidv7();
  const document = structuredClone(before.draft.resume_json);
  document.root.children.push({ id: 'material-text', type: 'element', tag: 'p', text: '负责企业服务产品交付。', editable: true });
  helpers.db.run(`INSERT INTO uploads (id, owner_id, object_key, original_name, mime_type, size, sha256,
    status, created_at, updated_at, chat_conversation_id) VALUES (?, ?, ?, 'resume.docx', 'application/test', 1, '', 'ready', ?, ?, ?)`,
  [uploadId, user.id, 'test/' + uploadId, nowIso(), nowIso(), before.conversation.id]);
  helpers.db.run(`INSERT INTO document_imports (id, project_id, upload_id, owner_id, entry_context, status,
    content_candidate, quality_report, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'chat', 'ready', ?, '{"safe_to_review":true}', ?, ?)`,
  [importId, project.id, uploadId, user.id, JSON.stringify({ resume_json: document }), nowIso(), nowIso()]);
  assert.equal(loadDocumentMaterials([importId], user, project.id, before.conversation.id).length, 1);
  assert.throws(() => loadDocumentMaterials([importId], user, 'another-project', before.conversation.id));
  assert.throws(() => loadDocumentMaterials([importId], user, project.id, 'another-conversation'));
  const requests = [];
  t.after(harness.setModelClientForTests({ async generate({ input }) {
    requests.push(input);
    return { output: { type: 'message', content: '已读取经历，你还希望突出什么？', quick_replies: [] } };
  } }));
  const first = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '', document_import_ids: [importId] },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const next = await helpers.call(ctx, 'POST', `/projects/${project.id}/ai/messages`, {
    body: { content: '沿用刚才的经历，先讨论一下排版', task_id: first.body.task_id },
  });
  assert.equal(next.status, 200);
  assert.deepEqual(requests[0].workspace.materials.documents, requests[1].workspace.materials.documents);
  assert.equal(requests[1].workspace.materials.documents.length, 1);
  assert.deepEqual((await ws(project.id)).profile, before.profile);
  assert.deepEqual((await ws(project.id)).draft, before.draft);
});

test('下载当前草稿不创建历史或副本文档，校验项目归属和 revision', async () => {
  const id = await helpers.defaultProject(ctx), before = await ws(id);
  const url = ctx.base + `/projects/${id}/resume-draft/download?format=docx&revision=${before.draft.revision}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment/);
  assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.deepEqual((await ws(id)).draft, before.draft);
  assert.deepEqual((await ws(id)).versions, before.versions);
  assert.equal((await fetch(url.replace(/revision=\d+/, 'revision=0'))).status, 409);
  assert.equal((await fetch(url.replace(id, 'not-owned'))).status, 404);
});

test('真实浏览器：首页输入→首份成稿预览→编辑保存→制作另一份→返回原稿；附件不自动生成', {
  skip: available ? false : '需要 Chromium', timeout: 60000,
}, async (t) => {
  const requests = [];
  t.after(harness.setModelClientForTests(generationModel(requests)));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, until, click, cdp } = browser;
  assert.equal(await evaluate('document.body.classList.contains("home-mode")'), true);
  await evaluate(`(() => {
    const file=new File([new Uint8Array([37,80,68,70,45,49,46,55])],'resume.pdf',{type:'application/pdf'});
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('#home-files');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  })()`);
  await until('homeAttachments.length===1 && homeAttachments[0].status==="ready"');
  assert.equal(requests.length, 0, '附件上传不能触发模型或生成');
  await click('#home-attachments button');
  await click('#home-prompt');
  await cdp('Input.insertText', { text: '我叫王青，负责企业服务产品需求与交付。' });
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 8 });
  // IME / Shift+Enter do not submit; explicit button starts the same path.
  assert.equal(requests.length, 0);
  await click('#home-submit');
  await until('window.WS && !document.body.classList.contains("home-mode") && WS.versions.length===1', 15000);
  const firstId = await evaluate('PROJECT_ID');
  assert.equal(requests.length, 1);
  await click('#preview-current');
  await until('document.querySelector("#resume-preview-modal").classList.contains("show")');
  assert.match(await evaluate('document.querySelector("#resume-preview-document").textContent'), /王青/);
  assert.match(ResumeDom.plainText((await ws(firstId)).draft.resume_json), /王青/);
  await click('#resume-preview-modal .close');
  await until('WS.versions.length===1 && !!document.querySelector("#resume-document [data-resume-editable=true]")');
  await click('#resume-document [data-resume-editable=true]');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 });
  await cdp('Input.insertText', { text: '王青，负责企业服务产品需求、交付和客户沟通。' });
  assert.match(await evaluate('document.querySelector("#resume-document").textContent'), /客户沟通/,
    await evaluate('JSON.stringify({active:document.activeElement.outerHTML,prompt:document.querySelector("#prompt").value,body:document.querySelector("#resume-document").outerHTML})'));
  await evaluate('refresh()');
  assert.match(await evaluate('document.querySelector("#resume-document").textContent'), /客户沟通/,
    '聊天状态刷新不能重绘并吞掉尚未保存的正文输入');
  await click('#another-resume');
  await until('document.body.classList.contains("home-mode") && document.querySelector("#reuse-current")');
  assert.match(ResumeDom.plainText((await ws(firstId)).draft.resume_json), /客户沟通/);
  await evaluate('document.querySelector("#home-prompt").value="请先分析一下这份简历";');
  await click('#home-submit');
  await until(`window.WS && PROJECT_ID!==${JSON.stringify(firstId)} && !document.body.classList.contains("home-mode") && WS.conversation.messages.length>0`, 15000);
  const secondId = await evaluate('PROJECT_ID');
  assert.notEqual(secondId, firstId);
  assert.match(ResumeDom.plainText((await ws(secondId)).draft.resume_json), /客户沟通/);
  await click('#resume-list-button');
  await until('document.body.classList.contains("home-mode") && document.querySelector("#resume-list button")');
  await evaluate(`navigateResume('?project='+${JSON.stringify(firstId)})`);
  await until(`window.WS && PROJECT_ID===${JSON.stringify(firstId)} && !document.body.classList.contains("home-mode")`);
  assert.match(await evaluate('document.querySelector("#resume-document").textContent'), /客户沟通/);
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".context")).display'), 'none');
  await click('#another-resume');
  await until('document.body.classList.contains("home-mode") && document.querySelector("#reuse-current")');
  assert.equal(await evaluate('document.querySelector("#reuse-current").checked'), true);
  await evaluate('document.querySelector("#home-prompt").value=""');
  const callsBeforeCopy = requests.length;
  await click('#home-submit');
  await until(`window.WS && PROJECT_ID!==${JSON.stringify(firstId)} && !document.body.classList.contains("home-mode")`, 15000);
  assert.equal(requests.length, callsBeforeCopy, '只复用当前简历不必触发模型');
  assert.deepEqual((await ws(await evaluate('PROJECT_ID'))).draft.resume_json, (await ws(firstId)).draft.resume_json);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const mobileLayout = await evaluate(`JSON.stringify({width:innerWidth, scroll:document.documentElement.scrollWidth,
    overflowing:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>391
      &&getComputedStyle(e).display!=='none').slice(0,12).map(e=>({tag:e.tagName,cls:e.className,id:e.id,right:e.getBoundingClientRect().right}))})`);
  assert.equal(await evaluate('innerWidth===390 && document.documentElement.scrollWidth<=390'), true, mobileLayout);
  assert.deepEqual(browser.errors, []);
});

test('真实浏览器：Word 附件取消后可继续，只识别一次；保存失败不离开、不丢正文', {
  skip: available ? false : '需要 Chromium', timeout: 60000,
}, async (t) => {
  const project = await create(), original = await ws(project.id);
  const material = structuredClone(original.draft.resume_json);
  material.root.children.push({ id: 'import-text', type: 'element', tag: 'p', editable: true,
    semantic: { kind: 'paragraph' }, text: '王青，负责产品需求与交付。' });
  let recognized = 0, release;
  const waiting = new Promise((resolve) => { release = resolve; });
  recognition.setClientForTests(async () => {
    recognized++; await waiting;
    return { detected_format: 'docx', page_count: 1, parser_version: 'test', model_version: 'test',
      content_candidate: { resume_json: material }, layout_candidate: {},
      quality_report: { safe_to_review: true, requires_user_review: true }, warning_codes: [], previews: [] };
  });
  t.after(() => { release(); recognition.setClientForTests(null); helpers.queue.stopWorker(); });
  helpers.queue.startWorker(25);
  const requests = [];
  t.after(harness.setModelClientForTests(generationModel(requests)));
  const { evaluate, until, click, cdp, errors } = await openBrowser(t,
    ctx.base.replace('/api/v1', '/') + '?project=' + project.id);
  await evaluate(`(() => {
    const file=new File([new Uint8Array([80,75,3,4,20,0,0,0])],'resume.docx',
      {type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
    const transfer=new DataTransfer();transfer.items.add(file);
    const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change'));
  })()`);
  await until('chatAttachments.length===1 && chatAttachments[0].status==="ready"');
  assert.equal(recognized, 0, '选择附件不立即识别');
  await evaluate('document.querySelector("#prompt").value="请用附件制作简历";sendPrompt() && undefined');
  await until('!!preparingPrompt && !!preparingPrompt.items[0].document_import_id');
  await click('#stop-ai-request');
  await until('!promptBusy && chatAttachments.length===1');
  assert.match(await evaluate('document.querySelector("#prompt").value'), /请用附件/);
  assert.equal(requests.length, 0);
  release();
  await evaluate('sendPrompt() && undefined');
  await until('WS.conversation.messages.some(m=>m.actions && m.actions.some(a=>a.action_type==="RESUME_REWRITE_PROPOSAL"))', 15000);
  assert.equal(recognized, 1, '取消后继续复用同一识别结果');
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0].input.workspace.materials), /负责产品需求与交付/);
  await click('.chat-proposal .replace');
  await until('WS.versions.length===1');
  await click('#resume-document [data-resume-editable=true]');
  await cdp('Input.insertText', { text: '不能丢失的新文字' });
  await evaluate(`window.originalFetch=window.fetch;window.fetch=(url,options)=>{
    if(String(url).includes('/resume-draft/transactions'))return Promise.resolve(new Response(
      JSON.stringify({title:'SAVE_UNAVAILABLE',detail:'测试保存失败'}),{status:503,headers:{'content-type':'application/json'}}));
    return window.originalFetch(url,options);
  };navigateResume('')`);
  assert.equal(await evaluate('PROJECT_ID'), project.id);
  assert.equal(await evaluate('document.body.classList.contains("home-mode")'), false);
  assert.match(await evaluate('document.querySelector("#resume-document").textContent'), /不能丢失的新文字/);
  assert.match(await evaluate('document.querySelector("#toast").textContent'), /保存失败/);
  await evaluate('window.fetch=window.originalFetch;flushCurrentEdits()');
  assert.match(ResumeDom.plainText((await ws(project.id)).draft.resume_json), /不能丢失的新文字/);
  assert.deepEqual(errors, []);
});
