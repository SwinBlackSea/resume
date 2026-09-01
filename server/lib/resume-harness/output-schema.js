'use strict';

function normalizeModelOutput(raw, lockedScope) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('模型输出不是 JSON 对象');
  }
  if (typeof raw.reply !== 'string') throw new Error('模型输出缺少 reply');
  if (!Array.isArray(raw.actions)) throw new Error('模型输出缺少 actions');

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

module.exports = { normalizeModelOutput };
