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

  return {
    ...raw,
    reply: raw.reply.trim(),
    scope: {
      type: lockedScope.type,
      id: lockedScope.id || null,
      revision: lockedScope.revision ?? null,
    },
    actions: raw.actions,
    uncertainty: Array.isArray(raw.uncertainty) ? raw.uncertainty : [],
  };
}

module.exports = { normalizeModelOutput, findForbiddenKey, FORBIDDEN_RELATION_KEYS };
