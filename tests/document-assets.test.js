'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
process.env.RESUME_OBJECTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-asset-objects-'));
const { boot, close, call, defaultProject, db, drainWorker } = require('./helpers');
const sharp = require('sharp');
const { putObject, getObject } = require('../server/lib/storage');
const { uuidv7, nowIso } = require('../server/lib/util');
const assets = require('../server/lib/document-assets');
const { createZip } = require('../server/lib/render/zip');
const { runCommand } = require('../server/lib/document-recognition/command');
const { pythonPath } = require('../server/lib/document-recognition/ocr');
const harness = require('../server/lib/resume-harness');
const R = require('../resume-dom');

async function setup(t) {
  const ctx = await boot(); t.after(() => close(ctx));
  const projectId = await defaultProject(ctx);
  const ws = (await call(ctx, 'GET', `/projects/${projectId}`)).body;
  return { ctx, projectId, ownerId: ws.user.id, conversationId: ws.conversation.id, ws };
}
function upload(state, buffer, mime = 'image/png', name = 'photo.png') {
  const id = uuidv7(), key = `${state.ownerId}/test-images/${id}`, stamp = nowIso();
  putObject(key, buffer);
  db.run(`INSERT INTO uploads(id,owner_id,object_key,original_name,mime_type,size,sha256,status,
    created_at,updated_at,chat_conversation_id) VALUES(?,?,?,?,?,?,?,'ready',?,?,?)`,
  [id, state.ownerId, key, name, mime, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex'),
    stamp, stamp, state.conversationId]);
  return { id, key };
}
const png = (color = '#a0b0c0') => sharp({ create: { width: 120, height: 160, channels: 3, background: color } }).png().toBuffer();

test('private immutable images reuse original bytes, normalized crops deduplicate, enforce bounds and ownership', async t => {
  const state = await setup(t), bytes = await png(), original = upload(state, bytes);
  const [first, second] = await Promise.all([
    assets.prepareUploadImages(original.id, state), assets.prepareUploadImages(original.id, state),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first[0].width, 120);
  assert.equal(first[0].height, 160);
  const row = db.get('SELECT * FROM document_assets WHERE id = ?', [first[0].asset_id]);
  assert.equal(row.object_key, original.key);
  assert.equal(db.get('SELECT count(*) AS n FROM document_image_cache WHERE upload_id = ?', [original.id]).n, 1);
  assert.deepEqual(assets.readDocumentAsset(row.id, state.ownerId).buffer, bytes);
  assert.throws(() => assets.readDocumentAsset(row.id, 'another-owner'));
  const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  const cropped = await assets.cropImage(first[0], crop, state.ownerId);
  assert.equal(cropped.width, 60); assert.equal(cropped.height, 80);
  assert.equal((await assets.cropImage(first[0], crop, state.ownerId)).id, cropped.id);
  await assert.rejects(assets.cropImage(first[0], { x: 0.8, y: 0, width: 0.5, height: 1 }, state.ownerId));
  await assert.rejects(assets.cropImage(first[0], { x: 0, y: 0, width: 0.01, height: 0.01 }, state.ownerId));
  const content = await fetch(`${state.ctx.base}/document-assets/${row.id}/content`);
  assert.equal(content.status, 200);
  assert.equal(content.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
  db.run(`INSERT INTO users(id,display_name,status,created_at,updated_at)
    VALUES('another-owner','Other','active',?,?)`, [nowIso(), nowIso()]);
  assert.equal((await fetch(`${state.ctx.base}/document-assets/${row.id}/content`, {
    headers: { 'x-user-id': 'another-owner' },
  })).status, 404);
});

test('orientation-normalized model references match original crop coordinates', async t => {
  const state = await setup(t);
  const bytes = await sharp(await png()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const original = upload(state, bytes, 'image/jpeg', 'photo.jpg');
  const [candidate] = await assets.prepareUploadImages(original.id, state);
  assert.equal(candidate.width, 160); assert.equal(candidate.height, 120);
  const model = await assets.modelImage(candidate, state.ownerId);
  assert.equal(model.model_width, 160); assert.equal(model.model_height, 120);
  const cropped = await assets.cropImage(candidate, { x: 0, y: 0, width: 0.5, height: 1 }, state.ownerId);
  assert.equal(cropped.width, 80); assert.equal(cropped.height, 120);
});

test('eight uploaded images can be prepared concurrently without parser limit rejecting supported attachment count', async t => {
  const state = await setup(t);
  const uploads = await Promise.all(Array.from({ length: 8 }, async (_, index) =>
    upload(state, await png(`#${(0x110000 + index * 300).toString(16)}`))));
  const candidates = await Promise.all(uploads.map(original => assets.prepareUploadImages(original.id, state)));
  assert.equal(candidates.length, 8);
  assert.equal(new Set(candidates.map(items => items[0].input_image_id)).size, 8);
});

test('DOCX extracts embedded image with actual source crop and rotation, cache does not parse again', async t => {
  const state = await setup(t);
  const xml = `<w:document xmlns:w="w" xmlns:a="a" xmlns:wp="wp" xmlns:r="r"><w:body><w:p><w:r>
    <w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:blip r:embed="rId1"/>
    <a:srcRect l="25000" r="25000" t="0" b="0"/><a:xfrm rot="5400000"/></wp:inline></w:drawing>
    </w:r></w:p></w:body></w:document>`;
  const buffer = createZip([
    { name: 'word/document.xml', data: xml },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="media/photo.png"/></Relationships>' },
    { name: 'word/media/photo.png', data: await png() },
  ]);
  const original = upload(state, buffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'resume.docx');
  const candidates = await assets.prepareUploadImages(original.id, state);
  assert.equal(candidates.length, 1); assert.equal(candidates[0].kind, 'embedded_image');
  assert.equal(candidates[0].width, 160); assert.equal(candidates[0].height, 60);
  assert.equal(candidates[0].placement.width_emu, 914400);
  // Corrupting a test copy proves the completed extraction cache does not
  // re-recognize the import on each follow-up.
  putObject(original.key, Buffer.from('not zip'));
  assert.deepEqual(await assets.prepareUploadImages(original.id, state), candidates);
});

test('PDF extracts native pictures and page reference for locating a scan or clipped photo', async t => {
  const state = await setup(t);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-native-pdf-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'portrait.png');
  const pdfPath = path.join(tempDir, 'resume.pdf');
  fs.writeFileSync(imagePath, await png());
  await runCommand(pythonPath(), ['-c',
    'import fitz,sys; d=fitz.open(); p=d.new_page(); p.insert_text((30,30),"Fictional resume"); p.insert_image(fitz.Rect(400,30,490,150),filename=sys.argv[1]); d.save(sys.argv[2])',
    imagePath, pdfPath]);
  const original = upload(state, fs.readFileSync(pdfPath), 'application/pdf', 'resume.pdf');
  const candidates = await assets.prepareUploadImages(original.id, state);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].kind, 'page_reference');
  assert.equal(candidates[1].kind, 'embedded_image');
  assert.equal(candidates[1].width, 120);
  assert.deepEqual(candidates[1].placement.rectangles[0], [400, 30, 490, 150]);
});

test('scan-only PDF offers a page-coordinate image without pretending the whole page is an extracted portrait', async t => {
  const state = await setup(t), tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-scan-pdf-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'scan.png'), pdfPath = path.join(tempDir, 'scan.pdf');
  const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#fff' } })
    .composite([{ input: await png(), left: 440, top: 35 }]).png().toBuffer();
  fs.writeFileSync(imagePath, image);
  await runCommand(pythonPath(), ['-c',
    'import fitz,sys; d=fitz.open(); p=d.new_page(width=600,height=800); p.insert_image(p.rect,filename=sys.argv[1]); d.save(sys.argv[2])',
    imagePath, pdfPath]);
  const original = upload(state, fs.readFileSync(pdfPath), 'application/pdf', 'scan.pdf');
  const candidates = await assets.prepareUploadImages(original.id, state);
  assert.equal(candidates[0].kind, 'page_reference');
  assert.ok(candidates.every(candidate => candidate.kind !== 'portrait'));
  const cropped = await assets.cropImage(candidates.find(candidate => candidate.kind === 'embedded_image'),
    { x: 440 / 600, y: 35 / 800, width: 120 / 600, height: 160 / 800 }, state.ownerId);
  assert.equal(cropped.width, 120); assert.equal(cropped.height, 160);
});

test('DOC and DOCX import preserve photos, editable text and reusable native candidates through preview and apply', async t => {
  const state = await setup(t), tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-doc-photo-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const file = path.join(tempDir, 'portrait.docx');
  fs.writeFileSync(file, createZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Fictional applicant</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="1219200"/><wp:docPr id="1" name="Photo"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Photo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="photo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="1219200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>' },
    { name: 'word/_rels/document.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="photo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/photo.png"/></Relationships>' },
    { name: 'word/media/photo.png', data: await png('#994411') },
  ]));
  await runCommand('libreoffice', ['--headless', '--convert-to', 'doc:MS Word 97', '--outdir', tempDir, file],
    { cwd: tempDir, timeout: 90000 });
  const original = upload(state, fs.readFileSync(path.join(tempDir, 'portrait.doc')), 'application/msword', 'portrait.doc');
  const candidates = await assets.prepareUploadImages(original.id, state);
  assert.ok(candidates.length >= 1);
  assert.ok(candidates.some(candidate => candidate.width === 120 && candidate.height === 160));
  const docxUpload = upload(state, fs.readFileSync(file),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'portrait.docx');
  for (const source of [docxUpload, original]) {
    const before = (await call(state.ctx, 'GET', `/projects/${state.projectId}`)).body.draft;
    const created = await call(state.ctx, 'POST', `/projects/${state.projectId}/document-imports`, {
      body: { upload_id: source.id, entry_context: 'workspace' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    await drainWorker();
    const recognized = await call(state.ctx, 'GET', `/document-imports/${created.body.id}`);
    assert.equal(recognized.body.status, 'needs_review', JSON.stringify(recognized.body));
    assert.ok(recognized.body.warning_codes.includes('WORD_IMAGES_PRESERVED_IN_PAGE_SCENE'));
    const document = R.toResumeDocument(recognized.body.document_candidate.resume_json);
    const nodes = [];
    (function walk(node) { nodes.push(node); (node.children || []).forEach(walk); })(document.root);
    const background = nodes.find(node => node.attributes?.['data-scene-background-artifact-id']);
    assert.ok(background, 'page scene preserves the real embedded photo');
    assert.ok(nodes.some(node => node.editable && /Fictional applicant/.test(R.plainText({
      schema_version: R.RESUME_DOCUMENT_VERSION, root: node,
    }))), 'recognized text remains genuinely editable');
    const artifact = db.get('SELECT * FROM artifacts WHERE id = ?',
      [background.attributes['data-scene-background-artifact-id']]);
    const { data, info } = await sharp(getObject(artifact.object_key)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let photoPixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      if (Math.abs(data[offset] - 153) < 5 && Math.abs(data[offset + 1] - 68) < 5
        && Math.abs(data[offset + 2] - 17) < 5) photoPixels++;
    }
    assert.ok(photoPixels > 1000, 'the actual photo pixels survive, not a blank placeholder');
    assert.ok(db.get('SELECT * FROM document_image_cache WHERE upload_id = ?', [source.id]));
    const reviewed = await call(state.ctx, 'POST', `/document-imports/${created.body.id}/review`, {
      body: { accepted: true },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const applied = await call(state.ctx, 'POST', `/document-imports/${created.body.id}/apply`, {
      body: { expected_draft_revision: before.revision, mutation_id: uuidv7() },
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    const after = (await call(state.ctx, 'GET', `/projects/${state.projectId}`)).body.draft.resume_json;
    assert.match(R.plainText(after), /Fictional applicant/);
    assert.match(JSON.stringify(after), new RegExp(background.attributes['data-scene-background-artifact-id']));
    assert.equal(applied.body.version_created, true);
    if (source.id === docxUpload.id) {
      // Simulate an unsupported native artwork parser after successful
      // recognition: the existing preview is reused without a second OCR.
      db.run('DELETE FROM document_image_cache WHERE upload_id = ?', [source.id]);
      putObject(source.key, Buffer.from('unsupported-native-artwork-fixture'));
      const fallback = await assets.prepareUploadImages(source.id, state);
      assert.ok(fallback.length);
      assert.ok(fallback.every(candidate => candidate.kind === 'page_reference'));
      assert.ok(fallback.every(candidate => assets.readDocumentAsset(candidate.asset_id, state.ownerId).buffer.length > 100));
    }
  }
});

test('image materializer supports resource-only replacement, denies foreign tasks and reference portrait use', async t => {
  const state = await setup(t), original = upload(state, await png('#ff55ff'));
  const [candidate] = await assets.prepareUploadImages(original.id, state);
  const doc = R.toResumeDocument(state.ws.draft.resume_json);
  doc.root.children.push({ id: 'existing-photo', type: 'element', tag: 'img', children: [] });
  const input = { workspace: { resume: { content: doc } }, image_sources: [candidate],
    asset_authorization: { ownerId: state.ownerId } };
  const response = () => ({ actions: [{ type: 'RESUME_REWRITE_PROPOSAL', payload: { proposal: {
    target_resume_fragments: { format: 'resume-target-fragments-v2', changes: [], insertions: [] },
    asset_requests: [{ input_image_id: candidate.input_image_id, target_node_id: 'existing-photo', crop: null, purpose: 'portrait' }],
  } } }] });
  const { materializeImages } = require('../server/lib/resume-harness/image-materializer');
  const accepted = response();
  assert.deepEqual(await materializeImages(accepted, input, null, []), []);
  assert.equal(R.findNode(accepted.actions[0].payload.proposal.target_resume_document, 'existing-photo')
    .node.attributes['data-document-asset-id'], candidate.asset_id);
  assert.ok((await materializeImages(response(), { ...input, image_sources: [] }, null, [])).length);
  assert.ok((await materializeImages(response(), { ...input, image_sources: [{ ...candidate, material_role: 'layout' }] }, null, [])).length);
  const referenceImageRequest = response();
  referenceImageRequest.actions[0].payload.proposal.asset_requests[0].purpose = 'image';
  assert.ok((await materializeImages(referenceImageRequest, {
    ...input, image_sources: [{ ...candidate, material_role: 'layout', reference_only: true }],
  }, null, [])).length);
  const wrongNode = response();
  wrongNode.actions[0].payload.proposal.asset_requests[0].target_node_id = doc.root.id;
  assert.ok((await materializeImages(wrongNode, input, null, [])).length);
  assert.throws(() => assets.validateDocumentAssets({ root: { attributes: {
    'data-document-asset-id': candidate.asset_id, src: '/api/v1/document-assets/not-the-same/content',
  } } }, state.ownerId));
  assert.throws(() => assets.validateDocumentAssets({ root: { attributes: {
    src: `/api/v1/document-assets/${candidate.asset_id}/content`,
  } } }, 'another-owner'));
});

test('global sparse image insertion becomes previewable proposal, applies once, survives chat cleanup and history copy', async t => {
  const state = await setup(t), original = upload(state, await png('#123abc'));
  const requests = [];
  t.after(harness.setModelClientForTests({ async generate(request) {
    requests.push(request);
    const base = request.input.workspace.resume.proposal_content || request.input.workspace.resume.content;
    const image = request.input.image_sources[0];
    return { output: { type: 'proposal', content: '照片修改建议已准备好', proposal: {
      asset_requests: [{ input_image_id: image.input_image_id, target_node_id: 'portrait-test',
        purpose: 'portrait', crop: null }],
      target_resume_fragments: { format: 'resume-target-fragments-v2', changes: [], insertions: [{
        parent_id: base.root.id, after_id: null, new_subtrees: [
          { id: 'portrait-test', type: 'element', tag: 'img', style: { width: '90px', height: '120px' }, children: [] },
        ],
      }] },
      change_constraints: { content: 'preserve', structure: 'modify', style: 'modify',
        content_order: 'preserve', allowed_region_ids: [base.root.id] },
    } } };
  } }));
  const sent = await call(state.ctx, 'POST', `/projects/${state.projectId}/ai/messages`, { body: {
    conversation_id: state.conversationId, content: '将这张照片放入简历右上角', attachment_ids: [original.id],
  } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const response = (await call(state.ctx, 'GET', `/projects/${state.projectId}`)).body;
  assert.ok(!R.findNode(response.draft.resume_json, 'portrait-test'));
  const action = response.conversation.messages.flatMap(message => message.actions || []).find(action => action.action_type === 'RESUME_REWRITE_PROPOSAL');
  const rows = db.all("SELECT * FROM ai_action_requests WHERE owner_id=? AND action_type='RESUME_REWRITE_PROPOSAL' ORDER BY created_at DESC", [state.ownerId]);
  const actionId = action?.id || rows[0].id;
  const preview = await call(state.ctx, 'GET', `/ai/actions/${actionId}/preview`);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const target = preview.body.target_resume_document || preview.body.resume_document;
  const image = R.findNode(target, 'portrait-test')?.node;
  assert.ok(image, JSON.stringify(preview.body).slice(0, 600));
  assert.ok(image.attributes['data-document-asset-id']);
  assert.equal(target.assets.length > 0, true);
  const models = requests[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  assert.ok(models.some(part => part.type === 'text' && part.text.includes('input_image_id')));
  assert.equal(models.at(-1).type, 'image_url');
  const applied = await call(state.ctx, 'POST', `/ai/actions/${actionId}/apply`, {
    body: { preview_revision: preview.body.preview_revision },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const after = (await call(state.ctx, 'GET', `/projects/${state.projectId}`)).body;
  assert.ok(R.findNode(after.draft.resume_json, 'portrait-test'));
  const reset = await call(state.ctx, 'POST', `/projects/${state.projectId}/ai/conversations`,
    { body: { conversation_id: state.conversationId } });
  assert.equal(reset.status, 200);
  assets.collectUnusedAssets(state.ownerId, { graceMs: 0 });
  assert.ok(assets.readDocumentAsset(image.attributes['data-document-asset-id'], state.ownerId).buffer);
  assert.ok(getObject(original.key), 'original object retained after chat upload ownership was removed');
});

test('orphan crop collection protects compressed reapply and undo documents, unknown private ID rejects', async t => {
  const state = await setup(t);
  const keep = await assets.storeImage(await png('#ff0000'), state.ownerId);
  const orphan = await assets.storeImage(await png('#00ff00'), state.ownerId);
  assert.throws(() => assets.validateDocumentAssets({ root: { attributes: { 'data-document-asset-id': 'missing' } } }, state.ownerId));
  const doc = R.toResumeDocument(state.ws.draft.resume_json);
  doc.assets = [keep]; doc.root.children.push({ id: 'kept-image', type: 'element', tag: 'img',
    attributes: { src: keep.url, 'data-document-asset-id': keep.id }, children: [] });
  const proposal = { base_resume_json: state.ws.draft.resume_json, target_resume_document: doc };
  require('../server/lib/proposal-reapply').retainReapply(proposal);
  delete proposal.base_resume_json; delete proposal.target_resume_document;
  db.run(`INSERT INTO ai_action_requests(id,conversation_id,owner_id,action_type,payload_json,status,created_at)
    VALUES(?,?,?,'RESUME_REWRITE_PROPOSAL',?,'applied',?)`,
  [uuidv7(), state.conversationId, state.ownerId, JSON.stringify({ proposal }), nowIso()]);
  db.run("UPDATE document_assets SET created_at='2000-01-01T00:00:00Z' WHERE id IN (?,?)", [keep.id, orphan.id]);
  const result = assets.collectUnusedAssets(state.ownerId, { graceMs: 0 });
  assert.equal(result.deferred, false);
  assert.ok(assets.readDocumentAsset(keep.id, state.ownerId));
  assert.throws(() => assets.readDocumentAsset(orphan.id, state.ownerId));
});
