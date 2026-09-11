'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { fixture } = require('./fixtures/manual-structures');
const { openBrowser, available } = require('./browser-driver');

function cases() {
  const before = fixture(), after = structuredClone(before);
  after.root.style = { ...after.root.style, padding: '26pt 30pt', 'border-top': '9pt solid #BE9D65' };
  const result = [{ name: '完整文档样式修改', before, after }];
  if (process.env.RESUME_UNDO_PRODUCTION_REPRO === '1') {
    const db = new DatabaseSync(path.resolve(__dirname, '../data/resume.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT before_json,after_json FROM resume_change_events WHERE id=?')
        .get('01a08534-0e00-73e0-9b71-b8641f17e66f');
      assert.ok(row, '报告中的撤销记录必须存在');
      result.push({ name: '用户报告记录只读副本',
        before: JSON.parse(row.before_json).resume_json, after: JSON.parse(row.after_json).resume_json });
    } finally { db.close(); }
  }
  return result;
}

for (const sample of cases()) test(`真实撤销/重做：${sample.name}，文档和所有节点布局与独立渲染一致`, {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  async function setDocument(document, change) {
    const result = await helpers.call(ctx, 'PATCH', `/projects/${id}/resume-draft`, { body: {
      expected_revision: (await ws()).draft.revision, resume_json: document, ...(change ? { change } : {}),
    } });
    assert.equal(result.status, 200);
  }
  await setDocument(sample.before);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, until, evaluate } = browser;
  async function geometry() {
    await evaluate('document.fonts.ready');
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    return evaluate(`(() => {
      const root=document.querySelector("#resume-document"), origin=root.getBoundingClientRect();
      return [root,...root.querySelectorAll("[data-node-id]")].filter(el=>!el.closest("[data-editor-only=true]"))
        .map(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return {
          id:el.dataset.nodeId||"root", x:Math.round((r.left-origin.left)*10)/10,y:Math.round((r.top-origin.top)*10)/10,
          width:Math.round(r.width*10)/10,height:Math.round(r.height*10)/10,
          font:s.font,color:s.color,padding:s.padding,display:s.display,grid:s.gridTemplateColumns,
          appearance:Object.fromEntries(['background','border','margin','gap','line-height',
            'text-align','letter-spacing','font-weight','box-sizing','transform','order',
            'grid-row','grid-column','flex-direction'].map(key=>[key,s.getPropertyValue(key)]))
        }});
    })()`);
  }
  const beforeDocument = (await ws()).draft.resume_json;
  const beforeGeometry = await geometry();
  await setDocument(sample.after, { change_type: 'full_document',
    before: { resume_json: sample.before }, after: { resume_json: sample.after } });
  await evaluate('refresh()');
  const afterDocument = (await ws()).draft.resume_json;
  const afterGeometry = await geometry();
  await click('#undo-step'); await until('!historyStepPending');
  assert.deepEqual((await ws()).draft.resume_json, beforeDocument);
  assert.deepEqual(await geometry(), beforeGeometry, '撤销后的每个节点应与修改前布局一致');
  await click('#redo-step'); await until('!historyStepPending');
  assert.deepEqual((await ws()).draft.resume_json, afterDocument);
  assert.deepEqual(await geometry(), afterGeometry, '重做后的每个节点应与修改后布局一致');
  t.diagnostic(`${sample.name}：${beforeGeometry.length} 个节点，撤销/重做的完整文档、几何位置及展示样式一致`);
  assert.deepEqual(browser.errors, []);
});
