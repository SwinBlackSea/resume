'use strict';

const { createDeepSeekClient } = require('../deepseek-client');
const { buildHarnessInput, buildMessages } = require('./context-builder');
const { buildConversationMemory, selectRecentMessages } = require('./memory-manager');
const { runResumeHarness } = require('./orchestrator');
const { PROMPT_VERSION, SCHEMA_VERSION, SYSTEM_PROMPT } = require('./prompt');

let testModelClient = null;

function resolveModelClient() {
  if (testModelClient) return testModelClient;
  const provider = String(process.env.RESUME_LLM_PROVIDER || '').toLowerCase();
  if (provider === 'deepseek') return createDeepSeekClient();
  throw new Error('未配置可用模型，请设置 RESUME_LLM_PROVIDER=deepseek');
}

async function complete(input, options = {}) {
  return runResumeHarness({
    input,
    modelClient: options.modelClient || resolveModelClient(),
    signal: options.signal,
    onActivity: options.onActivity,
  });
}

function setModelClientForTests(client) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('测试模型只能在 NODE_ENV=test 时注入');
  }
  const previous = testModelClient;
  testModelClient = client;
  return () => {
    testModelClient = previous;
  };
}

module.exports = {
  complete,
  buildHarnessInput,
  buildMessages,
  buildConversationMemory,
  selectRecentMessages,
  setModelClientForTests,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  SYSTEM_PROMPT,
};
