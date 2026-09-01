'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');

let ctx;
let projectId;

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});

test.after(() => helpers.close(ctx));

test('AI 沟通区展示 A、B、C，并且只有当前建议可操作', async () => {
  const first = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: { content: '写得更专业', scope_type: 'RESUME_BLOCK', scope_id: 'target-bullet' },
  });
  const proposalB = first.body.actions.find((action) => action.action_type === 'RESUME_REWRITE_PROPOSAL');
  assert.ok(proposalB);

  const second = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '再简洁一点',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'target-bullet',
      task_id: first.body.task_id,
      parent_proposal_id: proposalB.id,
    },
  });
  assert.ok(second.body.actions.some((action) => action.action_type === 'RESUME_REWRITE_PROPOSAL'));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(url, origin), options);
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const cards = [...dom.window.document.querySelectorAll('#chat-messages .chat-proposal')];
  const proposalCards = cards.filter((card) => card.querySelector('.suggestion-copy'));
  assert.strictEqual(proposalCards.length, 2);
  assert.match(proposalCards[0].textContent, /已有新版建议/);
  assert.match(proposalCards[1].textContent, /简历当前内容/);
  assert.match(proposalCards[1].textContent, /沿用上一版建议/);
  assert.match(proposalCards[1].textContent, /本轮建议/);
  assert.deepStrictEqual(
    [...proposalCards[1].querySelectorAll('.proposal-actions button')].map((button) => button.textContent),
    ['应用修改', '继续调整', '暂不使用'],
  );
  dom.window.close();
});

test('AI 沟通区可确认后开始新对话，并说明保留与失效内容', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options) => fetch(new URL(url, origin), options);
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const document = dom.window.document;
  document.querySelector('#new-chat-button').click();
  assert.strictEqual(document.querySelector('#new-chat-modal').classList.contains('show'), true);
  assert.match(document.querySelector('#new-chat-summary').textContent, /个人信息、岗位、简历和历史版本不会改变/);
  assert.match(document.querySelector('#new-chat-summary').textContent, /未应用建议将不再可用/);

  document.querySelector('#confirm-new-chat').click();
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.strictEqual(document.querySelector('#new-chat-modal').classList.contains('show'), false);
  assert.strictEqual(document.querySelectorAll('#chat-messages .chat-proposal').length, 0);
  assert.strictEqual(document.querySelectorAll('#chat-messages .bubble').length, 1);
  assert.match(document.querySelector('#chat-messages').textContent, /你可以直接询问整份简历/);
  assert.strictEqual(document.querySelector('#selection-label').textContent, '@整份简历');
  assert.strictEqual(Object.hasOwn(dom.window.WS, 'pending_facts'), false);
  dom.window.close();
});

test('段落改写时持续标记正文位置，并在思考期间锁定发送按钮', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  let resolveAi;
  let aiCalls = 0;
  const pendingAi = new Promise((resolve) => {
    resolveAi = resolve;
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options = {}) => {
        const parsed = new URL(url, origin);
        if (parsed.pathname.endsWith('/ai/messages') && options.method === 'POST') {
          aiCalls += 1;
          return pendingAi;
        }
        return fetch(parsed, options);
      };
      window.EventSource = class {
        addEventListener() {}
        close() {}
      };
      window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const document = dom.window.document;
  document.querySelector('#target-bullet').click();
  document.querySelector('.rewrite-action').click();

  let target = document.querySelector('#target-bullet');
  assert.strictEqual(target.classList.contains('ai-target'), true);
  assert.strictEqual(target.dataset.aiTargetLabel, 'AI 修改位置');

  const prompt = document.querySelector('#prompt');
  const send = document.querySelector('.assistant-input .send');
  prompt.value = '写得更有说服力';
  send.click();

  assert.strictEqual(send.disabled, true);
  assert.strictEqual(send.classList.contains('is-thinking'), true);
  assert.strictEqual(send.textContent, '思考中');
  assert.strictEqual(send.getAttribute('aria-busy'), 'true');
  assert.strictEqual(target.classList.contains('ai-target-thinking'), true);
  assert.strictEqual(target.dataset.aiTargetLabel, 'AI 正在修改');

  send.click();
  prompt.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.strictEqual(aiCalls, 1, '处理中不得重复发送');

  resolveAi(new Response(JSON.stringify({
    task_id: 'task-ui-thinking',
    actions: [{
      action_type: 'RESUME_REWRITE_PROPOSAL',
      payload: { proposal: { scope_id: 'target-bullet' } },
    }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await new Promise((resolve) => setTimeout(resolve, 900));

  target = document.querySelector('#target-bullet');
  assert.strictEqual(send.disabled, false);
  assert.strictEqual(send.classList.contains('is-thinking'), false);
  assert.strictEqual(send.textContent, '发送');
  assert.strictEqual(send.getAttribute('aria-busy'), 'false');
  assert.strictEqual(target.classList.contains('ai-target-ready'), true);
  assert.strictEqual(target.dataset.aiTargetLabel, '建议对应这里');
  assert.strictEqual(document.querySelector('#selection-label').getAttribute('role'), 'button');
  dom.window.close();
});
