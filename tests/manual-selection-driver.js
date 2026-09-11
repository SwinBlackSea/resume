'use strict';
const assert = require('node:assert/strict');
const R = require('../resume-dom');

// Migrate old layout scenarios to explicit selection, without using the
// application hit-test or setting its state from the test.
function scenarioTarget(document, anchor, action) {
  const found = R.findNode(document, anchor);
  if (action === 'add_section_after') return found.parent.id;
  if (action === 'add_section_content') return found.parent.children.at(-1).id;
  if (['add_content_sibling', 'remove_content', 'duplicate_node', 'delete_node'].includes(action)) return anchor;
  const cap = R.manualStructureCapabilities(document, anchor);
  return action.startsWith('remove') ? cap.remove.target_id : cap.target_id;
}

async function selectNode(browser, id) {
  const { evaluate, cdp, hover } = browser;
  const selector = `[data-node-id=${JSON.stringify(id)}]`;
  const editable = await evaluate(`document.querySelector(${JSON.stringify(selector)}).matches('[data-resume-editable=true]')`);
  if (editable) {
    await hover(selector);
  } else {
    const box = await evaluate(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)});
      const anchor=el.querySelector('[data-resume-editable=true]')||el;
      anchor.scrollIntoView({block:'center',behavior:'instant'});
      // A 150% table can exceed the canvas. Reveal the selected container's
      // own left edge instead of aiming at a negative viewport coordinate
      // after centering one of its right-hand cells.
      el.scrollIntoView({block:'nearest',inline:'start',behavior:'instant'});
      const canvas=el.closest('.canvas');
      if(canvas){
        const edge=el.getBoundingClientRect().left,visible=canvas.getBoundingClientRect().left+24;
        if(edge<visible)canvas.scrollLeft=Math.max(0,canvas.scrollLeft-(visible-edge));
      }
      let r=el.getBoundingClientRect();
      if(!r.width||!r.height){
        const rs=[...el.querySelectorAll('[data-node-id]')].map(n=>n.getBoundingClientRect()).filter(r=>r.width&&r.height);
        r={left:Math.min(...rs.map(r=>r.left)),top:Math.min(...rs.map(r=>r.top)),bottom:Math.max(...rs.map(r=>r.bottom))};
      }
      return {left:r.left,top:r.top,bottom:r.bottom};
    })()`);
    let selected = false;
    for (const fy of [.5, .15, .85]) {
      const y = Math.max(90, Math.min(950, box.top + (box.bottom - box.top) * fy));
      for (let lane = 0; lane < 12; lane++) {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.left - 4 - lane * 8, y });
        if (await evaluate(`nodeStructureState?.nodeId===${JSON.stringify(id)}`)) { selected = true; break; }
      }
      if (selected) break;
    }
  }
  assert.equal(await evaluate('nodeStructureState&&nodeStructureState.nodeId'), id, `鼠标必须明确选中 ${id} ` +
    await evaluate(`JSON.stringify({zoom:currentResumeZoom,rect:document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()})`));
  assert.equal(await evaluate('document.querySelectorAll("#node-structure-outline.show").length'), 1);
  assert.equal(await evaluate('document.querySelector("#node-structure-menu")'), null);
}
module.exports = { scenarioTarget, selectNode };
