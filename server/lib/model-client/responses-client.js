'use strict';

const { parseJsonObject } = require('./json');
const {
  MODEL_ERROR_CODES,
  ModelClientError,
} = require('./errors');
const { consumeResponsesStream } = require('./responses-sse');

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function responseInput(messages) {
  return messages.map((message) => {
    const role = String(message && message.role || 'user');
    if (!Array.isArray(message && message.content)) {
      return { role, content: String(message && message.content || '') };
    }
    const content = message.content.map((part) => {
      if (!part || typeof part !== 'object') {
        return { type: 'input_text', text: String(part || '') };
      }
      if (part.type === 'image_url') {
        const image = part.image_url && typeof part.image_url === 'object'
          ? part.image_url
          : {};
        return {
          type: 'input_image',
          image_url: String(image.url || ''),
          ...(image.detail ? { detail: image.detail } : {}),
        };
      }
      return {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: String(part.text || ''),
      };
    });
    return { role, content };
  });
}

function schemaFormat(outputSchema, provider = null) {
  if (
    !outputSchema
    || typeof outputSchema !== 'object'
    || !outputSchema.name
    || !outputSchema.schema
  ) {
    throw new ModelClientError('模型请求缺少严格输出 Schema', {
      code: MODEL_ERROR_CODES.SCHEMA_REQUIRED,
      provider,
    });
  }
  return {
    type: 'json_schema',
    name: String(outputSchema.name).slice(0, 64),
    strict: true,
    schema: outputSchema.schema,
  };
}

function createResponsesClient(options = {}) {
  const { endpoint, apiKey, model, provider } = options;
  const firstTokenMs = positiveNumber(
    options.firstTokenMs
    || process.env.RESUME_MODEL_FIRST_TOKEN_MS
    || process.env.RESUME_LLM_FIRST_TOKEN_MS,
    30000,
  );
  const idleMs = positiveNumber(
    options.idleMs
    || process.env.RESUME_MODEL_IDLE_MS
    || process.env.RESUME_LLM_IDLE_MS,
    30000,
  );
  const totalMs = positiveNumber(
    options.totalMs
    || process.env.RESUME_MODEL_TOTAL_MS
    || process.env.RESUME_LLM_TOTAL_MS,
    180000,
  );
  const defaultMaxTokens = positiveNumber(
    options.maxTokens
    || process.env.RESUME_MODEL_MAX_TOKENS
    || process.env.RESUME_LLM_MAX_TOKENS,
    4096,
  );
  const maxTokensLimit = positiveNumber(
    options.maxTokensLimit
    || process.env.RESUME_MODEL_MAX_TOKENS_LIMIT
    || process.env.RESUME_LLM_MAX_TOKENS_LIMIT,
    32768,
  );
  const fetchImpl = options.fetchImpl || fetch;

  async function generate({
    messages,
    signal,
    onActivity,
    maxTokens: requestedMaxTokens,
    thinking,
    reasoningEffort,
    outputSchema,
    temperature,
  } = {}) {
    const requestedEffort = reasoningEffort ?? (thinking === true ? 'high' : 'none');
    const minimumEffort = options.minimumReasoningEffort ?? 'none';
    if (!['none', 'low'].includes(minimumEffort)) {
      throw new ModelClientError('模型最低推理配置无效', {
        code: MODEL_ERROR_CODES.INVALID_REQUEST, provider, model,
      });
    }
    // Some explicitly configured gateways cannot disable reasoning. Keep this
    // compatibility constraint at the adapter, never rewrite the user's task.
    const effort = requestedEffort === 'none' ? minimumEffort : requestedEffort;
    if (!['none', 'low', 'medium', 'high'].includes(effort)) {
      throw new ModelClientError('模型推理配置无效', {
        code: MODEL_ERROR_CODES.INVALID_REQUEST, provider, model,
      });
    }
    const effectiveMaxTokens = Math.min(
      positiveNumber(requestedMaxTokens, defaultMaxTokens),
      maxTokensLimit,
    );
    if (!apiKey) {
      throw new ModelClientError('未配置模型 API Key', {
        code: MODEL_ERROR_CODES.NOT_CONFIGURED,
        provider,
        model,
      });
    }
    if (!Array.isArray(messages) || !messages.length) {
      throw new ModelClientError('模型消息不能为空', {
        code: MODEL_ERROR_CODES.INVALID_REQUEST,
        provider,
        model,
      });
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    let abortPhase = null;
    const abort = phase => { if (!controller.signal.aborted) { abortPhase = phase; controller.abort(); } };
    const totalTimer = setTimeout(() => abort('total'), totalMs);
    const firstTimer = setTimeout(() => abort('first_response'), firstTokenMs);
    const abortFromCaller = () => abort('canceled');
    if (signal) {
      if (signal.aborted) abortFromCaller();
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
          input: responseInput(messages),
          stream: true,
          store: false,
          text: { format: schemaFormat(outputSchema, provider) },
          reasoning: { effort },
          ...(options.includeTemperature ? { temperature: Number(
            temperature
            ?? options.temperature
            ?? process.env.RESUME_MODEL_TEMPERATURE
            ?? process.env.RESUME_LLM_TEMPERATURE
            ?? 0.2,
          ) } : {}),
          max_output_tokens: effectiveMaxTokens,
        }),
        redirect: 'error',
        signal: controller.signal,
      });

      started = true;
      if (!response.ok) {
        // A proxy error body can echo credentials or resume text.
        await response.body?.cancel?.().catch(() => {});
        throw new ModelClientError(
          `模型服务返回 HTTP ${response.status}`,
          {
            code: MODEL_ERROR_CODES.HTTP_ERROR,
            provider,
            model,
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
          },
        );
      }

      const streamed = await consumeResponsesStream(response.body, {
        idleMs,
        onActivity: (event) => {
          if (!firstActivity) {
            firstActivity = true;
            clearTimeout(firstTimer);
          }
          if (onActivity) onActivity(event);
        },
      });
      if (streamed.refused) {
        throw new ModelClientError('模型拒绝了本次请求，未生成修改建议', {
          code: MODEL_ERROR_CODES.REFUSED, provider, model,
        });
      }
      const truncated = streamed.finishReason === 'max_output_tokens';
      if (truncated) {
        throw new ModelClientError(
          `模型输出达到长度上限（正文 ${streamed.content.length} 字）`,
          {
            code: MODEL_ERROR_CODES.OUTPUT_TRUNCATED,
            provider,
            model,
            content_length: streamed.content.length,
            reasoning_length: streamed.reasoningLength,
            finish_reason: streamed.finishReason,
            usage: streamed.usage,
            max_tokens: effectiveMaxTokens,
          },
        );
      }
      if (streamed.status !== 'completed') {
        throw new ModelClientError(
          '模型没有完成响应',
          {
            code: MODEL_ERROR_CODES.RESPONSE_FAILED,
            provider,
            model,
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
        throw new ModelClientError(
          `模型未返回合法 JSON（正文 ${streamed.content.length} 字）`,
          {
            code: MODEL_ERROR_CODES.INVALID_JSON,
            provider,
            model,
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
        strict_schema: true,
        provider,
        model,
        usage: streamed.usage,
        reasoning_length: streamed.reasoningLength,
        finish_reason: streamed.finishReason,
        max_tokens: effectiveMaxTokens,
      };
    } catch (error) {
      if (error instanceof ModelClientError) throw error;
      const aborted = controller.signal.aborted || (error && error.name === 'AbortError');
      const idleTimeout = error && error.code === 'MODEL_STREAM_IDLE_TIMEOUT';
      if (idleTimeout && !controller.signal.aborted) abort('stream_idle');
      throw new ModelClientError(
        abortPhase === 'canceled' ? '模型请求已取消' : aborted || idleTimeout
          ? started
            ? '模型响应超时或被取消'
            : '模型首次响应超时或被取消'
          : '模型请求失败',
        {
          code: abortPhase === 'canceled' ? 'MODEL_CANCELED' : aborted || idleTimeout
            ? MODEL_ERROR_CODES.TIMEOUT
            : MODEL_ERROR_CODES.NETWORK_ERROR,
          provider,
          model,
          timeout_phase: abortPhase,
          duration_ms: Date.now() - startedAt,
          response_started: started,
          first_activity_received: firstActivity,
          cause: error,
        },
      );
    } finally {
      clearTimeout(firstTimer);
      clearTimeout(totalTimer);
      if (signal) signal.removeEventListener('abort', abortFromCaller);
    }
  }

  return {
    provider,
    model,
    endpoint,
    generate,
  };
}

module.exports = {
  createResponsesClient,
  responseInput,
  schemaFormat,
};
