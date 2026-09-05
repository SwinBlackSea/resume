'use strict';

const { createDeepSeekClient } = require('../deepseek-client');
const { buildHarnessInput, buildMessages } = require('./context-builder');
const { buildConversationMemory, selectRecentMessages } = require('./memory-manager');
const { runResumeHarness } = require('./orchestrator');
const {
  runInlineRewriteHarness,
  INLINE_PROMPT_VERSION,
  INLINE_SCHEMA_VERSION,
} = require('./inline-rewrite');
const {
  TARGET_FRAGMENTS_FORMAT,
  LEGACY_TARGET_FRAGMENTS_FORMAT,
  materializeTargetFragments,
} = require('./target-fragments');
const { calculateOutputBudget } = require('./output-budget');
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

async function completeInlineRewrite(input, options = {}) {
  return runInlineRewriteHarness({
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
  completeInlineRewrite,
  buildHarnessInput,
  buildMessages,
  buildConversationMemory,
  selectRecentMessages,
  setModelClientForTests,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  SYSTEM_PROMPT,
  INLINE_PROMPT_VERSION,
  INLINE_SCHEMA_VERSION,
  TARGET_FRAGMENTS_FORMAT,
  LEGACY_TARGET_FRAGMENTS_FORMAT,
  materializeTargetFragments,
  calculateOutputBudget,
};
