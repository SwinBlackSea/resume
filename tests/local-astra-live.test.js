'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// Must establish the isolated database before loading any server module.
const helpers = require('./helpers');
const harness = require('../server/lib/resume-harness');
const { createModelClient } = require('../server/lib/model-client');
const { loadQAConfig } = require('../server/scripts/openai-qa-config');
const { fixture } = require('./fixtures/manual-structures');
const R = require('../resume-dom');
const { openBrowser, available } = require('./browser-driver');

test('Astra 实测：局部三轮自然对话、建议预览、应用和撤销（虚构简历/隔离数据库）', {
  skip: !available || process.env.RESUME_LOCAL_ASTRA_QA !== '1', timeout: 240000,
}, async t => {
  const ctx = await helpers.boot(); t.after(() => helpers.close(ctx));
  const id = await helpers.defaultProject(ctx);
  const ws = async () => (await helpers.call(ctx, 'GET', `/projects/${id}`)).body;
  const document = fixture();
  const originalText = '负责产品规划与项目推进，服务120家客户，参与跨部门需求沟通、项目协调、进度跟踪和上线验收，保障重点项目按期交付，同时持续整理客户反馈，完善产品需求管理流程。';
  R.findNode(document, 'overview-p').node.text = originalText;
  assert.equal((await helpers.call(ctx, 'PATCH', `/projects/${id}/resume-draft`, { body: {
    expected_revision: (await ws()).draft.revision, resume_json: document,
  } })).status, 200);
  const original = await ws();
  const config = loadQAConfig();
  assert.equal(config.model, 'gpt-6-astra');
  const wireRequests = [];
  const client = createModelClient({ provider: 'openai', globalProvider: 'openai',
    openai: { ...config, minimumReasoningEffort: 'low' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      wireRequests.push({ model: body.model, reasoning: body.reasoning, store: body.store });
      return fetch(url, options);
    },
  });
  const calls = [];
  t.after(harness.setModelClientForTests({ async generate(request) {
    const started = Date.now();
    const result = await client.generate(request);
    calls.push({ request, model: result.model, provider: result.provider, milliseconds: Date.now() - started });
    return result;
  } }));
  const browser = await openBrowser(t, ctx.base.replace('/api/v1', '/'));
  const { click, until, evaluate } = browser;
  await click('[data-node-id="overview-p"]');
  await click('#selection-tools .rewrite-action');
  await until('document.querySelector("#local-ai-popover").classList.contains("show")');
  const instructions = [
    '精简这段经历，保留120家客户这个数据。',
    '还是太多了，再简洁一些，保留120家客户。',
    '把上版改成更专业的一句话，不增加新事实，也保留120家客户。',
  ];
  let lastAction = '';
  let lastSuggestion = originalText;
  const suggestions = [];
  for (const instruction of instructions) {
    if (lastAction) await click('#local-ai-adjust');
    await evaluate(`document.querySelector("#local-ai-input").value=${JSON.stringify(instruction)}`);
    await click('#local-ai-generate');
    await until(`!document.querySelector("#local-ai-generate").disabled`, 70000);
    const result = await evaluate(`({
      action:localAiState?.action?.id,
      suggestion:localAiState?.action?.payload?.suggestion,
      status:document.querySelector("#local-ai-status").textContent,
      error:document.querySelector("#local-ai-status").classList.contains("error")
    })`);
    assert.equal(result.error, false, result.status);
    assert.ok(result.action && result.action !== lastAction, result.status);
    assert.ok(result.suggestion?.includes('120'), '用户要求的数据必须保留');
    assert.notEqual(result.suggestion, lastSuggestion, '继续调整不能原样返回');
    if (suggestions.length < 2) assert.ok(result.suggestion.length < lastSuggestion.length,
      '两轮精简应逐轮缩短，而非机械保留原文');
    assert.deepEqual((await ws()).draft.resume_json, original.draft.resume_json, '应用前正文不变');
    lastAction = result.action;
    lastSuggestion = result.suggestion;
    suggestions.push(lastSuggestion);
  }
  assert.ok(calls.length >= 3);
  for (const call of calls) {
    assert.equal(call.request.thinking, false);
    assert.ok(['text', 'complex'].includes(call.request.capability));
    assert.doesNotMatch(JSON.stringify(call.request.messages), /resume-ai-context-v3|target_node_id|editing_document/);
  }
  for (const request of wireRequests) {
    assert.equal(request.model, 'gpt-6-astra');
    assert.deepEqual(request.reasoning, { effort: 'low' });
    assert.equal(request.store, false);
  }
  await click('#local-ai-apply');
  await until('!document.querySelector("#local-ai-popover").classList.contains("show")');
  assert.equal(R.findNode((await ws()).draft.resume_json, 'overview-p').node.text, lastSuggestion);
  await click('#undo-step');
  await until('!historyStepPending');
  assert.deepEqual((await ws()).draft.resume_json, original.draft.resume_json);
  assert.deepEqual(browser.errors, []);
  t.diagnostic(JSON.stringify({
    model: config.model, rounds: suggestions.length, originalCharacters: originalText.length,
    suggestionCharacters: suggestions.map(text => text.length),
    effectiveReasoning: 'low',
    calls: calls.map(({ request, ...metadata }) => ({ ...metadata, capability: request.capability })),
  }));
});
