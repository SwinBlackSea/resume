'use strict';
/**
 * AI 策略执行器（TECH §9.6）。
 *
 * AI Gateway 与业务写服务之间的确定性边界：
 *  1. 校验响应 Schema、动作枚举、目标所有权和 scope revision；
 *  2. 根据动作矩阵决定「仅回复 / 待确认 / 可直接执行 / 拒绝」；
 *  3. 对可执行动作调用内部领域服务，不允许模型提供任意 API、SQL 或 JSON Patch；
 *  4. 写入 ai_action_requests、fact_candidates、change_receipts 和 audit_logs；
 *  5. 返回后端实际执行结果，前端不得根据模型文本乐观显示「已保存」。
 *
 * fail-closed：分类失败、策略冲突、target revision 变化或依赖异常时不执行任何业务写入。
 */
const db = require('./db');
const audit = require('./audit');
const { uuidv7, nowIso, deepClone, problem } = require('./util');

const POLICY_VERSION = 'policy-v1';

/** 动作枚举：模型只允许输出这些类型，未知类型一律拒绝（零写入）。 */
const ACTION_TYPES = new Set([
  'NO_OP',
  'PROFILE_FIELD_UPDATE',
  'FACT_CANDIDATE',
  'JOB_CANDIDATE',
  'RESUME_REWRITE_PROPOSAL',
  'TEMPORARY_CONTEXT',
]);

/** 作用范围稳定枚举。界面显示文案不得替代内部类型（AGENTS.md）。 */
const SCOPE_TYPES = new Set(['DATA_PROFILE', 'DATA_JOB', 'RESUME_BLOCK', 'RESUME_DOCUMENT']);

/** 显示文案映射：内部枚举 → 界面文案。 */
const SCOPE_LABEL = {
  DATA_PROFILE: '@资料 · 个人信息',
  DATA_JOB: '@资料 · 岗位信息',
  RESUME_BLOCK: '@简历 · 具体内容',
  RESUME_DOCUMENT: '@整份简历',
};

/**
 * 可直接执行的字段白名单（TECH §9.6）。
 * 首期仅包含：姓名、电话、邮箱、所在城市、当前职位和求职状态。
 */
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

/** 字段级校验。返回 {ok, value, reason}。 */
function validateFieldValue(field, raw) {
  const value = typeof raw === 'string' ? raw.trim() : raw;
  switch (field) {
    case 'name':
      if (typeof value !== 'string' || value.length < 1 || value.length > 32)
        return { ok: false, reason: '姓名需为 1—32 个字符' };
      return { ok: true, value };
    case 'phone': {
      const normalized = String(value).replace(/[\s-]/g, '');
      if (!/^1[3-9]\d{9}$/.test(normalized))
        return { ok: false, reason: '手机号格式不正确（需 11 位中国大陆号码）' };
      return { ok: true, value: normalized };
    }
    case 'email':
      if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        return { ok: false, reason: '邮箱格式不正确' };
      return { ok: true, value };
    case 'city':
      if (typeof value !== 'string' || value.length < 1 || value.length > 24)
        return { ok: false, reason: '城市需为 1—24 个字符' };
      return { ok: true, value };
    case 'current_title':
      if (typeof value !== 'string' || value.length < 1 || value.length > 40)
        return { ok: false, reason: '当前职位需为 1—40 个字符' };
      return { ok: true, value };
    case 'job_status':
      if (!JOB_STATUS_VALUES.has(value)) return { ok: false, reason: '求职状态取值不支持' };
      return { ok: true, value };
    default:
      return { ok: false, reason: `字段 ${field} 不在白名单内` };
  }
}

/**
 * 校验模型响应 Schema。返回 {ok, errors, rejected}。
 * 不合法的部分被剔除并记入 rejected，绝不进入业务层。
 */
function validateModelResponse(response, opts = {}) {
  const errors = [];
  const rejected = [];
  if (!response || typeof response !== 'object') {
    return { ok: false, errors: ['响应不是对象'], rejected, actions: [] };
  }
  // 证据由后端注入：本条用户消息就是事实/岗位动作的证据来源，
  // 不应依赖模型自觉填写（模型经常漏填，导致合法动作被误拒）。
  const injectEvidence = opts.injectEvidence || null;
  if (typeof response.reply !== 'string') errors.push('reply 必须是字符串');

  const scope = response.scope || {};
  if (scope && scope.type && !SCOPE_TYPES.has(scope.type)) {
    errors.push(`未知 scope_type: ${scope.type}`);
  }

  const rawActions = Array.isArray(response.actions) ? response.actions : [];
  const actions = [];
  rawActions.forEach((action, index) => {
    if (!action || typeof action !== 'object') {
      rejected.push({ index, reason: '动作不是对象' });
      return;
    }
    if (!ACTION_TYPES.has(action.type)) {
      // 模型返回未知 action_type：拒绝并记录安全错误（P0-12）
      rejected.push({ index, reason: `未知 action_type: ${action.type}` });
      return;
    }
    // FACT / JOB / REWRITE 必须要求确认（SYSTEM_PROMPT §5）
    const needsConfirm = ['FACT_CANDIDATE', 'JOB_CANDIDATE', 'RESUME_REWRITE_PROPOSAL'].includes(
      action.type,
    );
    if (needsConfirm && action.requires_confirmation === false) {
      // 不得因为模型声明而跳过确认：强制纠正 rather than 执行
      action.requires_confirmation = true;
    }
    // 事实与岗位类动作必须有证据（SYSTEM_PROMPT §5：无证据不生成写动作）
    if (['FACT_CANDIDATE', 'JOB_CANDIDATE'].includes(action.type)) {
      const evidence = Array.isArray(action.evidence_ids) ? action.evidence_ids : [];
      if (!evidence.length && injectEvidence) {
        action.evidence_ids = [injectEvidence];
      } else if (!evidence.length) {
        rejected.push({ index, reason: `${action.type} 缺少证据`, action_type: action.type });
        return;
      }
    }
    actions.push(action);
  });

  return { ok: errors.length === 0, errors, rejected, actions, scope };
}

/**
 * 策略矩阵决策（TECH §9.6）。
 * @returns {{outcome:'reply_only'|'await_confirm'|'execute'|'reject', reason:string, convertTo?:string}}
 */
function decideAction(action, ctx) {
  const { profileRevision } = ctx;

  if (!ACTION_TYPES.has(action.type)) {
    return { outcome: 'reject', reason: `未知 action_type: ${action.type}` };
  }
  if (action.type === 'NO_OP' || action.type === 'TEMPORARY_CONTEXT') {
    return { outcome: 'reply_only', reason: '临时上下文或普通问答，不持久化业务资料' };
  }
  if (action.type === 'FACT_CANDIDATE') {
    return { outcome: 'await_confirm', reason: '新增事实需用户确认后才进入可靠事实库' };
  }
  if (action.type === 'JOB_CANDIDATE') {
    return { outcome: 'await_confirm', reason: '岗位变化需用户确认，不自动替换当前岗位' };
  }
  if (action.type === 'RESUME_REWRITE_PROPOSAL') {
    return { outcome: 'await_confirm', reason: '修改方案在应用前不改变正文' };
  }

  // PROFILE_FIELD_UPDATE
  const field = action.field_path || (action.payload && action.payload.field);
  const value = action.payload && action.payload.value;
  const explicit = action.explicit === true || (action.payload && action.payload.explicit === true);

  if (!PROFILE_WHITELIST.has(field)) {
    return {
      outcome: 'await_confirm',
      reason: `字段 ${field} 不在直接执行白名单内，转为待确认事实`,
      convertTo: 'FACT_CANDIDATE',
    };
  }
  if (!explicit) {
    return {
      outcome: 'await_confirm',
      reason: '未识别为明确更正，转为待确认事实',
      convertTo: 'FACT_CANDIDATE',
    };
  }
  const checked = validateFieldValue(field, value);
  if (!checked.ok) {
    return {
      outcome: 'await_confirm',
      reason: `字段值校验失败（${checked.reason}），转为待确认事实`,
      convertTo: 'FACT_CANDIDATE',
    };
  }
  // expected_revision 冲突：返回冲突并要求重新确认（P0-14）
  if (typeof action.expected_revision === 'number' && action.expected_revision !== profileRevision) {
    return {
      outcome: 'reject',
      reason: 'REVISION_CONFLICT',
      conflict: { expected: action.expected_revision, current: profileRevision },
    };
  }
  if (ctx.profileBefore && ctx.profileBefore[field] === undefined) {
    return { outcome: 'reject', reason: '无法记录旧值，动作不可撤销，按 fail-closed 拒绝' };
  }
  return { outcome: 'execute', reason: `字段 ${field} 命中白名单且校验通过`, field, value: checked.value };
}

/** 读取 profile basics（含 revision）。 */
function loadProfileBasics(projectId, user) {
  const project = db.get('SELECT * FROM resume_projects WHERE id = ? AND owner_id = ?', [
    projectId,
    user.id,
  ]);
  if (!project) throw problem.notFound('项目不存在');
  const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
    project.current_profile_id,
    user.id,
  ]);
  if (!profile) throw problem.notFound('个人信息不存在');
  return { project, profile, basics: JSON.parse(profile.basics_json || '{}') };
}

/**
 * 执行白名单字段更新并生成回执（可撤销）。
 * 只有本函数产生的 change_receipt 才能让前端展示「已保存」。
 */
function executeProfileFieldUpdate({ user, project, profile, field, value, actionRequestId, requestId, ipHash }) {
  return db.tx(() => {
    const basics = JSON.parse(profile.basics_json || '{}');
    const before = basics[field];
    if (before === value) {
      return { changed: false, before, after: value };
    }
    basics[field] = value;
    const revision = db.bumpRevision('profiles', profile.id);
    db.run('UPDATE profiles SET basics_json = ?, updated_at = ? WHERE id = ?', [
      JSON.stringify(basics),
      nowIso(),
      profile.id,
    ]);
    const mutationId = uuidv7();
    const receiptId = uuidv7();
    db.run(
      `INSERT INTO change_receipts (id, action_request_id, owner_id, resource_type, resource_id, before_json, after_json, mutation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        receiptId,
        actionRequestId,
        user.id,
        'profile_field',
        `${profile.id}:${field}`,
        JSON.stringify({ [field]: before }),
        JSON.stringify({ [field]: value }),
        mutationId,
        nowIso(),
      ],
    );
    db.run('UPDATE ai_action_requests SET status = ?, applied_at = ? WHERE id = ?', [
      'applied',
      nowIso(),
      actionRequestId,
    ]);
    audit.log({
      ownerId: user.id,
      actorId: user.id,
      action: 'profile_field_update_applied',
      resourceType: 'profile',
      resourceId: profile.id,
      requestId,
      ipHash,
      metadata: { field, before, after: value, receipt_id: receiptId, revision },
    });
    return { changed: true, before, after: value, receipt_id: receiptId, revision, mutation_id: mutationId };
  });
}

/** 撤销已执行的白名单动作，恢复 before 值并记录 reverted（P0-16）。 */
function revertAction({ user, actionRequestId, requestId = '', ipHash = '' }) {
  const request = db.get(
    'SELECT * FROM ai_action_requests WHERE id = ? AND owner_id = ?',
    [actionRequestId, user.id],
  );
  if (!request) throw problem.notFound('动作不存在');
  if (request.status !== 'applied') {
    throw problem.conflict('ACTION_NOT_APPLIED', '该动作未处于已应用状态，无法撤销');
  }
  const receipt = db.get(
    'SELECT * FROM change_receipts WHERE action_request_id = ? AND owner_id = ? AND reverted_at IS NULL',
    [actionRequestId, user.id],
  );
  if (!receipt) throw problem.notFound('未找到可撤销的回执');

  return db.tx(() => {
    const before = JSON.parse(receipt.before_json);
    const after = JSON.parse(receipt.after_json);
    const [profileId, field] = receipt.resource_id.split(':');
    const profile = db.get('SELECT * FROM profiles WHERE id = ? AND owner_id = ?', [
      profileId,
      user.id,
    ]);
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
    db.run('UPDATE ai_action_requests SET status = ?, reverted_at = ? WHERE id = ?', [
      'reverted',
      nowIso(),
      actionRequestId,
    ]);
    audit.log({
      ownerId: user.id,
      actorId: user.id,
      action: 'profile_field_update_reverted',
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
