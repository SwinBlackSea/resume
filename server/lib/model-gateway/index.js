'use strict';

const {
  createModelClient, CAPABILITIES, ModelClientError, MODEL_ERROR_CODES,
} = require('../model-client');

/**
 * 模型基础设施边界：供应商/能力路由由 adapter 工厂实现；gateway 校验统一请求、
 * 传递取消信号并返回无正文的计量。没有业务状态、提示词或语义重试。
 */
function createModelGateway(options = {}) {
  const client = options.client || createModelClient(options);
  return {
    provider: client.provider,
    model: client.model,
    models: client.models,
    async generate(request = {}) {
      if (!Array.isArray(request.messages) || !request.messages.length
        || !request.outputSchema || !request.outputSchema.schema) {
        throw new ModelClientError('模型请求必须包含消息与输出 Schema', {
          code: MODEL_ERROR_CODES.INVALID_REQUEST,
        });
      }
      const capability = request.capability || CAPABILITIES.TEXT;
      if (!Object.values(CAPABILITIES).includes(capability)) {
        throw new ModelClientError('未知模型能力', { code: MODEL_ERROR_CODES.INVALID_REQUEST });
      }
      if (request.signal && request.signal.aborted) {
        throw new ModelClientError('模型请求已取消', { code: 'MODEL_CANCELED' });
      }
      const startedAt = Date.now();
      // 明确白名单：领域 input（完整草稿、数据库字段等）不能越过模型边界。
      const response = await client.generate({
        messages: request.messages,
        outputSchema: request.outputSchema,
        capability,
        routingReason: request.routingReason,
        signal: request.signal,
        onActivity: request.onActivity,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        thinking: request.thinking,
        reasoningEffort: request.reasoningEffort,
      });
      return {
        ...response,
        gateway_metrics: {
          duration_ms: Date.now() - startedAt,
          input_characters: JSON.stringify(request.messages).length,
          message_count: request.messages.length,
          capability,
          reasoning_effort: request.reasoningEffort ?? (request.thinking === true ? 'high' : 'none'),
          stage: request.routingReason || null,
        },
      };
    },
  };
}

module.exports = { createModelGateway };
