'use strict';

const { buildMessages } = require('./context-builder');
const { normalizeModelOutput } = require('./output-schema');
const { validateExecutableResponse } = require('./executable-validator');
const { PROMPT_VERSION, SCHEMA_VERSION } = require('./prompt');
const { calculateOutputBudget } = require('./output-budget');
const { isRetryableProtocolError } = require('./protocol-recovery');
const {
  FLOW_CONFIRMATION_REQUIRED,
  onlyFlowConfirmationErrors,
  fallbackPlanMessage,
} = require('./flow-policy');

function harnessError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function repairInstruction(output, errors) {
  const previous = JSON.stringify(output).slice(0, 16000);
  const needsPlanConfirmation = errors.some((error) =>
    String(error || '').startsWith(`${FLOW_CONFIRMATION_REQUIRED}:`));
  return [
    needsPlanConfirmation
      ? '上一次直接生成了同时修改文字和结构的最终建议；本轮必须先确认处理思路。'
      : '上一次返回的 JSON 无法形成合法的目标简历，请依据同一份工作区和用户请求重新返回完整 JSON。',
    `校验问题：${errors.join('；')}`,
    ...(needsPlanConfirmation
      ? [
          '请返回 type=message，用 2—4 条简洁自然语言说明将如何结合整份简历处理、会修改哪些方面以及默认影响范围。',
          '设置 awaiting_user=true，并提供“按这个思路修改”“调整要求”两个 quick_replies；本次不得返回 proposal 或 actions。',
        ]
      : []),
    '输出只能采用两种协议：有疑问或仍需沟通时返回 {"type":"message","content":"自然语言回复","awaiting_user":true,"quick_replies":[]}；已经完成修改时返回 {"type":"proposal","content":"结果说明","proposal":{...}}。',
    '不要改变用户意图，不要补造事实。每个简历修改必须包含 change_constraints，准确区分是否允许修改内容、结构和样式。',
    '只有最终完整保留全部原文字的合并、拆分、移动或容器调整才使用 content=preserve。删除任何包含文字的节点、段落或模块都会删除内容，必须使用 content=modify。',
    '简历修改优先返回 resume-target-fragments-v2；后端会重建完整 ResumeDocument。只有文档元数据或整份重构才返回 target_resume_document。不得返回 DOM operations。',
    '工作区文档是 resume-ai-context-v1 精简语义树；children 是真实父子关系，省略的坐标、CSS 和资源仍由后端持有。',
    '现有节点的 replacement_subtree 可以只返回实际改变字段；省略字段由后端继承。仅改文字只返回目标 id 和新 text，不要复制整棵展示子树。',
    '修改或删除已有节点使用 changes：replacement_subtree=null 表示删除，替换子树必须沿用 target_id，变化区域不得嵌套。',
    '新增同级或子级节点使用 insertions：填写现有 parent_id、现有直接子节点 after_id（插入开头时为 null）和仅包含新内容的 new_subtrees。不要为了新增节点重复返回整个父节点。',
    '一个 editable 节点只能对应一个 AI 编辑单元，内部不得再包含 editable 子孙节点；禁止 data-ai-scope。合并或拆分编辑单元时直接在目标文档中表达最终节点结构。',
    '如果确实缺少会改变最终结果的信息，返回 type=message，用自然语言直接询问用户，不要生成 proposal。内部节点编排错误不属于用户歧义。',
    '若用户目标明确，必须自行修复目标文档并返回 type=proposal；不得声称已完成却缺少目标文档。',
    `上一次输出仅供修正：${previous}`,
  ].join('\n');
}

function protocolRetryInstruction(error, previousOutput) {
  const truncated = error && error.code === 'DEEPSEEK_OUTPUT_TRUNCATED';
  const invalidShape = error && error.code === 'MODEL_OUTPUT_SCHEMA_INVALID';
  const previous = previousOutput && typeof previousOutput === 'object'
    ? JSON.stringify(previousOutput).slice(0, 16000)
    : '';
  return [
    truncated
      ? '上一次输出达到长度上限，没有形成完整 JSON。'
      : invalidShape
        ? `上一次输出虽然是 JSON，但不符合返回协议：${error.message}`
        : '上一次输出没有形成可解析的 JSON。',
    '请重新返回一个完整 JSON 对象，不输出 Markdown 或额外说明。',
    '简历修改优先在 proposal.target_resume_fragments 中使用 resume-target-fragments-v2，只返回实际变化的最小内容；不要重复输出整份未变化文档。',
    '现有节点的 replacement_subtree 可以省略未变化字段，后端会从基准文档继承；不要复制坐标、CSS、背景或未变化的富文本 run。',
    '删除现有节点时使用 replacement_subtree:null；替换时 replacement_subtree 的根 ID 必须与 target_id 相同。',
    '新增节点时使用 insertions，只返回 parent_id、after_id 和 new_subtrees；parent_id 与非空 after_id 必须是当前文档中的现有直接父子节点。',
    '只有修改 page_setup、styles、assets、annotations，或确实无法用非重叠目标子树表达时，才返回 target_resume_document。',
    ...(previous ? [`上一次 JSON 仅供修正：${previous}`] : []),
  ].join('\n');
}

function normalizeResult(result, input) {
  try {
    return normalizeModelOutput(result.output, input.scope);
  } catch (error) {
    if (error && typeof error === 'object') {
      error.finish_reason = result.finish_reason || null;
      error.content_length = JSON.stringify(result.output || {}).length;
      error.reasoning_length = result.reasoning_length || 0;
      error.max_tokens = result.max_tokens || null;
    }
    throw error;
  }
}

async function runResumeHarness({ input, modelClient, signal, onActivity }) {
  if (!modelClient || typeof modelClient.generate !== 'function') {
    throw new Error('Resume Harness 未配置模型客户端');
  }
  const messages = buildMessages(input);
  const outputBudget = calculateOutputBudget(input);
  let protocolRetryCount = 0;
  let result;
  let response;
  try {
    result = await modelClient.generate({
      input,
      messages,
      signal,
      onActivity,
      maxTokens: outputBudget.initial,
    });
    response = normalizeResult(result, input);
  } catch (error) {
    if (!isRetryableProtocolError(error)) {
      throw error;
    }
    protocolRetryCount = 1;
    result = await modelClient.generate({
      input,
      messages: messages.concat([{
        role: 'user',
        content: protocolRetryInstruction(error, result && result.output),
      }]),
      signal,
      onActivity,
      maxTokens: outputBudget.retry,
    });
    response = normalizeResult(result, input);
  }
  let executableErrors = validateExecutableResponse(response, input);
  let repairCount = protocolRetryCount;
  if (executableErrors.length) {
    if (protocolRetryCount) {
      if (onlyFlowConfirmationErrors(executableErrors)) {
        response = fallbackPlanMessage(response, input);
        executableErrors = [];
      } else {
        throw harnessError(
          'PROPOSAL_NOT_EXECUTABLE',
          `模型没有生成可执行动作：${executableErrors.join('；')}`,
          { validation_errors: executableErrors },
        );
      }
    }
    if (executableErrors.length) {
      repairCount += 1;
      const repairedMessages = messages.concat([
        { role: 'assistant', content: JSON.stringify(result.output) },
        { role: 'user', content: repairInstruction(result.output, executableErrors) },
      ]);
      result = await modelClient.generate({
        input,
        messages: repairedMessages,
        signal,
        onActivity,
        maxTokens: outputBudget.retry,
      });
      response = normalizeResult(result, input);
      executableErrors = validateExecutableResponse(response, input);
      if (onlyFlowConfirmationErrors(executableErrors)) {
        response = fallbackPlanMessage(response, input);
        executableErrors = [];
      }
      if (executableErrors.length) {
        throw harnessError(
          'PROPOSAL_NOT_EXECUTABLE',
          `模型没有生成可执行动作：${executableErrors.join('；')}`,
          { validation_errors: executableErrors },
        );
      }
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
    output_budget: outputBudget,
    finish_reason: result.finish_reason || null,
  };
}

module.exports = { runResumeHarness, harnessError };
