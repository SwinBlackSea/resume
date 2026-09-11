'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { problem } = require('../util');

let active = 0;
const MAX_CONCURRENT = 2;
const MAX_WAITING = 8;
const waiters = [];
const TIMEOUT = 30000;

function chromiumPath() {
  const candidates = [
    process.env.RESUME_CHROMIUM_PATH, process.env.CHROME_BIN,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    path.join(os.homedir(), '.cache/ms-playwright/chromium-1187/chrome-linux/chrome'),
  ];
  return candidates.find(value => value && fs.existsSync(value));
}
async function acquire() {
  if (active >= MAX_CONCURRENT) {
    if (waiters.length >= MAX_WAITING) throw problem.conflict('EXPORT_BUSY', '导出任务较多，请稍后重试');
    await new Promise((resolve, reject) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(problem.conflict('EXPORT_BUSY', '等待导出超时，请重试'));
      }, TIMEOUT);
      waiters.push(waiter);
    });
  } else active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active--;
  };
}

async function printPdf(html, page) {
  const executable = chromiumPath();
  if (!executable) throw problem.unprocessable('PDF_RENDERER_UNAVAILABLE', 'PDF 导出组件未就绪，请联系管理员配置浏览器');
  if (Buffer.byteLength(html) > 96 * 1024 * 1024) throw problem.unprocessable('EXPORT_TOO_LARGE', '简历文件过大，无法导出');
  const release = await acquire();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-'));
  let child, socket, deadline;
  const requests = new Map();
  let sequence = 0, sessionId;
  try {
    const args = ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
      '--disable-background-networking', '--disable-extensions', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'];
    // This container already runs Chromium without a kernel sandbox. Keep
    // document JS and external network disabled; hardened hosts can enable it.
    if (process.env.RESUME_CHROMIUM_SANDBOX !== '1') args.unshift('--no-sandbox');
    child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const work = async () => {
      const endpoint = await new Promise((resolve, reject) => {
        let tail = '';
        child.stderr.on('data', data => {
          tail = (tail + data).slice(-4096);
          const match = tail.match(/DevTools listening on (ws:\/\/[^\s]+)/);
          if (match) resolve(match[1]);
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('PDF browser stopped')));
      });
      socket = new WebSocket(endpoint);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      socket.addEventListener('message', ({ data }) => {
        const message = JSON.parse(data);
        if (message.method === 'Fetch.requestPaused') {
          command('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'BlockedByClient' })
            .catch(() => {});
          return;
        }
        const request = requests.get(message.id);
        if (!request) return;
        requests.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      });
      function command(method, params = {}) {
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          requests.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      }
      const target = await command('Target.createTarget', { url: 'about:blank' });
      ({ sessionId } = await command('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
      await command('Page.enable');
      await command('Runtime.enable');
      await command('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }, { urlPattern: 'file://*' }] });
      await command('Emulation.setEmulatedMedia', { media: 'screen' });
      const tree = await command('Page.getFrameTree');
      await command('Page.setDocumentContent', { frameId: tree.frameTree.frame.id, html });
      const ready = await command('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{
        await document.fonts.ready;
        await Promise.all([...document.images].map(image=>image.decode()));
        document.querySelectorAll('[data-scene-text-width-pt]').forEach(element=>{
          const width=Number(element.dataset.sceneTextWidthPt)*96/72;
          element.style.transform='none';const natural=element.scrollWidth;
          if(width&&natural)element.style.transform='scaleX('+(width/natural)+')';
        });
        return {images:document.images.length,failed:[...document.images].some(i=>!i.naturalWidth)};
      })()` });
      if (ready.exceptionDetails || ready.result.value?.failed) throw new Error('PDF image did not load');
      const result = await command('Page.printToPDF', {
        printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false,
        paperWidth: page.width / 72, paperHeight: page.height / 72,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      });
      const buffer = Buffer.from(result.data, 'base64');
      const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
      if (!pages) throw new Error('PDF contains no pages');
      return { buffer, pages };
    };
    return await Promise.race([work(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('PDF rendering timed out')), TIMEOUT);
    })]);
  } catch (_) {
    throw problem.unprocessable('PDF_RENDER_FAILED', 'PDF 未能完整生成，请重试；简历正文未改变');
  } finally {
    clearTimeout(deadline);
    for (const request of requests.values()) request.reject(new Error('PDF renderer closed'));
    requests.clear();
    if (socket) { try { socket.close(); } catch (_) { /* Already closed. */ } }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    try { fs.rmSync(directory, { recursive: true, force: true }); }
    finally { release(); }
  }
}
module.exports = { printPdf, chromiumPath };
