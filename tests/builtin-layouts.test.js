'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');
const { listBuiltinLayouts, readBuiltinReferenceImage } = require('../server/lib/builtin-layouts');
const { findLayout } = require('../server/lib/home-materials');
const manifest = require('../assets/builtin-layouts/manifest.json');
let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => helpers.close(ctx));

test('20个本地网络样式均有固定上游、MIT归属、独立内容哈希与可解码原图和缩略图', async () => {
  assert.equal(manifest.items.length, 20);
  assert.equal(new Set(manifest.items.map((item) => item.sha256)).size, 20);
  for (const item of manifest.items) {
    assert.match(item.commit, /^[a-f0-9]{40}$/);
    assert.match(item.source_url, /^https:\/\/raw\.githubusercontent\.com\//);
    assert.equal(item.license, 'MIT');
    if (item.commit === '730f795073126e850cab348038f9557da6f810fd') {
      assert.ok(item.width >= 1600, `${item.id}必须使用真正高清参考，不能放大510px缩略图`);
      assert.match(item.source_filename, /\.pdf$/);
      assert.match(item.image_transformation, /200 DPI/);
      const pdf = fs.readFileSync(path.join(__dirname, '../assets/builtin-layouts', item.source_filename));
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.equal(crypto.createHash('sha256').update(pdf).digest('hex'), item.source_sha256);
    }
    assert.match(fs.readFileSync(path.join(__dirname, '../assets/builtin-layouts/licenses', item.license_file), 'utf8'),
      /Permission is hereby granted/);
    for (const preview of [false, true]) {
      const resource = readBuiltinReferenceImage(item.id, { preview });
      assert.equal(crypto.createHash('sha256').update(resource.buffer).digest('hex'),
        preview ? item.preview_sha256 : item.sha256);
      const metadata = await sharp(resource.buffer).metadata();
      assert.ok(metadata.width >= 400 && metadata.height >= 500);
      const response = await fetch(ctx.base+`/home/layouts/${item.id}/image`+(preview ? '?size=preview' : ''));
      assert.equal(response.status, 200);
      assert.equal(crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), resource.sha256);
      assert.equal(response.headers.get('content-type'), resource.mime_type);
    }
  }
  assert.equal((await fetch(ctx.base+'/home/layouts/not-allowed/image')).status, 404);
  assert.ok(findLayout('quiet') && findLayout('editorial') && findLayout('modern'), '历史ID仍可读取');
  assert.equal(listBuiltinLayouts().some((item) => item.id === 'quiet'), false, '不能用旧3款凑20份');
});

test('真实Chromium：20款均可预览应用，取消不改材料，首页缩略图和服务端参考身份完全对应', {
  skip: !available, timeout: 90000,
}, async (t) => {
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, until, click, cdp } = browser;
  await until('document.querySelectorAll("[data-layout-id]").length===20');
  await click('#home-layout-toggle');
  await until('[...document.querySelectorAll(".home-layout-image-button img")].every(img=>img.complete&&img.naturalWidth>0)');
  assert.equal(await evaluate('document.querySelector("#home-layout-dialog").open'), true);
  assert.equal(await evaluate('document.querySelector("#home-submit").disabled'), true);
  for (const width of [1440, 768, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await evaluate('document.querySelector("#home-layout-dialog").scrollWidth<=document.querySelector("#home-layout-dialog").clientWidth'), true);
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const [index, item] of listBuiltinLayouts().entries()) {
    if (index) await click('#home-layout-toggle');
    await click(`[data-layout-id="${item.id}"]`);
    await until('!document.querySelector("#home-layout-use").disabled && document.querySelector("#home-layout-full-image").naturalWidth>0');
    assert.equal(await evaluate('document.querySelector("#home-layout-full-image").getAttribute("src")'), item.image_url);
    const before = await evaluate('homeController.getState().intake&&homeController.getState().intake.materials.layout.layout_id');
    if (index) {
      assert.equal(before, listBuiltinLayouts()[index - 1].id, '单独预览不应用');
      await click('#home-layout-back');
      assert.equal(await evaluate('homeController.getState().intake.materials.layout.layout_id'), before);
      await click(`[data-layout-id="${item.id}"]`);
      await until('!document.querySelector("#home-layout-use").disabled');
    }
    await click('#home-layout-use');
    await until(`homeController.getState().intake&&homeController.getState().intake.materials.layout.layout_id===${JSON.stringify(item.id)}&&!document.querySelector("#home-layout-dialog").open`);
    const intake = await evaluate('homeController.getState().intake');
    const stored = (await helpers.call(ctx, 'GET', '/home/intakes/'+intake.id)).body;
    assert.equal(stored.materials.layout.layout_id, item.id);
    assert.equal(stored.ready, false, '仅选样式不绕过另外两项材料门槛');
    assert.equal(stored.attempted, false, '应用样式不能自动生成');
    assert.equal(await evaluate('document.querySelector("#home-layout-selected-image").getAttribute("src")'), item.preview_url);
    assert.equal(await evaluate('document.querySelector("#home-layout-selected-name").textContent'), item.name);
    assert.equal(await evaluate('document.activeElement.id'), 'home-layout-toggle');
  }
  // Native dialog focus trap and Escape cancellation never commits a new style.
  await click('#home-layout-toggle');await click('[data-layout-id="rr-azurill"]');
  await until('!document.querySelector("#home-layout-use").disabled');
  await evaluate('document.querySelector("#home-layout-full-image").src="/api/v1/home/layouts/not-allowed/image"');
  await until('document.querySelector("#home-layout-use").disabled&&document.querySelector("#home-layout-load-status").textContent.includes("无法加载")');
  assert.equal(await evaluate('homeController.getState().intake.materials.layout.layout_id'), 'resumake-9',
    '大图加载失败不能提交、不能替换已选样式');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until('document.querySelector("#home-layout-enlarged").hidden');
  assert.equal(await evaluate('homeController.getState().intake.materials.layout.layout_id'), 'resumake-9');
  await click('#home-layout-close');
  // Inspecting the chosen template is read-only, not a gallery-selection action.
  const selected=listBuiltinLayouts().find(item=>item.id==='resumake-9');
  await click('#home-layout-selected');
  await until('document.querySelector(".home-image-preview").open&&document.querySelector(".home-image-preview img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelector("#home-layout-dialog").open'),false);
  assert.equal(await evaluate('document.querySelector(".home-image-preview h2").textContent'),selected.name);
  assert.equal(await evaluate('document.querySelector(".home-image-preview img").naturalWidth'),selected.width);
  await click('.home-image-preview button[aria-label="关闭图片预览"]');
  assert.equal(await evaluate('document.activeElement.id'),'home-layout-selected');
  await evaluate('window.__selectedPreviewReload=true');
  await cdp('Page.reload');
  await until('!window.__selectedPreviewReload&&!document.querySelector("#home-layout-selected").hidden');
  await evaluate('document.querySelector("#home-layout-selected").focus()');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until('document.querySelector(".home-image-preview").open&&document.querySelector(".home-image-preview img").naturalWidth>0');
  assert.equal(await evaluate('document.querySelector("#home-layout-dialog").open'),false);
  assert.equal(await evaluate('homeController.getState().intake.materials.layout.layout_id'),selected.id);
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until('!document.querySelector(".home-image-preview").open');
  await click('#home-layout-toggle');
  assert.equal(await evaluate('document.querySelector("#home-layout-options").hidden'),false,
    '只有系统样式入口打开全部模板列表');
  await click('#home-layout-close');
  assert.deepEqual(browser.errors, []);
});
