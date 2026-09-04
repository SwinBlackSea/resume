'use strict';
/**
 * 简历变更的紧凑存储与局部撤销。
 *
 * 文本编辑和局部 AI 修改只保存目标节点前后的内容，不重复保存两份完整简历。
 * 撤销时先确认目标节点仍是该变更应用后的状态，再只恢复该节点，因此不会覆盖
 * 用户随后在其他区域完成的修改。
 */
const ResumeDom = require('../../resume-dom');
const { deepClone, hashJson } = require('./util');

const NODE_DELTA_FORMAT = 'resume-node-delta-v1';
const STRUCTURE_DELTA_FORMAT = 'resume-structure-delta-v1';
const ARCHIVED_FORMAT = 'archived-change-v1';

function parsePayload(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch (_) {
    return fallback;
  }
}

function isNodeDelta(payload) {
  return Boolean(
    payload
      && payload.format === NODE_DELTA_FORMAT
      && Array.isArray(payload.nodes)
      && payload.nodes.length,
  );
}

function isArchivedPayload(payload) {
  return Boolean(payload && payload.format === ARCHIVED_FORMAT);
}

function isStructureDelta(payload) {
  return Boolean(
    payload
      && payload.format === STRUCTURE_DELTA_FORMAT
      && Array.isArray(payload.nodes)
      && payload.nodes.length,
  );
}

function captureNodes(resume, nodeIds, metadata = {}) {
  const document = ResumeDom.ensureDocument(resume);
  const uniqueIds = Array.from(new Set((nodeIds || []).filter(Boolean).map(String)));
  if (!uniqueIds.length) throw new Error('节点差量至少需要一个目标');
  const nodes = uniqueIds.map((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found || !found.parent) throw new Error(`无法记录简历节点：${nodeId}`);
    const node = deepClone(found.node);
    return { node_id: nodeId, node, node_hash: hashJson(node) };
  });
  return {
    format: NODE_DELTA_FORMAT,
    nodes,
    ...metadata,
  };
}

function createNodeDeltaPair(beforeResume, afterResume, nodeIds, afterMetadata = {}) {
  return {
    before: captureNodes(beforeResume, nodeIds),
    after: captureNodes(afterResume, nodeIds, afterMetadata),
  };
}

function restoreNodeDelta(resume, restorePayload, expectedPayload) {
  if (!isNodeDelta(restorePayload)) throw new Error('变更记录不包含可恢复的节点');
  const expectedById = new Map(
    isNodeDelta(expectedPayload)
      ? expectedPayload.nodes.map((entry) => [String(entry.node_id), entry])
      : [],
  );
  let document = ResumeDom.ensureDocument(resume);
  restorePayload.nodes.forEach((entry) => {
    const nodeId = String(entry.node_id || '');
    const found = ResumeDom.findNode(document, nodeId);
    if (!found || !found.parent) {
      const error = new Error('目标内容已经不存在');
      error.code = 'CHANGE_TARGET_MISSING';
      throw error;
    }
    const expected = expectedById.get(nodeId);
    if (expected && hashJson(found.node) !== expected.node_hash) {
      const error = new Error('目标内容在此后又发生了变化');
      error.code = 'CHANGE_TARGET_MODIFIED';
      throw error;
    }
    found.parent.children[found.index] = deepClone(entry.node);
    document = ResumeDom.normalizeDocument(found.document);
  });
  const current = ResumeDom.toResumeDocument(resume);
  return ResumeDom.toResumeDocument({ ...current, root: document.root });
}

function operationTargetId(operation) {
  if (!operation || typeof operation !== 'object') return null;
  if (operation.op === 'insert_node') {
    return operation.node && operation.node.id ? String(operation.node.id) : null;
  }
  return operation.node_id ? String(operation.node_id) : null;
}

function nodeState(document, nodeId) {
  const found = ResumeDom.findNode(document, nodeId);
  if (!found) return { node_id: nodeId, node: null, node_hash: null, parent_id: null, index: null };
  return {
    node_id: nodeId,
    node: deepClone(found.node),
    node_hash: hashJson(found.node),
    parent_id: found.parent ? found.parent.id : null,
    index: found.index,
  };
}

function targetsOverlap(document, targetIds) {
  return targetIds.some((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found) return false;
    const ancestorIds = new Set(found.ancestors.map((node) => node.id));
    return targetIds.some((otherId) => otherId !== nodeId && ancestorIds.has(otherId));
  });
}

function createStructureDeltaPair(beforeResume, afterResume, operations, afterMetadata = {}) {
  const beforeDocument = ResumeDom.ensureDocument(beforeResume);
  const afterDocument = ResumeDom.ensureDocument(afterResume);
  let targetIds = Array.from(
    new Set((operations || []).map(operationTargetId).filter(Boolean)),
  );
  if (
    !targetIds.length
    || targetIds.includes(beforeDocument.root.id)
    || targetIds.includes(afterDocument.root.id)
    || targetsOverlap(beforeDocument, targetIds)
    || targetsOverlap(afterDocument, targetIds)
  ) {
    return null;
  }
  let beforeNodes = targetIds.map((nodeId) => nodeState(beforeDocument, nodeId));
  let afterNodes = targetIds.map((nodeId) => nodeState(afterDocument, nodeId));
  // 连续调整可能产生只存在于中间建议态的临时节点。它们不属于最终 A→C
  // 差量，不应迫使变更事件退化为两份完整文档。
  const retainedIndexes = targetIds
    .map((_, index) => index)
    .filter((index) => beforeNodes[index].node || afterNodes[index].node);
  targetIds = retainedIndexes.map((index) => targetIds[index]);
  beforeNodes = retainedIndexes.map((index) => beforeNodes[index]);
  afterNodes = retainedIndexes.map((index) => afterNodes[index]);
  if (!targetIds.length) return null;
  return {
    before: { format: STRUCTURE_DELTA_FORMAT, nodes: beforeNodes },
    after: {
      format: STRUCTURE_DELTA_FORMAT,
      nodes: afterNodes,
      ...afterMetadata,
    },
  };
}

function restoreStructureDelta(resume, restorePayload, expectedPayload) {
  if (!isStructureDelta(restorePayload) || !isStructureDelta(expectedPayload)) {
    throw new Error('结构变更记录不完整');
  }
  let document = ResumeDom.ensureDocument(resume);
  const expectedById = new Map(
    expectedPayload.nodes.map((entry) => [String(entry.node_id), entry]),
  );

  restorePayload.nodes.forEach((restoreEntry) => {
    const nodeId = String(restoreEntry.node_id || '');
    const expected = expectedById.get(nodeId);
    if (!expected) {
      const error = new Error('结构变更记录不完整');
      error.code = 'CHANGE_DOCUMENT_MODIFIED';
      throw error;
    }
    const current = ResumeDom.findNode(document, nodeId);
    if (!expected.node) {
      if (current) {
        const error = new Error('目标位置已经出现同名内容');
        error.code = 'CHANGE_DOCUMENT_MODIFIED';
        throw error;
      }
      return;
    }
    if (
      !current
      || hashJson(current.node) !== expected.node_hash
      || String(current.parent && current.parent.id || '') !== String(expected.parent_id || '')
    ) {
      const error = new Error('相关结构在此后又发生了变化');
      error.code = 'CHANGE_DOCUMENT_MODIFIED';
      throw error;
    }
  });

  const removals = restorePayload.nodes
    .map((entry) => ResumeDom.findNode(document, entry.node_id))
    .filter((found) => found && found.parent)
    .sort((left, right) => {
      if (left.parent.id === right.parent.id) return right.index - left.index;
      return right.ancestors.length - left.ancestors.length;
    });
  removals.forEach((found) => {
    const latest = ResumeDom.findNode(document, found.node.id);
    if (latest && latest.parent) {
      latest.parent.children.splice(latest.index, 1);
      document = ResumeDom.normalizeDocument(latest.document);
    }
  });

  const insertions = restorePayload.nodes
    .filter((entry) => entry.node)
    .sort((left, right) => {
      if (left.parent_id === right.parent_id) return left.index - right.index;
      return String(left.parent_id).localeCompare(String(right.parent_id));
    });
  insertions.forEach((entry) => {
    const parent = ResumeDom.findNode(document, entry.parent_id);
    if (!parent || !Array.isArray(parent.node.children)) {
      const error = new Error('原结构位置已经不存在');
      error.code = 'CHANGE_DOCUMENT_MODIFIED';
      throw error;
    }
    const index = Math.max(0, Math.min(Number(entry.index) || 0, parent.node.children.length));
    parent.node.children.splice(index, 0, deepClone(entry.node));
    document = ResumeDom.normalizeDocument(parent.document);
  });
  const current = ResumeDom.toResumeDocument(resume);
  return ResumeDom.toResumeDocument({ ...current, root: document.root });
}

function compactLegacyEvent(row) {
  if (!row) return null;
  const beforePayload = parsePayload(row.before_json);
  const afterPayload = parsePayload(row.after_json);
  if (!beforePayload.resume_json || !afterPayload.resume_json) return null;
  try {
    let pair = null;
    if (
      row.scope_id
      && (
        row.change_type === 'document_transaction'
        || (row.change_type === 'dom_operations' && row.scope_type === 'RESUME_BLOCK')
      )
    ) {
      pair = createNodeDeltaPair(
        beforePayload.resume_json,
        afterPayload.resume_json,
        [row.scope_id],
        {
          ...(afterPayload.label ? { label: afterPayload.label } : {}),
          ...(afterPayload.input_type ? { input_type: afterPayload.input_type } : {}),
        },
      );
    } else if (
      row.change_type === 'dom_operations'
      || row.change_type === 'document_transaction'
    ) {
      const beforeResume = ResumeDom.toResumeDocument(beforePayload.resume_json);
      const afterResume = ResumeDom.toResumeDocument(afterPayload.resume_json);
      const { root: beforeRoot, ...beforeMetadata } = beforeResume;
      const { root: afterRoot, ...afterMetadata } = afterResume;
      if (hashJson(beforeMetadata) !== hashJson(afterMetadata)) return null;
      const changes = ResumeDom.compareDocuments(beforeResume, afterResume).changes || [];
      const targets = Array.from(
        new Set(changes.map((change) => change.node_id).filter(Boolean)),
      );
      pair = createStructureDeltaPair(
        beforeResume,
        afterResume,
        targets.map((nodeId) => ({ op: 'set_style', node_id: nodeId })),
        {
          ...(afterPayload.label ? { label: afterPayload.label } : {}),
          ...(afterPayload.input_type ? { input_type: afterPayload.input_type } : {}),
        },
      );
    }
    if (!pair) return null;
    const compact = {
      before_json: JSON.stringify(pair.before),
      after_json: JSON.stringify(pair.after),
    };
    const originalBytes = Buffer.byteLength(row.before_json || '')
      + Buffer.byteLength(row.after_json || '');
    const compactBytes = Buffer.byteLength(compact.before_json)
      + Buffer.byteLength(compact.after_json);
    return compactBytes < originalBytes ? compact : null;
  } catch (_) {
    // 旧事件若无法确认是单节点变更，就继续保留完整文档，避免错误压缩。
    return null;
  }
}

function archivedPayload(label) {
  return {
    format: ARCHIVED_FORMAT,
    ...(label ? { label: String(label).slice(0, 120) } : {}),
  };
}

module.exports = {
  NODE_DELTA_FORMAT,
  STRUCTURE_DELTA_FORMAT,
  ARCHIVED_FORMAT,
  parsePayload,
  isNodeDelta,
  isStructureDelta,
  isArchivedPayload,
  captureNodes,
  createNodeDeltaPair,
  createStructureDeltaPair,
  restoreNodeDelta,
  restoreStructureDelta,
  compactLegacyEvent,
  archivedPayload,
};
