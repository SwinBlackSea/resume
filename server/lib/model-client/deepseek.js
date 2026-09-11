'use strict';

const { createResponsesClient, responseInput, schemaFormat } = require('./responses-client');

function responsesEndpoint(options = {}) {
  const configured = options.endpoint || process.env.RESUME_MODEL_ENDPOINT;
  if (configured) return configured;
  const legacy = process.env.RESUME_LLM_ENDPOINT;
  if (!legacy) return 'https://api.deepseek.com/responses';
  try {
    const url = new URL(legacy);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '/responses');
    if (!url.pathname.endsWith('/responses')) url.pathname = '/responses';
    url.search = '';
    return url.toString();
  } catch (_) {
    return 'https://api.deepseek.com/responses';
  }
}

function createDeepSeekResponsesClient(options = {}) {
  return createResponsesClient({
    ...options,
    provider: 'deepseek',
    endpoint: responsesEndpoint(options),
    apiKey: options.apiKey || process.env.RESUME_MODEL_API_KEY || process.env.RESUME_LLM_API_KEY,
    model: options.model || 'deepseek-v4-flash',
    includeTemperature: true,
  });
}

module.exports = { createDeepSeekResponsesClient, responsesEndpoint, responseInput, schemaFormat };
