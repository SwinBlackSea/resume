'use strict';

const { createResponsesClient } = require('./responses-client');
const { ModelClientError, MODEL_ERROR_CODES } = require('./errors');

function openAIEndpoint(baseUrl = 'https://api.openai.com/v1') {
  let url;
  try { url = new URL(baseUrl); } catch (_) { /* invalid below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ModelClientError('OpenAI base URL 必须是无凭据、无查询参数的 HTTPS 地址', {
      code: MODEL_ERROR_CODES.INVALID_REQUEST, provider: 'openai',
    });
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/responses')) url.pathname += '/responses';
  return url.toString();
}

function createOpenAIResponsesClient(options = {}) {
  return createResponsesClient({
    ...options,
    provider: 'openai',
    endpoint: openAIEndpoint(options.baseUrl || process.env.RESUME_OPENAI_BASE_URL),
    // Never reuse the DeepSeek key, Codex auth.json, or global endpoint.
    apiKey: options.apiKey || process.env.RESUME_OPENAI_API_KEY,
    model: options.model || process.env.RESUME_OPENAI_MODEL || 'gpt-5.5',
    minimumReasoningEffort: options.minimumReasoningEffort
      ?? process.env.RESUME_OPENAI_MIN_REASONING_EFFORT ?? 'none',
    // Sampling options are not portable across reasoning models/proxies.
    includeTemperature: false,
  });
}

module.exports = { createOpenAIResponsesClient, openAIEndpoint };
