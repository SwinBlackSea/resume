'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelGateway } = require('../server/lib/model-gateway');

test('gateway只发送模型协议，不泄露领域input，消息原样传递', async () => {
  let received;
  const gateway = createModelGateway({ client: {
    provider: 'fake',
    generate: async (request) => { received = request; return { output: { ok: true } }; },
  } });
  const messages = [{ role: 'user', content: '  用户原话  ' }];
  const result = await gateway.generate({
    input: { secret: 'domain-only', database_fields: {} },
    messages,
    outputSchema: { name: 'test', schema: { type: 'object' } },
    capability: 'complex', routingReason: 'global_document', reasoningEffort: 'low',
  });
  assert.equal(received.messages, messages);
  assert.equal(received.input, undefined);
  assert.equal(received.capability, 'complex');
  assert.equal(received.reasoningEffort, 'low');
  assert.equal(result.gateway_metrics.message_count, 1);
  assert.doesNotMatch(JSON.stringify(result.gateway_metrics), /用户原话|secret/);
});

test('gateway拒绝无效请求、取消和未知能力，不做循环重试', async () => {
  let calls = 0;
  const gateway = createModelGateway({ client: {
    generate: async () => { calls += 1; throw new Error('network failure'); },
  } });
  const request = {
    messages: [{ role: 'user', content: 'test' }],
    outputSchema: { name: 'test', schema: { type: 'object' } },
  };
  await assert.rejects(gateway.generate({}), { code: 'MODEL_INVALID_REQUEST' });
  await assert.rejects(gateway.generate({ ...request, capability: 'unknown' }), {
    code: 'MODEL_INVALID_REQUEST',
  });
  await assert.rejects(gateway.generate({
    ...request, signal: AbortSignal.abort(),
  }), { code: 'MODEL_CANCELED' });
  assert.equal(calls, 0);
  await assert.rejects(gateway.generate(request), /network failure/);
  assert.equal(calls, 1);
});
