'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { fixture } = require('./fixtures/manual-structures');
const { openBrowser, available } = require('./browser-driver');

test('点击纸内/纸外空白清除编辑框与悬停框，保持保存、撤销和局部 AI 可用', {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  await helpers.call(ctx, 'PATCH', `/projects/${id}/resume-draft`, { body: {
    expected_revision: (await ws()).draft.revision, resume_json: fixture(),
  } });
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, cdp, until, evaluate, hover } = browser;
  const target = '[data-node-id="overview-p"]';
  async function blank(outside = false) {
    const point = await evaluate(`(() => {
      const page=document.querySelector("#resume-document"), canvas=document.querySelector(".canvas");
      const r=( ${outside} ?canvas:page).getBoundingClientRect();
      return {x:r.left+6,y:Math.max(r.top+6,document.querySelector("#doc-toolbar").getBoundingClientRect().bottom+8)};
    })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    await until('!document.querySelector("#selection-tools").classList.contains("show")');
    assert.equal(await evaluate('document.querySelectorAll("#resume-document .selected").length'), 0);
    assert.equal(await evaluate('!!document.activeElement.closest("#resume-document [data-resume-editable=true]")'), false);
    assert.equal(await evaluate('selectionToolsAnchor'), null);
    assert.equal(await evaluate('document.querySelector("#node-structure-outline").classList.contains("show")'), false);
  }
  const original = (await ws()).draft.resume_json;
  await click(target); await blank();
  await click(target); await blank(true);
  assert.deepEqual((await ws()).draft.resume_json, original);
  await click(target);
  await cdp('Input.insertText', { text: '空白点击前的修改' });
  await blank();
  await until('inlineTransactionsPending===0');
  assert.notDeepEqual((await ws()).draft.resume_json, original);
  await click('#undo-step'); await until('!historyStepPending');
  assert.deepEqual((await ws()).draft.resume_json, original);
  await click('#account-button'); await click('#settings-button');
  await click('#manual-structure-setting'); await click('#settings-modal .close');
  await hover(target); await until('nodeStructureState?.nodeId==="overview-p"');
  await blank();
  await evaluate('refresh()');
  assert.equal(await evaluate('document.querySelector("#node-structure-outline").classList.contains("show")'), false);
  await hover(target); await until('nodeStructureState?.nodeId==="overview-p"');
  await click(target); await click('#selection-tools .rewrite-action');
  assert.equal(await evaluate('document.querySelector("#local-ai-popover").classList.contains("show")'), true);
  assert.deepEqual(browser.errors, []);
});
