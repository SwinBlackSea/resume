'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { fixture } = require('./fixtures/manual-structures');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：悬停开关即时生效、刷新记忆、不影响改字/撤销/历史保存', {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  await helpers.call(ctx, 'PATCH', `/projects/${id}/resume-draft`, { body: {
    expected_revision: (await ws()).draft.revision, resume_json: fixture(),
  } });
  const before = await ws();
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, hover, cdp, until, evaluate } = browser;
  for (const width of [1440, 760, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const placement = await evaluate(`(() => {
      const bar=document.querySelector(".topbar"), account=document.querySelector("#account-button");
      const b=bar.getBoundingClientRect(), a=account.getBoundingClientRect();
      return {rightGap:b.right-a.right, width:a.width, center:a.left+a.width/2, brandRight:document.querySelector(".brand").getBoundingClientRect().right};
    })()`);
    assert.ok(placement.width > 0 && placement.rightGap >= 0 && placement.rightGap <= 28,
      `个人中心在 ${width}px 屏幕须保持顶栏最右侧：${JSON.stringify(placement)}`);
    assert.ok(placement.center > placement.brandRight);
    assert.equal(await evaluate('document.querySelector("#my-resumes")'), null);
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const target = '[data-node-id="overview-p"]';
  await hover(target);
  assert.equal(await evaluate('manualStructureEnabled'), false);
  assert.equal(await evaluate('document.querySelector("#node-structure-tools").classList.contains("show")'), false);
  await click('#account-button'); await click('#settings-button');
  assert.equal(await evaluate('document.querySelector("#manual-structure-setting").checked'), false);
  await click('#manual-structure-setting'); await click('#settings-modal .close');
  await hover(target);
  await until('nodeStructureState?.nodeId==="overview-p"');
  assert.equal(await evaluate('document.activeElement.matches("[data-resume-editable=true]")'), false);
  await click('#account-button'); await click('#settings-button');
  assert.equal(await evaluate('document.querySelector("#manual-structure-setting").checked'), true);
  await click('#manual-structure-setting');
  await click('#settings-modal .close');
  await hover(target);
  assert.equal(await evaluate('document.querySelector("#node-structure-tools").classList.contains("show")'), false);
  await click(target);
  await cdp('Input.insertText', { text: '开关关闭后仍可改字' });
  await evaluate('flushCurrentEdits()');
  assert.equal(await evaluate('document.querySelector("#node-structure-tools").classList.contains("show")'), false);
  await click('#undo-step');
  await until('!historyStepPending');
  assert.deepEqual((await ws()).draft.resume_json, before.draft.resume_json);
  await evaluate('window.__settingReload=true'); await cdp('Page.reload');
  await until('!window.__settingReload&&window.WS&&WS.draft');
  await hover(target);
  assert.equal(await evaluate('manualStructureEnabled'), false);
  assert.equal(await evaluate('document.querySelector("#node-structure-tools").classList.contains("show")'), false);
  await click('#account-button'); await click('#settings-button');
  assert.equal(await evaluate('document.querySelector("#manual-structure-setting").checked'), false);
  await click('#manual-structure-setting'); await click('#settings-modal .close');
  await hover(target);
  await until('nodeStructureState?.nodeId==="overview-p"');
  assert.deepEqual((await ws()).draft.resume_json, before.draft.resume_json);
  assert.deepEqual(browser.errors, []);
});
