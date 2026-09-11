'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const R = require('../resume-dom');
const { layouts } = require('./fixtures/manual-flow-layouts');
const { openBrowser, available } = require('./browser-driver');
const { scenarioTarget, selectNode } = require('./manual-selection-driver');
const { compileManualNodeAction } = require('../server/lib/manual-node-actions');
const { createStructureDeltaPair, restoreStructureDelta } = require('../server/lib/resume-change');

function ids(node) { return [node.id, ...(node.children || []).flatMap(ids)]; }
function withoutPlacement(node) {
  const value = structuredClone(node);
  delete value.id;
  if (value.style) {
    for (const key of Object.keys(value.style)) if (key.startsWith('grid-') || key === 'order') delete value.style[key];
  }
  value.children = (value.children || []).map(withoutPlacement);
  return value;
}

for (const sample of layouts()) {
  test(`布局事务：${sample.name}，完整复制、可逆位置调整`, () => {
    for (const [anchor, action] of [[sample.anchor, 'add_sibling'], [sample.title, 'add_section_content'],
      [sample.title, 'add_section_after']]) {
      const before = sample.document;
      const compiled = compileManualNodeAction(before, action, anchor);
      const after = R.applyDocumentOperations(before, compiled.operations, { allowStructure: true });
      if (action === 'add_sibling' && sample.name.startsWith('grid-') && sample.name !== 'grid-auto') {
        const expectedRow = sample.name === 'grid-longhand' ? '5 / 7'
          : sample.name === 'grid-span' ? '5 / 6'
            : sample.name === 'grid-overlap' ? '6 / 7' : '4 / 5';
        const inserted = compiled.operations.find(op => op.op === 'insert_node').node;
        assert.equal(inserted.style['grid-row'], expectedRow, '新增占位应在当前闭合行之后，不能跳出多余空行');
        assert.equal(inserted.style['grid-column'], '3 / 4');
      }
      const pair = createStructureDeltaPair(before, after, compiled.operations);
      assert.ok(pair, `${action} 必须能构成同一撤销事务`);
      assert.deepEqual(restoreStructureDelta(after, pair.before, pair.after), before);
      assert.deepEqual(restoreStructureDelta(before, pair.after, pair.before), after);
      assert.equal(new Set(ids(after.root)).size, ids(after.root).length);
    }
  });
}

test('真实浏览器：布局矩阵新增、显示、重复点击、删除、撤销重做、刷新及缩放', {
  skip: !available, timeout: 600000,
}, async (t) => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { manualStructure: true });
  const { evaluate, cdp, click, hover, until } = browser;
  const samples = layouts();
  // Opt-in local reproduction only; never modify the production database or
  // commit a user's resume into fixtures/reports.
  if (process.env.RESUME_MANUAL_PRODUCTION_REPRO === '1') {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(require('node:path').resolve(__dirname, '../data/resume.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT resume_json FROM resume_drafts WHERE project_id=?')
        .get('01a08144-e3ca-733a-8fa8-1eac2f246991');
      if (row) {
        const document = R.toResumeDocument(JSON.parse(row.resume_json));
        // The original is physically covered by the copies made before the
        // fix. Click the topmost saved copy just as the user actually can.
        const anchor = R.findNode(document, 'sidebar-results').node.children.at(-1).id;
        samples.push({ name: 'reported-document', document, anchor, title: 'sidebar-results-h' });
      }
    } finally { db.close(); }
  }
  async function workspace() { return (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body; }
  async function reset(doc) {
    const ws = await workspace();
    const result = await helpers.call(ctx, 'PATCH', `/projects/${projectId}/resume-draft`, {
      body: { expected_revision: ws.draft.revision, resume_json: doc },
    });
    assert.equal(result.status, 200);
    await evaluate('refresh()');
    return (await workspace()).draft.resume_json;
  }
  async function action(anchor, name) {
    await selectNode(browser, scenarioTarget((await workspace()).draft.resume_json, anchor, name));
    const remove = name.startsWith('remove');
    const previous = (await workspace()).draft.revision;
    await click(remove ? '#node-structure-remove' : '#node-structure-add', false);
    await until(`!nodeStructureActionPending && WS.draft.revision>${previous}`);
    return (await workspace()).draft.resume_json;
  }
  async function step(name, expected) {
    const previous = (await workspace()).draft.revision;
    await click(`#${name}-step`);
    await until(`!historyStepPending&&WS.draft.revision>${previous}`);
    assert.deepEqual((await workspace()).draft.resume_json, expected);
  }
  let operations = 0;
  for (const sample of samples) {
    for (const zoom of ['1', '1.25', '1.5']) {
      await click('#zoom-button');
      await click(`#zoom-menu [data-zoom="${zoom}"]`, false);
      for (const [anchor, name] of [[sample.anchor, 'add_sibling'], [sample.title, 'add_section_content'],
        [sample.title, 'add_section_after']]) {
        const before = await reset(sample.document);
        let current = before;
        // Two successive additions expose reuse of the *new* position as well.
        for (let repeat = 0; repeat < 2; repeat++) {
          const after = await action(anchor, name); operations++;
          const added = ids(after.root).filter(id => !ids(current.root).includes(id));
          assert.ok(added.length, `${sample.name}/${name} 应新增完整内容`);
          const newRoot = added.find(id => !added.includes(R.findNode(after, id).parent?.id));
          const source = name === 'add_sibling' ? R.manualStructureCapabilities(current, anchor).target_id
            : name === 'add_section_after' ? R.findNode(current, anchor).parent.id
              : scenarioTarget(current, anchor, name);
          if (source) assert.deepEqual(withoutPlacement(R.findNode(after, newRoot).node),
            withoutPlacement(R.findNode(current, source).node));
          // Geometry comes from actual Chromium rendering, not CSS strings.
          const collision = await evaluate(`(() => {
            const ids=new Set(${JSON.stringify(added)});
            const nodes=[...document.querySelectorAll('#resume-document [data-resume-editable=true]')];
            const rects=e=>{
              const range=document.createRange();range.selectNodeContents(e);
              return [...range.getClientRects()].filter(r=>r.width>1&&r.height>1);
            };
            const fresh=nodes.filter(e=>ids.has(e.dataset.nodeId));
            const old=nodes.filter(e=>!ids.has(e.dataset.nodeId));
            const overlaps=[];
            for(const n of fresh)for(const r of rects(n))for(const o of old)for(const q of rects(o)){
              if(Math.min(r.right,q.right)-Math.max(r.left,q.left)>2&&
                 Math.min(r.bottom,q.bottom)-Math.max(r.top,q.top)>2)overlaps.push([n.dataset.nodeId,o.dataset.nodeId]);
            }
            return {visible:fresh.length>0&&fresh.every(e=>rects(e).length>0),overlaps};
          })()`);
          assert.equal(collision.visible, true, `${sample.name}/${name}/${zoom} 新内容应可见`);
          assert.deepEqual(collision.overlaps, [], `${sample.name}/${name}/${zoom} 新内容不能覆盖原内容`);
          await step('undo', current); operations++;
          await step('redo', after); operations++;
          current = after;
        }
        const freshIds = ids(current.root).filter(id => !ids(before.root).includes(id));
        const editable = freshIds.find(id => R.findNode(current, id).node.editable);
        const removed = await action(editable, 'remove'); operations++;
        assert.equal(R.findNode(removed, editable), null);
        await step('undo', current); operations++;
        await evaluate('window.__flowReload=true'); await cdp('Page.reload');
        await until('!window.__flowReload&&window.WS&&WS.draft');
        assert.deepEqual(await evaluate('WS.draft.resume_json'), current);
      }
    }
    console.log(`${sample.name}：3 种缩放 × 3 种新增，通过真实点击及显示/保存/撤销检查`);
  }
  assert.deepEqual(browser.errors, []);
  t.diagnostic(`共 ${samples.length} 种布局，${operations} 次真实浏览器修改/撤销/重做操作`);
});
