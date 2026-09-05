'use strict';

const test = require('node:test');
const assert = require('node:assert');
const helpers = require('./helpers');
const resumeHarness = require('../server/lib/resume-harness');

async function sendWithModel(ctx, projectId, client, content) {
  const restore = resumeHarness.setModelClientForTests(client);
  try {
    return await helpers.call(ctx, 'POST', `/projects/${projectId}/ai/messages`, {
      body: {
        content,
        scope_type: 'RESUME_DOCUMENT',
        scope_id: null,
      },
    });
  } finally {
    restore();
  }
}

test('全局 AI 自动重试协议错误，并向用户区分格式错误、截断和服务不可用', async (t) => {
  const ctx = await helpers.boot();
  t.after(() => helpers.close(ctx));
  const projectId = await helpers.defaultProject(ctx);

  let invalidCalls = 0;
  const invalid = await sendWithModel(ctx, projectId, {
    provider: 'test',
    model: 'invalid-json',
    generate: async () => {
      invalidCalls += 1;
      const error = new Error('模型未返回合法 JSON');
      error.code = 'DEEPSEEK_INVALID_JSON';
      error.finish_reason = 'stop';
      error.content_length = 12;
      throw error;
    },
  }, '删除职业概况');
  assert.strictEqual(invalidCalls, 2);
  assert.strictEqual(invalid.status, 422);
  assert.strictEqual(invalid.body.title, 'MODEL_RESPONSE_INVALID');
  assert.match(invalid.body.detail, /没有返回完整可用/);

  let truncatedCalls = 0;
  const truncated = await sendWithModel(ctx, projectId, {
    provider: 'test',
    model: 'truncated-json',
    generate: async () => {
      truncatedCalls += 1;
      const error = new Error('模型输出达到长度上限');
      error.code = 'DEEPSEEK_OUTPUT_TRUNCATED';
      error.finish_reason = 'length';
      error.content_length = 12000;
      error.max_tokens = 8192;
      throw error;
    },
  }, '删除职业概况');
  assert.strictEqual(truncatedCalls, 2);
  assert.strictEqual(truncated.status, 422);
  assert.strictEqual(truncated.body.title, 'MODEL_OUTPUT_TRUNCATED');
  assert.match(truncated.body.detail, /结果过长/);

  const unavailable = await sendWithModel(ctx, projectId, {
    provider: 'test',
    model: 'network-error',
    generate: async () => {
      const error = new Error('模型网络不可达');
      error.code = 'DEEPSEEK_NETWORK_ERROR';
      throw error;
    },
  }, '删除职业概况');
  assert.strictEqual(unavailable.status, 422);
  assert.strictEqual(unavailable.body.title, 'MODEL_UNAVAILABLE');
  assert.match(unavailable.body.detail, /暂时不可用/);
});
