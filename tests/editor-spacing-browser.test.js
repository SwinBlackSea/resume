'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { openBrowser, available } = require('./browser-driver');

test('编辑器紧凑外框：四档屏宽、纸张不变、聊天空间、收缩和工具栏吸顶', {
  skip: !available, timeout: 60000,
}, async t => {
  const app = await helpers.boot(); t.after(() => helpers.close(app));
  const projectId = await helpers.defaultProject(app);
  const before = (await helpers.call(app, 'GET', `/projects/${projectId}`)).body.draft;
  const browser = await openBrowser(t, app.base.replace('/api/v1', '/') + '?project=' + projectId);
  const { cdp, evaluate, until, click } = browser;
  const samples = [];
  for (const width of [1440, 1280, 900, 390]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await until(`innerWidth===${width}`);
    await until(`document.querySelector('.app').getAnimations()
      .filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState==='finished')`);
    const sample = await evaluate(`(() => {
      const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();
      return {width:innerWidth,topbar:rect('.topbar'),bar:rect('#doc-toolbar'),
        canvas:rect('.canvas'),paper:rect('#resume-zoom-stage'),chat:rect('#assistant-panel'),
        base:Number(document.querySelector('#resume-zoom-stage').dataset.baseWidth),
        root:document.documentElement.scrollWidth,chatDisplay:getComputedStyle(document.querySelector('#assistant-panel')).display,
        zoom:document.querySelector('#resume-zoom-stage').dataset.zoom};
    })()`);
    samples.push(sample);
    assert.ok(sample.bar.top - sample.topbar.bottom <= 14, JSON.stringify(sample));
    assert.ok(sample.bar.top >= sample.topbar.bottom, '工具栏不能遮住顶栏');
    assert.ok(sample.paper.top - sample.bar.bottom <= 13, '工具栏与纸张间不保留双层留白');
    assert.equal(sample.zoom, '1', '不能偷偷放大简历来减少空白');
    assert.ok(sample.root <= width, '超宽纸张仅在画布内横向滚动，不撑开整个页面');
    if (width >= 1161) {
      assert.equal(sample.chat.width,390, '聊天恢复原先固定宽度，不再为填充留白而扩宽');
      assert.ok(Math.abs(sample.paper.left-(sample.chat.left-sample.paper.right))<=3,
        '释放的画布空间均匀分配在纸张两侧，不拉伸简历内容');
      assert.ok(sample.chat.left >= sample.paper.right, '常见桌面宽度下纸张不被聊天边缘裁切');
    } else assert.equal(sample.chatDisplay, 'none');
    {
      await evaluate('document.querySelector(".canvas").scrollTop=300');
      await until('document.querySelector("#doc-toolbar").classList.contains("is-floating")');
      const sticky = await evaluate(`(() => {const c=document.querySelector('.canvas').getBoundingClientRect(),
        b=document.querySelector('#doc-toolbar').getBoundingClientRect();return b.top-c.top})()`);
      assert.ok(sticky >= 0 && sticky <= 14, '画布滚动后工具栏保持吸顶');
      await evaluate('document.querySelector(".canvas").scrollTop=0');
    }
  }
  assert.equal(samples[0].base, samples[1].base, '桌面纸张宽度不能随聊天重新分配而改变');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('#assistant-collapse');
  await until('document.querySelector("#assistant-panel").classList.contains("collapsed")');
  await until(`document.querySelector('.app').getAnimations()
    .filter(a=>a.effect.getTiming().iterations!==Infinity).every(a=>a.playState==='finished')`);
  assert.equal(await evaluate('Math.round(document.querySelector("#assistant-panel").getBoundingClientRect().width)'), 56);
  await click('#assistant-collapse');
  await until('!document.querySelector("#assistant-panel").classList.contains("collapsed")');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: false });
  await click('.assistant-toggle');
  await until('document.querySelector("#assistant-panel").classList.contains("open")');
  await until('Math.round(document.querySelector("#assistant-panel").getBoundingClientRect().width)===360');
  assert.equal(await evaluate('Math.round(document.querySelector("#assistant-panel").getBoundingClientRect().width)'), 360);
  assert.deepEqual((await helpers.call(app, 'GET', `/projects/${projectId}`)).body.draft, before);
  assert.deepEqual(browser.errors, []);
  console.log('editor-spacing', JSON.stringify(samples.map(s => ({ width: s.width,
    topGap: s.bar.top - s.topbar.bottom, leftGap: s.paper.left, chatWidth: s.chat.width,
    paperChatGap: s.chatDisplay === 'none' ? null : s.chat.left - s.paper.right }))));
});
