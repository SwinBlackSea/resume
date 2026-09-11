'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：resume 双向跳转回到刚才简历，离开前保存，不串到更新创建的简历', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { evaluate, cdp, until, click } = browser;
  const originalId = await evaluate('WS.project.id');
  const another = await helpers.call(ctx, 'POST', '/projects', { body: { name: '不应误跳到这份新简历' } });
  assert.equal(another.status, 200);
  const anotherBefore = (await helpers.call(ctx, 'GET', `/projects/${another.body.id}`)).body.draft;
  for (const width of [1440, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 760,
    });
    const brand = await evaluate(`(() => {
      const element=document.querySelector('.brand'),style=getComputedStyle(element);
      const rect=element.getBoundingClientRect();
      const next=document.querySelector('.top-actions').getBoundingClientRect();
      return {text:element.textContent,font:parseFloat(style.fontSize),width:rect.width,
        background:style.backgroundImage,right:rect.right,nextLeft:next.left,
        bottom:rect.bottom,nextTop:next.top,
        overflow:document.documentElement.scrollWidth>innerWidth+1};
    })()`);
    assert.equal(brand.text, 'resume');
    assert.ok(brand.font >= 18 && brand.width > 40);
    assert.equal(brand.background, 'none');
    assert.ok(brand.right <= brand.nextLeft || brand.bottom <= brand.nextTop,
      JSON.stringify({ width, brand }));
    const buttons = await evaluate(`[...document.querySelectorAll(".topbar .resume-nav")].map(e=>{
      const r=e.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right};
    })`);
    assert.ok(buttons.every(b => b.width >= 60 && b.height >= 36 && b.left >= 0 && b.right <= width),
      '导航按钮应有足够点击区域且不越界');
    assert.equal(brand.overflow, false, `页面在 ${width}px 不应横向溢出`);
  }
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await click('#target-bullet');
  await cdp('Input.insertText', { text: '离开前应保存的文字' });
  await click('.brand');
  await until('document.body.classList.contains("home-mode")&&Boolean(window.WS)&&!document.querySelector(".home-brand").disabled');
  assert.equal(await evaluate('document.title'), 'resume');
  assert.equal(await evaluate('document.querySelector(".home-brand").textContent'), 'resume');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".home-brand")).fontSize'), '24px');
  await until('Boolean(window.WS)&&!document.querySelector(".home-brand").disabled');
  assert.equal(await evaluate('document.querySelector(".home-brand").tagName'), 'BUTTON');
  await click('#home-layout-toggle');
  await until('document.querySelector("[data-layout-id]")');
  const layoutId = await evaluate('document.querySelector("[data-layout-id]").dataset.layoutId');
  await click('[data-layout-id]');
  await until('!document.querySelector("#home-layout-use").disabled');
  await click('#home-layout-use');
  await until('homeController.getState().intake?.materials.layout.status==="ready"');
  await click('.home-brand');
  await until(`!document.body.classList.contains('home-mode')&&Boolean(window.WS)&&WS.project.id===${JSON.stringify(originalId)}`);
  assert.equal(await evaluate('new URL(location.href).searchParams.get("project")'), originalId);
  assert.match(await evaluate('document.querySelector("#target-bullet").textContent'), /离开前应保存的文字/);
  assert.deepEqual((await helpers.call(ctx, 'GET', `/projects/${another.body.id}`)).body.draft, anotherBefore);
  await click('.brand');
  await until(`document.body.classList.contains("home-mode")&&Boolean(window.WS)&&homeController.getState().intake?.materials.layout.layout_id===${JSON.stringify(layoutId)}`);
  // A stale remembered project must never be opened without checking ownership.
  await evaluate('sessionStorage.setItem("resumeLastProject","not-owned-or-deleted");window.__oldBrandPage=true');
  await cdp('Page.reload');
  await until('!window.__oldBrandPage&&Boolean(window.WS)&&!document.querySelector(".home-brand").disabled');
  assert.notEqual(await evaluate('WS.project.id'), 'not-owned-or-deleted');
  assert.deepEqual(browser.errors, []);
});
