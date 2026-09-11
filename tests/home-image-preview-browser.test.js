'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');
let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => helpers.close(ctx));

test('真实Chromium：材料原图私有读取、blob预览、原始大小、关闭焦点、失败与子路径', {
  skip: !available, timeout: 45000,
}, async (t) => {
  const png = await sharp({ create: { width: 1200, height: 1900, channels: 3, background: '#587a95' } }).png().toBuffer();
  const upload = (await helpers.call(ctx, 'POST', '/uploads', {
    body: { original_name: 'image.png', mime_type: 'image/png', size: png.length },
  })).body;
  const transmitted = await fetch(ctx.base+'/uploads/'+upload.id+'/content', { method: 'POST', body: png });
  assert.equal(transmitted.status, 200);
  helpers.db.run("UPDATE uploads SET status='ready' WHERE id=?", [upload.id]);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, until, click, cdp } = browser;
  await evaluate(fs.readFileSync(path.join(__dirname, '../home-image-preview.js'), 'utf8'));
  await evaluate(`window.previewForTest=ResumeImagePreview.create({apiBase:'/api/v1'});
    const trigger=document.createElement('button');trigger.id='image-preview-test-trigger';trigger.textContent='image.png';document.body.appendChild(trigger);
    trigger.onclick=()=>previewForTest.open({uploadId:${JSON.stringify(upload.id)},name:'image.png',opener:trigger});`);
  await click('#image-preview-test-trigger');
  await until('document.querySelector(".home-image-preview img").naturalWidth===1200&&!document.querySelector(".home-image-preview img").hidden');
  assert.equal(await evaluate('document.querySelector(".home-image-preview img").naturalHeight'), 1900);
  assert.equal(await evaluate('document.querySelector(".home-image-preview h2").textContent'), 'image.png');
  await click('.home-image-preview-controls button:first-child');
  assert.equal(await evaluate('document.querySelector(".home-image-preview-canvas").dataset.original'), 'true');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until('!document.querySelector(".home-image-preview").open');
  assert.equal(await evaluate('document.activeElement.id'), 'image-preview-test-trigger');
  await evaluate(`window.localPreviewUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],{type:'image/png'}));
    previewForTest.open({url:localPreviewUrl,name:'尚未上传.png',opener:document.querySelector('#image-preview-test-trigger')});`);
  await until('!document.querySelector(".home-image-preview img").hidden');
  assert.equal(await evaluate('document.querySelector(".home-image-preview img").naturalWidth'), 1200);
  await evaluate('previewForTest.close();URL.revokeObjectURL(localPreviewUrl)');
  await evaluate('previewForTest.open({url:"https://example.invalid/image.png",name:"外网图片"})');
  await until('document.querySelector(".home-image-preview-status").getAttribute("role")==="alert"');
  assert.equal(await evaluate('document.querySelector(".home-image-preview img").hidden'), true);
  await evaluate('previewForTest.open({uploadId:"missing",name:"不存在.png"})');
  await until('document.querySelector(".home-image-preview-status").textContent.includes("不可用")');
  await evaluate('previewForTest.destroy()');
  const subpath = await evaluate(`(async()=>{
    const originalFetch=window.fetch, urls=[];
    window.fetch=async(url,options)=>{urls.push({url,credentials:options.credentials,cache:options.cache});return new Response(new Blob([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],{type:'image/png'}))};
    const nested=ResumeImagePreview.create({apiBase:'/resume/api/v1'});
    await nested.open({uploadId:'example-id',name:'子路径.png'});nested.destroy();window.fetch=originalFetch;return urls;
  })()`);
  assert.equal(new URL(subpath[0].url).pathname, '/resume/api/v1/uploads/example-id/preview');
  assert.equal(subpath[0].credentials, 'same-origin');
  assert.equal(subpath[0].cache, 'no-store');
  assert.deepEqual(browser.errors, []);
});
