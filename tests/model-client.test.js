'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  CAPABILITIES,
  MODEL_ERROR_CODES,
  createDeepSeekResponsesClient,
  createModelClient,
  configuredModels,
  parseJsonObject,
  responseInput,
} = require('../server/lib/model-client');

const TEST_SCHEMA = {
  name: 'test_response',
  schema: {
    type: 'object',
    properties: {
      type: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['type', 'content'],
    additionalProperties: false,
  },
};

function streamFrom(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function completedStream(content, usage = { input_tokens: 12, output_tokens: 8 }) {
  return streamFrom([
    'event: response.created',
    'data: {"type":"response.created","response":{"status":"in_progress"}}',
    '',
    'event: response.output_text.delta',
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: content })}`,
    '',
    'event: response.completed',
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [],
        usage,
      },
    })}`,
    '',
  ].join('\n'));
}

function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

test('模型 JSON 解析只接受唯一完整顶层对象', () => {
  assert.deepStrictEqual(parseJsonObject('说明：{"type":"message","content":"完成"}'), {
    type: 'message',
    content: '完成',
  });
  assert.strictEqual(
    parseJsonObject('{"debug":true}\n{"type":"message","content":"最终结果"}'),
    null,
  );
  assert.strictEqual(parseJsonObject('{"type":"proposal"'), null);
});

test('Responses 输入把文本和图片转换为供应商协议', () => {
  assert.deepStrictEqual(responseInput([
    { role: 'system', content: '系统规则' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '识别图片' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' },
        },
      ],
    },
  ]), [
    { role: 'system', content: '系统规则' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '识别图片' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,aW1hZ2U=',
          detail: 'high',
        },
      ],
    },
  ]);
});

test('推理强度按请求透传，局部默认不推理，非法配置在网络请求前拒绝', async () => {
  const efforts = [];
  const client = createDeepSeekResponsesClient({
    apiKey: 'test-key',
    fetchImpl: async (_, options) => {
      efforts.push(JSON.parse(options.body).reasoning.effort);
      return { ok: true, body: completedStream('{"type":"message","content":"完成"}') };
    },
  });
  const request = { messages: [{ role: 'user', content: '原话' }], outputSchema: TEST_SCHEMA };
  await client.generate({ ...request, reasoningEffort: 'low', thinking: false });
  await client.generate(request);
  await assert.rejects(client.generate({ ...request, reasoningEffort: 'invalid' }), {
    code: 'MODEL_INVALID_REQUEST',
  });
  assert.deepStrictEqual(efforts, ['low', 'none']);
});

test('DeepSeek 适配器使用 Responses API 严格 Schema 并解析语义流', async () => {
  let captured;
  const client = createDeepSeekResponsesClient({
    apiKey: 'test-key',
    endpoint: 'https://example.test/responses',
    model: 'deepseek-v4-flash',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        body: completedStream('{"type":"message","content":"完成"}'),
      };
    },
  });
  const result = await client.generate({
    messages: [{ role: 'user', content: '你好' }],
    outputSchema: TEST_SCHEMA,
    thinking: false,
    maxTokens: 18000,
  });

  assert.strictEqual(captured.url, 'https://example.test/responses');
  assert.strictEqual(captured.body.model, 'deepseek-v4-flash');
  assert.strictEqual(captured.body.stream, true);
  assert.strictEqual(captured.body.store, false);
  assert.deepStrictEqual(captured.body.reasoning, { effort: 'none' });
  assert.strictEqual(captured.body.text.format.type, 'json_schema');
  assert.strictEqual(captured.body.text.format.strict, true);
  assert.deepStrictEqual(result.output, { type: 'message', content: '完成' });
  assert.strictEqual(result.finish_reason, 'stop');
  assert.strictEqual(result.strict_schema, true);
  assert.strictEqual(result.max_tokens, 18000);
  assert.deepStrictEqual(result.usage, {
    input_tokens: 12,
    output_tokens: 8,
    prompt_tokens: 12,
    completion_tokens: 8,
  });
});

test('模型路由客户端按能力选择 Flash、Pro 和视觉模型', async () => {
  const seen = [];
  const client = createModelClient({
    provider: 'deepseek',
    apiKey: 'test-key',
    endpoint: 'https://example.test/responses',
    textModel: 'flash-model',
    complexModel: 'pro-model',
    visionModel: 'vision-model',
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body).model);
      return {
        ok: true,
        status: 200,
        body: completedStream('{"type":"message","content":"完成"}'),
      };
    },
  });
  for (const capability of [
    CAPABILITIES.TEXT,
    CAPABILITIES.COMPLEX,
    CAPABILITIES.VISION,
  ]) {
    await client.generate({
      messages: [{ role: 'user', content: '测试' }],
      outputSchema: TEST_SCHEMA,
      capability,
    });
  }
  assert.deepStrictEqual(seen, ['flash-model', 'pro-model', 'vision-model']);
});

test('新模型配置优先于旧单模型变量，旧配置只作为视觉兼容', () => {
  const previous = {
    text: process.env.RESUME_MODEL_TEXT_MODEL,
    complex: process.env.RESUME_MODEL_COMPLEX_MODEL,
    vision: process.env.RESUME_MODEL_VISION_MODEL,
    legacy: process.env.RESUME_LLM_MODEL,
  };
  process.env.RESUME_MODEL_TEXT_MODEL = 'new-flash';
  process.env.RESUME_MODEL_COMPLEX_MODEL = 'new-pro';
  delete process.env.RESUME_MODEL_VISION_MODEL;
  process.env.RESUME_LLM_MODEL = 'legacy-vision';
  try {
    assert.deepStrictEqual(configuredModels(), {
      text: 'new-flash',
      complex: 'new-pro',
      vision: 'legacy-vision',
    });
  } finally {
    for (const [key, value] of Object.entries({
      RESUME_MODEL_TEXT_MODEL: previous.text,
      RESUME_MODEL_COMPLEX_MODEL: previous.complex,
      RESUME_MODEL_VISION_MODEL: previous.vision,
      RESUME_LLM_MODEL: previous.legacy,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('适配器区分截断、无效 JSON 和缺少 Schema', async () => {
  const truncated = createDeepSeekResponsesClient({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: streamFrom([
        'event: response.incomplete',
        'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":2,"output_tokens":4}}}',
        '',
      ].join('\n')),
    }),
  });
  await assert.rejects(
    () => truncated.generate({
      messages: [{ role: 'user', content: '测试' }],
      outputSchema: TEST_SCHEMA,
    }),
    (error) => error.code === MODEL_ERROR_CODES.OUTPUT_TRUNCATED,
  );

  const invalid = createDeepSeekResponsesClient({
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: completedStream('不是 JSON'),
    }),
  });
  await assert.rejects(
    () => invalid.generate({
      messages: [{ role: 'user', content: '测试' }],
      outputSchema: TEST_SCHEMA,
    }),
    (error) => error.code === MODEL_ERROR_CODES.INVALID_JSON,
  );

  await assert.rejects(
    () => invalid.generate({ messages: [{ role: 'user', content: '测试' }] }),
    (error) => error.code === MODEL_ERROR_CODES.SCHEMA_REQUIRED,
  );
});

test('业务服务不再依赖供应商专属错误码或旧客户端路径', () => {
  const serverRoot = path.join(__dirname, '..', 'server');
  const source = javascriptFiles(serverRoot)
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /DEEPSEEK_[A-Z_]+/);
  assert.doesNotMatch(source, /lib\/deepseek-client|DeepSeekClientError/);
});
