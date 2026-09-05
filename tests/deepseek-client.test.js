'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDeepSeekClient, parseJsonObject } = require('../server/lib/deepseek-client');

function streamFrom(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test('DeepSeek JSON 解析只接受最终正文中的对象', () => {
  assert.deepStrictEqual(parseJsonObject('思考内容\n```json\n{"reply":"ok","actions":[]}\n```'), {
    reply: 'ok',
    actions: [],
  });
  assert.deepStrictEqual(
    parseJsonObject('{"type":"message","content":"完成"}\n```'),
    { type: 'message', content: '完成' },
  );
  assert.deepStrictEqual(
    parseJsonObject('说明 {不是 JSON}，最终结果：{"reply":"含有 { 花括号 } 的内容","actions":[]}'),
    { reply: '含有 { 花括号 } 的内容', actions: [] },
  );
  assert.strictEqual(
    parseJsonObject(
      '{"type":"proposal","content":"新增模块","proposal":{"target_resume_fragments":{"format":"resume-target-fragments-v2","changes":[]}}',
    ),
    null,
  );
  assert.strictEqual(
    parseJsonObject('{"debug":true}\n{"type":"message","content":"最终结果"}'),
    null,
  );
  assert.strictEqual(
    parseJsonObject(
      '示例：{"type":"message","content":"示例"}\n最终：{"type":"message","content":"最终"}',
    ),
    null,
  );
  assert.strictEqual(parseJsonObject('没有 JSON'), null);
});

test('DeepSeek JSON 恢复对大量未闭合花括号保持线性处理', () => {
  const started = Date.now();
  assert.strictEqual(parseJsonObject('{'.repeat(50000)), null);
  assert.ok(Date.now() - started < 500, '解析不应随未闭合花括号出现平方级退化');
});

test('DeepSeek 客户端发送指定模型并解析流式 JSON', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"choices":[{"delta":{"reasoning_content":"内部推理"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"reply\\":\\"完成\\",\\"actions\\":[],\\"uncertainty\\":[]}"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":12,"completion_tokens":8},"choices":[]}\n\n',
        'data: [DONE]\n\n',
      ].join('')),
    };
  };
  const client = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    model: 'deepseek-v4-flash-vision-exp',
    fetchImpl,
  });
  const result = await client.generate({ messages: [{ role: 'user', content: '你好' }] });

  assert.strictEqual(captured.url, 'https://example.test/chat/completions');
  assert.strictEqual(captured.body.model, 'deepseek-v4-flash-vision-exp');
  assert.strictEqual(captured.body.stream, true);
  assert.deepStrictEqual(result.output, { reply: '完成', actions: [], uncertainty: [] });
  assert.strictEqual(result.reasoning_length, 4);
  assert.deepStrictEqual(result.usage, { prompt_tokens: 12, completion_tokens: 8 });
});

test('DeepSeek 客户端使用请求级动态输出预算，但不突破部署硬上限', async () => {
  let captured;
  const client = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    maxTokens: 4096,
    maxTokensLimit: 10000,
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"message\\",\\"content\\":\\"完成\\"}"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')),
      };
    },
  });

  const result = await client.generate({
    messages: [{ role: 'user', content: '你好' }],
    maxTokens: 18000,
  });
  assert.strictEqual(captured.max_tokens, 10000);
  assert.strictEqual(result.max_tokens, 10000);
  assert.strictEqual(result.finish_reason, 'stop');
});

test('旧默认预算再高也不能抬升缺省的 32768 硬上限', async () => {
  let captured;
  const client = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    maxTokens: 50000,
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        body: streamFrom([
          'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"message\\",\\"content\\":\\"完成\\"}"},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')),
      };
    },
  });

  await client.generate({ messages: [{ role: 'user', content: '你好' }] });
  assert.strictEqual(captured.max_tokens, 32768);
});

test('DeepSeek 客户端区分输出截断和普通 JSON 格式错误', async () => {
  const truncated = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"proposal\\""},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')),
    }),
  });
  await assert.rejects(
    () => truncated.generate({ messages: [{ role: 'user', content: '你好' }] }),
    (error) => (
      error.code === 'DEEPSEEK_OUTPUT_TRUNCATED'
      && error.finish_reason === 'length'
      && error.content_length > 0
    ),
  );

  const completeJsonButLengthFinish = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"choices":[{"delta":{"content":"{\\"type\\":\\"message\\",\\"content\\":\\"看似完整\\"}"},"finish_reason":"length"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')),
    }),
  });
  await assert.rejects(
    () => completeJsonButLengthFinish.generate({
      messages: [{ role: 'user', content: '你好' }],
    }),
    (error) => (
      error.code === 'DEEPSEEK_OUTPUT_TRUNCATED'
      && error.finish_reason === 'length'
    ),
  );

  const invalid = createDeepSeekClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/chat/completions',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'data: {"choices":[{"delta":{"content":"不是 JSON"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')),
    }),
  });
  await assert.rejects(
    () => invalid.generate({ messages: [{ role: 'user', content: '你好' }] }),
    (error) => error.code === 'DEEPSEEK_INVALID_JSON' && error.finish_reason === 'stop',
  );
});
