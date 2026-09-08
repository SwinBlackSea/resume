'use strict';

const {
  createDeepSeekResponsesClient,
  responseInput,
  responsesEndpoint,
  schemaFormat,
} = require('./deepseek');
const {
  MODEL_ERROR_CODES,
  ModelClientError,
  isModelServiceError,
} = require('./errors');
const {
  consumeResponsesStream,
  parseDataLine,
  outputTextFromResponse,
} = require('./responses-sse');
const {
  balancedObjectAt,
  extractJsonObject,
  parseJsonObject,
} = require('./json');

const CAPABILITIES = Object.freeze({
  TEXT: 'text',
  COMPLEX: 'complex',
  VISION: 'vision',
});

function configuredProvider(options = {}) {
  return String(
    options.provider
    || process.env.RESUME_MODEL_PROVIDER
    || process.env.RESUME_LLM_PROVIDER
    || '',
  ).toLowerCase();
}

function configuredModels(options = {}) {
  return {
    text:
      options.textModel
      || process.env.RESUME_MODEL_TEXT_MODEL
      || 'deepseek-v4-flash',
    complex:
      options.complexModel
      || process.env.RESUME_MODEL_COMPLEX_MODEL
      || 'deepseek-v4-pro',
    vision:
      options.visionModel
      || process.env.RESUME_MODEL_VISION_MODEL
      || process.env.RESUME_LLM_MODEL
      || 'deepseek-v4-flash-vision-exp',
  };
}

function createModelClient(options = {}) {
  const provider = configuredProvider(options);
  if (!provider) {
    throw new ModelClientError('未配置模型供应商', {
      code: MODEL_ERROR_CODES.NOT_CONFIGURED,
    });
  }
  if (provider !== 'deepseek') {
    throw new ModelClientError(`暂不支持模型供应商：${provider}`, {
      code: MODEL_ERROR_CODES.NOT_CONFIGURED,
      provider,
    });
  }
  const models = configuredModels(options);
  const shared = {
    ...options,
    provider: undefined,
    textModel: undefined,
    complexModel: undefined,
    visionModel: undefined,
  };
  const clients = {
    [CAPABILITIES.TEXT]: createDeepSeekResponsesClient({
      ...shared,
      model: models.text,
    }),
    [CAPABILITIES.COMPLEX]: createDeepSeekResponsesClient({
      ...shared,
      model: models.complex,
    }),
    [CAPABILITIES.VISION]: createDeepSeekResponsesClient({
      ...shared,
      model: models.vision,
    }),
  };

  async function generate(request = {}) {
    const capability = Object.values(CAPABILITIES).includes(request.capability)
      ? request.capability
      : CAPABILITIES.TEXT;
    const result = await clients[capability].generate(request);
    return {
      ...result,
      capability,
      routing_reason: request.routingReason || null,
    };
  }

  return {
    provider,
    model: models.text,
    models,
    generate,
  };
}

module.exports = {
  CAPABILITIES,
  MODEL_ERROR_CODES,
  ModelClientError,
  isModelServiceError,
  configuredProvider,
  configuredModels,
  createModelClient,
  createDeepSeekResponsesClient,
  responseInput,
  responsesEndpoint,
  schemaFormat,
  consumeResponsesStream,
  parseDataLine,
  outputTextFromResponse,
  balancedObjectAt,
  extractJsonObject,
  parseJsonObject,
};
