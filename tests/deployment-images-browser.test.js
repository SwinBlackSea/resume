'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');
const db = require('../server/lib/db');
const { storeImage } = require('../server/lib/document-assets');
const { listBuiltinLayouts } = require('../server/lib/builtin-layouts');
const { buildChangePreview } = require('../server/lib/resume-change-preview');
const { document: example } = require('./fixtures/full-resume-comparison');
const { openBrowser, available } = require('./browser-driver');

// Exercise the same strip-prefix behavior as the production reverse proxy.
// Requests outside the mount fail, so a root-only image URL cannot pass.
async function mount(t, app, prefix) {
  const escaped = [];
  const proxy = http.createServer((req, res) => {
    if (!req.url.startsWith(prefix + '/')) {
      if (req.url !== '/favicon.ico') escaped.push(req.url);
      res.writeHead(502).end('outside deployment mount');
      return;
    }
    const upstream = http.request({
      hostname: '127.0.0.1', port: app.port, method: req.method,
      path: req.url.slice(prefix.length), headers: req.headers,
    }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502).end(); });
    req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  return { origin: `http://127.0.0.1:${proxy.address().port}${prefix}/`, escaped };
}

for (const prefix of ['', '/resume', '/tools/resume']) {
  test(`真实Chromium：${prefix || '/'}部署图片、预览和图库不越过网关前缀，不污染文档`, {
    skip: !available, timeout: 60000,
  }, async t => {
    const app = await helpers.boot();
    t.after(() => helpers.close(app));
    const id = await helpers.defaultProject(app);
    const owner = db.get('SELECT owner_id FROM resume_projects WHERE id=?', [id]).owner_id;
    const asset = await storeImage(await sharp({ create: {
      width: 96, height: 128, channels: 3, background: '#358a76',
    } }).png().toBuffer(), owner);
    const doc = example('single');
    doc.root.children.unshift({ id: 'mount-portrait', type: 'element', tag: 'img',
      attributes: { src: asset.url, 'data-document-asset-id': asset.id, alt: '测试头像' },
      style: { width: '48px', height: '64px' } });
    doc.assets = [asset];
    const original = (await helpers.call(app, 'GET', `/projects/${id}`)).body.draft;
    const patched = await helpers.call(app, 'PATCH', `/projects/${id}/resume-draft`, {
      body: { revision: original.revision, resume_json: doc },
    });
    assert.equal(patched.status, 200);
    const saved = (await helpers.call(app, 'GET', `/projects/${id}`)).body.draft;
    const gateway = await mount(t, app, prefix);
    const browser = await openBrowser(t, gateway.origin + '?project=' + id);
    const { evaluate, until, click, cdp } = browser;
    const mapped = prefix + asset.url;
    async function imageAt(selector) {
      await until(`document.querySelector(${JSON.stringify(selector)})?.naturalWidth===96`);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('src')`), mapped);
    }
    await imageAt('#resume-document img[data-document-asset-id]');
    const paths = ['/api/v1/a?x=1#b', prefix + '/api/v1/a', '/api/v10/a',
      'https://example.invalid/api/v1/a', '//example.invalid/api/v1/a', 'data:image/png;base64,AA==', 'blob:example'];
    const converted = await evaluate(`${JSON.stringify(paths)}.map(toApiUrl)`);
    assert.deepEqual(converted, [prefix + '/api/v1/a?x=1#b', prefix + '/api/v1/a', ...paths.slice(2)]);

    await click('#preview-current');
    await imageAt('#resume-preview-document img[data-document-asset-id]');
    await click('#resume-preview-modal .close');
    await evaluate(`renderHistoryResume('#snapshot-resume',WS.draft.resume_json,'snapshot')`);
    await imageAt('#snapshot-resume img[data-document-asset-id]');
    const before = structuredClone(doc);
    before.root.children.shift();
    const preview = buildChangePreview(before, doc);
    await evaluate(`renderProposalDiff(document.querySelector('#proposal-diff-content'),'','',[],
      ${JSON.stringify({ before, after: doc, preview })});openModal('#proposal-diff-modal')`);
    await imageAt('#proposal-diff-content img[data-document-asset-id]');
    await click('#proposal-diff-modal .close');

    await click('.brand');
    await until('document.body.classList.contains("home-mode")&&window.homeController');
    await click('#home-layout-toggle');
    await until('document.querySelectorAll("[data-layout-id]").length===20');
    await until('[...document.querySelectorAll(".home-layout-image-button img")].every(i=>i.complete&&i.naturalWidth>0)');
    const layout = listBuiltinLayouts().find(item => item.id === 'rr-azurill');
    assert.equal(await evaluate(`document.querySelector('.home-layout-image-button img').getAttribute('src')`),
      prefix + layout.preview_url);
    await click('[data-layout-id="rr-azurill"]');
    await until('document.querySelector("#home-layout-full-image").naturalWidth>0&&!document.querySelector("#home-layout-use").disabled');
    assert.equal(await evaluate(`document.querySelector('#home-layout-full-image').getAttribute('src')`),
      prefix + layout.image_url);
    await click('#home-layout-use');
    await until('!document.querySelector("#home-layout-dialog").open&&document.querySelector("#home-layout-selected-image").naturalWidth>0');
    assert.equal(await evaluate(`document.querySelector('#home-layout-selected-image').getAttribute('src')`),
      prefix + layout.preview_url);
    await evaluate('window.__mountPage=true');
    await cdp('Page.reload');
    await until('!window.__mountPage&&document.querySelector("#home-layout-selected-image")?.naturalWidth>0');
    assert.equal(await evaluate('homeController.getState().intake.materials.layout.layout_id'), 'rr-azurill');
    assert.deepEqual((await helpers.call(app, 'GET', `/projects/${id}`)).body.draft, saved,
      '显示路径不能写回文档、触发保存或改变版本');
    assert.deepEqual(gateway.escaped, [], '包括首次加载在内，不能先发错误地址再补前缀');
    assert.deepEqual(browser.errors, []);
  });
}
