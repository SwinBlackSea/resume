'use strict';

const FORBIDDEN_RELATION_KEYS = new Set([
  'evidence',
  'evidence_ids',
  'evidence_map',
  'source',
  'source_id',
  'source_item_id',
  'source_item_ids',
  'dependency_fact_ids',
]);
const RESULT_TYPES = new Set(['MESSAGE', 'PROPOSAL']);
const LEGACY_MESSAGE_TYPES = new Set([
  'ANSWER',
  'CLARIFICATION_REQUIRED',
  'PLAN_CONFIRMATION_REQUIRED',
]);

function findForbiddenKey(value, path = '$') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findForbiddenKey(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_RELATION_KEYS.has(key)) return `${path}.${key}`;
    const found = findForbiddenKey(entry, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function normalizeQuickReplies(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 3)
    .map((option, index) => {
      if (typeof option === 'string') {
        const label = option.trim().slice(0, 120);
        return label ? { id: `option-${index + 1}`, label } : null;
      }
      if (!option || typeof option !== 'object') return null;
      const label = String(option.label || option.text || '').trim().slice(0, 120);
      if (!label) return null;
      return {
        id: String(option.id || `option-${index + 1}`).slice(0, 80),
        label,
        ...(option.description
          ? { description: String(option.description).trim().slice(0, 240) }
          : {}),
      };
    })
    .filter(Boolean);
}

function directProposalAction(raw, lockedScope) {
  const proposal = raw.proposal && typeof raw.proposal === 'object'
    ? raw.proposal
    : null;
  if (!proposal || Array.isArray(proposal)) return null;
  if (!['RESUME_BLOCK', 'RESUME_DOCUMENT'].includes(lockedScope.type)) return null;
  return {
    type: 'RESUME_REWRITE_PROPOSAL',
    target_type: lockedScope.type,
    target_id: lockedScope.id || null,
    payload: { proposal },
  };
}

function normalizeModelOutput(raw, lockedScope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模型输出不是 JSON 对象');
  }
  const forbidden = findForbiddenKey(raw);
  if (forbidden) throw new Error(`模型输出包含不允许的内容关系字段：${forbidden}`);

  const explicitProtocolType = String(raw.type || '').trim().toLowerCase();
  const legacyResultType = String(raw.result_type || '').trim().toUpperCase();
  let resultType;
  if (explicitProtocolType) {
    if (!['message', 'proposal'].includes(explicitProtocolType)) {
      throw new Error(`模型输出包含未知 type：${explicitProtocolType}`);
    }
    resultType = explicitProtocolType.toUpperCase();
  } else if (legacyResultType === 'PROPOSAL') {
    resultType = 'PROPOSAL';
  } else if (LEGACY_MESSAGE_TYPES.has(legacyResultType)) {
    resultType = 'MESSAGE';
  } else {
    const hasActions = Array.isArray(raw.actions) && raw.actions.length;
    const hasDirectProposal = raw.proposal && typeof raw.proposal === 'object';
    resultType = hasActions || hasDirectProposal ? 'PROPOSAL' : 'MESSAGE';
  }
  if (!RESULT_TYPES.has(resultType)) {
    throw new Error(`模型输出包含未知 result_type：${resultType}`);
  }

  const content = String(raw.content ?? raw.reply ?? '').trim();
  if (!content) throw new Error('模型输出缺少 content');

  const rawClarification = raw.clarification && typeof raw.clarification === 'object'
    ? raw.clarification
    : null;
  const rawPlan = raw.plan && typeof raw.plan === 'object' ? raw.plan : null;
  let quickReplies = normalizeQuickReplies(raw.quick_replies);
  if (!quickReplies.length && rawClarification) {
    quickReplies = normalizeQuickReplies(rawClarification.options);
  }
  if (!quickReplies.length && rawPlan) {
    quickReplies = normalizeQuickReplies([
      rawPlan.confirm_label || '按这个思路修改',
      rawPlan.adjust_label || '调整要求',
    ]);
  }

  let actions = Array.isArray(raw.actions) ? raw.actions : [];
  const generatedAction = resultType === 'PROPOSAL'
    ? directProposalAction(raw, lockedScope)
    : null;
  if (!actions.length && generatedAction) actions = [generatedAction];

  const awaitingUser = resultType === 'MESSAGE'
    ? raw.awaiting_user !== undefined
      ? Boolean(raw.awaiting_user)
      : legacyResultType === 'CLARIFICATION_REQUIRED'
        || legacyResultType === 'PLAN_CONFIRMATION_REQUIRED'
        || quickReplies.length > 0
    : false;

  return {
    ...raw,
    type: resultType.toLowerCase(),
    content,
    reply: content,
    result_type: resultType,
    awaiting_user: awaitingUser,
    quick_replies: quickReplies,
    // 兼容升级前客户端和已落库消息；新协议不要求模型构造这些对象。
    clarification: rawClarification,
    plan: rawPlan,
    scope: {
      type: lockedScope.type,
      id: lockedScope.id || null,
      revision: lockedScope.revision ?? null,
    },
    actions,
    uncertainty: Array.isArray(raw.uncertainty) ? raw.uncertainty : [],
  };
}

module.exports = {
  RESULT_TYPES,
  normalizeModelOutput,
  normalizeQuickReplies,
  findForbiddenKey,
  FORBIDDEN_RELATION_KEYS,
};
