'use strict';

function streamTimeout(message) {
  const error = new Error(message);
  error.code = 'MODEL_STREAM_IDLE_TIMEOUT';
  return error;
}

function readWithIdleTimeout(reader, idleMs) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(streamTimeout('模型长时间没有返回新数据')),
        idleMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseDataLine(line) {
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

function outputTextFromResponse(response) {
  const parts = [];
  for (const item of Array.isArray(response && response.output) ? response.output : []) {
    if (!item || item.type !== 'message') continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content && content.type === 'output_text' && content.text) {
        parts.push(String(content.text));
      }
    }
  }
  return parts.join('');
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    ...usage,
    prompt_tokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0),
    completion_tokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
  };
}

/**
 * 消费 Responses API 的语义 SSE。正文只读取 output_text，推理内容只计数，
 * 不向业务层暴露。
 */
async function consumeResponsesStream(body, { idleMs = 30000, onActivity } = {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('模型服务没有返回可读取的响应流');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningLength = 0;
  let usage = null;
  let finishReason = null;
  let status = 'in_progress';
  let responseError = null;
  let finalResponse = null;

  const consumeLine = (line) => {
    const event = parseDataLine(line);
    if (!event) return;
    if (onActivity) onActivity({ type: 'response' });
    const type = String(event.type || '');
    if (type === 'response.output_text.delta' && event.delta) {
      content += String(event.delta);
      if (onActivity) onActivity({ type: 'content', delta: String(event.delta) });
      return;
    }
    if (type === 'response.reasoning_text.delta' && event.delta) {
      reasoningLength += String(event.delta).length;
      if (onActivity) onActivity({ type: 'thinking' });
      return;
    }
    if (!['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
      return;
    }
    finalResponse = event.response || null;
    status = String(finalResponse && finalResponse.status || type.replace('response.', ''));
    usage = normalizedUsage(finalResponse && finalResponse.usage);
    responseError = finalResponse && finalResponse.error || null;
    if (type === 'response.completed') {
      finishReason = 'stop';
    } else if (type === 'response.incomplete') {
      finishReason = String(
        finalResponse
        && finalResponse.incomplete_details
        && finalResponse.incomplete_details.reason
        || 'incomplete',
      );
    } else {
      finishReason = 'failed';
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

  if (!content && finalResponse) content = outputTextFromResponse(finalResponse);
  return {
    content,
    reasoningLength,
    usage,
    finishReason,
    status,
    responseError,
  };
}

module.exports = {
  readWithIdleTimeout,
  parseDataLine,
  outputTextFromResponse,
  normalizedUsage,
  consumeResponsesStream,
};
