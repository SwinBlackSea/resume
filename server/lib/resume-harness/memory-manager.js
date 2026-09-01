'use strict';

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MAX_CHARS = 24000;

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

function buildConversationMemory({ messages = [], summary = null, options = {} } = {}) {
  return {
    summary: summary && typeof summary === 'object' ? summary : null,
    recent_messages: selectRecentMessages(messages, options),
  };
}

module.exports = {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_CHARS,
  selectRecentMessages,
  buildConversationMemory,
};
