'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：输入聚焦仅加深中性细边框，不叠加光圈，键盘按钮焦点仍可见', {
  skip: !available, timeout: 30000,
}, async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, until, click, cdp } = browser;
  async function focusedStyle(container, input) {
    const before = await evaluate(`(() => {
      document.activeElement.blur();
      const el=document.querySelector(${JSON.stringify(container)});
      return {shadow:getComputedStyle(el).boxShadow,width:el.getBoundingClientRect().width};
    })()`);
    await click(input);
    await until(`getComputedStyle(document.querySelector(${JSON.stringify(container)})).borderTopColor==='rgb(150, 157, 167)'`);
    const after = await evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(container)}),style=getComputedStyle(el);
      return {shadow:style.boxShadow,width:el.getBoundingClientRect().width,
        border:style.borderTopWidth,outline:getComputedStyle(document.activeElement).outlineWidth};
    })()`);
    assert.equal(after.shadow, before.shadow, '聚焦不增加额外光圈或阴影');
    assert.equal(after.width, before.width);
    assert.equal(after.border, '1px');
    assert.equal(after.outline, '0px', '输入区域不叠加第二道高亮');
  }
  for (const width of [1440, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 760,
    });
    const selector = '#home-job-link';
    const before = await evaluate(`getComputedStyle(document.querySelector('${selector}')).boxShadow`);
    await click(selector);
    const styles = await evaluate(`(() => {const s=getComputedStyle(document.querySelector('${selector}'));return {shadow:s.boxShadow,outline:s.outlineWidth,border:s.borderBottomWidth}})()`);
    assert.equal(styles.shadow, before, '首页岗位输入不增加额外光圈');
    assert.equal(styles.outline, '0px');
    assert.equal(styles.border, '1px');
  }
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate('document.activeElement.dataset.homeUpload'), 'job');
  assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid');
  const projectId = await helpers.defaultProject(ctx);
  await cdp('Page.navigate', { url: ctx.base.replace('/api/v1', '/') + '?project=' + projectId });
  await until('Boolean(window.WS && WS.draft && !document.body.classList.contains("home-mode"))');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await focusedStyle('.assistant-input', '#prompt');
  assert.deepEqual(browser.errors, []);
});
