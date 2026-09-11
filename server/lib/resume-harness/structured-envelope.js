'use strict';

const { parseJsonObject } = require('../model-client');
const { protocolError } = require('./protocol-recovery');

const ENVELOPE_KEYS = [
  'type',
  'content',
  'awaiting_user',
  'message_kind',
  'quick_replies',
  'payload_json',
];
const V2_KEYS = ENVELOPE_KEYS.filter((key) => key !== 'payload_json')
  .concat(['resume_proposal', 'data_actions']);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', `${label}字段不符合严格协议`);
  }
}

function objectJson(value, label) {
  // Exact JSON, not an embedded example or a guessed substring.
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : null;
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch (_) { /* bounded protocol recovery handles invalid units */ }
  throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', `${label}必须是完整 JSON 对象字符串`);
}

function decodeV2(raw) {
  exactKeys(raw, V2_KEYS, '全局 v2 外壳');
  const { resume_proposal: resume, data_actions: data, ...common } = raw;
  assertGlobalEnvelope({ ...common, payload_json: '' });
  if (!Array.isArray(data) || !['message', 'proposal'].includes(raw.type) || !raw.content.trim()) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '全局 v2 结果状态无效');
  }
  if (raw.type === 'message') {
    if (resume !== null || data.length) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', 'message 不能携带修改动作');
    }
    return { ...common, message_kind: raw.message_kind || undefined };
  }
  if (raw.awaiting_user || raw.message_kind !== null || raw.quick_replies.length) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', 'proposal 不能要求再次确认思路');
  }
  const actions = data.map((action) => {
    if (action && Object.hasOwn(action, 'payload')) {
      exactKeys(action, ['type', 'target_id', 'payload'], '结构化资料动作');
      if (!(action.target_id === null || typeof action.target_id === 'string')) {
        throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '资料动作目标类型无效');
      }
      // Keep semantic payload validation at the action boundary. That lets
      // recovery retain an independent valid resume if a provider violates
      // its strict data-action schema, without trusting any missing fields.
      const payload = action.payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return { type: action.type, target_id: action.target_id, payload: {} };
      }
      if (action.type === 'PROFILE_SAVE_PROPOSAL') {
        return { type: action.type, target_type: 'DATA_PROFILE', target_id: action.target_id,
          payload: { operation: 'update_basics',
            values: typeof payload.field === 'string' ? { [payload.field]: payload.value } : {},
            ...(Object.keys(payload).length !== 2 || !Object.keys(payload).every((key) => ['field', 'value'].includes(key))
              ? { invalid_typed_payload: true } : {}) } };
      }
      if (action.type === 'JOB_SET_CURRENT_PROPOSAL') {
        return { type: action.type, target_type: 'DATA_JOB', target_id: action.target_id,
          payload: { ...payload,
            ...(Object.keys(payload).length !== 3 || !Object.keys(payload).every((key) => ['title', 'company', 'confirmed_text'].includes(key))
              ? { invalid_typed_payload: true } : {}) } };
      }
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '未知的结构化资料动作');
    }
    exactKeys(action, ['type', 'target_type', 'target_id', 'payload_json'], '资料动作');
    if (!['PROFILE_SAVE_PROPOSAL', 'JOB_SET_CURRENT_PROPOSAL'].includes(action.type)
      || ![action.target_type, action.target_id].every((value) => value === null || typeof value === 'string')) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '资料动作类型或目标无效');
    }
    const { payload_json: payload, ...fields } = action;
    return { ...fields, payload: objectJson(payload, '资料动作 payload_json') };
  });
  let proposal;
  if (resume !== null) {
    exactKeys(resume, ['changes', 'insertions', 'target_document_json', 'change_constraints',
      ...(Object.hasOwn(resume, 'asset_requests') ? ['asset_requests'] : [])], '简历建议');
    if (resume.asset_requests !== undefined && !Array.isArray(resume.asset_requests)) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '图片声明必须是数组');
    }
    if (!Array.isArray(resume.changes) || !Array.isArray(resume.insertions)) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '修改列表必须是数组');
    }
    exactKeys(resume.change_constraints,
      ['content', 'structure', 'style', 'content_order', 'allowed_region_ids'], '修改约束');
    const constraints = resume.change_constraints;
    if (!['content', 'structure', 'style'].every((key) => ['preserve', 'modify'].includes(constraints[key]))
      || !['preserve', 'reorder'].includes(constraints.content_order)
      || !Array.isArray(constraints.allowed_region_ids)
      || !constraints.allowed_region_ids.every((id) => typeof id === 'string' && id.trim())) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '修改约束值无效');
    }
    const changes = resume.changes.map((change) => {
      exactKeys(change, ['target_id', 'replacement_json'], '目标片段');
      if (typeof change.target_id !== 'string' || !change.target_id.trim()) {
        throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '目标片段缺少 ID');
      }
      return {
        target_id: change.target_id,
        // JSON-encoded null is the same explicit deletion, not a guessed target
        // or a repaired/truncated node. Other primitive JSON remains invalid.
        replacement_subtree: change.replacement_json === null
          || (typeof change.replacement_json === 'string' && change.replacement_json.trim() === 'null')
          ? null : objectJson(change.replacement_json, `节点 ${change.target_id}`),
      };
    });
    const insertions = resume.insertions.map((insertion) => {
      exactKeys(insertion, ['parent_id', 'after_id', 'new_nodes_json'], '新增片段');
      if (typeof insertion.parent_id !== 'string'
        || !(insertion.after_id === null || typeof insertion.after_id === 'string')
        || !Array.isArray(insertion.new_nodes_json)) {
        throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '新增片段字段类型无效');
      }
      return {
        parent_id: insertion.parent_id, after_id: insertion.after_id,
        new_subtrees: insertion.new_nodes_json.map((node) => objectJson(node, '新增节点')),
      };
    });
    if (resume.target_document_json !== null && (changes.length || insertions.length)) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '完整目标文档不能与片段同时返回');
    }
    proposal = {
      ...(resume.asset_requests?.length ? { asset_requests: resume.asset_requests } : {}),
      change_constraints: resume.change_constraints,
      ...(resume.target_document_json !== null
        ? { target_resume_document: objectJson(resume.target_document_json, '完整目标文档') }
        : { target_resume_fragments: { format: 'resume-target-fragments-v2', changes, insertions } }),
    };
  }
  if (!proposal && !actions.length) throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', 'proposal 缺少修改结果');
  if (proposal && !actions.length) return { type: 'proposal', content: raw.content, proposal };
  if (proposal) actions.push({ type: 'RESUME_REWRITE_PROPOSAL', payload: { proposal } });
  return { type: 'proposal', content: raw.content, actions };
}

function assertGlobalEnvelope(raw) {
  const keys = Object.keys(raw).sort();
  const expected = ENVELOPE_KEYS.slice().sort();
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
  ) {
    throw protocolError(
      'MODEL_OUTPUT_SCHEMA_INVALID',
      '模型严格输出外壳字段不完整或包含额外字段',
    );
  }
  if (
    typeof raw.type !== 'string'
    || typeof raw.content !== 'string'
    || typeof raw.awaiting_user !== 'boolean'
    || !(raw.message_kind === null || typeof raw.message_kind === 'string')
    || !Array.isArray(raw.quick_replies)
    || raw.quick_replies.length > 3
    || typeof raw.payload_json !== 'string'
  ) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '模型严格输出外壳字段类型无效');
  }
  for (const reply of raw.quick_replies) {
    if (
      !reply
      || typeof reply !== 'object'
      || Array.isArray(reply)
      || Object.keys(reply).sort().join(',') !== 'description,id,label'
      || typeof reply.id !== 'string'
      || !reply.id.trim()
      || typeof reply.label !== 'string'
      || !reply.label.trim()
      || typeof reply.description !== 'string'
    ) {
      throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '模型快捷回复不符合严格外壳');
    }
  }
}

function decodeGlobalStructuredOutput(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '模型严格输出外壳不是 JSON 对象');
  }
  if (Object.hasOwn(raw, 'resume_proposal') || Object.hasOwn(raw, 'data_actions')) return decodeV2(raw);
  // 测试客户端与兼容适配器可以直接返回内部协议；生产 Responses
  // 客户端始终带 payload_json，因此不会绕过严格外壳。
  if (!Object.hasOwn(raw, 'payload_json')) {
    if (options.requireEnvelope) {
      throw protocolError(
        'MODEL_OUTPUT_SCHEMA_INVALID',
        '模型没有返回严格输出外壳',
      );
    }
    return raw;
  }
  assertGlobalEnvelope(raw);
  const type = String(raw.type || '').trim().toLowerCase();
  if (!['message', 'proposal'].includes(type)) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '模型严格输出外壳 type 无效');
  }
  const content = String(raw.content || '').trim();
  if (!content) {
    throw protocolError('MODEL_OUTPUT_SCHEMA_INVALID', '模型严格输出外壳缺少 content');
  }
  if (type === 'message') {
    if (raw.payload_json !== '') {
      throw protocolError(
        'MODEL_OUTPUT_SCHEMA_INVALID',
        '模型 message 的 payload_json 必须为空字符串',
      );
    }
    return {
      type,
      content,
      awaiting_user: Boolean(raw.awaiting_user),
      message_kind: raw.message_kind ? String(raw.message_kind) : undefined,
      quick_replies: Array.isArray(raw.quick_replies) ? raw.quick_replies : [],
    };
  }
  if (
    raw.awaiting_user
    || raw.message_kind !== null
    || raw.quick_replies.length
    || !raw.payload_json.trim()
  ) {
    throw protocolError(
      'MODEL_OUTPUT_SCHEMA_INVALID',
      '模型 proposal 的严格外壳状态无效',
    );
  }
  const payload = parseJsonObject(raw.payload_json);
  if (!payload) {
    throw protocolError(
      'MODEL_OUTPUT_SCHEMA_INVALID',
      '模型 proposal 的 payload_json 不是唯一完整 JSON 对象',
    );
  }
  const proposal = payload.proposal && typeof payload.proposal === 'object'
    ? payload.proposal
    : undefined;
  const actions = Array.isArray(payload.actions) ? payload.actions : undefined;
  if (!proposal && !actions) {
    throw protocolError(
      'MODEL_OUTPUT_SCHEMA_INVALID',
      '模型 proposal 的 payload_json 缺少 proposal 或 actions',
    );
  }
  return {
    type,
    content,
    ...(proposal ? { proposal } : {}),
    ...(actions ? { actions } : {}),
  };
}

module.exports = {
  ENVELOPE_KEYS,
  assertGlobalEnvelope,
  decodeGlobalStructuredOutput,
};
