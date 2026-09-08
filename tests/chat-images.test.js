'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sharp = require('sharp');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const db = require('../server/lib/db');
const { objectPath } = require('../server/lib/storage');
const { openBrowser, available } = require('./browser-driver');

test('聊天图片完整链路：上传/纯图/多轮视觉/权限/重试/新对话清理，不写资料或正文', async (t) => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const workspace = async () => (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    body: { conversation_id: (await workspace()).conversation.id },
  });
  const before = await workspace();
  const conversationId = before.conversation.id;
  const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#125678' } }).png().toBuffer();
  const up = await helpers.call(ctx, 'POST', '/uploads', { body: {
    original_name: 'screenshot.png', mime_type: 'image/png', size: bytes.length, chat_conversation_id: conversationId,
  } });
  assert.equal(up.status, 200);
  const uploadId = up.body.id;
  const send = (body) => helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: { conversation_id: conversationId, scope_type: 'RESUME_DOCUMENT', ...body },
  });
  assert.equal((await send({ content: '参考图片', attachment_ids: [uploadId] })).status, 400);
  await fetch(ctx.base + `/uploads/${uploadId}/content`, { method: 'POST', body: bytes });
  assert.equal((await helpers.call(ctx, 'POST', `/uploads/${uploadId}/complete`, { body: {} })).status, 200);
  const requests = [];
  let fail = false;
  harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    if (fail) throw Object.assign(new Error('测试中断'), { code: 'MODEL_UNAVAILABLE' });
    return { output: { type: 'message', content: '已看到图片，可以继续告诉我如何修改简历。', quick_replies: [] } };
  } });
  const first = await send({ content: '', attachment_ids: [uploadId] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(requests[0].capability, 'vision');
  assert.ok(requests[0].messages.at(-1).content.some((part) => part.type === 'image_url'));
  const after = await workspace();
  assert.equal(after.conversation.messages[0].attachments[0].id, uploadId);
  assert.deepEqual(after.profile, before.profile);
  assert.deepEqual(after.draft, before.draft);
  assert.equal((await fetch(ctx.base + `/uploads/${uploadId}/preview`)).status, 200);
  assert.equal((await fetch(ctx.base + `/uploads/${uploadId}/preview`, { headers: { 'x-user-id': 'not-owner' } })).status, 401);
  assert.equal((await helpers.call(ctx, 'DELETE', `/uploads/${uploadId}`)).status, 409);
  const next = await send({ content: '沿用刚才图片的颜色', task_id: first.body.task_id });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(requests.at(-1).capability, 'vision');
  assert.ok(requests.at(-1).messages.slice(0, -1).some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url')));
  assert.equal(requests.at(-1).messages.at(-1).content, '沿用刚才图片的颜色');
  fail = true;
  const failed = await send({ content: '按图片继续', task_id: first.body.task_id, attachment_ids: [uploadId] });
  assert.ok(failed.status >= 400);
  fail = false;
  const failedMessage = (await workspace()).conversation.messages.at(-1);
  assert.ok(failedMessage.retry_message_id);
  assert.equal((await send({ retry_message_id: failedMessage.retry_message_id })).status, 200);
  assert.equal(requests.at(-1).capability, 'vision');
  const row = db.get('SELECT * FROM uploads WHERE id = ?', [uploadId]);
  assert.ok(fs.existsSync(objectPath(row.object_key)));
  assert.equal((await send({ content: '超量', attachment_ids: Array(9).fill(uploadId) })).status, 400);
  await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    body: { conversation_id: conversationId },
  });
  assert.equal(db.get('SELECT * FROM uploads WHERE id = ?', [uploadId]), null);
  assert.equal(fs.existsSync(objectPath(row.object_key)), false);
});

test('真实浏览器聊天图片：文件选择、粘贴、拖入、移除、纯图发送、刷新和后续文字', {
  skip: available ? false : '需要CHROME_BIN', timeout: 60000,
}, async (t) => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const workspace = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/conversations`, {
    body: { conversation_id: workspace.conversation.id },
  });
  const requests = [];
  harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    return { output: { type: 'message', content: '我已看到这张图片。', quick_replies: [] } };
  } });
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { evaluate, until, click, cdp } = browser;
  const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#aa3344' } }).png().toBuffer();
  await evaluate(`window.testImageBytes=${JSON.stringify([...bytes])}`);
  async function attach(kind) {
    await evaluate(`(() => {
      const file=new File([new Uint8Array(testImageBytes)],'example.png',{type:'image/png'});
      const transfer=new DataTransfer();transfer.items.add(file);
      ${kind === 'select' ? `const input=document.querySelector('#file-input');input.files=transfer.files;input.dispatchEvent(new Event('change'));`
    : kind === 'paste' ? `document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));`
      : `document.querySelector('#composer').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));`}
    })()`);
    await until('chatAttachments.length>0 && chatAttachments.every(item=>item.status==="ready")');
  }
  await attach('select');
  await click('#chat-attachments button');
  assert.equal(await evaluate('chatAttachments.length'), 0);
  await attach('paste');
  await attach('drop');
  assert.equal(await evaluate('chatAttachments.length'), 2);
  await click('.assistant-input .send');
  await until('!promptBusy && WS.conversation.messages.length===2');
  assert.equal(requests[0].messages.at(-1).content.filter((part) => part.type === 'image_url').length, 2);
  assert.equal(await evaluate('document.querySelectorAll(".bubble.user img").length'), 2);
  await evaluate('window.__imageReloadPending=true');
  await cdp('Page.reload');
  await until('!window.__imageReloadPending && Boolean(window.WS && WS.conversation.messages.length===2)');
  assert.equal(await evaluate('document.querySelectorAll(".bubble.user img").length'), 2);
  await until('[...document.querySelectorAll(".bubble.user img")].every(image=>image.complete&&image.naturalWidth>0)');
  await click('#prompt');
  await cdp('Input.insertText', { text: '按照图片里的样式调整' });
  await click('.assistant-input .send');
  await until('!promptBusy && WS.conversation.messages.length===4');
  assert.equal(requests.at(-1).capability, 'vision');
  await click('#new-chat-button');
  await click('#confirm-new-chat');
  await until('WS.conversation.messages.length===0');
  assert.equal(await evaluate('document.querySelectorAll(".bubble.user img").length'), 0);
  assert.deepEqual(browser.errors, []);
});
