'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.RESUME_OBJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-image-edit-objects-'));
const h = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { uuidv7, nowIso } = require('../server/lib/util');
const assets = require('../server/lib/document-assets');
const { openBrowser } = require('./browser-driver');
const R = require('../resume-dom');
const { canReplaceImage } = require('../resume-image-edit');
const png = (color, width = 80, height = 120) => sharp({ create: {
  width, height, channels: 3, background: color,
} }).png().toBuffer();
async function setup(t) {
  const ctx = await h.boot(); t.after(() => h.close(ctx));
  const projectId = await h.defaultProject(ctx);
  const ws = (await h.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const asset = await assets.storeImage(await png('#133755'), ws.user.id);
  const document = R.toResumeDocument({ schema_version: R.RESUME_DOCUMENT_VERSION,
    assets: [asset], root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'photo', type: 'element', tag: 'img', attributes: { src: asset.url,
        'data-document-asset-id': asset.id, alt: '本人照片' },
      style: { width: '80px', height: '120px', 'object-fit': 'cover', float: 'right' }, children: [] },
      { id: 'summary', type: 'element', tag: 'p', editable: true, text: '虚构测试简历正文', children: [] },
    ] } });
  const saved = await h.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
    body: { revision: ws.draft.revision, resume_json: document },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { ctx, projectId, ownerId: ws.user.id, revision: saved.body.revision, asset, document };
}
async function upload(state, bytes, name = 'replacement.png', mime = 'image/png') {
  const created = await h.call(state.ctx, 'POST', '/uploads', {
    body: { original_name: name, mime_type: mime, size: bytes.length },
  });
  assert.equal(created.status, 200);
  assert.equal((await fetch(state.ctx.base + `/uploads/${created.body.id}/content`, {
    method: 'POST', body: bytes,
  })).status, 200);
  const complete = await h.call(state.ctx, 'POST', `/uploads/${created.body.id}/complete`);
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return created.body.id;
}
test('image replacement uses immutable resources and the existing compact five-step undo, with ownership/revision/replay protection', async t => {
  const state = await setup(t);
  const uploadId = await upload(state, await png('#ba2050', 160, 100));
  const endpoint = `/projects/${state.projectId}/resume-draft/images/photo`;
  const body = { upload_id: uploadId, expected_revision: state.revision, mutation_id: uuidv7() };
  const beforeAI = h.db.get('SELECT count(*) AS n FROM ai_messages').n;
  const wrongRevision = await h.call(state.ctx, 'POST', endpoint, { body: { ...body, expected_revision: -1 } });
  assert.equal(wrongRevision.status, 409);
  h.db.run(`INSERT INTO users(id,display_name,status,created_at,updated_at)
    VALUES('image-other-owner','Other','active',?,?)`, [nowIso(), nowIso()]);
  assert.equal((await h.call(state.ctx, 'POST', endpoint, { body, user: 'image-other-owner' })).status, 404);
  const replaced = await h.call(state.ctx, 'POST', endpoint, { body });
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  const next = replaced.body.resume_json, node = R.findNode(next, 'photo').node;
  assert.deepEqual(node.style, R.findNode(state.document, 'photo').node.style);
  const nextAsset = node.attributes['data-document-asset-id'];
  assert.notEqual(nextAsset, state.asset.id);
  assert.equal(assets.readDocumentAsset(nextAsset, state.ownerId).width, 160);
  assert.equal(assets.readDocumentAsset(nextAsset, state.ownerId).height, 100, 'no implicit crop');
  assert.equal(h.db.get('SELECT count(*) AS n FROM ai_messages').n, beforeAI, 'no model invocation');
  const event = h.db.get('SELECT * FROM resume_change_events WHERE id = ?', [replaced.body.change_id]);
  assert.equal(event.change_type, 'document_transaction');
  assert.equal(JSON.parse(event.after_json).resume_json, undefined, 'compact node + resource metadata, not a full document copy');
  assert.equal((await h.call(state.ctx, 'DELETE', `/uploads/${uploadId}`)).status, 200);
  assert.ok(assets.readDocumentAsset(nextAsset, state.ownerId).buffer.length, 'upload deletion preserves draft resource bytes');
  assert.equal((await h.call(state.ctx, 'POST', endpoint, { body })).body.idempotent_replay, true);
  assert.equal((await h.call(state.ctx, 'POST', endpoint, {
    body: { ...body, upload_id: 'different-upload' },
  })).status, 409);
  const undo = await h.call(state.ctx, 'POST', `/projects/${state.projectId}/resume-draft/undo`, { body: {} });
  assert.equal(undo.status, 200, JSON.stringify(undo.body));
  assert.equal(R.findNode(undo.body.resume_json, 'photo').node.attributes['data-document-asset-id'], state.asset.id);
  assert.deepEqual(undo.body.resume_json.assets, state.document.assets);
  assets.collectUnusedAssets(state.ownerId, { graceMs: 0 });
  assert.ok(assets.readDocumentAsset(nextAsset, state.ownerId).buffer.length, 'redo protects replacement');
  const redo = await h.call(state.ctx, 'POST', `/projects/${state.projectId}/resume-draft/redo`, { body: {} });
  assert.equal(redo.status, 200, JSON.stringify(redo.body));
  assert.deepEqual(redo.body.resume_json, next);
  assert.equal((await h.call(state.ctx, 'POST', `/projects/${state.projectId}/resume-draft/images/summary`, {
    body: { ...body, mutation_id: uuidv7(), expected_revision: redo.body.revision },
  })).status, 422);
});

test('page/scan scene backgrounds cannot be mistaken for individually replaceable pictures', () => {
  for (const attribute of ['data-scene-background-artifact-id', 'data-scene-background-page', 'data-page-background']) {
    const document = { root: { id: 'page', children: [
      { id: 'photo', tag: 'img', attributes: { [attribute]: '1' }, children: [] },
    ] } };
    assert.equal(canReplaceImage(document, 'photo'), false);
  }
  assert.equal(canReplaceImage({ root: { id: 'page',
    attributes: { 'data-scene-background-page': '1' },
    children: [{ id: 'photo', tag: 'img' }] } }, 'photo'), false);
});

test('concurrent replacements recheck revision after async image reading and reject foreign resources', async t => {
  const state = await setup(t);
  const first = await upload(state, await png('#402060'));
  const second = await upload(state, await png('#a03010'));
  const body = uploadId => ({ upload_id: uploadId, expected_revision: state.revision, mutation_id: uuidv7() });
  const results = await Promise.all([first, second].map(uploadId =>
    h.call(state.ctx, 'POST', `/projects/${state.projectId}/resume-draft/images/photo`, { body: body(uploadId) })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const latest = (await h.call(state.ctx, 'GET', `/projects/${state.projectId}`)).body.draft;
  h.db.run(`INSERT OR IGNORE INTO users(id,display_name,status,created_at,updated_at)
    VALUES('image-foreign-owner','Other','active',?,?)`, [nowIso(), nowIso()]);
  const foreign = await assets.storeImage(await png('#903074'), 'image-foreign-owner');
  const attempt = await h.call(state.ctx, 'POST', `/projects/${state.projectId}/resume-draft/transactions`, {
    body: { expected_revision: latest.revision, mutation_id: uuidv7(),
      operations: [{ op: 'replace_image', node_id: 'photo', asset_id: foreign.id }] },
  });
  assert.equal(attempt.status, 422);
  assert.deepEqual((await h.call(state.ctx, 'GET', `/projects/${state.projectId}`)).body.draft.resume_json, latest.resume_json);
  for (const uploadId of [first, second]) assert.equal((await h.call(state.ctx, 'DELETE', `/uploads/${uploadId}`)).status, 200);
});

test('real browser: click photo, choose local file, save, undo/redo/reload, cancel and preserve pending text', { timeout: 60000 }, async t => {
  const state = await setup(t), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-image-edit-browser-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'replacement.png');
  fs.writeFileSync(file, await png('#229944', 160, 100));
  const browser = await openBrowser(t, state.ctx.base.replace('/api/v1', '/?project=' + state.projectId));
  await browser.until('document.querySelector("#resume-document img[data-node-id=photo]")?.naturalWidth===80');
  await browser.evaluate(`(() => {var text=document.querySelector('[data-node-id=summary]');text.textContent='未失焦的文字也要保存';})()`);
  await browser.click('#resume-document img[data-node-id=photo]');
  await browser.until('document.querySelector("#resume-image-dialog").open');
  await browser.click('#resume-image-dialog [data-cancel]');
  assert.equal(await browser.evaluate('document.querySelector("#resume-image-dialog").open'), false);
  await browser.click('#resume-document img[data-node-id=photo]');
  const { root } = await browser.cdp('DOM.getDocument');
  const { nodeId } = await browser.cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#resume-image-dialog input' });
  await browser.cdp('DOM.setFileInputFiles', { nodeId, files: [file] });
  await browser.until('!document.querySelector("#resume-image-dialog [data-save]").disabled');
  await browser.click('#resume-image-dialog [data-save]');
  await browser.until('!document.querySelector("#resume-image-dialog").open && document.querySelector("#resume-document img[data-node-id=photo]")?.naturalWidth===160');
  const latest = (await h.call(state.ctx, 'GET', `/projects/${state.projectId}`)).body;
  assert.match(R.plainText(latest.draft.resume_json), /未失焦的文字也要保存/);
  assert.deepEqual(R.findNode(latest.draft.resume_json, 'photo').node.style, R.findNode(state.document, 'photo').node.style);
  await browser.click('#undo-step');
  await browser.until('document.querySelector("#resume-document img[data-node-id=photo]")?.naturalWidth===80');
  assert.match(await browser.evaluate('document.querySelector("#resume-document").textContent'), /未失焦的文字也要保存/);
  await browser.click('#redo-step');
  await browser.until('document.querySelector("#resume-document img[data-node-id=photo]")?.naturalWidth===160');
  await browser.cdp('Page.reload');
  await browser.until('document.querySelector("#resume-document img[data-node-id=photo]")?.naturalWidth===160');
  assert.deepEqual(browser.errors, []);
});
