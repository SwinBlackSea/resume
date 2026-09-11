'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');
const db = require('../server/lib/db');
const { uuidv7, nowIso } = require('../server/lib/util');
const harness = require('../server/lib/resume-harness');
const { messageAttachments } = require('../server/lib/message-attachments');
const { openBrowser, available } = require('./browser-driver');

async function fixture(t) {
  const app = await helpers.boot(); t.after(() => helpers.close(app));
  const call = (method, path, body) => helpers.call(app, method, path, { body });
  let intake = (await call('POST', '/home/intakes', {})).body;
  const uploads = [];
  for (const role of ['personal', 'job']) {
    const bytes = await sharp({ create: { width: 80, height: 100, channels: 3,
      background: role === 'personal' ? '#176c4d' : '#304d96' } }).png().toBuffer();
    const upload = (await call('POST', '/uploads', {
      original_name: `${role}.png`, mime_type: 'image/png', size: bytes.length,
    })).body;
    await fetch(`${app.base}/uploads/${upload.id}/content`, { method: 'POST', body: bytes });
    assert.equal((await call('POST', `/uploads/${upload.id}/complete`, {})).status, 200);
    const chosen = await call('PUT', `/home/intakes/${intake.id}/materials/${role}`,
      { upload_id: upload.id, image_material: true });
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    intake = chosen.body; uploads.push(upload);
  }
  intake = (await call('PUT', `/home/intakes/${intake.id}/materials/layout`, { layout_id: 'quiet' })).body;
  const requests = [];
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    return { output: { type: 'message', content: '已收到个人截图和岗位截图，请继续补充简历要求。', quick_replies: [] } };
  } }));
  const prepared = await call('POST', `/home/intakes/${intake.id}/prepare`, {});
  assert.equal(prepared.status, 200);
  const sent = await call('POST', `/projects/${intake.project_id}/ai/messages`, prepared.body.request);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const workspace = (await call('GET', `/projects/${intake.project_id}`)).body;
  const row = db.get("SELECT * FROM ai_messages WHERE conversation_id=? AND role='user'",
    [intake.conversation_id]);
  return { app, call, intake, uploads, requests, workspace, row };
}

test('首页截图按冻结消息恢复，旧图片导入兼容，不复制模型附件或泄漏其他项目', async t => {
  const { call, intake, uploads, workspace, row } = await fixture(t);
  const originalMetadata = row.model_metadata_json;
  const metadata = JSON.parse(originalMetadata);
  assert.deepEqual(metadata.attachment_ids, []);
  assert.equal(workspace.conversation.messages[0].attachments.length, 2);
  assert.deepEqual(workspace.conversation.messages[0].attachments.map(a => a.material_role), ['personal', 'job']);
  for (const attachment of workspace.conversation.messages[0].attachments) {
    assert.match(attachment.preview_url, /^\/api\/v1\/document-assets\//);
  }
  // Intake replacement cannot rewrite a previously accepted user message.
  db.run("UPDATE home_intakes SET state_json='{}' WHERE id=?", [intake.id]);
  assert.deepEqual((await call('GET', `/projects/${intake.project_id}`)).body.conversation.messages[0].attachments,
    workspace.conversation.messages[0].attachments);
  assert.equal(db.get('SELECT model_metadata_json FROM ai_messages WHERE id=?', [row.id]).model_metadata_json,
    originalMetadata);
  assert.equal(messageAttachments({ ...row, owner_id: 'not-owner' }, metadata).attachments.length, 0);
  const other = (await call('POST', '/home/intakes', {})).body;
  assert.equal(messageAttachments({ ...row, conversation_id: other.conversation_id }, metadata).attachments.length, 0);
  const importId = uuidv7();
  db.run(`INSERT INTO document_imports(id,project_id,upload_id,owner_id,status,created_at,updated_at)
    VALUES(?,?,?,?,'ready',?,?)`, [importId, intake.project_id, uploads[0].id, row.owner_id, nowIso(), nowIso()]);
  const legacy = structuredClone(metadata);
  legacy.home_materials.roles.personal = { kind: 'document', upload_id: uploads[0].id, document_import_id: importId };
  legacy.document_import_ids = [importId];
  legacy.attachment_ids = [uploads[0].id]; // Even mixed legacy metadata renders once.
  const view = messageAttachments(row, legacy);
  assert.equal(view.attachments.length, 2);
  assert.deepEqual(view.documents, []);
  assert.match(view.attachments[0].preview_url, /\/uploads\/.*\/preview$/);
});

test('真实浏览器首次详情、刷新与续聊均显示首页截图，部署 /resume 不漏前缀', {
  skip: !available, timeout: 60000,
}, async t => {
  const { app, call, intake, requests } = await fixture(t);
  const escaped = [];
  const proxy = http.createServer((req, res) => {
    if (!req.url.startsWith('/resume/')) {
      if (req.url !== '/favicon.ico') escaped.push(req.url);
      res.writeHead(502).end(); return;
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: app.port,
      method: req.method, path: req.url.slice('/resume'.length), headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const browser = await openBrowser(t,
    `http://127.0.0.1:${proxy.address().port}/resume/?project=${intake.project_id}`);
  const { evaluate, until, cdp, click } = browser;
  const loaded = `document.querySelectorAll('.bubble.user img').length===2 &&
    [...document.querySelectorAll('.bubble.user img')].every(i=>i.complete&&i.naturalWidth===80)`;
  await until(loaded);
  assert.equal(await evaluate(`[...document.querySelectorAll('.bubble.user img')].every(i=>
    new URL(i.src).pathname.startsWith('/resume/api/v1/document-assets/'))`), true);
  await evaluate('window.__awaitChatReload=true');
  await cdp('Page.reload');
  await until('!window.__awaitChatReload && window.WS && WS.conversation.messages.length===2');
  await until(loaded);
  await click('#prompt');
  await cdp('Input.insertText', { text: '继续按照刚才截图调整' });
  await click('.assistant-input .send');
  await until('!promptBusy && WS.conversation.messages.length===4');
  await until(loaded);
  assert.equal(requests.at(-1).capability, 'vision');
  assert.ok(requests.at(-1).messages.some(m => Array.isArray(m.content)
    && m.content.some(part => part.type === 'image_url')));
  const after = (await call('GET', `/projects/${intake.project_id}`)).body;
  assert.equal(after.conversation.messages.filter(m => m.attachments.length).length, 1);
  assert.deepEqual(escaped, []);
  assert.deepEqual(browser.errors, []);
});
