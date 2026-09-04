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
const RESULT_TYPES = new Set([
  'ANSWER',
  'CLARIFICATION_REQUIRED',
  'PLAN_CONFIRMATION_REQUIRED',
  'PROPOSAL',
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

function normalizeModelOutput(raw, lockedScope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模型输出不是 JSON 对象');
  }
  if (typeof raw.reply !== 'string') throw new Error('模型输出缺少 reply');
  if (!Array.isArray(raw.actions)) throw new Error('模型输出缺少 actions');
  const forbidden = findForbiddenKey(raw);
  if (forbidden) throw new Error(`模型输出包含不允许的内容关系字段：${forbidden}`);
  const explicitResultType = String(raw.result_type || '').trim().toUpperCase();
  const resultType = explicitResultType || (
    raw.actions.length
      ? 'PROPOSAL'
      : (raw.clarification || (Array.isArray(raw.uncertainty) && raw.uncertainty.length))
        ? 'CLARIFICATION_REQUIRED'
        : 'ANSWER'
  );
  if (!RESULT_TYPES.has(resultType)) {
    throw new Error(`模型输出包含未知 result_type：${resultType}`);
  }
  const rawClarification = raw.clarification && typeof raw.clarification === 'object'
    ? raw.clarification
    : null;
  const clarification = resultType === 'CLARIFICATION_REQUIRED'
    ? {
        question: String(
          rawClarification && rawClarification.question
          || raw.reply,
        ).trim(),
        options: Array.isArray(rawClarification && rawClarification.options)
          ? rawClarification.options.slice(0, 3).map((option, index) => ({
              id: String(option && option.id || `option-${index + 1}`).slice(0, 80),
              label: String(option && option.label || '').trim().slice(0, 120),
              ...(option && option.description
                ? { description: String(option.description).trim().slice(0, 240) }
                : {}),
            })).filter((option) => option.label)
          : [],
        ...(rawClarification && rawClarification.reason
          ? { reason: String(rawClarification.reason).trim().slice(0, 240) }
          : {}),
      }
    : null;
  const rawPlan = raw.plan && typeof raw.plan === 'object' ? raw.plan : null;
  const plan = resultType === 'PLAN_CONFIRMATION_REQUIRED'
    ? {
        summary: String(rawPlan && rawPlan.summary || raw.reply).trim().slice(0, 240),
        steps: Array.isArray(rawPlan && rawPlan.steps)
          ? rawPlan.steps
              .slice(0, 5)
              .map((step) => String(step || '').trim().slice(0, 160))
              .filter(Boolean)
          : [],
        scope_note: String(rawPlan && rawPlan.scope_note || '').trim().slice(0, 200),
        affected_scope_ids: Array.isArray(rawPlan && rawPlan.affected_scope_ids)
          ? rawPlan.affected_scope_ids.map(String).filter(Boolean).slice(0, 12)
          : [],
        confirm_label: String(
          rawPlan && rawPlan.confirm_label || '按这个思路修改',
        ).trim().slice(0, 40),
        adjust_label: String(
          rawPlan && rawPlan.adjust_label || '调整要求',
        ).trim().slice(0, 40),
      }
    : null;

  return {
    ...raw,
    reply: raw.reply.trim(),
    result_type: resultType,
    clarification,
    plan,
    scope: {
      type: lockedScope.type,
      id: lockedScope.id || null,
      revision: lockedScope.revision ?? null,
    },
    actions: raw.actions,
    uncertainty: Array.isArray(raw.uncertainty) ? raw.uncertainty : [],
  };
}

module.exports = {
  RESULT_TYPES,
  normalizeModelOutput,
  findForbiddenKey,
  FORBIDDEN_RELATION_KEYS,
};
