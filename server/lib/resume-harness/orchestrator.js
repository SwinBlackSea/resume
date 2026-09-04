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
    '上一次返回的 JSON 无法形成合法的目标简历，请依据同一份工作区和用户请求重新返回完整 JSON。',
    `校验问题：${errors.join('；')}`,
    '输出只能采用两种协议：有疑问或仍需沟通时返回 {"type":"message","content":"自然语言回复","awaiting_user":true,"quick_replies":[]}；已经完成修改时返回 {"type":"proposal","content":"结果说明","proposal":{...}}。',
    '不要改变用户意图，不要补造事实。每个简历修改必须包含 change_constraints，准确区分是否允许修改内容、结构和样式；只调整结构时 content 必须为 preserve。',
    '简历修改必须返回完整 target_resume_document，表示修改完成后应得到的 ResumeDocument。保留所有未修改节点的稳定 ID；新增节点使用新的唯一 ID；不得返回 DOM operations。',
    '一个 editable 节点只能对应一个 AI 编辑单元，内部不得再包含 editable 子孙节点；禁止 data-ai-scope。合并或拆分编辑单元时直接在目标文档中表达最终节点结构。',
    '如果确实缺少会改变最终结果的信息，返回 type=message，用自然语言直接询问用户，不要生成 proposal。内部节点编排错误不属于用户歧义。',
    '若用户目标明确，必须自行修复目标文档并返回 type=proposal；不得声称已完成却缺少目标文档。',
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
