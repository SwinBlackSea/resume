'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const { openBrowser, available } = require('./browser-driver');
const recognition = require('../server/lib/document-recognition');
const harness = require('../server/lib/resume-harness');
const home = require('../server/modules/home');
const jobValidation = require('../server/lib/home-job-validation');
const ResumeDom = require('../resume-dom');
const { layoutDocument } = require('../server/lib/home-materials');
let ctx;
test.before(async () => { ctx = await helpers.boot(); });
test.after(() => { recognition.setClientForTests(null); home.setLinkReaderForTests(null);
  jobValidation.setClientForTests(null); helpers.close(ctx); });
function document(text) {
  return ResumeDom.toResumeDocument({ schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'resume-root', type: 'element', tag: 'article', semantic: { kind: 'document' },
      children: [{ id: 'profile-heading', type: 'element', tag: 'h1', editable: true,
        semantic: { kind: 'heading' }, text: '王青', children: [] },
      { id: 'profile-intro', type: 'element', tag: 'p', editable: true,
        semantic: { kind: 'paragraph' }, text, children: [] }] } });
}
test('真实 Chromium：首页三区、拖拽截图、岗位实时验证、内置样式、加载刷新、就地预览与独立重生成', {
  skip: !available, timeout: 90000,
}, async (t) => {
  const png = await require('sharp')({ create: { width: 150, height: 220, channels: 3, background: '#e5e9eb' } }).png().toBuffer();
  let recognitionCount = 0;
  recognition.setClientForTests(async () => {
    recognitionCount++;
    return { detected_format: 'png', page_count: 1, parser_version: 'test', model_version: 'test',
      content_candidate: { resume_json: document('个人经历：负责软件开发与用户沟通。') },
      layout_candidate: {}, quality_report: { safe_to_review: true }, warning_codes: [], previews: [] };
  });
  home.setLinkReaderForTests(async (url) => ({ url, resolved_url: url,
    text: 'Software Engineer at Fictional Company. Build tools for users, collaborate with partners and maintain quality software.' }));
  jobValidation.setClientForTests({ async generate(request) {
    return { output: { is_job: !JSON.stringify(request.messages).includes('not-job'),
      title: 'Software Engineer', company: 'Fictional Company' } };
  } });
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const requests = [];
  t.after(harness.setModelClientForTests({ async generate(options) {
    requests.push(options);
    if (requests.length === 1) await waiting;
    return { output: { type: 'proposal', content: '你的简历已制作完成。',
      proposal: { target_resume_document: document('针对软件工程师岗位的完整简历，第 '+requests.length+' 份。'),
        change_constraints: { content: 'modify', structure: 'modify', style: 'modify',
          content_order: 'reorder', allowed_region_ids: ['resume-root'] } } } };
  } }));
  t.after(() => { release(); recognition.setClientForTests(null); helpers.queue.stopWorker(); });
  helpers.queue.startWorker(25);
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, click, until, cdp } = browser;
  await until('document.querySelectorAll("[data-layout-id]").length===20');
  const layoutGeometry = await evaluate(`(() => {
    const host=document.createElement('div');host.style.width='794px';document.body.appendChild(host);
    const renderer=new ResumeDom.Renderer(host);
    const values=${JSON.stringify(['quiet', 'editorial', 'modern'].map(layoutDocument))}.map(doc=>{
      renderer.render(doc);
      const node=renderer.elementFor('layout-reference');
      const sections=[...host.querySelectorAll('section')];
      return {display:getComputedStyle(node).display,columns:getComputedStyle(node).gridTemplateColumns,
        padding:getComputedStyle(node).paddingLeft,font:getComputedStyle(host.querySelector('h1')).fontSize,
        sectionX:sections.slice(0,2).map(section=>section.getBoundingClientRect().x)};
    });
    host.remove();return values;
  })()`);
  assert.equal(layoutGeometry[0].padding, '40px');
  assert.equal(layoutGeometry[0].font, '30px');
  assert.equal(layoutGeometry[0].sectionX[0], layoutGeometry[0].sectionX[1]);
  assert.equal(layoutGeometry[1].display, 'grid');
  assert.notEqual(layoutGeometry[1].columns, 'none');
  assert.notEqual(layoutGeometry[1].sectionX[0], layoutGeometry[1].sectionX[1]);
  assert.equal(layoutGeometry[2].padding, '30px');
  assert.equal(await evaluate('document.querySelectorAll("[data-home-role]").length'), 3);
  assert.equal(await evaluate('Boolean(document.querySelector(".home-intro"))'), false);
  assert.equal(await evaluate('document.querySelector("#home-generation-status").textContent'), '');
  assert.equal(await evaluate('document.querySelector("#home-generation-status").getAttribute("aria-live")'), 'polite');
  assert.equal(await evaluate('document.querySelector("#home-submit").disabled'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("#resume-list,#home-prompt"))'), false);
  for (const width of [1440, 900, 390, 320]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 600 });
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true,
      '首页不能水平溢出：'+width);
    const rects = await evaluate('[...document.querySelectorAll("[data-home-role]")].map(e=>({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width}))');
    assert.equal(new Set(rects.map((rect) => Math.round(rect.x))).size, width <= 700 ? 1 : 3);
    assert.ok(rects.every((rect) => rect.width >= 230));
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(() => {
    const binary=atob(${JSON.stringify(png.toString('base64'))});
    const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const file=new File([bytes],'个人简历.png',{type:'image/png'}),data=new DataTransfer();
    data.items.add(file);
    document.querySelector('[data-home-role="personal"]').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data}));
  })()`);
  await until('homeController.getState().intake && homeController.getState().intake.materials.personal.status==="ready"', 15000);
  assert.equal(recognitionCount, 0, '首页截图在生成时由视觉模型读取，上传阶段不排队OCR');
  assert.equal(requests.length, 0, '上传识别不能自动生成简历');
  await click('#home-job-link');
  await cdp('Input.insertText', { text: 'https://example.test/not-job' });
  await until('homeController.getState().intake.materials.job.status==="failed"', 10000);
  assert.equal(await evaluate('document.querySelector("#home-submit").disabled'), true);
  assert.match(await evaluate('document.querySelector("#home-job-status").textContent'), /Word、PDF|截图/);
  await evaluate(`document.querySelector('#home-job-link').value='https://example.test/job';
    document.querySelector('#home-job-link').dispatchEvent(new Event('input',{bubbles:true}));`);
  await until('homeController.getState().intake.materials.job.status==="ready"');
  assert.match(await evaluate('document.querySelector("#home-job-status").textContent'), /Software Engineer/);
  await click('#home-layout-toggle');
  await until('!document.querySelector("[data-layout-id=rr-azurill]").disabled');
  await click('[data-layout-id="rr-azurill"]');
  await until('!document.querySelector("#home-layout-use").disabled');await click('#home-layout-use');
  await until('homeController.getState().intake.ready && !document.querySelector("#home-submit").disabled');
  assert.equal(await evaluate('document.querySelector("#home-generation-status").textContent'), '',
    '材料齐全时不重复显示引导小字');
  assert.equal(await evaluate('document.querySelector("[data-layout-id=rr-azurill]").getAttribute("aria-pressed")'), 'true');
  const firstIntake = await evaluate('homeController.getState().intake');
  await click('#home-submit');
  await until('homeController.getState().started');
  await until('document.querySelector("#home-submit").getAttribute("aria-busy")==="true"');
  assert.match(await evaluate('document.querySelector("#home-generation-status").textContent'), /正在生成/,
    '删除空闲提示不影响必要的生成状态');
  assert.equal(await evaluate('document.body.classList.contains("home-mode")'), true);
  while (!requests.length) await new Promise((resolve) => setTimeout(resolve, 20));
  await evaluate('window.__homeReloadSentinel=true');
  await cdp('Page.reload');
  await until('!window.__homeReloadSentinel && window.homeController && homeController.getState().started', 10000);
  assert.equal(await evaluate('homeController.getState().intake.id'), firstIntake.id);
  assert.equal(requests.length, 1, '刷新不重复生成');
  release();
  await until('homeController.getState().result && !document.querySelector("#home-result").hidden', 20000);
  assert.equal(await evaluate('document.body.classList.contains("home-mode")'), true, '成功后留在首页预览');
  assert.match(await evaluate('document.querySelector("#home-result-document").textContent'), /完整简历/);
  const first = (await helpers.call(ctx, 'GET', '/projects/'+firstIntake.project_id)).body;
  assert.equal(first.versions.length, 1);
  assert.deepEqual(first.profile.basics, {});
  assert.equal(requests[0].input.workspace.materials.home_intake.roles.layout.kind, 'builtin');
  const reference = require('../server/lib/builtin-layouts').readBuiltinReferenceImage('rr-azurill');
  const layoutRole = requests[0].input.workspace.materials.home_intake.roles.layout;
  assert.equal(layoutRole.builtin_reference_id, 'rr-azurill');
  assert.equal(layoutRole.reference_document, undefined, '图库选择不能仍传旧JSON排版');
  const imageSource = requests[0].input.image_sources.find((item) => item.reference_only);
  assert.equal(imageSource.input_image_id, 'builtin-layout:rr-azurill:'+reference.sha256);
  assert.equal(imageSource.material_role, 'layout');
  assert.equal(imageSource.reference_only, true);
  const expectedVision = await require('sharp')(reference.buffer).rotate()
    .resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#fff' }).jpeg({ quality: 90 }).toBuffer();
  assert.ok(JSON.stringify(requests[0].messages).includes(expectedVision.toString('base64')),
    '实际模型消息携带所选原图的受控视觉编码，不仅提供一个名称');
  const downloaded = await fetch(ctx.base+'/projects/'+firstIntake.project_id+'/resume-draft/download?format=docx&revision='+first.draft.revision);
  assert.equal(downloaded.status, 200); assert.equal(Buffer.from(await downloaded.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.equal(await evaluate('document.querySelector("#home-result-modal").open'), true);
  await click('#home-result-close');
  await click('#home-result-open');
  assert.equal(await evaluate('document.querySelector("#home-result-modal").open'), true);
  await click('#home-result-close');
  await click('#home-layout-toggle');
  await click('[data-layout-id="rr-bronzor"]');
  await until('!document.querySelector("#home-layout-use").disabled');await click('#home-layout-use');
  await until(`homeController.getState().intake.id!==${JSON.stringify(firstIntake.id)} && !document.querySelector("#home-submit").disabled`);
  assert.equal(recognitionCount, 0, '原图复用不额外调用OCR');
  await click('#home-submit');
  await until('homeController.getState().result && !homeController.getState().started', 20000);
  const second = await evaluate('homeController.getState().result');
  assert.notEqual(second.projectId, firstIntake.project_id);
  assert.deepEqual((await helpers.call(ctx, 'GET', '/projects/'+firstIntake.project_id)).body.draft, first.draft);
  await click('#home-continue');
  await until(`window.WS && PROJECT_ID===${JSON.stringify(second.projectId)} && !document.body.classList.contains("home-mode")`, 12000);
  await click('.brand');
  await until('document.body.classList.contains("home-mode") && window.homeController && !document.querySelector(".home-brand").disabled');
  await click('.home-brand');
  await until(`window.WS && PROJECT_ID===${JSON.stringify(second.projectId)} && !document.body.classList.contains("home-mode")`, 12000);
  await click('#account-button');await click('#another-resume');
  await until(`document.body.classList.contains("home-mode") && window.homeController &&
    homeController.getState().intake && homeController.getState().intake.project_id!==${JSON.stringify(second.projectId)}`, 12000);
  assert.equal(await evaluate('document.querySelector("#home-result").hidden'), true, '明确制作另一份不能恢复旧预览');
  const anotherId = await evaluate('homeController.getState().intake.id');
  await evaluate('window.__homeAnotherSentinel=true');await cdp('Page.reload');
  await until('!window.__homeAnotherSentinel && window.homeController && homeController.getState().intake', 10000);
  assert.equal(await evaluate('homeController.getState().intake.id'), anotherId, '新制作链接刷新不重复创建项目');
  assert.deepEqual(browser.errors, []);
});

test('真实 Chromium：真实追问可自然回答；停止后迟到结果不覆盖，取消后可换材料', {
  skip: !available, timeout: 60000,
}, async (t) => {
  recognition.setClientForTests(async () => ({
    detected_format: 'png', page_count: 1, parser_version: 'test', model_version: 'test',
    content_candidate: { resume_json: document('虚构资料：王青开发软件产品。') },
    layout_candidate: {}, quality_report: { safe_to_review: true }, warning_codes: [], previews: [],
  }));
  helpers.queue.startWorker(25);
  const png = await require('sharp')({ create: { width: 80, height: 120, channels: 3, background: '#f0f0e0' } }).png().toBuffer();
  const requests = []; let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  t.after(() => { release(); helpers.queue.stopWorker(); recognition.setClientForTests(null); });
  t.after(harness.setModelClientForTests({ async generate(options) {
    requests.push(options);
    if (requests.length === 1) return { output: { type: 'message', content: '希望重点保留哪段项目经历？' } };
    if (requests.length === 3) await waiting;
    return { output: { type: 'proposal', content: '已整理简历。',
      proposal: { target_resume_document: document('王青负责客户管理系统的开发和交付。'),
        change_constraints: { content: 'modify', structure: 'modify', style: 'modify',
          content_order: 'reorder', allowed_region_ids: ['resume-root'] } } } };
  } }));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'), { home: true });
  const { evaluate, click, until, cdp } = browser;
  await until('document.querySelectorAll("[data-layout-id]").length===20');
  for (const role of ['personal', 'job']) {
    await evaluate(`(() => {
      const file=new File([Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}),c=>c.charCodeAt(0))],${JSON.stringify(role+'.png')},{type:'image/png'});
      const data=new DataTransfer();data.items.add(file);
      const input=document.querySelector('[data-home-file="${role}"]');input.files=data.files;input.dispatchEvent(new Event('change'));
    })()`);
    await until(`homeController.getState().intake && homeController.getState().intake.materials.${role}.status==="ready"`, 15000);
  }
  await click('#home-layout-toggle');
  await until('!document.querySelector("[data-layout-id=rr-onyx]").disabled');
  await click('[data-layout-id="rr-onyx"]');
  await until('!document.querySelector("#home-layout-use").disabled');await click('#home-layout-use');
  await until('!document.querySelector("#home-submit").disabled');
  await click('#home-submit');
  await until('!document.querySelector("#home-question").hidden && !homeController.getState().started', 15000);
  assert.equal(await evaluate('document.querySelector("#home-result").hidden'), true);
  assert.match(await evaluate('document.querySelector("#home-question-message").textContent'), /重点保留/);
  const answer = '请重点保留客户管理系统，我负责开发和交付。';
  await click('#home-followup'); await cdp('Input.insertText', { text: answer });
  await click('#home-question-send');
  await until('homeController.getState().result && !homeController.getState().started', 15000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).content, answer, '追问回答原样作为最新用户消息');
  assert.match(JSON.stringify(requests[1].messages), /希望重点保留/);
  const originalId = await evaluate('homeController.getState().result.projectId');
  await click('#home-result-close');
  // Choose another reference to create an independent attempt.
  await click('#home-layout-toggle');await click('[data-layout-id="rr-bronzor"]');
  await until('!document.querySelector("#home-layout-use").disabled');await click('#home-layout-use');
  await until(`homeController.getState().intake.project_id!==${JSON.stringify(originalId)} && !document.querySelector("#home-submit").disabled`);
  const canceledIntake = await evaluate('homeController.getState().intake');
  await click('#home-submit');
  while (requests.length < 3) await new Promise((resolve) => setTimeout(resolve, 20));
  await click('#home-stop');
  await until('!homeController.getState().started', 10000);
  release();
  await until('!document.querySelector("#home-submit").disabled');
  assert.equal(ResumeDom.plainText((await helpers.call(ctx, 'GET', '/projects/'+canceledIntake.project_id)).body.draft.resume_json), '');
  await click('#home-layout-toggle');await click('[data-layout-id="rr-azurill"]');
  await until('!document.querySelector("#home-layout-use").disabled');await click('#home-layout-use');
  await until(`homeController.getState().intake.id!==${JSON.stringify(canceledIntake.id)} && !document.querySelector("#home-submit").disabled`);
  assert.equal(await evaluate('document.querySelector("#home-error").hidden'), true);
  assert.deepEqual(browser.errors, []);
});
