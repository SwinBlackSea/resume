'use strict';

const ResumeDom = require('../../../resume-dom');

const DEFAULT_MIN_OUTPUT_TOKENS = 4096;
const DEFAULT_INITIAL_MAX_OUTPUT_TOKENS = 16384;
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function currentResumeOf(input) {
  return input
    && input.workspace
    && input.workspace.resume
    && (
      input.workspace.resume.proposal_content
      || input.workspace.resume.content
    )
    || {};
}

/**
 * 局部目标子树是默认输出，因此初次预算只随文档复杂度缓慢增长。
 * 若供应商明确截断或未形成 JSON，重试预算按完整文档最坏情况增长，
 * 但始终受部署侧硬上限保护。
 */
function calculateOutputBudget(input, options = {}) {
  const configuredMaximum = positiveInteger(
    options.maximum
      || process.env.RESUME_MODEL_MAX_TOKENS_LIMIT
      || process.env.RESUME_LLM_MAX_TOKENS_LIMIT,
    DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const maximum = configuredMaximum;
  const requestedMinimum = positiveInteger(
    options.minimum
      || process.env.RESUME_MODEL_MIN_OUTPUT_TOKENS
      || process.env.RESUME_LLM_MIN_OUTPUT_TOKENS,
    DEFAULT_MIN_OUTPUT_TOKENS,
  );
  // 部署硬上限永远优先。错误配置不能把一次模型调用放大到限制之外。
  const minimum = Math.min(requestedMinimum, maximum);
  const requestedInitialMaximum = positiveInteger(
    options.initialMaximum
      || process.env.RESUME_MODEL_INITIAL_MAX_TOKENS
      || process.env.RESUME_LLM_INITIAL_MAX_TOKENS,
    DEFAULT_INITIAL_MAX_OUTPUT_TOKENS,
  );
  const initialMaximum = Math.max(
    minimum,
    Math.min(requestedInitialMaximum, maximum),
  );
  const currentResume = currentResumeOf(input);
  const rawDocumentChars = JSON.stringify(currentResume).length;
  const documentChars = JSON.stringify(
    ResumeDom.toAiContextDocument(currentResume),
  ).length;
  const documentScope = input && input.scope && input.scope.type === 'RESUME_DOCUMENT';
  const reasoningAllowance = { none: 0, low: 4096, medium: 8192, high: 16384 }[options.reasoningEffort || 'none'] || 0;
  // 全局可能同时改写所有正文；不能只按树字段的低比例估算，导致首次
  // 正常输出用尽预算、占用唯一恢复机会。预算是上限，不强迫模型输出。
  const fragmentEstimate = 2048
    + Math.ceil(documentChars / (documentScope ? 2 : 12))
    + (documentScope ? 768 : 0)
    + reasoningAllowance;
  const fullDocumentEstimate = 2048 + Math.ceil(documentChars / 2.35);
  const initial = clamp(fragmentEstimate, minimum, initialMaximum);
  const retry = clamp(
    Math.max(initial * 2, fullDocumentEstimate),
    initial,
    maximum,
  );
  return {
    initial,
    retry,
    minimum,
    initial_maximum: initialMaximum,
    maximum,
    configured_minimum: requestedMinimum,
    configured_initial_maximum: requestedInitialMaximum,
    configuration_adjusted:
      requestedMinimum > maximum
      || requestedInitialMaximum > maximum
      || requestedInitialMaximum < minimum,
    document_chars: documentChars,
    raw_document_chars: rawDocumentChars,
    reasoning_allowance: reasoningAllowance,
  };
}

module.exports = {
  DEFAULT_MIN_OUTPUT_TOKENS,
  DEFAULT_INITIAL_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  calculateOutputBudget,
};
