'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelGateway } = require('../server/lib/model-gateway');
const { createOpenAIResponsesClient, openAIEndpoint } = require('../server/lib/model-client/openai');
const { GLOBAL_RESPONSE_SCHEMA } = require('../server/lib/resume-harness/output-json-schema');
const { saveQAKey, loadQAConfig } = require('../server/scripts/openai-qa-config');

function eventsStream(events, leaveOpen = false, canceled = () => {}) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
      if (!leaveOpen) controller.close();
    },
    cancel: canceled,
  });
}
function completed(output) {
  return { ok: true, body: eventsStream([{ type: 'response.completed',
    response: { status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      usage: { input_tokens: 12, output_tokens: 8 } } }]) };
}
const request = { capability: 'complex', reasoningEffort: 'low', maxTokens: 18000,
  messages: [{ role: 'system', content: '规则' }, { role: 'assistant', content: '上一轮建议' },
    { role: 'user', content: [{ type: 'text', text: '  按图片改排版，保留文字  ' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' } }] }],
  outputSchema: GLOBAL_RESPONSE_SCHEMA };

test('OpenAI Responses 请求原样透传文本、历史、图片和严格 Schema，关闭存储，不发送 temperature', async () => {
  let captured;
  const client = createOpenAIResponsesClient({
    apiKey: 'candidate-test-key', model: 'gpt-5.5', baseUrl: 'https://api.info52.top/v1/',
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return completed({ type: 'message', content: '完成' });
    },
  });
  const result = await client.generate(request);
  assert.equal(captured.url, 'https://api.info52.top/v1/responses');
  assert.equal(captured.options.headers.authorization, 'Bearer candidate-test-key');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.body.model, 'gpt-5.5');
  assert.equal(captured.body.store, false);
  assert.equal(captured.body.stream, true);
  assert.equal(captured.body.temperature, undefined);
  assert.equal(captured.body.max_output_tokens, 18000);
  assert.deepEqual(captured.body.reasoning, { effort: 'low' });
  assert.deepEqual(captured.body.text.format.schema, GLOBAL_RESPONSE_SCHEMA.schema);
  assert.equal(captured.body.text.format.strict, true);
  assert.equal(captured.body.input.at(-1).content[0].text, '  按图片改排版，保留文字  ');
  assert.equal(captured.body.input.at(-1).content[1].type, 'input_image');
  assert.equal(captured.body.input[1].content, '上一轮建议');
  assert.equal(result.provider, 'openai');
  assert.equal(result.model, 'gpt-5.5');
  assert.equal(result.usage.prompt_tokens, 12);
});

test('混合供应商隔离地址和 Key：局部仍走 DeepSeek，全局和历史含图走 OpenAI', async () => {
  const seen = [];
  const client = createModelGateway({
    provider: 'deepseek', globalProvider: 'openai',
    endpoint: 'https://deepseek.example/responses', apiKey: 'baseline-key',
    textModel: 'deepseek-v4-flash',
    openai: { baseUrl: 'https://candidate.example/v1', apiKey: 'candidate-key', model: 'gpt-5.5' },
    fetchImpl: async (url, options) => {
      seen.push({ url, key: options.headers.authorization, body: JSON.parse(options.body) });
      return completed({ type: 'message', content: '完成' });
    },
  });
  for (const capability of ['text', 'complex', 'vision']) await client.generate({ ...request, capability });
  assert.deepEqual(seen.map((item) => item.url), [
    'https://deepseek.example/responses', 'https://candidate.example/v1/responses', 'https://candidate.example/v1/responses',
  ]);
  assert.deepEqual(seen.map((item) => item.key), ['Bearer baseline-key', 'Bearer candidate-key', 'Bearer candidate-key']);
  assert.deepEqual(seen.map((item) => item.body.model), ['deepseek-v4-flash', 'gpt-5.5', 'gpt-5.5']);
  assert.equal(seen[0].body.temperature, 0.2);
  assert.equal(seen[1].body.temperature, undefined);
});

test('网关最低推理能力显式配置：轻量请求使用 low，不改 user/schema；高强度不降级', async () => {
  const bodies = [];
  const client = createOpenAIResponsesClient({
    apiKey: 'test-key', model: 'gpt-6-astra', minimumReasoningEffort: 'low',
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return completed({}); },
  });
  await client.generate({ ...request, capability: 'text', thinking: false, reasoningEffort: undefined });
  await client.generate({ ...request, reasoningEffort: 'high' });
  assert.deepEqual(bodies.map(body => body.reasoning.effort), ['low', 'high']);
  assert.equal(bodies[0].input.at(-1).content[0].text, request.messages.at(-1).content[0].text);
  assert.deepEqual(bodies[0].text.format.schema, request.outputSchema.schema);
  const invalid = createOpenAIResponsesClient({ apiKey: 'test-key', minimumReasoningEffort: 'unknown',
    fetchImpl: () => { throw new Error('invalid configuration must not send'); } });
  await assert.rejects(invalid.generate(request), { code: 'MODEL_INVALID_REQUEST' });
});

test('候选 Key 缺失时不借用 DeepSeek 密钥，也不发送请求', async () => {
  const previous = process.env.RESUME_OPENAI_API_KEY;
  delete process.env.RESUME_OPENAI_API_KEY;
  let calls = 0;
  try {
    const gateway = createModelGateway({ provider: 'deepseek', globalProvider: 'openai',
      apiKey: 'baseline-key', endpoint: 'https://baseline.example/responses',
      fetchImpl: async () => { calls++; return completed({}); } });
    await assert.rejects(gateway.generate(request), { code: 'MODEL_NOT_CONFIGURED', provider: 'openai' });
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.RESUME_OPENAI_API_KEY;
    else process.env.RESUME_OPENAI_API_KEY = previous;
  }
});

test('OpenAI URL 保留 /v1，只加一次 responses，拒绝凭据和明文 HTTP', () => {
  assert.equal(openAIEndpoint('https://example.test/prefix/v1/'), 'https://example.test/prefix/v1/responses');
  assert.equal(openAIEndpoint('https://example.test/v1/responses'), 'https://example.test/v1/responses');
  for (const value of ['http://example.test/v1', 'https://user:secret@example.test/v1', 'https://example.test/v1?key=secret', 'invalid']) {
    assert.throws(() => openAIEndpoint(value), { code: 'MODEL_INVALID_REQUEST' });
  }
});

test('401/429 不自动重发，不回显第三方错误正文或凭据', async () => {
  for (const status of [401, 429]) {
    let calls = 0;
    const client = createOpenAIResponsesClient({ apiKey: 'secret-key', fetchImpl: async () => {
      calls++;
      return { ok: false, status, body: eventsStream([]),
        text: async () => 'secret-key 真实简历正文' };
    } });
    await assert.rejects(client.generate(request), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'MODEL_HTTP_ERROR');
      assert.doesNotMatch(error.message, /secret|简历正文/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('Responses 拒绝、截断、错误、无终止事件均不假成功，终止后主动释放连接', async () => {
  const cases = [
    [{ type: 'response.incomplete', response: { status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' } } }, 'MODEL_OUTPUT_TRUNCATED'],
    [{ type: 'response.completed', response: { status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: '不处理' }] }] } }, 'MODEL_REFUSED'],
    [{ type: 'error', message: '不能回显的内容' }, 'MODEL_RESPONSE_FAILED'],
    [{ type: 'response.output_text.delta', delta: '{"type":"message","content":"完成"}' }, 'MODEL_RESPONSE_FAILED'],
  ];
  for (const [event, code] of cases) {
    const client = createOpenAIResponsesClient({ apiKey: 'test-key',
      fetchImpl: async () => ({ ok: true, body: eventsStream([event]) }) });
    await assert.rejects(client.generate(request), { code });
  }
  let canceled = false;
  const client = createOpenAIResponsesClient({ apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, body: eventsStream([
      { type: 'response.output_text.delta', delta: '{"type":"message","content":"完成"}' },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ], true, () => { canceled = true; }) }) });
  await client.generate(request);
  assert.equal(canceled, true);
});

test('OpenAI 空闲超时和调用方取消有界退出，不泄露正文', async () => {
  let canceled = false;
  const idle = createOpenAIResponsesClient({ apiKey: 'test-key', idleMs: 15,
    fetchImpl: async () => ({ ok: true, body: new ReadableStream({
      cancel() { canceled = true; },
    }) }) });
  await assert.rejects(idle.generate(request), { code: 'MODEL_TIMEOUT', timeout_phase: 'stream_idle' });
  assert.equal(canceled, true);
  const abort = createOpenAIResponsesClient({ apiKey: 'test-key',
    fetchImpl: async (_url, options) => { options.signal.throwIfAborted(); return completed({}); } });
  await assert.rejects(abort.generate({ ...request, signal: AbortSignal.abort() }), { code: 'MODEL_CANCELED', timeout_phase: 'canceled' });
});

test('首响应与总时限诊断可区分；按能力配置时限不重发、不改写要求', async () => {
  const { createModelClient } = require('../server/lib/model-client');
  const calls = [];
  const client = createModelClient({
    provider: 'openai', globalProvider: 'openai', openai: { apiKey: 'test-key' },
    timeouts: { text: { firstTokenMs: 10 }, vision: { firstTokenMs: 300 } },
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      calls.push(JSON.parse(options.body));
      const timer = setTimeout(() => resolve(completed({ type: 'message', content: '完成' })), 50);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    }),
  });
  await assert.rejects(client.generate({ ...request, capability: 'text' }), { code: 'MODEL_TIMEOUT', timeout_phase: 'first_response', response_started: false });
  assert.equal((await client.generate({ ...request, capability: 'vision' })).output.content, '完成');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].input, calls[1].input);
  const total = createOpenAIResponsesClient({ apiKey: 'test-key', totalMs: 10, firstTokenMs: 100,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }) });
  await assert.rejects(total.generate(request), { code: 'MODEL_TIMEOUT', timeout_phase: 'total' });
});

test('测试 Key 配置为私有文件、独立读取，不修改已有文件或写入项目运行配置', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-openai-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.openai-qa');
  assert.throws(() => loadQAConfig(file), /尚未配置/);
  assert.throws(() => saveQAKey('bad\nkey', file), /无效/);
  saveQAKey('test-only-placeholder', file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadQAConfig(file), { apiKey: 'test-only-placeholder', model: 'gpt-6-astra', baseUrl: 'https://api.info52.top/v1' });
  saveQAKey('replacement-test-only', file);
  assert.equal(loadQAConfig(file).apiKey, 'replacement-test-only');
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadQAConfig(file), /权限 600/);
});

module.exports = { completed };
