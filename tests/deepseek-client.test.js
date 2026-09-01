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
  assert.strictEqual(parseJsonObject('没有 JSON'), null);
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
