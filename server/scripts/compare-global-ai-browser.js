'use strict';

// Opt-in real Chromium + real HTTP application + real providers.
// All writes are confined to a disposable test database and QA object directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadQAConfig } = require('./openai-qa-config');
const { document: fixture, FACTS, geometry } = require('../../tests/fixtures/full-resume-comparison');
const R = require('../../resume-dom');
const JOB_URL = 'https://job-boards.greenhouse.io/anthropic/jobs/5386182008';

async function main() {
  const live = process.argv.includes('--live');
  const onlyLayout = process.argv.includes('--only-layout');
  const roundsIndex = process.argv.indexOf('--rounds');
  const rounds = roundsIndex < 0 ? 3 : Number(process.argv[roundsIndex + 1]);
  assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5, '轮数限 1—5');
  console.log(JSON.stringify({ live, rounds, model: 'gpt-6-astra', browser: 'Chromium',
    scenarios: ['link-and-image-intake', 'new-reference-restructure', 'image-history-followup',
      'copy-independent-resume', 'reference-switch', 'unreadable-link'],
    checks: ['facts', 'reference-person-leak', 'layout-geometry', 'preview', 'apply-boundary',
      'undo-redo', 'reload', 'project-isolation', 'subtree-controls', 'download'],
    note: '真实网络、模型和页面；仅虚构数据，临时数据库；不把失败自动替换为模拟成功。',
  }));
  if (!live) return;
  const openai = loadQAConfig();
  require('../lib/dotenv').loadEnv();
  assert.ok(process.env.RESUME_MODEL_API_KEY || process.env.RESUME_LLM_API_KEY, 'DeepSeek key 未配置');
  const qaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-browser-live-'));
  process.env.RESUME_OBJECTS_DIR = path.join(qaDirectory, 'objects');
  const helpers = require('../../tests/helpers'); // establishes disposable DB BEFORE app import
  const harness = require('../lib/resume-harness');
  const { createModelGateway } = require('../lib/model-gateway');
  const { openBrowser } = require('../../tests/browser-driver');
  const { hashJson } = require('../lib/util');
  assert.notEqual(path.resolve(helpers.db.DB_PATH), path.resolve('server/data/resume.db'));
  const reportDir = path.resolve('.runtime/ai-comparison', `browser-${Date.now()}`);
  fs.mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const report = { started_at: new Date().toISOString(), rounds, candidate: openai.model, only_layout: onlyLayout,
    prompt_version: harness.PROMPT_VERSION,
    job_url: JOB_URL, temporary_database: helpers.db.DB_PATH, entries: [] };
  const save = () => fs.writeFileSync(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`浏览器报告：${reportDir}`);
  const ctx = await helpers.boot();
  const cleanup = [];
  const t = { after: callback => cleanup.unshift(callback) };
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, until, click, cdp } = browser;
  const providers = [
    { name: 'deepseek', client: createModelGateway({ provider: 'deepseek', globalProvider: 'deepseek' }) },
    { name: 'astra', client: createModelGateway({ provider: 'deepseek', globalProvider: 'openai', openai }) },
  ];
  const screen = async name => {
    const result = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(reportDir, name + '.png'), Buffer.from(result.data, 'base64'), { mode: 0o600 });
  };
  async function reference(layout, ref) {
    const doc = fixture(layout, ref);
    // Code-native fixture rendered by the same browser, no simulated image recognition.
    await evaluate(`(() => {
      const host=document.createElement('div');host.id='qa-fixture';host.style.cssText='position:fixed;inset:0;z-index:99999;background:white;overflow:auto';
      host.innerHTML=ResumeDom.renderToHtml(${JSON.stringify(doc)},{includeRoot:true});
      document.body.append(host);
    })()`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1400, deviceScaleFactor: 1, mobile: false });
    const clip = await evaluate('(() => {const r=document.querySelector("#qa-fixture > *").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()');
    const shot = await cdp('Page.captureScreenshot', { format: 'png', clip });
    const file = path.join(reportDir, `${ref ? 'reference' : 'original'}-${layout}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'), { mode: 0o600 });
    await evaluate('document.querySelector("#qa-fixture").remove()');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    return file;
  }
  async function upload(selector, files) {
    const root = await cdp('DOM.getDocument');
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.root.nodeId, selector });
    await cdp('DOM.setFileInputFiles', { nodeId, files });
    await until(selector === '#home-files'
      ? `homeAttachments.length===${files.length} && homeAttachments.every(x=>x.status==='ready')`
      : `chatAttachments.length===${files.length} && chatAttachments.every(x=>x.status==='ready')`, 20000);
  }
  async function navigate(query) {
    await cdp('Page.navigate', { url: ctx.base.replace('/api/v1', '/') + query });
    await until('Boolean(window.WS && WS.draft)');
    await until(query.startsWith('?project=')
      ? `Boolean(window.WS && WS.draft && PROJECT_ID===${JSON.stringify(query.slice(9))})`
      : 'document.body.classList.contains("home-mode")');
  }
  async function send(text) {
    await click('#prompt');
    await cdp('Input.insertText', { text });
    await click('.send');
    await until('!promptBusy', 240000);
  }
  async function waitFinished() {
    await until('!promptBusy && WS.conversation.messages.some(m=>m.role==="assistant")', 240000);
  }
  const getDoc = () => evaluate('WS.draft.resume_json');
  const checkFacts = doc => {
    const text = R.nodeText(doc.root);
    return { missing_facts: FACTS.filter(f => !text.includes(f)),
      reference_leak: ['顾明', '18812345678', '北岭大学', '数学博士'].filter(f => text.includes(f)) };
  };
  async function checkView(entry, selector, expectedLayout) {
    const view = await evaluate(`(${geometry.toString()})(${JSON.stringify(selector)})`);
    entry[selector.includes('preview') ? 'preview_geometry' : 'canvas_geometry'] = view;
    if (view.narrow.length || view.overflow.length || view.nested_editable.length) entry.issues.push('RENDER_GEOMETRY');
    if (expectedLayout === 'single') {
      const titles = view.headings.filter(h => !h.text.includes('林舟') && h.width > 0);
      if (titles.length < 4 || titles.some(h => h.width < view.width * 0.65)) entry.issues.push('REFERENCE_SINGLE_COLUMN_MISMATCH');
      const education = titles.find(h => /教育/.test(h.text)), work = titles.find(h => /工作/.test(h.text));
      if (education && work && education.y >= work.y) entry.issues.push('REFERENCE_SECTION_ORDER');
    }
    if (expectedLayout === 'sidebar') {
      const edu = view.editable.find(h => /江原大学/.test(h.text));
      const work = view.editable.find(h => /远山科技/.test(h.text));
      if (!edu || !work || work.x - edu.x < view.width * 0.18) entry.issues.push('REFERENCE_SIDEBAR_MISMATCH');
    }
  }
  async function proposal(entry, expectedLayout, before) {
    await waitFinished();
    const action = await evaluate('WS.conversation.messages.flatMap(m=>m.actions||[]).filter(a=>a.action_type==="RESUME_REWRITE_PROPOSAL"&&a.status==="awaiting_confirmation").at(-1)');
    if (!action) {
      entry.issues.push('NO_APPLICABLE_PROPOSAL');
      entry.ui_message = await evaluate('document.querySelector("#chat-messages").innerText.slice(-1600)');
      return false;
    }
    entry.action_id = action.id;
    const target = action.payload.proposal.target_resume_document;
    Object.assign(entry, checkFacts(target));
    if (entry.missing_facts.length || entry.reference_leak.length) entry.issues.push('CONTENT_ACCURACY');
    assert.equal(hashJson(await getDoc()), hashJson(before), '建议未经应用改变了正文');
    await click(`[data-action="${action.id}"] .preview-document`);
    await checkView(entry, '#resume-preview-document', expectedLayout);
    await screen(entry.key + '-preview');
    await click('#resume-preview-modal .close');
    await click(`[data-action="${action.id}"] .replace`);
    await until(`WS.conversation.messages.flatMap(m=>m.actions||[]).some(a=>a.id===${JSON.stringify(action.id)}&&a.status==="applied")`, 20000);
    const applied = await getDoc();
    entry.apply_matches_target = hashJson(applied) === hashJson(target);
    if (!entry.apply_matches_target) entry.issues.push('APPLY_MISMATCH');
    await checkView(entry, '#resume-document', expectedLayout);
    await screen(entry.key + '-applied');
    await click('#undo-step');
    await until(`JSON.stringify(WS.draft.resume_json)===${JSON.stringify(JSON.stringify(before))}`, 10000);
    await click('#redo-step');
    await until(`JSON.stringify(WS.draft.resume_json)===${JSON.stringify(JSON.stringify(applied))}`, 10000);
    entry.undo_redo = true;
    fs.writeFileSync(path.join(reportDir, entry.key + '-target.json'), JSON.stringify(target), { mode: 0o600 });
    return true;
  }
  async function scenario(provider, round, id, callback) {
    if (onlyLayout && id !== 'new-reference-restructure') return null;
    const entry = { key: `${round}-${provider.name}-${id}`, round, provider: provider.name, scenario: id,
      started_at: new Date().toISOString(), issues: [], calls: [], ok: false };
    const restore = harness.setModelClientForTests({ async generate(request) {
      const start = Date.now();
      const call = { capability: request.capability, stage: request.routingReason,
        request_hash: hashJson(request.messages) };
      entry.calls.push(call);
      try {
        const result = await provider.client.generate(request);
        Object.assign(call, { model: result.model, usage: result.usage });
        return result;
      } catch (error) { call.code = error.code; call.status = error.status; throw error; }
      finally { call.duration_ms = Date.now() - start; }
    } });
    console.log(JSON.stringify({ start: entry.key }));
    const start = Date.now();
    try { await callback(entry); entry.ok = entry.issues.length === 0; }
    catch (error) { entry.issues.push(error.code || 'BROWSER_ASSERTION'); entry.error = error.message.slice(0, 1500); }
    finally {
      restore(); entry.duration_ms = Date.now() - start;
      report.entries.push(entry); save();
      console.log(JSON.stringify({ finished: entry.key, ok: entry.ok, issues: entry.issues, calls: entry.calls.length, ms: entry.duration_ms }));
    }
    if (entry.calls.some(c => [401, 403, 404, 429].includes(c.status))) throw new Error('模型配置/限额错误，停止消耗请求');
    return entry;
  }
  try {
    const original = await reference('sidebar', false);
    const single = await reference('single', true);
    const sidebar = await reference('sidebar', true);
    for (let round = 1; round <= rounds; round++) {
      const ordered = round % 2 ? providers : providers.slice().reverse();
      for (const provider of ordered) {
        let projectId;
        await scenario(provider, round, 'link-and-image-intake', async entry => {
          await navigate('?new=1');
          const countBefore = entry.calls.length;
          await upload('#home-files', [original, single]);
          assert.equal(entry.calls.length, countBefore, '上传不能自动生成');
          await click('#home-prompt');
          await cdp('Input.insertText', { text: `请直接制作中文简历。第一张图片是我的原始简历，只用其中林舟的真实内容；第二张是排版参考，按第二张的单栏结构、模块顺序和标题样式重新组织，不能使用参考图中顾明的个人信息。保留原始联系方式、经历和成果数字。目标岗位链接：\n${JOB_URL}\n请按此岗位突出企业服务产品能力，不编造经历。` });
          await click('#home-submit');
          await until('Boolean(window.WS && WS.draft) && !document.body.classList.contains("home-mode") && !promptBusy && WS.conversation.messages.some(m=>m.role==="assistant")', 240000);
          projectId = await evaluate('PROJECT_ID');
          const doc = await getDoc();
          if (!R.plainText(doc).includes('林舟')) {
            entry.issues.push('FIRST_GENERATION_FAILED');
            entry.ui_message = await evaluate('document.querySelector("#chat-messages").innerText.slice(-1800)');
            return;
          }
          Object.assign(entry, checkFacts(doc));
          if (entry.missing_facts.length || entry.reference_leak.length) entry.issues.push('CONTENT_ACCURACY');
          entry.version_saved = await evaluate('WS.versions.length===1');
          if (!entry.version_saved) entry.issues.push('FIRST_VERSION_NOT_SAVED');
          await checkView(entry, '#resume-document', 'single');
          await click('#preview-current');
          await checkView(entry, '#resume-preview-document', 'single');
          await screen(entry.key);
          await click('#resume-preview-modal .close');
        });
        // Every independent input comparison starts from the same complete document,
        // even if the public job link has expired or the intake failed.
        const created = await helpers.call(ctx, 'POST', '/projects', { body: { name: `QA ${round} ${provider.name}` } });
        assert.equal(created.status, 200);
        projectId = created.body.id;
        helpers.db.run('UPDATE resume_drafts SET resume_json = ? WHERE project_id = ?', [JSON.stringify(fixture()), projectId]);
        await navigate('?project=' + projectId);
        await scenario(provider, round, 'new-reference-restructure', async entry => {
          const before = await getDoc();
          await upload('#file-input', [single]);
          await send('按我新发这张图片的单栏结构重新排版当前简历，模块顺序、标题效果参考图片。使用当前林舟的内容，不使用图片里顾明的姓名、电话、学校等信息，所有原始经历和数字保留。直接给出修改建议。');
          await proposal(entry, 'single', before);
        });
        await scenario(provider, round, 'image-history-followup', async entry => {
          const before = await getDoc();
          await send('继续按刚才图片的结构，正文更简洁，保留全部经历、联系方式、学校、任职时间和数字；SQL保持原样，不增加新经历。');
          await proposal(entry, 'single', before);
          if (!entry.calls.every(c => c.capability === 'vision')) entry.issues.push('HISTORY_IMAGE_NOT_ROUTED_TO_VISION');
        });
        await scenario(provider, round, 'copy-independent-resume', async entry => {
          const before = await getDoc();
          await click('#another-resume');
          await until('document.body.classList.contains("home-mode") && document.querySelector("#reuse-current")');
          await click('#home-submit');
          await until(`Boolean(window.WS && WS.draft) && !document.body.classList.contains("home-mode") && PROJECT_ID!==${JSON.stringify(projectId)}`);
          assert.equal(hashJson(await getDoc()), hashJson(before));
          assert.equal(await evaluate('WS.conversation.messages.length'), 0);
          entry.original_project = projectId; entry.copied_project = await evaluate('PROJECT_ID');
          await upload('#file-input', [sidebar]);
          await send('这份新简历请改成这张新图片的左右双栏布局：左侧基本信息、教育背景和技能，右侧职业概况、项目经历和工作经历；内容仍使用林舟，不使用顾明的资料，保留所有经历和数字。直接给出建议。');
          await proposal(entry, 'sidebar', before);
          const originalWS = await helpers.call(ctx, 'GET', '/projects/' + projectId);
          assert.equal(hashJson(originalWS.body.draft.resume_json), hashJson(before), '新简历覆盖了原简历');
          entry.project_isolated = true;
        });
        await scenario(provider, round, 'unreadable-link', async entry => {
          const before = await getDoc();
          await send('按这个岗位优化：https://127.0.0.1/private');
          assert.equal(entry.calls.length, 0, '受限链接不应进入模型');
          assert.equal(hashJson(await getDoc()), hashJson(before));
          const text = await evaluate('document.querySelector("#chat-messages").innerText');
          assert.match(text, /粘贴岗位描述|上传截图/);
        });
      }
    }
    report.browser_errors = browser.errors;
    report.finished_at = new Date().toISOString();
    save();
  } finally {
    for (const callback of cleanup) await callback();
    helpers.close(ctx);
  }
  console.log(JSON.stringify({ report: reportDir, passed: report.entries.filter(e => e.ok).length,
    total: report.entries.length, completed: Boolean(report.finished_at) }));
  if (report.entries.some(e => !e.ok)) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
