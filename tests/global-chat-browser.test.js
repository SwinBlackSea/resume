'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const ResumeDom = require('../resume-dom');

// Real Chromium regression, no browser automation dependency. Set CHROME_BIN
// in CI; the development image already contains this Chromium build.
const chrome = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/ms-playwright/chromium-1187/chrome-linux/chrome');
const available = fs.existsSync(chrome);

test('真实浏览器：连续聊天、输入、长建议、重试、手改合并、样式结构、撤销重做、新对话及响应式', {
  skip: available ? false : '设置 CHROME_BIN 运行真实浏览器发布检查',
  timeout: 60000,
}, async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);
  const before = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  let release;
  let entered;
  const pendingStarted = new Promise((resolve) => { entered = resolve; });
  const pendingModel = new Promise((resolve) => { release = resolve; });
  let releaseNewChat;
  let enteredNewChat;
  const newChatStarted = new Promise((resolve) => { enteredNewChat = resolve; });
  const newChatModel = new Promise((resolve) => { releaseNewChat = resolve; });
  const requests = [];
  t.after(harness.setModelClientForTests({
    generate: async ({ input }) => {
      requests.push(input);
      if (requests.length === 3) { entered(); await pendingModel; }
      if (requests.length === 9) { enteredNewChat(); await newChatModel; }
      const call = requests.length;
      if ([4, 5].includes(call)) return { output: {
        type: 'proposal', content: '模拟供应商无效输出',
        proposal: { target_resume_fragments: { format: 'resume-target-fragments-v2',
          changes: [{ target_id: 'missing-node', replacement_subtree: null }] } },
      } };
      if (call === 8) return { output: {
        type: 'proposal', content: '已准备模块结构调整建议。',
        proposal: {
          target_resume_fragments: { format: 'resume-target-fragments-v2',
            changes: [{ target_id: 'section-summary', replacement_subtree: null }],
            insertions: [{ parent_id: 'resume-root', after_id: null, new_subtrees: [{
              id: 'browser-new-section', type: 'element', tag: 'section', semantic: { kind: 'section' },
              children: [
                { id: 'browser-new-heading', type: 'element', tag: 'h2',
                  semantic: { kind: 'section_title' }, text: '职业发展' },
                { id: 'browser-new-list', type: 'element', tag: 'ul', semantic: { kind: 'list' }, children: [
                  { id: 'browser-new-item', type: 'element', tag: 'li',
                    semantic: { kind: 'list_item' }, editable: true, text: '完整保留新增子树' },
                ] },
              ],
            }] }],
          },
          change_constraints: { content: 'modify', structure: 'modify', style: 'preserve',
            content_order: 'preserve', allowed_region_ids: ['resume-root'] },
        },
      } };
      return { output: { type: 'proposal', content: '修改建议已准备好。',
        proposal: {
          target_resume_fragments: { format: 'resume-target-fragments-v2', insertions: [],
            changes: [{ target_id: 'target-bullet', replacement_subtree: {
              id: 'target-bullet',
              ...(call === 7 ? { style: { color: '#17365D', 'font-size': '18px' } }
                : { text: call === 6 ? '长建议中的关键成果。'.repeat(60) : `真实浏览器建议第${call}版` }),
            } }] },
          change_constraints: { content: call === 7 ? 'preserve' : 'modify',
            structure: 'preserve', style: call === 7 ? 'modify' : 'preserve',
            content_order: 'preserve', allowed_region_ids: ['resume-root'] },
        },
      } };
    },
  }));
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-chat-browser-'));
  const child = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profilePath}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => {
    release(); releaseNewChat(); child.kill();
    child.once('exit', () => fs.rmSync(profilePath, { recursive: true, force: true }));
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium 启动超时')), 10000);
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  t.after(() => socket.close());
  let nextId = 0;
  let sessionId;
  const waiting = new Map();
  const pageErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending?.reject(new Error(JSON.stringify(message.error)));
    else pending?.resolve(message.result);
  });
  function cdp(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }));
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: 'sessionStorage.setItem("resumeGuideSeen","1");',
  });
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function until(expression) {
    for (let i = 0; i < 150; i += 1) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    console.log('浏览器失败诊断', await evaluate(`JSON.stringify({
      toast:document.querySelector("#toast").textContent,
      undo_disabled:document.querySelector("#undo-step").disabled,
      redo_disabled:document.querySelector("#redo-step").disabled,
      undo:WS.draft.undo_stack,redo:WS.draft.redo_stack,
      has_summary:!!ResumeDom.findNode(WS.draft.resume_json,"section-summary"),
      has_new:!!ResumeDom.findNode(WS.draft.resume_json,"browser-new-section"),
      status:WS.conversation.tasks.map(t=>t.status)
    })`));
    assert.fail(`浏览器未达到状态：${expression}`);
  }
  async function typeAndSend(text) {
    await evaluate('document.querySelector("#prompt").focus()');
    await cdp('Input.insertText', { text });
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  await cdp('Page.navigate', { url: ctx.base.replace('/api/v1', '/') });
  await until('Boolean(window.WS && WS.draft)');
  await evaluate(`document.querySelector("#prompt").value="中文候选尚未确认";
    document.querySelector("#prompt").dispatchEvent(new KeyboardEvent("keydown",
      {key:"Enter",isComposing:true,bubbles:true}));`);
  assert.equal(requests.length, 0, '中文输入法确认候选不能误发送');
  await evaluate('document.querySelector("#prompt").value=""');
  await typeAndSend('把整份简历精简一下');
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(requests.length, 1);
  const firstTask = requests[0].request.task.id;
  const proposed = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.deepEqual(proposed.draft.resume_json, before.draft.resume_json);
  await typeAndSend('保留数字，继续精简');
  await until('!promptBusy && document.querySelectorAll(".chat-proposal").length === 2');
  assert.equal(requests[1].request.task.id, firstTask);
  assert.ok(requests[1].workspace.resume.proposal_content);
  assert.equal(await evaluate('document.querySelector(".proposal-comparison").open'), false);
  await evaluate('document.querySelector(".chat-proposal .replace").click()');
  await until('WS.draft.revision > 1 && Boolean(document.querySelector(".chat-proposal button[disabled]"))');
  await until('activeTaskId !== null');
  const applied = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.ok(applied.draft.revision > before.draft.revision);
  await typeAndSend('再调一下排版');
  await pendingStarted;
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await until('document.querySelectorAll(".chat-thinking-dots i").length === 3');
  const animationTime = await evaluate('document.querySelector(".chat-thinking-dots i").getAnimations()[0].currentTime');
  // Exercise the real six-second delayed label update, not just initial CSS.
  await evaluate('new Promise(resolve => setTimeout(resolve, 6200))');
  assert.equal(await evaluate('document.querySelector(".chat-thinking-label").textContent'), 'AI 正在生成，请稍候…');
  assert.ok(await evaluate('document.querySelector(".chat-thinking-dots i").getAnimations()[0].currentTime') > animationTime + 1000);
  assert.equal(await evaluate('document.querySelector(".bubble.thinking").getAttribute("role")'), 'status');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".chat-thinking-dots i")).animationName'), 'none');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cdp('Page.reload');
  await until('Boolean(window.WS && WS.draft && promptBusy && !document.querySelector("#stop-ai-request").hidden)');
  assert.equal(await evaluate('document.querySelectorAll(".chat-thinking-dots i").length'), 3);
  assert.equal(await evaluate('document.querySelector(".chat-thinking-dots i").getAnimations()[0].playState'), 'running');
  await evaluate('document.querySelector("#stop-ai-request").click()');
  await until('!promptBusy && Boolean(document.querySelector(".ai-retry-button"))');
  assert.equal(await evaluate('document.querySelectorAll(".bubble.thinking").length'), 0);
  release();
  await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  const final = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.equal(final.conversation.messages.filter((row) => row.result_type === 'PROPOSAL').length, 2);
  assert.deepEqual(final.draft.resume_json, applied.draft.resume_json);
  // A failed retry keeps the original request; a second retry succeeds without
  // inserting duplicate user messages or clearing a draft in the composer.
  await evaluate('document.querySelector("#prompt").value="尚未发送的补充"; document.querySelector(".ai-retry-button").click()');
  await until('!promptBusy && WS.conversation.messages.at(-1).error_code === "PROPOSAL_NOT_EXECUTABLE"');
  assert.equal(requests.length, 5);
  await evaluate('document.querySelector(".ai-retry-button").click()');
  await until('!promptBusy && Boolean(document.querySelector(".proposal-expand"))');
  assert.equal(requests.length, 6);
  assert.equal(await evaluate('document.querySelector("#prompt").value'), '尚未发送的补充');
  await evaluate('document.querySelector(".proposal-expand").click()');
  assert.equal(await evaluate('document.querySelector(".proposal-expand").getAttribute("aria-expanded")'), 'true');
  await evaluate('document.querySelector(".proposal-expand").click()');
  assert.equal(await evaluate('document.querySelector(".proposal-expand").getAttribute("aria-expanded")'), 'false');
  const editable = [];
  function collect(node) {
    if (node.editable && node.id !== 'target-bullet') editable.push(node.id);
    (node.children || []).forEach(collect);
  }
  collect(before.draft.resume_json.root);
  const manualId = editable[0];
  assert.ok(manualId);
  await evaluate(`{
    const el=document.querySelector('[data-node-id="${manualId}"]');
    el.focus();const range=document.createRange();range.selectNodeContents(el);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
  }`);
  await cdp('Input.insertText', { text: '并行手工补充须保留' });
  await evaluate('document.querySelector("#prompt").focus()');
  await until(`ResumeDom.nodeText(ResumeDom.findNode(WS.draft.resume_json,"${manualId}").node).includes("并行手工补充须保留")`);
  const revisionBeforeApply = await evaluate('WS.draft.revision');
  await evaluate('document.querySelector(".chat-proposal .replace").click()');
  await until(`WS.draft.revision > ${revisionBeforeApply}`);
  assert.equal(await evaluate(`ResumeDom.nodeText(ResumeDom.findNode(WS.draft.resume_json,"${manualId}").node)`),
    '并行手工补充须保留');
  await evaluate('document.querySelector("#undo-step").click()');
  await until('ResumeDom.nodeText(ResumeDom.findNode(WS.draft.resume_json,"target-bullet").node).includes("第2版")');
  assert.equal(await evaluate(`ResumeDom.nodeText(ResumeDom.findNode(WS.draft.resume_json,"${manualId}").node)`),
    '并行手工补充须保留');
  await evaluate('document.querySelector("#redo-step").click()');
  await until('ResumeDom.nodeText(ResumeDom.findNode(WS.draft.resume_json,"target-bullet").node).includes("长建议")');
  await evaluate('document.querySelector("#prompt").value=""');
  await typeAndSend('只把当前成果文字设为18px深蓝色');
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  await evaluate('document.querySelector(".chat-proposal .replace").click()');
  await until('getComputedStyle(document.querySelector("#target-bullet")).color === "rgb(23, 54, 93)"');
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#target-bullet")).fontSize'), '18px');
  await typeAndSend('删除概况，增加一个带列表的职业发展模块');
  await until('!promptBusy && Boolean(document.querySelector(".chat-proposal .replace"))');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-node-id=browser-new-section]"))'), false);
  await evaluate('document.querySelector(".chat-proposal .replace").click()');
  await until('Boolean(document.querySelector("[data-node-id=browser-new-section] ul li"))');
  assert.equal(await evaluate('Boolean(document.querySelector("[data-node-id=section-summary]"))'), false);
  await evaluate('document.querySelector("#undo-step").click()');
  await until('Boolean(document.querySelector("[data-node-id=section-summary]")) && !document.querySelector("[data-node-id=browser-new-section]")');
  await evaluate('document.querySelector("#redo-step").click()');
  await until('Boolean(document.querySelector("[data-node-id=browser-new-section] ul li"))');
  const beforeNewChat = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  await typeAndSend('再帮我看看');
  await newChatStarted;
  await evaluate('document.querySelector("#new-chat-button").click();document.querySelector("#confirm-new-chat").click()');
  await until(`!promptBusy && WS.conversation.id !== "${beforeNewChat.conversation.id}"`);
  releaseNewChat();
  await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  const afterNewChat = (await helpers.call(ctx, 'GET', `/projects/${projectId}`)).body;
  assert.equal(afterNewChat.conversation.messages.length, 0);
  assert.deepEqual(afterNewChat.draft.resume_json, beforeNewChat.draft.resume_json);
  assert.deepEqual(afterNewChat.profile, beforeNewChat.profile);
  assert.equal(await evaluate('document.querySelector("#selection-label").textContent'), '@整份简历');
  await evaluate('document.querySelector("#assistant-collapse").click()');
  assert.equal(await evaluate('document.querySelector("#assistant-collapse").getAttribute("aria-expanded")'), 'false');
  await evaluate('document.querySelector("#assistant-collapse").click()');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector(".assistant-toggle").click()');
  await evaluate('new Promise(resolve => setTimeout(resolve, 250))');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
    '窄屏不能产生整页横向溢出');
  assert.deepEqual(pageErrors, []);
  const image = await cdp('Page.captureScreenshot', { format: 'png' });
  const imagePath = path.join(os.tmpdir(), `resume-global-chat-browser-${process.pid}.png`);
  fs.writeFileSync(imagePath, Buffer.from(image.data, 'base64'));
  console.log(`真实浏览器截图：${imagePath}`);
});
