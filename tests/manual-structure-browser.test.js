'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const R = require('../resume-dom');
const { fixture } = require('./fixtures/manual-structures');
const { publicDocuments } = require('./fixtures/public-resume-samples');
const { openBrowser, available } = require('./browser-driver');

function ids(node) { return [node.id, ...(node.children || []).flatMap(ids)]; }
function shape(node) {
  const result = structuredClone(node);
  (function visit(n) {
    delete n.id;
    if (n.semantic) delete n.semantic.group_id;
    if (n.attributes) {
      delete n.attributes.id;
      Object.keys(n.attributes).filter((key) => /^data-(?:.*-)?id$/i.test(key))
        .forEach((key) => delete n.attributes[key]);
    }
    (n.children || []).forEach(visit);
  })(result);
  return result;
}
const nodeSelector = (id) => `[data-node-id=${JSON.stringify(id)}]`;

test('真实浏览器 +/-：表格、合并行、多层列表、整块/内部、定位缩放、连点、撤销重做和公开文件', {
  skip: available ? false : '需要CHROME_BIN',
  timeout: 600000,
}, async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { cdp, evaluate, until, click, hover } = browser;
  async function workspace() { return (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body; }
  async function reset(document) {
    const current = await workspace();
    const result = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
      body: { expected_revision: current.draft.revision, resume_json: document },
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await evaluate('refresh()');
    await until('!nodeStructureActionPending');
    return (await workspace()).draft.resume_json;
  }
  async function action(anchor, actionName) {
    await hover(nodeSelector(anchor));
    await until(`nodeStructureState && nodeStructureState.nodeId===${JSON.stringify(anchor)}`);
    const capability = await evaluate('nodeStructureState.capability');
    const remove = actionName.startsWith('remove');
    const revision = (await workspace()).draft.revision;
    const previousChange = await evaluate('lastChange&&lastChange.meta&&lastChange.meta.changeId||null');
    await click(remove ? '#node-structure-remove' : '#node-structure-add', false);
    const options = remove ? capability.remove_choices || [capability.remove] : capability.add;
    if (remove || options.length > 1) {
      await until('document.querySelector("#node-structure-menu").classList.contains("show")');
      const choice = options.filter((item) => item.enabled !== false).findIndex((item) => item.action === actionName);
      assert.ok(choice >= 0, actionName);
      await click(`#node-structure-menu button:nth-child(${choice + 1})`, false);
    }
    await until(`!nodeStructureActionPending && WS.draft.revision>${revision} && lastChange&&lastChange.meta&&lastChange.meta.changeId!==${JSON.stringify(previousChange)}`);
    return (await workspace()).draft.resume_json;
  }
  async function undo(expected) {
    const revision = (await workspace()).draft.revision;
    await click('#undo-step');
    await until(`WS.draft.revision>${revision}`);
    assert.deepEqual((await workspace()).draft.resume_json, expected);
  }
  async function reload() {
    await evaluate('window.__structureReloadPending=true');
    await cdp('Page.reload');
    await until('Boolean(!window.__structureReloadPending && window.WS && WS.draft)');
  }
  let operations = 0;
  for (const [anchor, actionName] of [
    ['overview-p', 'add_sibling'],
    ['grid-row-2-p-2', 'add_sibling'],
    ['grid-row-2-p-2', 'add_content_sibling'],
    ['item-text', 'add_sibling'],
    ['nested-text', 'add_sibling'],
    ['entry-name', 'add_sibling'],
    ['deep-text', 'add_sibling'],
    ['overview-title', 'add_section_after'],
    ['overview-title', 'add_section_content'],
    ['merged-text-2', 'add_sibling'],
  ]) {
    const before = await reset(fixture());
    const capability = R.manualStructureCapabilities(before, anchor);
    const after = await action(anchor, actionName);
    operations++;
    const added = ids(after.root).filter((id) => !ids(before.root).includes(id));
    assert.ok(added.length);
    assert.equal(ids(after.root).length, new Set(ids(after.root)).size);
    let sourceIds;
    if (actionName === 'add_section_after') sourceIds = ['overview'];
    else if (actionName === 'add_section_content') sourceIds = ['grid-table'];
    else if (actionName === 'add_content_sibling') sourceIds = [anchor];
    else sourceIds = capability.target_ids || [anchor];
    const duplicateRoots = added.filter((id) => {
      const found = R.findNode(after, id);
      return !found.parent || !added.includes(found.parent.id);
    });
    assert.equal(duplicateRoots.length, sourceIds.length);
    sourceIds.forEach((sourceId, index) => {
      const source = R.findNode(before, sourceId);
      const duplicate = R.findNode(after, duplicateRoots[index]);
      assert.equal(duplicate.parent.id, source.parent.id);
      assert.deepEqual(shape(duplicate.node), shape(source.node));
      assert.deepEqual(R.findNode(after, sourceId).node, source.node);
    });
    const placement = await evaluate(`(() => {
      const original=document.querySelector(${JSON.stringify(nodeSelector(sourceIds.at(-1)))});
      const copy=document.querySelector(${JSON.stringify(nodeSelector(duplicateRoots[0]))});
      return {sameParent:original.parentElement===copy.parentElement,
        nested:original.contains(copy),bottom:original.getBoundingClientRect().bottom,
        top:copy.getBoundingClientRect().top};
    })()`);
    assert.equal(placement.sameParent, true);
    assert.equal(placement.nested, false);
    assert.ok(placement.top >= placement.bottom - 1, JSON.stringify({ anchor, placement }));
    await reload();
    assert.deepEqual(await evaluate('WS.draft.resume_json'), after);
    await undo(before); operations++;
    const revision = (await workspace()).draft.revision;
    await click('#redo-step');
    await until(`WS.draft.revision>${revision}`);
    assert.deepEqual((await workspace()).draft.resume_json, after); operations++;
    const focus = added.find((id) => R.findNode(after, id).node.editable);
    const removed = await action(focus, actionName === 'add_content_sibling' ? 'remove_content' : 'remove'); operations++;
    // Removing a copied section uses its copied title; copied complete row/list
    // also removes its entire repeated unit, not only the editable paragraph.
    if (actionName !== 'add_section_content') assert.deepEqual(removed, before);
    await undo(after); operations++;
  }
  // Zoom and pointer drift must never replace the captured node with a nearby
  // cell or row. Use real mouse clicks after each zoom choice.
  for (const zoom of ['.75', '.9', '1', '1.1', '1.25', '1.5', 'fit']) {
    await reset(fixture());
    await click('#zoom-button');
    await click(`#zoom-menu [data-zoom="${zoom}"]`, false);
    const after = await action('grid-row-2-p-2', 'add_sibling');
    assert.equal(R.findNode(after, 'grid-body').node.children.length, 3);
    assert.equal(R.findNode(after, 'grid-row-1').node.children.length, 3);
    operations++;
  }
  await click('#zoom-button');
  await click('#zoom-menu [data-zoom="1"]', false);
  // Explicit internal deletion, last-row cleanup, and confirmation cancel.
  const beforeDelete = await reset(fixture());
  const contentDeleted = await action('grid-row-2-p-2', 'remove_content');
  assert.equal(R.findNode(contentDeleted, 'grid-row-2-p-2'), null);
  assert.ok(R.findNode(contentDeleted, 'grid-row-2')); operations++;
  await undo(beforeDelete); operations++;
  await hover(nodeSelector('overview-title'));
  await click('#node-structure-remove', false);
  await click('#node-structure-menu .cancel', false);
  assert.deepEqual((await workspace()).draft.resume_json, beforeDelete);

  // Save the text actually typed in Chromium before duplicating a different
  // unit; both edits must remain independently reversible.
  await reset(fixture());
  await click(nodeSelector('overview-p'));
  await cdp('Input.insertText', { text: '新输入必须保留' });
  const typedText = await evaluate(`directElementText(document.querySelector(${JSON.stringify(nodeSelector('overview-p'))}))`);
  const typedAndAdded = await action('grid-row-2-p-2', 'add_sibling');
  assert.equal(R.nodeText(R.findNode(typedAndAdded, 'overview-p').node), typedText);
  const typedOnly = R.applyDocumentOperations(fixture(), [{ op: 'replace_text', node_id: 'overview-p', text: typedText }]);
  await undo(typedOnly); operations += 2;

  // Actual double click: the second physical click cannot create another copy
  // of the pending target.
  const doubleBefore = await reset(fixture());
  await hover(nodeSelector('overview-p'));
  const position = await evaluate('(() => {const r=document.querySelector("#node-structure-add").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()');
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  for (const clickCount of [1, 2]) {
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...position });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...position });
  }
  await until('!nodeStructureActionPending && WS.draft.resume_json.root.children[0].children.length===4');
  assert.equal(ids((await workspace()).draft.resume_json.root).length, ids(doubleBefore.root).length + 1);
  operations++;
  // A narrow viewport keeps menus reachable and anchors stable.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await reset(fixture());
  await action('grid-row-2-p-2', 'add_sibling'); operations++;
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const samples = await publicDocuments(t);
  for (const sample of samples) {
    const before = await reset(sample.document);
    const editable = [];
    (function collect(node) {
      if (node.editable && !['document_title', 'inline', 'layout_line', 'decoration'].includes(R.semanticKind(node))) editable.push(node.id);
      (node.children || []).forEach(collect);
    })(before.root);
    const candidates = editable;
    assert.ok(candidates.length, sample.name);
    // Different locations across the file, not just the first visible paragraph.
    const anchors = [...new Set([candidates[0], candidates[Math.floor(candidates.length / 2)], candidates.at(-1)])];
    for (const anchor of anchors) {
      const baseline = await reset(sample.document);
      const capability = R.manualStructureCapabilities(baseline, anchor);
      assert.ok(capability, `${sample.name}: ${anchor}`);
      await hover(nodeSelector(anchor));
      if (capability.fixed_layout) {
        assert.equal(await evaluate('document.querySelector("#node-structure-add").disabled'), true);
        const rejected = await helpers.call(ctx, 'POST', `/projects/${projectId}/resume-draft/node-actions`, {
          body: { node_id: anchor, action: capability.add[0].action,
            expected_revision: (await workspace()).draft.revision, mutation_id: `fixed-${anchor}` },
        });
        assert.ok(rejected.status >= 400);
        assert.deepEqual((await workspace()).draft.resume_json, baseline);
        if (capability.remove.enabled) {
          const removed = await action(anchor, 'remove');
          assert.equal(R.findNode(removed, anchor), null);
          await undo(baseline); operations += 2;
        }
        continue; // fixed page addition must not silently overlap coordinates
      }
      const after = await action(anchor, capability.add[0].action);
      assert.ok(ids(after.root).length > ids(baseline.root).length);
      await reload();
      assert.deepEqual(await evaluate('WS.draft.resume_json'), after);
      await undo(baseline);
      operations += 2;
    }
    console.log(JSON.stringify({ sample: sample.name, pages: before.root.children.length,
      editable_nodes: editable.length, tested_anchors: anchors.length }));
  }
  assert.deepEqual(browser.errors, []);
  console.log(JSON.stringify({ browser_structure_operations: operations, public_documents: samples.length }));
});
