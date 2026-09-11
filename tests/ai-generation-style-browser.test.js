'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器：局部与全局共用生成按钮和状态，成功/失败恢复、窄屏及减少动态效果', {
  skip: !available, timeout: 60000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const before = await ws();
  let release, fail = false, calls = 0;
  t.after(() => { if (release) release(); });
  t.after(harness.setModelClientForTests({ async generate({ input }) {
    calls++;
    await new Promise(resolve => { release = resolve; });
    if (fail) throw Object.assign(new Error('生成态测试超时'), { code: 'MODEL_TIMEOUT' });
    return { output: input.target
      ? { type: 'proposal', content: '修改建议已准备好。',
        suggestion: input.target.source_text + '表达更清晰。', summary: '优化表达' }
      : { type: 'message', content: '这是一条测试回答。' } };
  } }));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { evaluate, click, until, cdp } = browser;
  const styles = {};
  for (const failed of [false, true]) {
    fail = failed;
    for (const mode of ['local', 'global']) {
      const local = mode === 'local';
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      if (local) {
        await click('#target-bullet');
        await click('#selection-tools .rewrite-action');
        await until('document.querySelector("#local-ai-popover").getAnimations().every(a=>a.playState!=="running")');
      }
      const input = local ? '#local-ai-input' : '#prompt';
      const button = local ? '#local-ai-generate' : '.assistant-input .send';
      const status = local ? '#local-ai-status' : '#chat-messages .bubble.thinking';
      await click(input);
      await cdp('Input.insertText', { text: '请优化表达' });
      release = null;
      await click(button);
      await until(`document.querySelector(${JSON.stringify(button)}).classList.contains("ai-generation-pending")&&
        Boolean(document.querySelector(${JSON.stringify(status + ' .chat-thinking-dots')}))`);
      const metrics = await evaluate(`(() => {
        const b=document.querySelector(${JSON.stringify(button)}),s=getComputedStyle(b),
          p=getComputedStyle(b,"::before"),h=document.querySelector(${JSON.stringify(status)}),
          t=getComputedStyle(h.querySelector(".ai-generation-status"));
        return {button:{background:s.backgroundImage,color:s.color,fontSize:s.fontSize,
          fontWeight:s.fontWeight,height:s.height,padding:s.padding,gap:s.gap,radius:s.borderRadius,
          spinner:p.animationName,spinnerSize:p.width,spinnerDuration:p.animationDuration},
          status:{fontSize:t.fontSize,color:t.color,gap:t.gap,lineHeight:t.lineHeight},
          disabled:b.disabled,busy:b.getAttribute("aria-busy"),label:b.textContent,
          live:h.getAttribute("aria-live"),dots:h.querySelectorAll(".chat-thinking-dots i").length,
          dotAnimation:getComputedStyle(h.querySelector(".chat-thinking-dots i")).animationName};
      })()`);
      assert.equal(metrics.disabled, true);
      assert.equal(metrics.busy, 'true');
      assert.equal(metrics.label, '生成中');
      assert.equal(metrics.live, 'polite');
      assert.equal(metrics.dots, 3);
      assert.equal(metrics.dotAnimation, 'chatThinkingDot');
      assert.equal(metrics.button.spinner, 'sendThinking');
      styles[mode] = metrics;
      if (!local) assert.deepEqual(styles.local, styles.global, '两个生成态的实际计算样式应一致');
      await cdp('Emulation.setDeviceMetricsOverride', { width: 320, height: 900, deviceScaleFactor: 1, mobile: true });
      await until(`(() => {const r=document.querySelector(${JSON.stringify(button)}).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()`);
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(button)}),"::before").animationName`), 'none');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(status + ' .chat-thinking-dots i')})).animationName`), 'none');
      await cdp('Emulation.setEmulatedMedia', { features: [] });
      assert.ok(release, '真实请求应到达隔离后端');
      release();
      await until(`!document.querySelector(${JSON.stringify(button)}).disabled`);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button)}).classList.contains("ai-generation-pending")`), false);
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button)}).getAttribute("aria-busy")`), 'false');
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(button)}).textContent`), local ? '生成' : '发送');
      if (local) {
        await until(`document.querySelector("#local-ai-status").classList.contains(${JSON.stringify(failed ? 'error' : 'show')})`);
        assert.equal(await evaluate('document.querySelector("#local-ai-status .chat-thinking-dots")'), null);
        await click('#local-ai-close');
      } else {
        assert.equal(await evaluate('document.querySelector("#chat-messages .bubble.thinking")'), null);
      }
    }
  }
  assert.equal(calls, 4);
  assert.deepEqual((await ws()).draft, before.draft, '仅生成建议不改变简历');
  assert.deepEqual(browser.errors, []);
});
