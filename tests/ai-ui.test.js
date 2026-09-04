'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const helpers = require('./helpers');
const resumeHarness = require('../server/lib/resume-harness');

let ctx;
let projectId;

test.before(async () => {
  ctx = await helpers.boot();
  projectId = await helpers.defaultProject(ctx);
});

test.after(() => helpers.close(ctx));

test('AI 澄清问题以克制的结果选项展示，并继续原任务', async () => {
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'ui-clarification',
    generate: async () => ({
      output: {
        type: 'message',
        content: '你希望保留当前排版，还是把内容真正拆成独立区域？',
        awaiting_user: true,
        quick_replies: [
          {
            id: 'keep-layout',
            label: '保留排版，分别编辑',
            description: '只改变 AI 编辑方式，页面外观不变。',
          },
          {
            id: 'ungroup',
            label: '拆成独立区域',
            description: '同时改变内容的物理分组。',
          },
        ],
      },
    }),
  });
  let proposed;
  try {
    proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content: '把这里拆开',
        scope_type: 'RESUME_BLOCK',
        scope_id: 'target-bullet',
      },
    });
  } finally {
    restore();
  }
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
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
  const choices = [...document.querySelectorAll('.clarification-option')];
  assert.deepStrictEqual(choices.map((button) => button.querySelector('b').textContent), [
    '保留排版，分别编辑',
    '拆成独立区域',
  ]);
  assert.match(choices[0].textContent, /页面外观不变/);
  assert.strictEqual(dom.window.activeTaskId, proposed.body.task_id);
  choices[0].click();
  assert.strictEqual(document.querySelector('#prompt').value, '保留排版，分别编辑');
  assert.strictEqual(dom.window.activeContext.scopeId, 'target-bullet');
  const completed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '保留排版，分别编辑',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'target-bullet',
      task_id: proposed.body.task_id,
    },
  });
  assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));
  dom.window.close();
});

test('复杂请求的处理思路以自然对话和克制的快捷回复展示', async () => {
  const restore = resumeHarness.setModelClientForTests({
    provider: 'test',
    model: 'ui-plan-confirmation',
    generate: async () => ({
      output: {
        type: 'message',
        content: '我准备这样修改：\n1. 结合整份简历中的相关经历\n2. 强化管理经验并去除重复表达\n3. 最终整理为三个段落\n本次先只修改职业概况。',
        awaiting_user: true,
        quick_replies: ['按这个思路修改', '调整要求'],
      },
    }),
  });
  let proposed;
  try {
    proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content: '合并重复内容，扩充成三段，更突出管理经验',
        scope_type: 'RESUME_BLOCK',
        scope_id: 'target-bullet',
      },
    });
  } finally {
    restore();
  }
  assert.strictEqual(proposed.status, 200, JSON.stringify(proposed.body));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
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
  const cards = [...document.querySelectorAll('.clarification-bubble')];
  const card = cards[cards.length - 1];
  assert.ok(card);
  assert.match(card.textContent, /结合整份简历/);
  assert.match(card.textContent, /只修改职业概况/);
  assert.deepStrictEqual(
    [...card.querySelectorAll('.clarification-option')].map((button) => button.textContent),
    ['按这个思路修改', '调整要求'],
  );
  card.querySelectorAll('.clarification-option')[1].click();
  assert.strictEqual(document.querySelector('#prompt').value, '调整要求');
  assert.strictEqual(dom.window.activeTaskId, proposed.body.task_id);
  dom.window.close();
});

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
  const proposalC = second.body.actions.find(
    (action) => action.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(proposalC);

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
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
  assert.ok(proposalCards[1].closest('.assistant-proposal-group'));
  assert.match(
    proposalCards[1].closest('.assistant-proposal-group').querySelector('.proposal-intro').textContent,
    /建议|调整|修改/,
  );
  assert.match(proposalCards[0].textContent, /已有新版建议/);
  assert.match(proposalCards[1].textContent, /简历当前内容/);
  assert.match(proposalCards[1].textContent, /沿用上一版建议/);
  assert.match(proposalCards[1].textContent, /本轮建议/);
  assert.strictEqual(
    proposalCards[1].querySelector('.current-copy').textContent,
    proposalC.payload.proposal.change_preview.before.text,
  );
  assert.strictEqual(
    proposalCards[1].querySelector('.suggestion-copy').textContent,
    proposalC.payload.proposal.change_preview.after.text,
  );
  assert.strictEqual(
    proposalCards[1].querySelector('.proposal-summary').textContent,
    proposalC.payload.proposal.change_preview.summary,
  );
  assert.deepStrictEqual(
    [...proposalCards[1].querySelectorAll('.proposal-actions button')].map((button) => button.textContent),
    ['应用修改', '继续调整', '暂不使用'],
  );
  dom.window.close();
});

test('建议因客观结构冲突无法应用时提供一键按最新内容重新生成', async () => {
  const proposed = await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
    body: {
      content: '写得更专业',
      scope_type: 'RESUME_BLOCK',
      scope_id: 'target-bullet',
    },
  });
  const action = proposed.body.actions.find(
    (item) => item.action_type === 'RESUME_REWRITE_PROPOSAL',
  );
  assert.ok(action, JSON.stringify(proposed.body));

  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  let regenerationCalls = 0;
  let regenerationContent = '';
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `${origin}/`,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = (url, options = {}) => {
        const absolute = new URL(url, origin);
        if (
          absolute.pathname.endsWith(`/ai/actions/${action.id}/apply`)
          && String(options.method || 'GET').toUpperCase() === 'POST'
        ) {
          return Promise.resolve(new Response(JSON.stringify({
            title: 'PROPOSAL_REBASE_REQUIRED',
            status: 409,
            detail: '当前简历结构已变化，需要根据最新内容重新生成这项建议',
            recovery_instruction: '请根据当前最新简历重新生成刚才的修改建议，保持原要求不变。',
          }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }));
        }
        if (
          absolute.pathname.endsWith(`/projects/${projectId}/ai/messages`)
          && String(options.method || 'GET').toUpperCase() === 'POST'
        ) {
          const body = JSON.parse(options.body || '{}');
          if (/最新简历重新生成/.test(body.content || '')) {
            regenerationCalls += 1;
            regenerationContent = body.content;
            return Promise.resolve(new Response(JSON.stringify({
              task_id: 'regenerated-task',
              result_type: 'ANSWER',
              actions: [],
              rejected: [],
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }));
          }
        }
        return fetch(absolute, options);
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
  const card = document.querySelector(`.chat-proposal[data-action="${action.id}"]`);
  assert.ok(card);
  card.querySelector('.replace').click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.match(card.querySelector('.proposal-summary').textContent, /按最新简历重新生成/);
  assert.deepStrictEqual(
    [...card.querySelectorAll('.proposal-actions button')].map((button) => button.textContent),
    ['按最新内容重新生成', '暂不处理'],
  );

  card.querySelector('.regenerate').click();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.strictEqual(regenerationCalls, 1);
  assert.match(regenerationContent, /最新简历重新生成/);
  dom.window.close();
});

test('AI 沟通区可确认后开始新对话，并说明保留与失效内容', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
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
    resources: 'usable',
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
  assert.strictEqual(
    document.querySelector('#selection-tools').classList.contains('show'),
    true,
    '光标落入可编辑区域时必须显示 AI 快捷入口',
  );
  assert.match(document.querySelector('.rewrite-action').textContent, /让 AI 帮写/);
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

test('点击单一编辑节点内任一格式段落时只提供整体 AI 入口', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const origin = ctx.base.replace('/api/v1', '');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: 'usable',
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

  const { window } = dom;
  const resume = window.ResumeDom.toResumeDocument(window.WS.draft.resume_json);
  const found = window.ResumeDom.findNode(resume, 'target-bullet');
  assert.ok(found);
  const groupId = 'ui-explicit-ai-scope';
  found.parent.children.splice(found.index, 1, {
    id: groupId,
    type: 'element',
    tag: 'div',
    editable: true,
    label: '整体能力模块',
    children: [
      { ...found.node, editable: undefined },
      {
        id: 'ui-explicit-ai-scope-second',
        type: 'element',
        tag: 'p',
        text: '第二段仍然可以直接编辑。',
        label: '第二段',
      },
    ],
  });
  resume.root = found.document.root;
  window.WS.draft.resume_json = resume;
  window.renderResume();

  const document = window.document;
  const group = document.querySelector(`[data-node-id="${groupId}"]`);
  const firstParagraph = document.querySelector('[data-node-id="target-bullet"]');
  const secondParagraph = document.querySelector('[data-node-id="ui-explicit-ai-scope-second"]');
  assert.ok(group);
  assert.strictEqual(group.getAttribute('contenteditable'), 'plaintext-only');
  assert.strictEqual(firstParagraph.getAttribute('contenteditable'), null);
  assert.strictEqual(secondParagraph.getAttribute('contenteditable'), null);

  firstParagraph.click();
  assert.strictEqual(group.classList.contains('selected'), true);
  assert.strictEqual(firstParagraph.classList.contains('selected'), false);
  assert.strictEqual(document.querySelectorAll('#resume-document .selected').length, 1);
  assert.match(document.querySelector('.rewrite-action').textContent, /整体能力模块/);

  document.querySelector('.rewrite-action').click();
  assert.strictEqual(window.activeContext.scopeId, groupId);

  secondParagraph.click();
  assert.strictEqual(group.classList.contains('selected'), true);
  assert.strictEqual(secondParagraph.classList.contains('selected'), false);
  assert.strictEqual(window.activeContext.scopeId, groupId);
  dom.window.close();
});
