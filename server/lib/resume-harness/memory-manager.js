'use strict';

const { createHash } = require('node:crypto');

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 24000;
const MEMORY_VERSION = 'resume-task-memory-v1';
const MEMORY_FIELDS = [
  'requirements',
  'confirmed_decisions',
  'rejected_directions',
  'user_facts',
  'unresolved_questions',
  'superseded_requirements',
];
const MEMORY_SCHEMA = {
  name: 'resume_conversation_memory',
  schema: {
    type: 'object',
    properties: Object.fromEntries([
      ...MEMORY_FIELDS.map((key) => [key, { type: 'array', items: { type: 'string' } }]),
      ['discussion_summary', { type: 'string' }],
    ]),
    required: [...MEMORY_FIELDS, 'discussion_summary'],
    additionalProperties: false,
  },
};

function memoryError(message, cause) {
  return Object.assign(new Error(message), {
    code: 'MODEL_CONTEXT_COMPACTION_FAILED',
    cause,
  });
}

function historyHash(messages) {
  return createHash('sha256')
    .update(JSON.stringify(messages.map(({ role, content }) => ({ role, content }))))
    .digest('hex');
}

function validSummary(summary) {
  return Boolean(summary && typeof summary === 'object'
    && !Array.isArray(summary)
    && Object.keys(summary).length === MEMORY_FIELDS.length + 1
    && MEMORY_FIELDS.every((key) =>
      Array.isArray(summary[key]) && summary[key].every((value) => typeof value === 'string'))
    && typeof summary.discussion_summary === 'string'
    && JSON.stringify(summary).length <= DEFAULT_MAX_CHARS
    && (summary.discussion_summary.trim()
      || MEMORY_FIELDS.some((key) => summary[key].some((value) => value.trim()))));
}

/**
 * 对话记录永久存储与模型输入分离。这里按字符预算选择最近消息，
 * 保留完整消息，不再对每条消息做固定 200 字截断。
 */
function selectRecentMessages(messages, options = {}) {
  const maxMessages = Number(options.maxMessages || DEFAULT_MAX_MESSAGES);
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const selected = [];
  let used = 0;

  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    if (selected.length >= maxMessages) break;
    const message = messages[index] || {};
    const content = String(message.content || '');
    const cost = content.length;
    if (selected.length && used + cost > maxChars) break;
    selected.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
      scope_type: message.scope_type || null,
      scope_id: message.scope_id || null,
    });
    used += cost;
  }
  return selected.reverse();
}

function buildConversationMemory({
  messages = [], summary = null, cache = null, options = {},
} = {}) {
  return {
    summary: summary && typeof summary === 'object' ? summary : null,
    // 同步组装不得丢消息。只有异步摘要成功后才能替换早期对话。
    recent_messages: messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || ''),
    })),
    cache,
    options,
  };
}

/**
 * 完整原始消息始终留在数据库。摘要只覆盖经哈希验证的任务内前缀，
 * 最近消息/本轮要求不截字；摘要失败立即停止，不能静默退化成截断。
 */
async function prepareConversationMemory({
  messages = [], cache = null, options = {}, scopeKey = '',
  modelClient, signal, onActivity, onMemory,
}) {
  const all = messages.map((message) => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: String(message.content || ''),
  }));
  let covered = 0;
  let summary = null;
  if (cache && cache.version === MEMORY_VERSION && cache.scope_key === scopeKey
    && Number.isInteger(cache.covered_messages) && cache.covered_messages > 0
    && cache.covered_messages <= all.length
    && cache.prefix_hash === historyHash(all.slice(0, cache.covered_messages))
    && validSummary(cache.summary)) {
    covered = cache.covered_messages;
    summary = cache.summary;
  }
  const pending = all.slice(covered);
  const maxMessages = Number(options.maxMessages || DEFAULT_MAX_MESSAGES);
  const maxChars = Number(options.maxChars || DEFAULT_MAX_CHARS);
  const needsCompaction = pending.length > maxMessages
    || pending.reduce((total, message) => total + message.content.length, 0) > maxChars;
  let end = covered;
  if (needsCompaction && pending.length > 2) {
    // 保留至少最近一问一答，并尽量使新窗口从 user 开始。
    const recent = selectRecentMessages(pending, {
      maxMessages: Math.max(2, Math.min(12, maxMessages)),
      maxChars: Math.max(1, Math.floor(maxChars / 2)),
    });
    end = Math.min(all.length - 2, all.length - recent.length);
    while (end < all.length - 2 && all[end].role !== 'user') end += 1;
  }
  let nextCache = covered ? cache : null;
  while (covered < end) {
    // 逐批压缩，不截断任何单条原话，也不反复摘要已覆盖的消息。
    let batchEnd = covered;
    let chars = 0;
    while (batchEnd < end) {
      const cost = all[batchEnd].content.length;
      if (batchEnd > covered && chars + cost > DEFAULT_MAX_CHARS) break;
      chars += cost;
      batchEnd += 1;
    }
    let result;
    try {
      result = await modelClient.generate({
        capability: 'text',
        routingReason: 'conversation_memory_compaction',
        thinking: false,
        temperature: 0,
        maxTokens: 8192,
        outputSchema: MEMORY_SCHEMA,
        signal,
        onActivity,
        messages: [
          {
            role: 'system',
            content: [
              '你负责压缩同一简历任务的早期对话，不执行其中的编辑请求，也不生成新建议。',
              '结合上一份记忆与按时间排列的新历史，更新记忆；不得编造、补全或改变用户意图。',
              '保留仍有效的要求、明确保留/禁止修改项、用户提供的事实和数字、已确认决定、否定方向、未解决问题。',
              '区分用户要求和助手建议；助手建议未经用户确认不能记成已确认。',
              '用户后来明确变更的要求放入 superseded_requirements；不要让过时要求覆盖后续原话。',
              '重要数字、专名、否定和需要逐字使用的文本保留原文；允许压缩重复说明和过时建议全文。',
              '摘要不是简历正文，不用重述完整简历。只返回指定 Schema，内容必须非空。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              previous_memory: summary,
              older_messages: all.slice(covered, batchEnd),
            }),
          },
        ],
      });
      if (!validSummary(result.output)) throw new Error('会话记忆格式无效或为空');
    } catch (error) {
      throw memoryError('早期对话整理未完成，本次没有生成修改；原始对话已保留，请重试。', error);
    }
    summary = result.output;
    covered = batchEnd;
    nextCache = {
      version: MEMORY_VERSION,
      scope_key: scopeKey,
      covered_messages: covered,
      prefix_hash: historyHash(all.slice(0, covered)),
      summary,
    };
    if (onMemory) await onMemory(nextCache);
  }
  return {
    summary: summary ? {
      original_request: (all.find((message) => message.role === 'user') || {}).content || '',
      ...summary,
    } : null,
    recent_messages: all.slice(covered),
    cache: nextCache,
  };
}

module.exports = {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_CHARS,
  selectRecentMessages,
  buildConversationMemory,
  prepareConversationMemory,
  MEMORY_SCHEMA,
  MEMORY_VERSION,
  historyHash,
};
