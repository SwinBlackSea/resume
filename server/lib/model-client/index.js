'use strict';

const {
  createDeepSeekResponsesClient,
  responseInput,
  responsesEndpoint,
  schemaFormat,
} = require('./deepseek');
const { createOpenAIResponsesClient } = require('./openai');
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

function configuredRouting(options = {}) {
  const provider = configuredProvider(options);
  const globalProvider = String(options.globalProvider
    || process.env.RESUME_GLOBAL_MODEL_PROVIDER || provider).toLowerCase();
  const defaults = configuredModels(options);
  const providers = { text: provider, complex: globalProvider, vision: globalProvider };
  const models = Object.fromEntries(Object.entries(providers).map(([capability, selected]) => [
    capability, selected === 'openai'
      ? options.openai?.model || process.env.RESUME_OPENAI_MODEL || 'gpt-5.5'
      : defaults[capability],
  ]));
  return { provider, globalProvider, providers, models };
}

function createModelClient(options = {}) {
  const { provider, globalProvider, providers, models } = configuredRouting(options);
  if (!provider) {
    throw new ModelClientError('未配置模型供应商', {
      code: MODEL_ERROR_CODES.NOT_CONFIGURED,
    });
  }
  if (![provider, globalProvider].every((value) => ['deepseek', 'openai'].includes(value))) {
    throw new ModelClientError(`暂不支持模型供应商：${provider}/${globalProvider}`, {
      code: MODEL_ERROR_CODES.NOT_CONFIGURED,
      provider,
    });
  }
  const shared = {
    ...options,
    provider: undefined,
    textModel: undefined,
    complexModel: undefined,
    visionModel: undefined,
  };
  const clients = Object.fromEntries(Object.entries(providers).map(([capability, selected]) => {
    const timeoutOptions = Object.fromEntries(['firstTokenMs', 'idleMs', 'totalMs'].map((key, index) => [
      key, options.timeouts?.[capability]?.[key] || process.env[
        `RESUME_MODEL_${capability.toUpperCase()}_${['FIRST_TOKEN_MS', 'IDLE_MS', 'TOTAL_MS'][index]}`
      ],
    ]).filter(([, value]) => value !== undefined));
    return [capability, selected === 'openai'
      ? createOpenAIResponsesClient({
        fetchImpl: options.fetchImpl,
        ...options.openai,
        ...timeoutOptions,
        model: models[capability],
      })
      : createDeepSeekResponsesClient({ ...shared, ...timeoutOptions, model: models[capability] })];
  }));

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
    providers,
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
  configuredRouting,
  createModelClient,
  createDeepSeekResponsesClient,
  createOpenAIResponsesClient,
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
