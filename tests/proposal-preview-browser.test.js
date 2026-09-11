'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const R = require('../resume-dom');
const { uuidv7 } = require('../server/lib/util');
const { openBrowser, available } = require('./browser-driver');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function waitForDialog(browser, selector) {
  // A "show" class is applied before the transform animation finishes. Clicking
  // a moving close/apply button can hit the paper underneath its new position.
  await browser.until(`(() => {
    const dialog=document.querySelector(${JSON.stringify(selector)});
    return dialog.classList.contains('show') && dialog.getAnimations({subtree:true})
      .filter(a=>a.effect.getTiming().iterations!==Infinity)
      .every(a=>a.playState==='finished');
  })()`);
}

test('真实浏览器：预览实际合并稿、阻止过期预览、首次及再次应用所见即所得', {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const original = await ws();
  const independent = R.manualSelectionNodes(original.draft.resume_json)
    .find(n => n.node_id !== 'target-bullet' && R.findNode(original.draft.resume_json, n.node_id).node.tag === 'p').node_id;
  t.after(harness.setModelClientForTests({ async generate() {
    return { output: { type: 'proposal', content: '已调整', proposal: {
      target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [],
        changes: [{ target_id: 'target-bullet', replacement_subtree: { id: 'target-bullet', text: '建议的中文表达', style: { 'font-size': '18px' } } }] },
      change_constraints: { content: 'modify', structure: 'preserve', style: 'modify',
        content_order: 'preserve', allowed_region_ids: [original.draft.resume_json.root.id] },
    } } };
  } }));
  const generated = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, { body: {
    content: '调整表达', conversation_id: original.conversation.id,
  } });
  assert.equal(generated.status, 200);
  const action = generated.body.actions.find(a => a.action_type === 'RESUME_REWRITE_PROPOSAL');
  async function edit(node, text) {
    const result = await helpers.call(ctx, 'POST', `/projects/${id}/resume-draft/transactions`, { body: {
      expected_revision: (await ws()).draft.revision, mutation_id: uuidv7(),
      operations: [{ op: 'replace_text', node_id: node, text }],
    } });
    assert.equal(result.status, 200);
  }
  await edit(independent, '预览前的独立手改');
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, until, evaluate } = browser;
  const card = `.chat-proposal[data-action="${action.id}"]`;
  assert.equal(await evaluate('document.querySelector("#chat-messages .proposal-diff")'), null);
  await click(card + ' .proposal-diff-open');
  await waitForDialog(browser, '#proposal-diff-modal');
  assert.equal(await evaluate('document.querySelector("#proposal-diff-content .proposal-diff-row ins").textContent'), '建议的中文表达');
  assert.equal(await evaluate('document.querySelector("#proposal-diff-content .proposal-diff-row ins").parentElement.dataset.diffKind'), 'add');
  assert.match(await evaluate('getComputedStyle(document.querySelector("#proposal-diff-content .proposal-diff-row del")).textDecorationLine'), /line-through/);
  assert.equal(await evaluate('document.querySelectorAll("#proposal-diff-content .resume-review-paper").length'), 1);
  assert.match(await evaluate('document.querySelector("#proposal-diff-content").textContent'), /字号/);
  assert.match(await evaluate('document.querySelector("#proposal-diff-content").textContent'), /预览前的独立手改/);
  assert.equal(await evaluate('typeof ResumeReview.render'), 'function');
  await click('#proposal-diff-modal .close');
  await until('!document.querySelector("#proposal-diff-modal").classList.contains("show")');
  assert.equal(await evaluate('document.querySelector("#preview-current").closest("#doc-toolbar")!==null'), true);
  assert.equal(await evaluate('document.querySelector(".generate")'), null);
  assert.equal(await evaluate('document.querySelectorAll(".history-open").length'), 1);
  await click(card + ' .preview-document');
  await waitForDialog(browser, '#resume-preview-modal');
  assert.match(await evaluate('document.querySelector("#resume-preview-document").textContent'), /预览前的独立手改/);
  assert.equal(await evaluate('document.querySelector("#resume-preview-apply").hidden'), false);
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-preview-export-'));
  t.after(() => fs.rmSync(downloadDir, { recursive: true, force: true }));
  await browser.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  const beforeExport = await ws();
  assert.equal(await evaluate('document.querySelector("#resume-preview-export")'), null);
  assert.equal(await evaluate('document.querySelector("#resume-preview-downloads").hidden'), false);
  await click('#resume-preview-downloads [data-download-format="docx"]');
  let download;
  for (let i = 0; i < 100; i++) {
    download = fs.readdirSync(downloadDir).find(name => name.endsWith('.docx'));
    if (download) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(download, '点击导出应实际下载建议文件：' + await evaluate('document.querySelector("#resume-preview-note").textContent'));
  const xml = execFileSync('unzip', ['-p', path.join(downloadDir, download), 'word/document.xml'], { encoding: 'utf8' });
  assert.match(xml, /建议的中文表达/);
  assert.match(xml, /预览前的独立手改/);
  await click('#resume-preview-downloads [data-download-format="pdf"]');
  let pdf;
  for (let i = 0; i < 100; i++) {
    pdf = fs.readdirSync(downloadDir).find(name => name.endsWith('.pdf'));
    if (pdf) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(pdf);
  assert.equal(fs.readFileSync(path.join(downloadDir, pdf)).subarray(0, 4).toString(), '%PDF');
  const pdfText = execFileSync('pdftotext', [path.join(downloadDir, pdf), '-'], { encoding: 'utf8' }).replace(/\s/g, '');
  assert.match(pdfText, /建议的中文表达/);
  assert.match(pdfText, /预览前的独立手改/);
  assert.deepEqual((await ws()).draft, beforeExport.draft);
  assert.deepEqual((await ws()).versions, beforeExport.versions);
  await click('#resume-preview-modal .close');
  await evaluate('refresh()');
  await edit(independent, '预览之后另一窗口修改');
  const beforeBlocked = await ws();
  await click(card + ' .replace');
  await until('document.querySelector("#toast").textContent.includes("重新预览")');
  assert.deepEqual((await ws()).draft.resume_json, beforeBlocked.draft.resume_json);
  const staleDownload = await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview/download?format=docx&revision=${beforeExport.draft.revision}`);
  assert.equal(staleDownload.status, 409);
  assert.equal(staleDownload.body.title, 'PREVIEW_OUTDATED');
  const missingRevision = await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview/download?format=docx`);
  assert.equal(missingRevision.status, 409);
  const notOwned = await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview/download?format=pdf&revision=${beforeBlocked.draft.revision}`, { user: 'not-owner' });
  assert.ok([401, 404].includes(notOwned.status));
  await click(card + ' .preview-document');
  await waitForDialog(browser, '#resume-preview-modal');
  const preview = (await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview`)).body.target_resume_document;
  assert.match(await evaluate('document.querySelector("#resume-preview-document").textContent'), /预览之后另一窗口修改/);
  await click('#resume-preview-apply');
  await until(`Boolean(document.querySelector(${JSON.stringify(card + ' .reapply')}))`);
  await until('!document.querySelector("#resume-preview-modal").classList.contains("show")');
  assert.deepEqual((await ws()).draft.resume_json, preview);
  for (let i = 0; i < 7; i++) await edit(i === 6 ? independent : 'target-bullet', '应用后的手改' + i);
  await evaluate('refresh()');
  await click(card + ' .preview-document');
  await waitForDialog(browser, '#resume-preview-modal');
  assert.match(await evaluate('document.querySelector("#resume-preview-document").textContent'), /应用后的手改6/);
  assert.match(await evaluate('document.querySelector("#resume-preview-note").textContent'), /再次应用/);
  const secondPreview = (await helpers.call(ctx, 'GET', `/ai/actions/${action.id}/preview`)).body.target_resume_document;
  await click('#resume-preview-apply');
  await until('document.querySelector("#toast").textContent.includes("已再次应用")');
  assert.deepEqual((await ws()).draft.resume_json, secondPreview);
  await click('#preview-current');
  await waitForDialog(browser, '#resume-preview-modal');
  assert.equal(await evaluate('document.querySelector("#resume-preview-apply").hidden'), true);
  assert.equal(await evaluate('document.querySelector("#resume-preview-downloads").hidden'), false);
  const beforeCurrentDownload = await ws();
  for (const format of ['pdf', 'docx']) {
    await click(`#resume-preview-downloads [data-download-format="${format}"]`);
    let file;
    for (let i = 0; i < 100; i++) {
      file = fs.readdirSync(downloadDir).find(name => name.endsWith('.' + format) && !name.includes('-建议'));
      if (file) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(file, '当前简历预览应直接下载 ' + format);
    const savedPath = path.join(downloadDir, file);
    if (format === 'pdf') {
      assert.equal(fs.readFileSync(savedPath).subarray(0, 4).toString(), '%PDF');
      assert.match(execFileSync('pdftotext', [savedPath, '-'], { encoding: 'utf8' }).replace(/\s/g, ''), /应用后的手改6/);
    } else {
      assert.match(execFileSync('unzip', ['-p', savedPath, 'word/document.xml'], { encoding: 'utf8' }), /应用后的手改6/);
    }
  }
  assert.deepEqual((await ws()).draft, beforeCurrentDownload.draft);
  assert.deepEqual((await ws()).versions, beforeCurrentDownload.versions);
  await click('#resume-preview-modal .close');
  const beforeVersion = await ws();
  await browser.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    document.querySelector('#save-version-button').scrollIntoView({block:'center',behavior:'instant'});
    requestAnimationFrame(resolve);
  })))`);
  await until(`(() => {const b=document.querySelector('#save-version-button'),r=b.getBoundingClientRect();
    return !b.disabled&&b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()`);
  await click('#save-version-button', false);
  await until(`WS.versions.length>${beforeVersion.versions.length}`);
  const saved = await ws();
  assert.deepEqual(saved.draft.resume_json, beforeVersion.draft.resume_json);
  assert.deepEqual(saved.draft.undo_stack, beforeVersion.draft.undo_stack);
  assert.equal(await evaluate('document.querySelector("#save-version-modal").classList.contains("show")'), false,
    '点击保存图标应直接创建历史版本，不增加一轮弹窗确认');
  await click('#account-button');
  await click('#account-menu .history-open');
  await until('document.querySelector("#history-modal").classList.contains("show")');
  await browser.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await click('#account-button');
  assert.equal(await evaluate('document.querySelector("#account-menu").hidden'), false);
  assert.equal(await evaluate(`(() => {const r=document.querySelector('#another-resume').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()`), true);
  await browser.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  assert.equal(await evaluate('document.querySelector("#account-menu").hidden'), true);
  assert.deepEqual(browser.errors, []);
});

test('真实浏览器：纯排版差异不再空白，可直接进入整份建议预览', {
  skip: !available, timeout: 30000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const conversation = await helpers.call(ctx, 'POST', `/projects/${id}/ai/conversations`, {
    body: { conversation_id: before.conversation.id },
  });
  const root = before.draft.resume_json.root.id;
  t.after(harness.setModelClientForTests({ async generate() {
    return { output: { type: 'proposal', content: '已调整排版', proposal: {
      target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [],
        changes: [{ target_id: root, replacement_subtree: { id: root, style: { 'text-align': 'right', padding: '31px' } } }] },
      change_constraints: { content: 'preserve', structure: 'preserve', style: 'modify',
        content_order: 'preserve', allowed_region_ids: [root] },
    } } };
  } }));
  const result = await helpers.call(ctx, 'POST', `/projects/${id}/ai/messages`, {
    body: { content: '调整对齐和间距', conversation_id: conversation.body.id },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  await browser.click('.proposal-diff-open');
  await browser.until('document.querySelector("#proposal-diff-modal").classList.contains("show")');
  const details = await browser.evaluate(`(() => {const d=document.querySelector('#proposal-diff-content');
    return {text:d.textContent,add:d.querySelectorAll('ins').length,remove:d.querySelectorAll('del').length};})()`);
  assert.match(details.text, /文字未变化/);
  assert.match(details.text, /文字对齐：.*靠右/);
  assert.match(details.text, /内边距：.*31px/);
  assert.ok(details.add > 0 && details.remove === details.add);
  await browser.click('#diff-preview-document');
  await waitForDialog(browser, '#resume-preview-modal');
  assert.equal(await browser.evaluate('document.querySelector("#proposal-diff-modal").classList.contains("show")'), false);
  assert.equal(await browser.evaluate('document.querySelector("#resume-preview-apply").hidden'), false);
  assert.deepEqual((await helpers.call(ctx, 'GET', `/projects/${id}`)).body.draft.resume_json, before.draft.resume_json);
  assert.deepEqual(browser.errors, []);
});
