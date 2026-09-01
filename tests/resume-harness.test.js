'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildHarnessInput,
  buildMessages,
  complete,
  setModelClientForTests,
} = require('../server/lib/resume-harness');

process.env.NODE_ENV = 'test';

function input(overrides = {}) {
  return buildHarnessInput({
    text: '把当前内容拆成两个段落',
    messageId: 'message-current',
    scope: { type: 'RESUME_BLOCK', id: 'bullet-1', revision: 7 },
    task: { id: 'task-1', goal: '优化工作经历' },
    profile: { revision: 3, basics: { name: '陈知行', city: '上海' } },
    resume: {
      revision: 7,
      content: {
        summary: '产品经理',
        experience: [{ id: 'work-1', bullets: [{ id: 'bullet-1', text: '完整正文尾部标记' }] }],
      },
    },
    job: { id: 'job-1', confirmed_text: '高级产品经理岗位完整描述' },
    focus: {
      current_text: '负责增长实验，激活率提升 26%',
      editing_base: '主导增长实验，推动激活率提升 26%',
      location: { section: 'experience', item_id: 'work-1', bullet_id: 'bullet-1' },
      neighboring_content: [{ id: 'bullet-2', text: '负责商业化策略' }],
    },
    conversationMessages: [
      { role: 'user', content: '先写得更专业' },
      { role: 'assistant', content: '这是上一版建议' },
    ],
    attachments: [{ id: 'upload-1', mime_type: 'image/png', content_base64: 'aW1hZ2U=' }],
    ...overrides,
  });
}

test('Harness 每轮携带完整工作区、会话和锁定焦点', () => {
  const built = input();
  assert.strictEqual(built.workspace.resume.content.experience[0].bullets[0].text, '完整正文尾部标记');
  assert.strictEqual(built.workspace.target_job.confirmed_text, '高级产品经理岗位完整描述');
  assert.strictEqual(Object.hasOwn(built.workspace, 'confirmed_facts'), false);
  assert.strictEqual(Object.hasOwn(built, 'pending_facts'), false);
  assert.strictEqual(built.focus.editing_base, '主导增长实验，推动激活率提升 26%');
  assert.deepStrictEqual(built.conversation.recent_messages.map((item) => item.content), [
    '先写得更专业',
    '这是上一版建议',
  ]);
});

test('Harness 将图片与本轮锁定焦点一起发送给视觉模型', () => {
  const messages = buildMessages(input());
  const last = messages[messages.length - 1];
  assert.strictEqual(last.role, 'user');
  assert.ok(Array.isArray(last.content));
  assert.match(last.content[0].text, /bullet-1/);
  assert.strictEqual(last.content[1].image_url.url, 'data:image/png;base64,aW1hZ2U=');
});

test('Harness 会话记忆按预算保留完整的最近消息', () => {
  const conversationMessages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `完整消息-${index}`,
  }));
  const built = input({ conversationMessages, memoryOptions: { maxMessages: 3, maxChars: 1000 } });
  assert.deepStrictEqual(built.conversation.recent_messages.map((item) => item.content), [
    '完整消息-5',
    '完整消息-6',
    '完整消息-7',
  ]);
});

test('Harness 不接受模型改写 scope', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'scope-spoof',
    generate: async () => ({
      output: {
        reply: '已生成建议。',
        scope: { type: 'DATA_PROFILE', id: 'other' },
        actions: [],
        uncertainty: [],
      },
    }),
  });
  try {
    const result = await complete(input());
    assert.deepStrictEqual(result.response.scope, {
      type: 'RESUME_BLOCK',
      id: 'bullet-1',
      revision: 7,
    });
  } finally {
    restore();
  }
});

test('Harness 拒绝模型返回来源、证据或依赖关系字段', async () => {
  const restore = setModelClientForTests({
    provider: 'test',
    model: 'forbidden-relations',
    generate: async () => ({
      output: {
        reply: '建议如下。',
        scope: { type: 'RESUME_BLOCK', id: 'bullet-1' },
        actions: [{
          type: 'RESUME_REWRITE_PROPOSAL',
          payload: {
            proposal: {
              original: 'A',
              suggestion: 'B',
              source_item_ids: ['exp-1'],
            },
          },
        }],
        uncertainty: [],
      },
    }),
  });
  try {
    await assert.rejects(() => complete(input()), /不允许的内容关系字段/);
  } finally {
    restore();
  }
});
