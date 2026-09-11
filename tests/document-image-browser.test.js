'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const db = require('../server/lib/db');
const { openBrowser } = require('./browser-driver');
const { storeImage, collectUnusedAssets } = require('../server/lib/document-assets');
const { document: example } = require('./fixtures/full-resume-comparison');

test('真实浏览器与API：私有头像显示、草稿及版本PDF/Word导出、版本保护图片', { timeout: 60000 }, async t => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  let ws = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const owner = db.get('SELECT owner_id FROM resume_projects WHERE id=?', [projectId]).owner_id;
  const asset = await storeImage(await sharp({ create: { width: 100, height: 150, channels: 3,
    background: '#187c87' } }).png().toBuffer(), owner);
  const doc = example('single');
  doc.root.children.unshift({ id: 'owned-portrait', type: 'element', tag: 'img',
    attributes: { 'data-document-asset-id': asset.id, src: asset.url, alt: '候选人照片' },
    style: { width: '60px', height: '90px', float: 'right', 'object-fit': 'cover' } });
  doc.assets = [asset];
  const patch = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
    body: { revision: ws.draft.revision, resume_json: doc },
  });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  ws = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/?project=' + projectId));
  await browser.until(`document.querySelector('#resume-document img[data-document-asset-id]')?.naturalWidth===100`);
  assert.equal(await browser.evaluate(`document.querySelector('#resume-document img[data-document-asset-id]').getAttribute('data-image-error')`), null);
  for (const format of ['pdf', 'docx']) {
    const response = await fetch(ctx.base + `/projects/${projectId}/resume-draft/download?format=${format}&revision=${ws.draft.revision}`);
    assert.equal(response.status, 200, `${format} download`);
    const output = Buffer.from(await response.arrayBuffer());
    assert.ok(output.length > 2000);
    if (format === 'pdf') assert.match(output.toString('latin1'), /\/Subtype\s*\/Image/);
    else assert.match(output.toString('utf8'), /word\/media\/image1.png/);
  }
  const saved = await helpers.call(ctx, 'POST', `/projects/${projectId}/versions`, {
    idemKey: 'portrait-browser-version', body: { name: '带照片的简历', draft_revision: ws.draft.revision,
      profile_revision: ws.profile.revision, job_revision: ws.job.revision },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const exported = await helpers.call(ctx, 'POST', `/versions/${saved.body.id}/export`, { body: {} });
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.deepEqual(exported.body.artifacts.map(a => a.type).sort(), ['docx', 'html', 'pdf']);
  const again = await helpers.call(ctx, 'POST', `/versions/${saved.body.id}/export`, { body: {} });
  assert.deepEqual(again.body.artifacts, exported.body.artifacts, '重复下载复用同版导出，不重复存储正文和图片');
  // Current draft no longer refers to it; immutable history must still protect it.
  const withoutPhoto = example('single');
  db.run('UPDATE resume_drafts SET resume_json=? WHERE project_id=?', [JSON.stringify(withoutPhoto), projectId]);
  collectUnusedAssets(owner, { graceMs: 0 });
  const retained = await fetch(ctx.base + `/document-assets/${asset.id}/content`);
  assert.equal(retained.status, 200);
  assert.deepEqual(browser.errors, []);
});
