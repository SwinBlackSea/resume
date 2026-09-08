'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { CAPABILITIES } = require('../server/lib/model-client');
const {
  routeResumeRequest,
  repairCapability,
} = require('../server/lib/resume-harness/model-routing');
const {
  decodeGlobalStructuredOutput,
} = require('../server/lib/resume-harness/structured-envelope');
const {
  assertInlineEnvelope,
} = require('../server/lib/resume-harness/inline-rewrite');

function input(text, overrides = {}) {
  return {
    request: {
      text,
      task: { state: {} },
    },
    scope: { type: 'RESUME_BLOCK', id: 'summary-1' },
    focus: {},
    attachments: [],
    ...overrides,
  };
}

test('全局接口固定完整文档能力，不因措辞简单降级或猜测操作范围', () => {
  const route = routeResumeRequest(input('把这句话写得更简洁'));
  assert.strictEqual(route.capability, CAPABILITIES.COMPLEX);
  assert.strictEqual(route.reason, 'global_document_capability');
});

test('结构、样式和跨区域修改保持完整文档能力，不根据措辞降级', () => {
  for (const text of [
    '把职业概况合并成一段',
    '把工作经历移动到项目经历前面',
    '统一所有模块标题颜色和间距',
    '同时精简概况并重排工作经历',
    '把教育经历放到项目经历之后',
    '把整份简历版式调整得更现代',
  ]) {
    assert.strictEqual(
      routeResumeRequest(input(text)).capability,
      CAPABILITIES.COMPLEX,
      text,
    );
  }
});

test('用户确认处理思路后继续使用完整文档能力', () => {
  const route = routeResumeRequest(input('按这个思路精简', {
    request: {
      text: '按这个思路精简',
      task: {
        state: {
          confirmed_plan: {
            content: '合并重复模块并精简多处内容',
          },
        },
      },
    },
  }));
  assert.strictEqual(route.capability, CAPABILITIES.COMPLEX);
  assert.strictEqual(route.reason, 'global_document_capability');
});

test('图片请求固定走视觉能力，恢复请求不丢失视觉上下文', () => {
  const route = routeResumeRequest(input('看看附件', {
    attachments: [{ mime_type: 'image/png' }],
  }));
  assert.strictEqual(route.capability, CAPABILITIES.VISION);
  assert.strictEqual(repairCapability(route.capability), CAPABILITIES.VISION);
});

test('严格外壳解码 proposal payload，并保留兼容测试协议', () => {
  const decoded = decodeGlobalStructuredOutput({
    type: 'proposal',
    content: '已准备好修改。',
    awaiting_user: false,
    message_kind: null,
    quick_replies: [],
    payload_json: JSON.stringify({
      proposal: {
        target_resume_fragments: {
          format: 'resume-target-fragments-v2',
          changes: [],
          insertions: [],
        },
      },
    }),
  });
  assert.strictEqual(decoded.type, 'proposal');
  assert.strictEqual(decoded.proposal.target_resume_fragments.format, 'resume-target-fragments-v2');

  const direct = { type: 'message', content: '测试客户端直返' };
  assert.strictEqual(decodeGlobalStructuredOutput(direct), direct);
});

test('严格外壳在业务解码前拒绝额外字段和状态冲突', () => {
  assert.throws(
    () => decodeGlobalStructuredOutput({
      type: 'message',
      content: '测试',
      awaiting_user: false,
      message_kind: null,
      quick_replies: [],
      payload_json: '{}',
    }),
    (error) => error.code === 'MODEL_OUTPUT_SCHEMA_INVALID',
  );
  assert.throws(
    () => decodeGlobalStructuredOutput({
      type: 'proposal',
      content: '测试',
      awaiting_user: true,
      message_kind: null,
      quick_replies: [],
      payload_json: '{"proposal":{}}',
    }),
    (error) => error.code === 'MODEL_OUTPUT_SCHEMA_INVALID',
  );
  assert.throws(
    () => decodeGlobalStructuredOutput(
      { type: 'message', content: '缺少严格外壳' },
      { requireEnvelope: true },
    ),
    (error) => error.code === 'MODEL_OUTPUT_SCHEMA_INVALID',
  );
});

test('局部严格外壳拒绝 proposal/message 状态混用', () => {
  assert.doesNotThrow(() => assertInlineEnvelope({
    type: 'proposal',
    content: '已生成。',
    handoff: null,
    suggestion: '精简后的文字',
    summary: '精简表达',
  }));
  assert.throws(
    () => assertInlineEnvelope({
      type: 'proposal',
      content: '已生成。',
      handoff: true,
      suggestion: '精简后的文字',
      summary: '精简表达',
    }),
    (error) => error.code === 'INLINE_OUTPUT_SCHEMA_INVALID',
  );
});
