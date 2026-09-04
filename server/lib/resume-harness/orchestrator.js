'use strict';

const { buildMessages } = require('./context-builder');
const { normalizeModelOutput } = require('./output-schema');
const { validateExecutableResponse } = require('./executable-validator');
const { PROMPT_VERSION, SCHEMA_VERSION } = require('./prompt');

function harnessError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function repairInstruction(output, errors) {
  const previous = JSON.stringify(output).slice(0, 16000);
  return [
    '上一次返回的 JSON 无法形成可执行动作，请依据同一份工作区和用户请求重新返回完整 JSON。',
    `校验问题：${errors.join('；')}`,
    '不要改变用户意图，不要补造事实。每个简历修改必须包含 change_constraints，准确区分是否允许修改内容、结构和样式；只调整结构时 content 必须为 preserve。',
    '一个 editable 节点只能对应一个 AI 编辑单元，内部不得再包含 editable 子孙节点；禁止 data-ai-scope。合并或拆分编辑单元时优先使用 merge_editable_nodes、split_editable_node，不要让用户决定节点移动顺序或锚点。',
    '所有 DOM 操作必须明确填写 op 和所需节点字段，并使用工作区内真实节点 ID；新增节点使用新的唯一 ID。批量操作按数组顺序执行，后续操作可以引用前序操作已经插入或移动到位的节点。',
    '只有用户目标存在会改变最终结果的真实歧义时，才返回 result_type=CLARIFICATION_REQUIRED、actions: [] 和 clarification.question；复杂但明确的请求可返回 PLAN_CONFIRMATION_REQUIRED 和 2—5 条极简步骤；不得用追问或理解确认掩盖节点、锚点、顺序等内部执行错误。',
    '若用户目标明确，必须自行修复技术操作并返回 result_type=PROPOSAL；reply 不得再声称不存在的修改可以确认。',
    `上一次输出仅供修正：${previous}`,
  ].join('\n');
}

async function runResumeHarness({ input, modelClient, signal, onActivity }) {
  if (!modelClient || typeof modelClient.generate !== 'function') {
    throw new Error('Resume Harness 未配置模型客户端');
  }
  const messages = buildMessages(input);
  let result = await modelClient.generate({
    input,
    messages,
    signal,
    onActivity,
  });
  let response = normalizeModelOutput(result.output, input.scope);
  let executableErrors = validateExecutableResponse(response, input);
  let repairCount = 0;
  if (executableErrors.length) {
    repairCount = 1;
    const repairedMessages = messages.concat([
      { role: 'assistant', content: JSON.stringify(result.output) },
      { role: 'user', content: repairInstruction(result.output, executableErrors) },
    ]);
    result = await modelClient.generate({
      input,
      messages: repairedMessages,
      signal,
      onActivity,
    });
    response = normalizeModelOutput(result.output, input.scope);
    executableErrors = validateExecutableResponse(response, input);
    if (executableErrors.length) {
      throw harnessError(
        'PROPOSAL_NOT_EXECUTABLE',
        `模型没有生成可执行动作：${executableErrors.join('；')}`,
        { validation_errors: executableErrors },
      );
    }
  }
  return {
    response,
    provider: result.provider || modelClient.provider || 'unknown',
    model: result.model || modelClient.model || 'unknown',
    prompt_version: PROMPT_VERSION,
    schema_version: SCHEMA_VERSION,
    usage: result.usage || null,
    reasoning_length: result.reasoning_length || 0,
    repair_count: repairCount,
  };
}

module.exports = { runResumeHarness, harnessError };
