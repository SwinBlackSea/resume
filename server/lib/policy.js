'use strict';
/**
 * AI 策略边界：模型只提出受限动作，后端校验后等待用户操作。
 * 不接收或保存来源、证据、依赖事实等内容关系字段。
 */
const db = require('./db');
const audit = require('./audit');
const { uuidv7, nowIso, deepClone, problem } = require('./util');
const { findForbiddenKey } = require('./resume-harness/output-schema');

const POLICY_VERSION = 'policy-v6-semantic-operations';
const ACTION_TYPES = new Set([
  'PROFILE_SAVE_PROPOSAL',
  'JOB_SET_CURRENT_PROPOSAL',
  'RESUME_REWRITE_PROPOSAL',
]);
const SCOPE_TYPES = new Set(['DATA_PROFILE', 'DATA_JOB', 'RESUME_BLOCK', 'RESUME_DOCUMENT']);
const SCOPE_LABEL = {
  DATA_PROFILE: '@资料 · 个人信息',
  DATA_JOB: '@资料 · 岗位信息',
  RESUME_BLOCK: '@简历 · 具体内容',
  RESUME_DOCUMENT: '@整份简历',
};
const PROFILE_WHITELIST = new Set(['name', 'phone', 'email', 'city', 'current_title', 'job_status']);
const FIELD_LABELS = {
  name: '姓名',
  phone: '手机',
  email: '邮箱',
  city: '所在城市',
  current_title: '当前职位',
  job_status: '求职状态',
};
const JOB_STATUS_VALUES = new Set(['actively_looking', 'open_to_opportunities', 'not_looking']);

function validateFieldValue(field, raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  switch (field) {
    case 'name':
      return typeof value === 'string' && value.length >= 1 && value.length <= 32
        ? { ok: true, value }
        : { ok: false, reason: '姓名需为 1—32 个字符' };
    case 'phone': {
      const normalized = String(value).replace(/[\s-]/g, '');
      return /^1[3-9]\d{9}$/.test(normalized)
        ? { ok: true, value: normalized }
        : { ok: false, reason: '手机号格式不正确（需 11 位中国大陆号码）' };
    }
    case 'email':
      return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? { ok: true, value }
        : { ok: false, reason: '邮箱格式不正确' };
    case 'city':
      return typeof value === 'string' && value.length >= 1 && value.length <= 24
        ? { ok: true, value }
        : { ok: false, reason: '城市需为 1—24 个字符' };
    case 'current_title':
      return typeof value === 'string' && value.length >= 1 && value.length <= 40
        ? { ok: true, value }
        : { ok: false, reason: '当前职位需为 1—40 个字符' };
    case 'job_status':
      return JOB_STATUS_VALUES.has(value)
        ? { ok: true, value }
        : { ok: false, reason: '求职状态取值不支持' };
    default:
      return { ok: false, reason: `不支持保存字段 ${field}` };
  }
}

function validateModelResponse(response) {
  const errors = [];
  const rejected = [];
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { ok: false, errors: ['响应不是对象'], rejected, actions: [] };
  }
  if (typeof response.reply !== 'string') errors.push('reply 必须是字符串');
  const scope = response.scope || {};
  if (scope.type && !SCOPE_TYPES.has(scope.type)) errors.push(`未知 scope_type: ${scope.type}`);

  const rawActions = Array.isArray(response.actions) ? response.actions : [];
  const actions = [];
  rawActions.forEach((rawAction, index) => {
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
      rejected.push({ index, reason: '动作不是对象' });
      return;
    }
    const forbidden = findForbiddenKey(rawAction, `$.actions[${index}]`);
    if (forbidden) {
      rejected.push({ index, reason: `动作包含不允许的内容关系字段：${forbidden}` });
      return;
    }
    if (!ACTION_TYPES.has(rawAction.type)) {
      rejected.push({ index, reason: `未知 action_type: ${rawAction.type}` });
      return;
    }
    const action = deepClone(rawAction);
    action.requires_user_action = true;
    actions.push(action);
  });
  return { ok: errors.length === 0, errors, rejected, actions, scope };
}

function decideAction(action, ctx = {}) {
  if (!ACTION_TYPES.has(action.type)) return { outcome: 'reject', reason: `未知 action_type: ${action.type}` };
  if (
    typeof action.expected_revision === 'number' &&
    typeof ctx.targetRevision === 'number' &&
    action.expected_revision !== ctx.targetRevision
  ) {
    return {
      outcome: 'reject',
      reason: 'REVISION_CONFLICT',
      conflict: { expected: action.expected_revision, current: ctx.targetRevision },
    };
  }
  return {
    outcome: 'await_confirm',
    reason: action.type === 'RESUME_REWRITE_PROPOSAL'
      ? '应用前不改变简历正文'
      : action.type === 'PROFILE_SAVE_PROPOSAL'
        ? '保存到资料需要用户单独确认'
        : '切换当前岗位需要用户确认',
  };
}

function loadProfileBasics(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [projectId, user.id]);
  if (!project) throw problem.notFound('项目不存在');
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  if (!profile) throw problem.notFound('个人信息不存在');
  return { project, profile, basics: JSON.parse(profile.basics_json || '{}') };
}

function executeProfileFieldUpdate({ user, profile, field, value, actionRequestId, requestId, ipHash }) {
  return db.tx(() => {
    if (!PROFILE_WHITELIST.has(field)) throw problem.badRequest(`不支持保存字段 ${field}`);
    const checked = validateFieldValue(field, value);
    if (!checked.ok) throw problem.unprocessable('INVALID_PROFILE_VALUE', checked.reason);
    const basics = JSON.parse(profile.basics_json || '{}');
    const before = basics[field];
    if (before === checked.value) {
      db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
        nowIso(),
        actionRequestId,
      ]);
      return { changed: false, before, after: checked.value, revision: profile.revision };
    }
    basics[field] = checked.value;
    db.run('UPDATE profiles SET basics_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(basics),
      nowIso(),
      profile.id,
    ]);
    const revision = db.bumpRevision('profiles', profile.id);
    const mutationId = uuidv7();
    const receiptId = uuidv7();
    db.run(
      `INSERT INTO change_receipts
       (id, action_request_id, owner_id, resource_type, resource_id, before_json, after_json, mutation_id, created_at)
       VALUES (?, ?, ?, 'profile_field', ?, ?, ?, ?, ?)`,
      [
        receiptId,
        actionRequestId,
        user.id,
        `${profile.id}:${field}`,
        JSON.stringify({ [field]: before }),
        JSON.stringify({ [field]: checked.value }),
        mutationId,
        nowIso(),
      ],
    );
    db.run("UPDATE ai_action_requests SET status = 'applied', applied_at = ? WHERE id = ?", [
      nowIso(),
      actionRequestId,
    ]);
    audit.log({
      ownerId: user.id,
      actorId: user.id,
      action: 'profile_save_applied',
      resourceType: 'profile',
      resourceId: profile.id,
      requestId,
      ipHash,
      metadata: { field, before, after: checked.value, receipt_id: receiptId, revision },
    });
    return { changed: true, before, after: checked.value, receipt_id: receiptId, revision, mutation_id: mutationId };
  });
}

function revertAction({ user, actionRequestId, requestId = '', ipHash = '' }) {
  const request = db.get('SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?', [
    actionRequestId,
    user.id,
  ]);
  if (!request) throw problem.notFound('动作不存在');
  if (request.status !== 'applied') {
    throw problem.conflict('ACTION_NOT_APPLIED', '该动作未处于已应用状态，无法撤销');
  }
  const receipt = db.get(
    'SELECT * FROM change_receipts WHERE action_request_id = ? AND owner_id = ? AND reverted_at IS NULL',
    [actionRequestId, user.id],
  );
  if (!receipt) throw problem.notFound('未找到可撤销的回执');
  if (receipt.resource_type !== 'profile_field') {
    throw problem.conflict('ACTION_NOT_REVERTIBLE_HERE', '该动作请通过简历撤销入口处理');
  }
  return db.tx(() => {
    const before = JSON.parse(receipt.before_json);
    const after = JSON.parse(receipt.after_json);
    const [profileId, field] = receipt.resource_id.split(':');
    const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [profileId, user.id]);
    if (!profile) throw problem.notFound('个人信息不存在');
    const basics = JSON.parse(profile.basics_json || '{}');
    basics[field] = before[field];
    db.run('UPDATE profiles SET basics_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(basics),
      nowIso(),
      profile.id,
    ]);
    db.bumpRevision('profiles', profile.id);
    db.run('UPDATE change_receipts SET reverted_at = ? WHERE id = ?', [nowIso(), receipt.id]);
    db.run("UPDATE ai_action_requests SET status = 'reverted', reverted_at = ? WHERE id = ?", [
      nowIso(),
      actionRequestId,
    ]);
    audit.log({
      ownerId: user.id,
      actorId: user.id,
      action: 'profile_save_reverted',
      resourceType: 'profile',
      resourceId: profileId,
      requestId,
      ipHash,
      metadata: { field, restored: before[field], discarded: after[field], receipt_id: receipt.id },
    });
    return {
      action_request_id: actionRequestId,
      status: 'reverted',
      field,
      before: before[field],
      after: after[field],
      receipt_id: receipt.id,
    };
  });
}

module.exports = {
  POLICY_VERSION,
  ACTION_TYPES,
  SCOPE_TYPES,
  SCOPE_LABEL,
  PROFILE_WHITELIST,
  FIELD_LABELS,
  validateFieldValue,
  validateModelResponse,
  decideAction,
  loadProfileBasics,
  executeProfileFieldUpdate,
  revertAction,
  deepClone,
};
