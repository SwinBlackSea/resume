'use strict';

function readWithIdleTimeout(reader, idleMs) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('模型长时间没有返回新数据')), idleMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseEventLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch (_) {
    return null;
  }
}

/**
 * 消费 OpenAI 兼容 SSE，返回模型可见正文、内部推理长度与用量。
 * reasoning_content 只用于状态与诊断，不向业务层暴露具体内容。
 */
async function consumeChatStream(body, { idleMs = 30000, onActivity } = {}) {
  if (!body || typeof body.getReader !== 'function') throw new Error('模型服务没有返回可读取的响应流');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningLength = 0;
  let usage = null;
  let finishReason = null;

  const consumeLine = (line) => {
    const chunk = parseEventLine(line);
    if (!chunk) return;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0] || {};
    const delta = choice.delta || {};
    if (choice.finish_reason) finishReason = String(choice.finish_reason);
    if (delta.reasoning_content) {
      reasoningLength += String(delta.reasoning_content).length;
      if (onActivity) onActivity({ type: 'thinking' });
    }
    if (delta.content) {
      content += delta.content;
      if (onActivity) onActivity({ type: 'content', delta: delta.content });
    }
  };

  while (true) {
    const { done, value } = await readWithIdleTimeout(reader, idleMs);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
  }
  buffer += decoder.decode();
  if (buffer.trim()) buffer.split(/\r?\n/).forEach(consumeLine);

  return { content, reasoningLength, usage, finishReason };
}

module.exports = { readWithIdleTimeout, parseEventLine, consumeChatStream };
