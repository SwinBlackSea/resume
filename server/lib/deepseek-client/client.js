'use strict';

const { parseJsonObject } = require('./json');
const { consumeChatStream } = require('./sse');

class DeepSeekClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DeepSeekClientError';
    this.code = details.code || 'DEEPSEEK_ERROR';
    this.status = details.status || null;
    this.cause = details.cause || null;
    Object.entries(details).forEach(([key, value]) => {
      if (!['code', 'status', 'cause'].includes(key)) this[key] = value;
    });
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createDeepSeekClient(options = {}) {
  const endpoint =
    options.endpoint || process.env.RESUME_LLM_ENDPOINT || 'https://api.deepseek.com/chat/completions';
  const apiKey = options.apiKey || process.env.RESUME_LLM_API_KEY;
  const model =
    options.model || process.env.RESUME_LLM_MODEL || 'deepseek-v4-flash-vision-exp';
  const firstTokenMs = positiveNumber(
    options.firstTokenMs || process.env.RESUME_LLM_FIRST_TOKEN_MS,
    30000,
  );
  const idleMs = positiveNumber(options.idleMs || process.env.RESUME_LLM_IDLE_MS, 30000);
  const totalMs = positiveNumber(options.totalMs || process.env.RESUME_LLM_TOTAL_MS, 180000);
  const defaultMaxTokens = positiveNumber(
    options.maxTokens || process.env.RESUME_LLM_MAX_TOKENS,
    4096,
  );
  const maxTokensLimit = positiveNumber(
    options.maxTokensLimit || process.env.RESUME_LLM_MAX_TOKENS_LIMIT,
    32768,
  );
  const fetchImpl = options.fetchImpl || fetch;

  async function generate({ messages, signal, onActivity, maxTokens: requestedMaxTokens } = {}) {
    const effectiveMaxTokens = Math.min(
      positiveNumber(requestedMaxTokens, defaultMaxTokens),
      maxTokensLimit,
    );
    if (!apiKey) {
      throw new DeepSeekClientError('未配置 RESUME_LLM_API_KEY', {
        code: 'DEEPSEEK_NOT_CONFIGURED',
      });
    }
    if (!Array.isArray(messages) || !messages.length) {
      throw new DeepSeekClientError('模型消息不能为空', { code: 'DEEPSEEK_INVALID_REQUEST' });
    }

    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), totalMs);
    const firstTimer = setTimeout(() => controller.abort(), firstTokenMs);
    const abortFromCaller = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', abortFromCaller, { once: true });
    }

    let started = false;
    let firstActivity = false;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          response_format: { type: 'json_object' },
          temperature: Number(options.temperature ?? process.env.RESUME_LLM_TEMPERATURE ?? 0.2),
          max_tokens: effectiveMaxTokens,
        }),
        signal: controller.signal,
      });

      started = true;
      if (!response.ok) {
        const safeBody = await response.text().catch(() => '');
        throw new DeepSeekClientError(
          `DeepSeek 返回 ${response.status}${safeBody ? `：${safeBody.slice(0, 240)}` : ''}`,
          { code: 'DEEPSEEK_HTTP_ERROR', status: response.status },
        );
      }

      const streamed = await consumeChatStream(response.body, {
        idleMs,
        onActivity: (event) => {
          if (!firstActivity) {
            firstActivity = true;
            clearTimeout(firstTimer);
          }
          if (onActivity) onActivity(event);
        },
      });
      const truncated = ['length', 'max_tokens'].includes(String(streamed.finishReason || ''));
      if (truncated) {
        throw new DeepSeekClientError(
          `模型输出达到长度上限（正文 ${streamed.content.length} 字）`,
          {
            code: 'DEEPSEEK_OUTPUT_TRUNCATED',
            content_length: streamed.content.length,
            reasoning_length: streamed.reasoningLength,
            finish_reason: streamed.finishReason,
            usage: streamed.usage,
            max_tokens: effectiveMaxTokens,
          },
        );
      }
      const output = parseJsonObject(streamed.content);
      if (!output) {
        throw new DeepSeekClientError(
          `模型未返回合法 JSON（正文 ${streamed.content.length} 字）`,
          {
            code: 'DEEPSEEK_INVALID_JSON',
            content_length: streamed.content.length,
            reasoning_length: streamed.reasoningLength,
            finish_reason: streamed.finishReason,
            usage: streamed.usage,
            max_tokens: effectiveMaxTokens,
          },
        );
      }
      return {
        output,
        provider: 'deepseek',
        model,
        usage: streamed.usage,
        reasoning_length: streamed.reasoningLength,
        finish_reason: streamed.finishReason,
        max_tokens: effectiveMaxTokens,
      };
    } catch (error) {
      if (error instanceof DeepSeekClientError) throw error;
      const aborted = controller.signal.aborted || (error && error.name === 'AbortError');
      throw new DeepSeekClientError(
        aborted
          ? started
            ? 'DeepSeek 响应超时或被取消'
            : 'DeepSeek 首次响应超时或被取消'
          : 'DeepSeek 请求失败',
        { code: aborted ? 'DEEPSEEK_TIMEOUT' : 'DEEPSEEK_NETWORK_ERROR', cause: error },
      );
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
  }

  return {
    provider: 'deepseek',
    model,
    generate,
  };
}

module.exports = { createDeepSeekClient, DeepSeekClientError };
