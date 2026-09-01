'use strict';

const { buildMessages } = require('./context-builder');
const { normalizeModelOutput } = require('./output-schema');
const { PROMPT_VERSION, SCHEMA_VERSION } = require('./prompt');

async function runResumeHarness({ input, modelClient, signal, onActivity }) {
  if (!modelClient || typeof modelClient.generate !== 'function') {
    throw new Error('Resume Harness 未配置模型客户端');
  }
  const messages = buildMessages(input);
  const result = await modelClient.generate({
    input,
    messages,
    signal,
    onActivity,
  });
  const response = normalizeModelOutput(result.output, input.scope);
  return {
    response,
    provider: result.provider || modelClient.provider || 'unknown',
    model: result.model || modelClient.model || 'unknown',
    prompt_version: PROMPT_VERSION,
    schema_version: SCHEMA_VERSION,
    usage: result.usage || null,
    reasoning_length: result.reasoning_length || 0,
  };
}

module.exports = { runResumeHarness };
