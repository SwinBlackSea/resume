'use strict';

const { buildMessages } = require('./context-builder');
const { prepareConversationMemory } = require('./memory-manager');
const { buildRetryMessages } = require('./conversation-protocol');
const { normalizeModelOutput } = require('./output-schema');
const { validateExecutableResponse } = require('./executable-validator');
const { PROMPT_VERSION, SCHEMA_VERSION } = require('./prompt');
const { calculateOutputBudget } = require('./output-budget');
const { isRetryableProtocolError } = require('./protocol-recovery');
const { GLOBAL_RESPONSE_SCHEMA } = require('./output-json-schema');
const { routeResumeRequest, repairCapability } = require('./model-routing');
const { decodeGlobalStructuredOutput } = require('./structured-envelope');
const { buildFragmentRecovery, recoveryContext, restoreIndependentFragments } = require('./fragment-recovery');
const { buildActionRecovery, actionRecoveryInstruction, restoreIndependentActions } = require('./action-recovery');
const { materializeImages } = require('./image-materializer');

function harnessError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function repairInstruction(output, errors, input, routing, diagnostics, recovery) {
  const previous = JSON.stringify(output);
  return [
    '上一次返回的 JSON 无法形成合法的目标简历，请依据同一份工作区和用户请求重新返回完整 JSON。',
    `校验问题：${errors.join('；')}`,
    `结构诊断：${JSON.stringify(diagnostics)}`,
    '使用当前严格 v3 Schema：type、content、awaiting_user、message_kind、quick_replies、resume_proposal、data_actions。message 时resume_proposal=null且data_actions=[]。',
    'proposal时resume_proposal直接包含asset_requests、changes、insertions、target_document_json、change_constraints；无插图时asset_requests=[]，需要插图时使用输入图片input_image_id、目标img节点target_node_id、purpose、crop（null或归一化矩形）。changes使用target_id和replacement_json，insertions使用parent_id、after_id和new_nodes_json。节点分别序列化为JSON字符串，禁止把整个proposal塞进payload_json。',
    'data_actions使用结构化对象：岗位{type:"JOB_SET_CURRENT_PROPOSAL",target_id:null,payload:{title,company,confirmed_text}}；资料{type:"PROFILE_SAVE_PROPOSAL",target_id:null,payload:{field,value}}。confirmed_text必须是非空完整岗位描述，不使用payload_json。',
    '不要改变用户意图，不新增用户未提供的事实。每个简历修改必须包含change_constraints，准确区分是否允许修改内容、结构和样式；删除任何节点都属于structure=modify，哪怕视觉上只是删除一段文字。',
    '只有最终完整保留全部原文字的合并、拆分、移动或容器调整才使用 content=preserve。删除任何包含文字的节点、段落或模块都会删除内容，必须使用 content=modify。',
    '后端将changes/insertions转换为resume-target-fragments-v2并重建ResumeDocument。只有文档元数据或整份重构才使用target_document_json（内部target_resume_document）。不得返回DOM operations。',
    '工作区文档是 resume-ai-context-v3，包含全文、真实 children、行内格式、style/attributes 和页面设置；资源只传描述，字节由后端持有。',
    'replacement_json内部只包含实际改变字段，省略字段由后端继承。仅改文字返回id和text，不复制展示子树；每个editable节点就是完整编辑单元，不必拆其内部格式run。',
    '删除使用replacement_json=null，替换节点沿用target_id，变化区域不得嵌套。',
    '新增使用insertions，填写现有parent_id、现有直接子节点after_id（开头为null），new_nodes_json只包含新节点。不要为新增重复整个父节点。',
    '一个 editable 节点只能对应一个 AI 编辑单元，内部不得再包含 editable 子孙节点；禁止 data-ai-scope。合并或拆分编辑单元时直接在目标文档中表达最终节点结构。',
    '如果确实缺少会改变最终结果的信息，返回 type=message，用自然语言直接询问用户，不要生成 proposal。内部节点编排错误不属于用户歧义。',
    '若用户目标明确，必须自行修复目标文档并返回 type=proposal；不得声称已完成却缺少目标文档。',
    `上一次输出仅供修正（可能已转为内部target_resume_fragments/replacement_subtree形状，返回时须使用上述当前严格Schema）：${previous}`,
    recoveryContext(recovery),
  ].join('\n');
}

function protocolRetryInstruction(error, previousOutput) {
  const truncated = error && error.code === 'MODEL_OUTPUT_TRUNCATED';
  const invalidShape = error && error.code === 'MODEL_OUTPUT_SCHEMA_INVALID';
  const previous = previousOutput && typeof previousOutput === 'object'
    ? JSON.stringify(previousOutput)
    : '';
  return [
    truncated
      ? '上一次输出达到长度上限，没有形成完整 JSON。'
      : invalidShape
        ? `上一次输出虽然是 JSON，但不符合返回协议：${error.message}`
        : '上一次输出没有形成可解析的 JSON。',
    '请重新返回一个符合严格输出外壳的完整 JSON 对象，不输出 Markdown 或额外说明。',
    '当前v3字段为type、content、awaiting_user、message_kind、quick_replies、resume_proposal、data_actions。message时resume_proposal=null、data_actions=[]。',
    'proposal时resume_proposal直接包含asset_requests、changes、insertions、target_document_json、change_constraints，无图片变更asset_requests=[]，禁止把整份proposal序列化到payload_json。',
    'changes只返回实际变化的最小内容：target_id和replacement_json，后者是单个节点JSON字符串或null（删除）。现有节点只需id及变化字段，不复制坐标、CSS、背景、富文本run。',
    'insertions包含parent_id、after_id、new_nodes_json（各个新节点的JSON字符串数组），父节点和非空锚点必须是当前文档的直接父子。',
    '只有page_setup、styles、assets、annotations或整份重构使用target_document_json字符串（内部target_resume_document），其他情况必须为null。',
    'data_actions不使用payload_json：岗位动作payload直接包含title、company、confirmed_text（非空完整岗位描述）；资料动作payload为{field,value}；两者含type和target_id，无需target_type。',
    ...(previous ? [`上一次 JSON 仅供修正：${previous}`] : []),
  ].join('\n');
}

function normalizeResult(result, input) {
  try {
    result.output = decodeGlobalStructuredOutput(result.output, {
      requireEnvelope: result.strict_schema === true,
    });
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

async function runResumeHarness({ input, modelClient, signal, onActivity, onMemory }) {
  if (!modelClient || typeof modelClient.generate !== 'function') {
    throw new Error('Resume Harness 未配置模型客户端');
  }
  const memory = await prepareConversationMemory({
    messages: input.conversation.recent_messages,
    cache: input.conversation.cache,
    options: input.conversation.options,
    scopeKey: `global:${input.request.task && input.request.task.id || ''}`,
    modelClient, signal, onActivity, onMemory,
  });
  input = { ...input, conversation: memory };
  const messages = buildMessages(input);
  const reasoningEffort = process.env.RESUME_GLOBAL_AI_REASONING_EFFORT || 'low';
  if (!['none', 'low', 'medium', 'high'].includes(reasoningEffort)) {
    throw harnessError('MODEL_INVALID_REQUEST', '全局AI推理配置无效');
  }
  const outputBudget = calculateOutputBudget(input, { reasoningEffort });
  const routing = routeResumeRequest(input);
  const recoveryCapability = repairCapability(routing.capability);
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
      reasoningEffort,
      outputSchema: GLOBAL_RESPONSE_SCHEMA,
      capability: routing.capability,
      routingReason: routing.reason,
    });
    response = normalizeResult(result, input);
  } catch (error) {
    if (!isRetryableProtocolError(error)) {
      throw error;
    }
    protocolRetryCount = 1;
    result = await modelClient.generate({
      input,
      messages: buildRetryMessages(messages, protocolRetryInstruction(error, result && result.output)),
      signal,
      onActivity,
      maxTokens: outputBudget.retry,
      reasoningEffort,
      outputSchema: GLOBAL_RESPONSE_SCHEMA,
      capability: recoveryCapability,
      routingReason: `protocol_recovery:${routing.reason}`,
    });
    response = normalizeResult(result, input);
  }
  // Validation materializes B in-place. Retain the compact model payload before
  // that step, otherwise recovery would resend a second, expanded document.
  const originalOutput = JSON.parse(JSON.stringify(result.output));
  const originalResponse = JSON.parse(JSON.stringify(response));
  let diagnostics = [];
  let executableErrors = await materializeImages(response, input, signal, diagnostics);
  if (!executableErrors.length) executableErrors = validateExecutableResponse(response, input, diagnostics);
  let repairCount = protocolRetryCount;
  if (executableErrors.length) {
    if (protocolRetryCount) {
      throw harnessError(
        'PROPOSAL_NOT_EXECUTABLE',
        `模型没有生成可执行动作：${executableErrors.join('；')}`,
        { validation_errors: executableErrors, validation_diagnostics: diagnostics,
          repair_count: protocolRetryCount, finish_reason: result.finish_reason || null },
      );
    }
    if (executableErrors.length) {
      repairCount += 1;
      const actionRecovery = buildActionRecovery(originalResponse, diagnostics);
      const recovery = actionRecovery ? null : buildFragmentRecovery(response, input, diagnostics);
      const repairedMessages = buildRetryMessages(
        messages, actionRecovery ? actionRecoveryInstruction(actionRecovery, diagnostics)
          : repairInstruction(originalOutput, executableErrors, input, routing, diagnostics, recovery),
      );
      result = await modelClient.generate({
        input,
        messages: repairedMessages,
        signal,
        onActivity,
        maxTokens: outputBudget.retry,
        reasoningEffort,
        outputSchema: actionRecovery?.schema || GLOBAL_RESPONSE_SCHEMA,
        capability: recoveryCapability,
        routingReason: `executable_repair:${routing.reason}`,
      });
      response = normalizeResult(result, input);
      diagnostics = [];
      executableErrors = restoreIndependentActions(response, actionRecovery);
      if (!executableErrors.length) executableErrors = restoreIndependentFragments(response, recovery);
      if (!executableErrors.length) {
        executableErrors = await materializeImages(response, input, signal, diagnostics);
        if (!executableErrors.length) executableErrors = validateExecutableResponse(response, input, diagnostics);
      }
      if (executableErrors.length) {
        throw harnessError(
          'PROPOSAL_NOT_EXECUTABLE',
          `模型没有生成可执行动作：${executableErrors.join('；')}`,
          {
            validation_errors: executableErrors,
            validation_diagnostics: diagnostics,
            repair_count: repairCount,
            finish_reason: result.finish_reason || null,
            content_length: JSON.stringify(result.output || {}).length,
            max_tokens: outputBudget.retry,
          },
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
    gateway_metrics: result.gateway_metrics || null,
    reasoning_length: result.reasoning_length || 0,
    repair_count: repairCount,
    output_budget: outputBudget,
    finish_reason: result.finish_reason || null,
    model_route: result.capability || routing.capability,
    routing_reason: result.routing_reason || routing.reason,
    routing_score: routing.score,
  };
}

module.exports = { runResumeHarness, harnessError };
