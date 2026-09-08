'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const chrome = process.env.CHROME_BIN || path.join(os.homedir(),
  '.cache/ms-playwright/chromium-1187/chrome-linux/chrome');

async function openBrowser(t, url) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-structure-browser-'));
  const child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve); child.kill();
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium启动超时')), 10000);
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
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
  let sequence = 0;
  let sessionId;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  function cdp(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`浏览器命令超时：${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const target = await cdp('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: 'sessionStorage.setItem("resumeGuideSeen","1");',
  });
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function until(expression, timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`浏览器状态超时：${expression}\n${await evaluate('JSON.stringify({toast:document.querySelector("#toast").textContent,target:nodeStructureState&&nodeStructureState.nodeId,hovered:[...document.querySelectorAll(":hover")].map(e=>e.id||e.dataset.nodeId||e.className)})')}`);
  }
  async function point(selector, scroll = true) {
    return evaluate(`(() => {
      const element=document.querySelector(${JSON.stringify(selector)});
      if(!element)throw new Error('未找到元素：'+${JSON.stringify(selector)});
      ${scroll ? "element.scrollIntoView({block:'center',inline:'center',behavior:'instant'});" : ''}
      const r=element.getBoundingClientRect();
      if(!r.width||!r.height)throw new Error('元素不可见');
      for(const fy of [.5,.1,.9])for(const fx of [.5,.1,.9]){
        const x=r.left+r.width*fx,y=r.top+r.height*fy;
        const hit=document.elementFromPoint(x,y);
        if(hit&&(hit===element||element.contains(hit)))return {x,y};
      }
      if(element.matches('[data-resume-editable=true]'))throw new Error(JSON.stringify({
        blocked:${JSON.stringify(selector)},rect:r.toJSON(),style:element.getAttribute('style'),
        above:document.elementsFromPoint(r.left+r.width/2,r.top+r.height/2).slice(0,4).map(e=>({
          id:e.dataset.nodeId||e.id,rect:e.getBoundingClientRect().toJSON(),style:e.getAttribute('style')
        }))
      }));
      return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
  }
  async function hover(selector) {
    const position = await point(selector);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  }
  async function click(selector, scroll = true) {
    const position = await point(selector, scroll);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  }
  await cdp('Page.navigate', { url });
  await until('Boolean(window.WS && WS.draft)');
  return { cdp, evaluate, until, hover, click, errors };
}
module.exports = { openBrowser, available: fs.existsSync(chrome) };
