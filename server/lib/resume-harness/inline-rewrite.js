'use strict';

const ResumeDom = require('../../../resume-dom');
const { prepareConversationMemory } = require('./memory-manager');
const {
  protocolError,
  isRetryableProtocolError,
} = require('./protocol-recovery');
const { CAPABILITIES } = require('../model-client');
const { INLINE_RESPONSE_SCHEMA } = require('./output-json-schema');
const {
  MODEL_CONVERSATION_PROTOCOL,
  buildConversationMessages,
  buildRetryMessages,
} = require('./conversation-protocol');

const INLINE_PROMPT_VERSION = 'resume-inline-rewrite-v8-task-memory';
const INLINE_SCHEMA_VERSION = 'resume-inline-text-v1';
const INLINE_TURN_PROTOCOL = 'resume-inline-turn-v1';

const INLINE_SYSTEM_PROMPT = [
  '你是简历中的“就地改写”助手。用户正在当前简历原文旁边进行一次轻量文字修改。',
  '只读上下文只提供简历全文、资料、岗位和当前锁定文字的纯文本语境，不包含可操作的文档结构。',
  '历史按正常 user/assistant 对话提供，内容必须按原意理解，不要把自然语言要求改写成关键词规则。',
  '若有 conversation_summary，它只是早期对话记忆；保留仍有效的用户要求，后续用户原话优先，不把未确认的助手建议当成要求。',
  `最后一条 user 消息是 ${INLINE_TURN_PROTOCOL} JSON：instruction 是必须完整执行的用户原话，editing_text 是本轮唯一直接编辑对象。每轮只聚焦这两个字段；历史和只读上下文仅用于理解语境。`,
  '你只能返回锁定文字的新版本，绝不能修改其他位置、增删模块、调整段落数量或改变样式。',
  'mode=node 时，suggestion 必须是整个锁定编辑单元的新文字；如果原文包含多个段落，必须保持完全相同的段落数量和顺序。',
  'mode=selection 时，suggestion 只能是所选文字的替换内容，不得返回整个段落。',
  '用户最终通过差异预览决定是否应用。你不负责判断内容真假，也不需要核对数字、组织、经历或成果是否已在上下文出现。',
  '用户要求增加数据支撑、量化成果或补充经历时，即使没有提供具体内容，也直接发挥润色与补写能力生成可应用建议，不要因此追问或拒绝。',
  '适合就地处理的请求包括精简、润色、改语气、突出已有成果和结合岗位调整表达。',
  '如果用户要求新增或删除节点、移动内容、跨区域联动、保存资料或修改其他位置，不要勉强生成文字。返回 message，简短说明这项操作需要到右侧 AI 对话中处理。',
  '只输出一个 JSON 对象，不输出 Markdown。',
  '可执行结果：type=proposal，content 填一句结果说明，suggestion 填替换文字，summary 填不超过30字的变化说明，handoff=null。',
  '不能在当前文字内完成：type=message，content 填简短说明，handoff=true，suggestion=null，summary=null。',
].join('\n');

function normalizeLineBreaks(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n');
}

function paragraphCount(value) {
  return normalizeLineBreaks(value).split('\n').length;
}

function countTextCharacters(value) {
  return Array.from(normalizeLineBreaks(value)).length;
}

function normalizeDigits(value) {
  return String(value == null ? '' : value).replace(/[０-９]/g, (digit) =>
    String(digit.charCodeAt(0) - 0xFF10));
}

function parsedLimit(match) {
  if (!match) return null;
  const candidates = match.slice(1)
    .filter((value) => value !== undefined)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 20000);
  return candidates.length ? Math.max(...candidates) : null;
}

function parseExplicitMaxCharacters(instruction) {
  const text = normalizeDigits(instruction).trim();
  if (!text) return null;
  const patterns = [
    /(?:控制|限制|压缩|精简|缩短|缩小|缩减|改|写|降|减)(?:到|至|为|在|成)\s*(\d{1,5})(?:\s*[-—~～至到]\s*(\d{1,5}))?\s*(?:个)?字(?:符)?(?:以内|以下|之内|内)?/,
    /字数\s*(?:控制|限制)?(?:到|至|为|在|成)?\s*(\d{1,5})(?:\s*[-—~～至到]\s*(\d{1,5}))?\s*(?:个)?字?(?:符)?(?:以内|以下|之内|内)/,
    /(?:不超过|不可超过|不能超过|至多|最多)\s*(\d{1,5})\s*(?:个)?字(?:符)?/,
    /(\d{1,5})(?:\s*[-—~～至到]\s*(\d{1,5}))?\s*(?:个)?字(?:符)?(?:以内|以下|之内|内)/,
    /^(\d{1,5})\s*(?:个)?字(?:符)?(?:[，,。；;！？!?\s]|$)/,
  ];
  for (const pattern of patterns) {
    const limit = parsedLimit(text.match(pattern));
    if (limit !== null) return limit;
  }
  return null;
}

function inlineOutputSchemaError(message, details = {}) {
  return protocolError('INLINE_OUTPUT_SCHEMA_INVALID', message, details);
}

function assertInlineEnvelope(raw) {
  const keys = Object.keys(raw).sort().join(',');
  if (keys !== 'content,handoff,suggestion,summary,type') {
    throw inlineOutputSchemaError('模型严格输出外壳字段不完整或包含额外字段');
  }
  const type = String(raw.type || '').trim().toLowerCase();
  if (
    !['message', 'proposal'].includes(type)
    || typeof raw.content !== 'string'
    || !raw.content.trim()
  ) {
    throw inlineOutputSchemaError('模型严格输出外壳字段类型无效');
  }
  if (
    type === 'message'
    && !(
      raw.handoff === true
      && raw.suggestion === null
      && raw.summary === null
    )
  ) {
    throw inlineOutputSchemaError('局部 message 的严格外壳状态无效');
  }
  if (
    type === 'proposal'
    && !(
      raw.handoff === null
      && typeof raw.suggestion === 'string'
      && typeof raw.summary === 'string'
    )
  ) {
    throw inlineOutputSchemaError('局部 proposal 的严格外壳状态无效');
  }
}

function normalizeInlineOutput(raw, input, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw inlineOutputSchemaError('模型输出不是 JSON 对象');
  }
  if (options.requireEnvelope) assertInlineEnvelope(raw);
  const type = String(raw.type || '').trim().toLowerCase();
  if (!['message', 'proposal'].includes(type)) {
    throw inlineOutputSchemaError('模型输出 type 必须是 message 或 proposal');
  }
  const content = String(raw.content || raw.reply || '').trim();
  if (!content) throw inlineOutputSchemaError('模型输出缺少 content');
  if (type === 'message') {
    return {
      type,
      content,
      handoff: raw.handoff !== false,
    };
  }
  if (!Object.hasOwn(raw, 'suggestion')) {
    throw inlineOutputSchemaError('局部修改缺少 suggestion');
  }
  const suggestion = normalizeLineBreaks(raw.suggestion);
  const source = normalizeLineBreaks(input.target.source_text);
  if (input.target.mode === 'node' && paragraphCount(source) !== paragraphCount(suggestion)) {
    throw inlineOutputSchemaError('局部修改改变了段落数量', {
      expected_paragraphs: paragraphCount(source),
      received_paragraphs: paragraphCount(suggestion),
    });
  }
  return {
    type,
    content,
    suggestion,
    summary: String(raw.summary || content).trim().slice(0, 60),
  };
}

function validateInlineOutput(response, input) {
  if (response.type !== 'proposal') return [];
  const errors = [];
  const suggestionLength = countTextCharacters(response.suggestion);
  if (suggestionLength > 20000) errors.push('修改结果过长');
  const maximum = parseExplicitMaxCharacters(
    input && input.request && input.request.instruction,
  );
  if (maximum !== null && suggestionLength > maximum) {
    errors.push(`用户明确要求不超过${maximum}字，当前结果为${suggestionLength}字`);
  }
  const source = normalizeLineBreaks(input && input.target && input.target.source_text);
  if (response.suggestion === source) {
    errors.push('修改结果与当前文字完全相同');
  }
  return errors;
}

function compactTextLines(lines) {
  const output = [];
  for (const value of lines || []) {
    const text = normalizeLineBreaks(value).trim();
    if (!text || output[output.length - 1] === text) continue;
    output.push(text);
  }
  return output.join('\n');
}

function objectTextLines(value, prefix = '', lines = []) {
  if (value === null || value === undefined || value === '') return lines;
  if (Array.isArray(value)) {
    value.forEach((item) => objectTextLines(item, prefix, lines));
    return lines;
  }
  if (typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      objectTextLines(item, prefix ? `${prefix}.${key}` : key, lines));
    return lines;
  }
  const text = String(value).trim();
  if (text) lines.push(prefix ? `${prefix}：${text}` : text);
  return lines;
}

function resumeTextForModel(documentValue) {
  if (!documentValue || typeof documentValue !== 'object') {
    return normalizeLineBreaks(documentValue);
  }
  const rendered = ResumeDom.toRenderBlocks(documentValue);
  const lines = [];
  if (rendered.header) {
    lines.push(rendered.header.title, rendered.header.subtitle);
  }
  for (const block of rendered.blocks || []) {
    if (block.type === 'table') {
      for (const row of block.rows || []) {
        lines.push((row.cells || []).map((cell) => cell.text).filter(Boolean).join(' | '));
      }
    } else {
      lines.push(block.text);
    }
  }
  return compactTextLines(lines);
}

function profileTextForModel(profileValue) {
  const profile = profileValue && typeof profileValue === 'object' ? profileValue : {};
  const basics = objectTextLines(profile.basics);
  const experiences = (profile.experiences || []).map((item) =>
    [
      item && item.organization,
      item && item.title,
      item && item.start_date,
      item && (item.is_current ? '至今' : item.end_date),
      item && item.description,
    ].filter(Boolean).join(' · '));
  return compactTextLines([...basics, profile.summary, ...experiences]);
}

function jobTextForModel(jobValue) {
  const job = jobValue && typeof jobValue === 'object' ? jobValue : {};
  return compactTextLines([
    [job.title, job.company].filter(Boolean).join(' · '),
    job.confirmed_text,
    ...objectTextLines(job.analysis),
  ]);
}

function buildInlineMessages(input) {
  const workspace = input.workspace && typeof input.workspace === 'object'
    ? input.workspace
    : {};
  const resume = workspace.resume || {};
  const history = input.conversation && Array.isArray(input.conversation.turns)
    ? input.conversation.turns
    : [];
  const context = {
    protocol: MODEL_CONVERSATION_PROTOCOL,
    resume_text: resumeTextForModel(resume.content),
    profile_text: profileTextForModel(workspace.profile),
    target_job_text: jobTextForModel(workspace.target_job),
    target: {
      label: input.target.label || '',
    },
    ...(input.conversation && input.conversation.summary
      ? { conversation_summary: input.conversation.summary }
      : {}),
  };
  const currentTurn = {
    protocol: INLINE_TURN_PROTOCOL,
    mode: input.target.mode,
    paragraph_count: input.target.paragraph_count,
    editing_text: input.target.source_text,
    instruction: String(input.request && input.request.instruction || ''),
  };
  return buildConversationMessages({
    systemPrompt: INLINE_SYSTEM_PROMPT,
    mode: 'inline_text',
    context,
    history,
    userText: JSON.stringify(currentTurn),
  });
}

function repairInstruction(errors, input) {
  return [
    '刚才的生成结果没有通过局部文字校验，请重新执行上一条用户要求。',
    `问题：${errors.join('；')}`,
    `锁定模式：${input.target.mode}`,
    ...(input.request && input.request.adjustment
      ? [
          '这是连续调整，最近一条历史 assistant 消息是直接编辑对象，不能退回当前草稿原文。',
          '新的 suggestion 必须真正执行最近一条 user 要求，不得再次原样返回。',
        ]
      : []),
    '只能修改锁定文字，不得调整任何节点或其他位置。',
    '如果不能在当前文字范围内完成，返回 type=message 并设置 handoff=true。',
  ].join('\n');
}

function protocolRepairInstruction(error, input) {
  return [
    error && error.code === 'MODEL_OUTPUT_TRUNCATED'
      ? '上一次局部结果达到长度上限，没有形成完整 JSON。'
      : `上一次局部结果不符合返回协议：${error && error.message || '格式无效'}`,
    '请重新返回一个完整 JSON 对象，不输出 Markdown 或额外说明。',
    '可执行结果必须包含 type、content、suggestion；不能局部完成时返回 type=message、content 和 handoff=true。',
    `锁定模式：${input.target.mode}。只能修改锁定文字，不得调整节点、段落数量、样式或其他位置。`,
    ...(input.request && input.request.adjustment
      ? ['继续调整的直接输入是最近一条历史 assistant 消息。']
      : []),
  ].join('\n');
}

function inlineOutputBudget(input) {
  const sourceLength = normalizeLineBreaks(
    input && input.target && input.target.source_text,
  ).length;
  const initial = Math.max(4096, Math.min(8192, sourceLength * 2 + 768));
  const retry = Math.max(8192, Math.min(16384, sourceLength * 3 + 1536));
  return { initial, retry };
}

function inlineAttemptDiagnostic(attempt, result, response, errors, input) {
  const raw = result && result.output && typeof result.output === 'object'
    ? result.output
    : {};
  const suggestion = response && response.type === 'proposal'
    ? response.suggestion
    : (Object.hasOwn(raw, 'suggestion') ? normalizeLineBreaks(raw.suggestion) : null);
  const source = normalizeLineBreaks(input && input.target && input.target.source_text);
  return {
    attempt,
    response_type: response && response.type || String(raw.type || '') || null,
    suggestion_characters: suggestion === null ? null : countTextCharacters(suggestion),
    source_characters: countTextCharacters(source),
    unchanged: suggestion === null ? null : suggestion === source,
    validation_errors: Array.isArray(errors) ? errors.slice(0, 10) : [],
    finish_reason: result && result.finish_reason || null,
  };
}

async function runInlineRewriteHarness({ input, modelClient, signal, onActivity, onMemory }) {
  if (!modelClient || typeof modelClient.generate !== 'function') {
    throw new Error('局部 AI 未配置模型客户端');
  }
  const conversation = input.conversation || {};
  const memory = await prepareConversationMemory({
    messages: conversation.turns || [],
    cache: conversation.cache,
    scopeKey: `inline:${conversation.task_key || ''}`,
    modelClient, signal, onActivity, onMemory,
  });
  input = {
    ...input,
    conversation: { ...conversation, turns: memory.recent_messages, summary: memory.summary },
  };
  const messages = buildInlineMessages(input);
  const outputBudget = inlineOutputBudget(input);
  let result;
  let response;
  let errors = [];
  let repairCount = 0;
  let repairMessages = null;
  const attempts = [];
  try {
    result = await modelClient.generate({
      input,
      messages,
      signal,
      onActivity,
      maxTokens: outputBudget.initial,
      thinking: false,
      outputSchema: INLINE_RESPONSE_SCHEMA,
      capability: CAPABILITIES.TEXT,
      routingReason: 'inline_text_change',
    });
    response = normalizeInlineOutput(result.output, input, {
      requireEnvelope: result.strict_schema === true,
    });
    errors = validateInlineOutput(response, input);
    attempts.push(inlineAttemptDiagnostic(1, result, response, errors, input));
    if (errors.length) {
      repairMessages = buildRetryMessages(messages, repairInstruction(errors, input));
    }
  } catch (error) {
    if (!isRetryableProtocolError(error)) throw error;
    attempts.push(inlineAttemptDiagnostic(1, result, null, [error.message], input));
    repairMessages = buildRetryMessages(messages, protocolRepairInstruction(error, input));
  }

  if (repairMessages) {
    repairCount = 1;
    try {
      result = await modelClient.generate({
        input,
        messages: repairMessages,
        signal,
        onActivity,
        maxTokens: outputBudget.retry,
        thinking: false,
        outputSchema: INLINE_RESPONSE_SCHEMA,
        capability: CAPABILITIES.COMPLEX,
        routingReason: 'inline_protocol_or_validation_recovery',
      });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.repair_count = repairCount;
        error.output_budget = outputBudget;
        error.attempts = attempts;
      }
      throw error;
    }
    response = normalizeInlineOutput(result.output, input, {
      requireEnvelope: result.strict_schema === true,
    });
    errors = validateInlineOutput(response, input);
    attempts.push(inlineAttemptDiagnostic(2, result, response, errors, input));
    if (errors.length) {
      const error = new Error(`模型没有生成可用的局部文字：${errors.join('；')}`);
      error.code = 'INLINE_REWRITE_INVALID';
      error.validation_errors = errors;
      error.repair_count = repairCount;
      error.output_budget = outputBudget;
      error.attempts = attempts;
      throw error;
    }
  }
  return {
    response,
    provider: result.provider || modelClient.provider || 'unknown',
    model: result.model || modelClient.model || 'unknown',
    prompt_version: INLINE_PROMPT_VERSION,
    schema_version: INLINE_SCHEMA_VERSION,
    usage: result.usage || null,
    gateway_metrics: result.gateway_metrics || null,
    repair_count: repairCount,
    output_budget: outputBudget,
    attempts,
    finish_reason: result.finish_reason || null,
    model_route: result.capability || CAPABILITIES.TEXT,
    routing_reason: result.routing_reason || 'inline_text_change',
  };
}

module.exports = {
  INLINE_PROMPT_VERSION,
  INLINE_SCHEMA_VERSION,
  INLINE_TURN_PROTOCOL,
  INLINE_SYSTEM_PROMPT,
  assertInlineEnvelope,
  buildInlineMessages,
  resumeTextForModel,
  profileTextForModel,
  jobTextForModel,
  normalizeInlineOutput,
  validateInlineOutput,
  countTextCharacters,
  parseExplicitMaxCharacters,
  inlineAttemptDiagnostic,
  inlineOutputBudget,
  runInlineRewriteHarness,
};
