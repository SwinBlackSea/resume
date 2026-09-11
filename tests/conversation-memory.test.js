'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareConversationMemory,
  MEMORY_SCHEMA,
} = require('../server/lib/resume-harness/memory-manager');

function history(count = 50) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index === 0 ? '保留174名学生，不要改变学校名称'
      : index === 2 ? '不要采用表格排版'
        : index === 48 ? '现在改为允许表格，但学校名称仍保持原文'
          : `第${index}条对话，原文保留。`,
  }));
}

function summary() {
  return {
    requirements: ['保留174名学生，不要改变学校名称'],
    confirmed_decisions: [],
    rejected_directions: ['不要采用表格排版'],
    user_facts: ['174名学生'],
    unresolved_questions: [],
    superseded_requirements: [],
    discussion_summary: '继续优化简历，保留用户要求。',
  };
}

test('短对话不增加摘要调用，原话包括超过1000字的单条消息全部透传', async () => {
  const messages = history(6);
  messages[0].content = '不丢原话'.repeat(800);
  const result = await prepareConversationMemory({
    messages,
    modelClient: { generate: () => assert.fail('短对话不应调用摘要模型') },
  });
  assert.deepEqual(result.recent_messages, messages);
  assert.equal(result.summary, null);
});

test('超预算先摘要旧对话，保留最近完整问答和原始目标，缓存只覆盖前缀', async () => {
  const messages = history();
  const saved = [];
  const requests = [];
  const result = await prepareConversationMemory({
    messages, scopeKey: 'global:task-1', onMemory: (cache) => saved.push(cache),
    modelClient: {
      generate: async (request) => {
        requests.push(request);
        return { output: summary() };
      },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].outputSchema.name, MEMORY_SCHEMA.name);
  assert.equal(requests[0].routingReason, 'conversation_memory_compaction');
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(payload.older_messages, messages.slice(0, 38));
  assert.deepEqual(result.recent_messages, messages.slice(38));
  assert.equal(result.summary.original_request, messages[0].content);
  assert.equal(result.recent_messages.at(-2).content, messages[48].content);
  assert.equal(saved[0].covered_messages, 38);
  assert.deepEqual(result.cache, saved[0]);

  const next = await prepareConversationMemory({
    messages: [...messages, ...history(2)],
    cache: result.cache, scopeKey: 'global:task-1',
    modelClient: { generate: () => assert.fail('有效缓存不能每轮重复摘要') },
  });
  assert.deepEqual(next.recent_messages, [...messages.slice(38), ...history(2)]);
  assert.deepEqual(next.summary, result.summary);
});

test('历史被改变或任务不同，旧记忆不可复用', async () => {
  let calls = 0;
  const modelClient = { generate: async () => { calls += 1; return { output: summary() }; } };
  const messages = history();
  const first = await prepareConversationMemory({ messages, modelClient, scopeKey: 'one' });
  await prepareConversationMemory({
    messages, modelClient, scopeKey: 'two', cache: first.cache,
  });
  const changed = messages.map((message) => ({ ...message }));
  changed[0].content = '学校名称已更新';
  await prepareConversationMemory({
    messages: changed, modelClient, scopeKey: 'one', cache: first.cache,
  });
  assert.equal(calls, 3);
});

test('滚动摘要合并旧记忆和新增历史，不重新发送已覆盖的原始前缀', async () => {
  const requests = [];
  const modelClient = { generate: async (request) => {
    requests.push(JSON.parse(request.messages[1].content));
    return { output: summary() };
  } };
  const first = await prepareConversationMemory({
    messages: history(), modelClient, scopeKey: 'task',
  });
  const next = await prepareConversationMemory({
    messages: history(90), modelClient, scopeKey: 'task', cache: first.cache,
  });
  assert.deepEqual(requests[1].previous_memory, summary());
  assert.deepEqual(requests[1].older_messages, history(90).slice(38, 78));
  assert.deepEqual(next.recent_messages, history(90).slice(78));
});

test('摘要失败或无效时明确报错，不发出丢历史的编辑请求或保存空记忆', async () => {
  for (const generate of [
    async () => { throw new Error('network'); },
    async () => ({ output: {} }),
    async () => ({ output: { ...summary(), requirements: '不合法' } }),
  ]) {
    await assert.rejects(prepareConversationMemory({
      messages: history(),
      modelClient: { generate },
      onMemory: () => assert.fail('失败摘要不得保存'),
    }), { code: 'MODEL_CONTEXT_COMPACTION_FAILED' });
  }
});

test('按字符预算压缩时不会截断长消息或丢最后一问一答', async () => {
  const messages = history(8);
  messages[0].content = '最初完整要求'.repeat(6000);
  const batches = [];
  const result = await prepareConversationMemory({
    messages,
    modelClient: { generate: async (request) => {
      batches.push(JSON.parse(request.messages[1].content));
      return { output: summary() };
    } },
  });
  assert.equal(batches[0].older_messages[0].content, messages[0].content);
  assert.deepEqual(result.recent_messages.slice(-2), messages.slice(-2));
  assert.equal(result.summary.original_request, messages[0].content);
});
