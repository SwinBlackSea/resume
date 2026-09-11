'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const R = require('../resume-dom');
const { fixture, element, paragraph } = require('./fixtures/manual-structures');
const { openBrowser, available } = require('./browser-driver');
const { selectNode } = require('./manual-selection-driver');

test('真实连续鼠标路径：从子树移向增删按钮不切换目标，停顿/刷新保持，离开后可选其他层级', {
  skip: !available, timeout: 180000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const document = fixture();
  document.root.children.unshift(element('education', 'section', 'section', [
    element('education-entry', 'div', 'entry', [
      paragraph('education-name', '示例学校 · 国际贸易学'),
      { ...paragraph('education-date', '2012—2016'), style: { width: '100px', margin: '0' } },
    ], { style: { display: 'flex', 'justify-content': 'space-between', padding: '14px 36px 14px 16px' } }),
  ]));
  await helpers.call(ctx, 'PATCH', `/projects/${id}/resume-draft`, { body: {
    expected_revision: (await ws()).draft.revision, resume_json: document,
  } });
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { manualStructure: true });
  const { cdp, evaluate, until, click } = browser;
  const rawMove = point => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  let routes = 0;
  for (const zoom of [1, 1.25, 1.5]) {
    await click('#zoom-button');
    await click(`#zoom-menu [data-zoom="${zoom}"]`, false);
    for (const nodeId of ['education-date', 'deep-text', 'education-entry', 'merged-row-2']) {
      for (const operation of ['add', 'remove']) {
        const before = (await ws()).draft.resume_json;
        await rawMove({ x: 2, y: 2 });
        await until('!document.querySelector("#node-structure-tools").classList.contains("show")');
        await selectNode(browser, nodeId);
        const route = await evaluate(`(() => {
          const b=document.querySelector("#node-structure-${operation}").getBoundingClientRect();
          return {from:nodeStructurePointer,to:{x:b.left+b.width/2,y:b.top+b.height/2}};
        })()`);
        assert.ok(route.from, '使用实际鼠标坐标，不能直接设置选中对象');
        for (let step = 1; step <= 24; step++) {
          const fraction = step / 24;
          await rawMove({
            x: route.from.x + (route.to.x - route.from.x) * fraction,
            y: route.from.y + (route.to.y - route.from.y) * fraction,
          });
          assert.equal(await evaluate('nodeStructureState?.nodeId'), nodeId,
            `${zoom} ${nodeId} → ${operation}：途中第 ${step} 步不得换成父/子/兄弟节点`);
          assert.equal(await evaluate('document.querySelectorAll("#node-structure-outline.show").length'), 1);
          if (step === 20) {
            // Longer than the former 180ms mouseout dismissal timeout.
            await new Promise(resolve => setTimeout(resolve, 260));
            assert.equal(await evaluate('nodeStructureState?.nodeId'), nodeId, '途中停顿也不能跳层');
            await evaluate('refresh()');
            await until(`nodeStructureState?.nodeId===${JSON.stringify(nodeId)}`);
          }
        }
        // Click the originally located button, not a newly resolved one.
        const revision = await evaluate('WS.draft.revision');
        await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...route.to });
        await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...route.to });
        await until(`!nodeStructureActionPending&&WS.draft.revision>${revision}`);
        const after = (await ws()).draft.resume_json;
        const foundBefore = R.findNode(before, nodeId);
        if (operation === 'add') {
          const cap = R.manualSelectionCapabilities(before, nodeId);
          const parentAfter = R.findNode(after, foundBefore.parent.id).node;
          assert.equal(parentAfter.children.length,
            foundBefore.parent.children.length + (cap.target_ids?.length || 1));
        } else {
          assert.equal(R.findNode(after, nodeId), null);
        }
        await click('#undo-step'); await until('!historyStepPending');
        assert.deepEqual((await ws()).draft.resume_json, before);
        routes++;
      }
    }
  }
  // Selecting a parent remains available from its own edge after leaving the corridor.
  await rawMove({ x: 2, y: 2 });
  await until('!nodeStructureState');
  await selectNode(browser, 'education-entry');
  await rawMove({ x: 2, y: 2 });
  await until('!nodeStructureState');
  await selectNode(browser, 'education-name');
  await selectNode(browser, 'education-date');
  await selectNode(browser, 'education-name');
  await rawMove({ x: -20, y: -20 });
  await until('!nodeStructureState');
  assert.deepEqual(browser.errors, []);
  t.diagnostic(`${routes} 条连续路径，含 100/125/150% 缩放、子节点/父子树/闭合行组、加/减、停顿、刷新与撤销`);
});
