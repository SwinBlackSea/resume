'use strict';

/**
 * 为 AI 的 DOM 操作生成最小可执行性前置条件。
 *
 * 用户点击“应用修改”代表接受 AI 建议覆盖当前内容，因此文字、样式和兄弟
 * 节点顺序变化本身不构成冲突。这里只确认操作在最新文档上仍有客观可执行
 * 条件：目标、父容器和稳定锚点存在，新增节点 ID 尚未被占用。
 */
const ResumeDom = require('../../resume-dom');
const { deepClone } = require('./util');

const FORMAT = 'resume-operation-preconditions-v3-sequential';
const LEGACY_FORMATS = new Set([
  'resume-operation-preconditions-v2',
  'resume-operation-preconditions-v1',
]);

function collectNodeIds(node, result = new Set()) {
  if (!node || typeof node !== 'object') return result;
  if (node.id) result.add(String(node.id));
  (node.children || []).forEach((child) => collectNodeIds(child, result));
  return result;
}

function insertedNodeIds(operations) {
  const result = new Set();
  (operations || []).forEach((operation) => {
    if (operation && operation.op === 'insert_node') {
      collectNodeIds(operation.node, result);
    }
    if (
      operation
      && ['wrap_nodes', 'merge_editable_nodes'].includes(operation.op)
    ) {
      collectNodeIds(operation.node, result);
    }
  });
  return result;
}

function operationDependencies(operations) {
  const generated = insertedNodeIds(operations);
  const nodeIds = new Set();
  const containerIds = new Set();
  (operations || []).forEach((operation) => {
    if (!operation || typeof operation !== 'object') return;
    if (operation.node_id && !generated.has(String(operation.node_id))) {
      nodeIds.add(String(operation.node_id));
    }
    if (operation.after_node_id && !generated.has(String(operation.after_node_id))) {
      nodeIds.add(String(operation.after_node_id));
    }
    if (operation.parent_id && !generated.has(String(operation.parent_id))) {
      containerIds.add(String(operation.parent_id));
    }
    if (['wrap_nodes', 'merge_editable_nodes'].includes(operation.op)) {
      (operation.node_ids || []).forEach((nodeId) => {
        if (!generated.has(String(nodeId))) nodeIds.add(String(nodeId));
      });
    }
  });
  return { generated, nodeIds, containerIds };
}

function buildOperationPreconditions(resume, operations) {
  const resumeDocument = ResumeDom.toResumeDocument(resume);
  const document = ResumeDom.ensureDocument(resumeDocument);
  const originalIds = collectNodeIds(document.root);
  const { generated } = operationDependencies(operations);
  const nodeIds = new Set();
  const containerIds = new Set();
  const nodes = [];
  const containers = [];
  const insertionPoints = [];
  const ranges = [];
  let working = resumeDocument;
  const relocated = new Set();

  function requireOriginalNode(nodeId) {
    const id = String(nodeId || '');
    if (id && originalIds.has(id) && !generated.has(id)) nodeIds.add(id);
  }

  function requireOriginalContainer(nodeId) {
    const id = String(nodeId || '');
    if (id && originalIds.has(id) && !generated.has(id)) containerIds.add(id);
  }

  (operations || []).forEach((operation, operationIndex) => {
    if (!operation || typeof operation !== 'object') {
      throw new Error(`第 ${operationIndex + 1} 个操作不是对象`);
    }
    const op = String(operation.op || '');
    requireOriginalNode(operation.node_id);
    requireOriginalContainer(operation.parent_id);

    if (['insert_node', 'move_node'].includes(op) && operation.after_node_id) {
      const parentId = String(operation.parent_id || '');
      const anchorId = String(operation.after_node_id);
      requireOriginalNode(anchorId);
      const currentAnchor = ResumeDom.findNode(working, anchorId);
      const currentParentId = String(currentAnchor && currentAnchor.parent && currentAnchor.parent.id || '');
      if (currentParentId !== parentId) {
        throw new Error(`第 ${operationIndex + 1} 个操作无法执行：插入锚点不属于目标父节点：${anchorId}`);
      }
      const originalAnchor = ResumeDom.findNode(document, anchorId);
      const originallyStable = originalAnchor
        && String(originalAnchor.parent && originalAnchor.parent.id || '') === parentId
        && !relocated.has(anchorId);
      if (originallyStable) {
        insertionPoints.push({
          kind: 'after',
          parent_id: parentId,
          anchor_node_id: anchorId,
        });
      }
    } else if (
      ['insert_node', 'move_node'].includes(op)
      && operation.parent_id
      && !Number.isInteger(operation.index)
      && originalIds.has(String(operation.parent_id))
    ) {
      insertionPoints.push({
        kind: 'append',
        parent_id: String(operation.parent_id),
      });
    } else if (
      ['insert_node', 'move_node'].includes(op)
      && operation.parent_id
      && Number.isInteger(operation.index)
      && originalIds.has(String(operation.parent_id))
    ) {
      insertionPoints.push({
        kind: 'indexed',
        parent_id: String(operation.parent_id),
        index: operation.index,
      });
    }

    if (['wrap_nodes', 'merge_editable_nodes'].includes(op)) {
      const memberIds = (operation.node_ids || []).map(String);
      memberIds.forEach(requireOriginalNode);
      if (originalIds.has(String(operation.parent_id || ''))) {
        ranges.push({
          parent_id: String(operation.parent_id),
          member_node_ids: memberIds,
        });
      }
    }

    try {
      working = ResumeDom.applyDocumentOperations(working, [operation], {
        allowStructure: true,
      });
    } catch (error) {
      const wrapped = new Error(`第 ${operationIndex + 1} 个操作无法执行：${error.message}`);
      wrapped.code = error.code || 'OPERATION_NOT_EXECUTABLE';
      wrapped.operation_index = operationIndex;
      throw wrapped;
    }
    if (op === 'move_node') relocated.add(String(operation.node_id || ''));
  });

  nodeIds.forEach((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found) throw new Error(`DOM 节点不存在：${nodeId}`);
    nodes.push({ node_id: nodeId });
  });

  containerIds.forEach((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found || found.node.type !== 'element') throw new Error(`父节点不存在：${nodeId}`);
    containers.push({ node_id: nodeId, node_type: found.node.type });
  });

  const uniqueInsertionPoints = insertionPoints.filter((point, index, list) =>
    list.findIndex((candidate) => (
      candidate.kind === point.kind
      && candidate.parent_id === point.parent_id
      && candidate.anchor_node_id === point.anchor_node_id
      && candidate.index === point.index
    )) === index);

  const uniqueRanges = ranges.filter((range, index, list) =>
    list.findIndex((candidate) => (
      candidate.parent_id === range.parent_id
      && candidate.member_node_ids.join('\u001f') === range.member_node_ids.join('\u001f')
    )) === index);

  return {
    format: FORMAT,
    nodes,
    containers,
    insertion_points: uniqueInsertionPoints,
    sibling_ranges: uniqueRanges,
    absent_node_ids: Array.from(generated),
  };
}

function validateSiblingRange(document, range) {
  const parent = ResumeDom.findNode(document, range.parent_id);
  if (!parent || parent.node.type !== 'element') return false;
  const childIds = (parent.node.children || []).map((child) => String(child.id));
  const positions = (range.member_node_ids || []).map((nodeId) => childIds.indexOf(String(nodeId)));
  if (!positions.length || positions.some((position) => position < 0)) return false;
  return positions.every((position, index) => (
    index === 0 || position === positions[0] + index
  ));
}

function validateOperationPreconditions(resume, preconditions) {
  if (
    !preconditions
    || (preconditions.format !== FORMAT && !LEGACY_FORMATS.has(preconditions.format))
  ) {
    return { valid: false, errors: ['操作前置条件缺失'] };
  }
  const document = ResumeDom.ensureDocument(resume);
  const errors = [];

  (preconditions.nodes || []).forEach((expected) => {
    const found = ResumeDom.findNode(document, expected.node_id);
    if (!found) {
      errors.push(`相关节点已不存在：${expected.node_id}`);
    }
  });

  (preconditions.containers || []).forEach((expected) => {
    const found = ResumeDom.findNode(document, expected.node_id);
    if (!found || found.node.type !== expected.node_type) {
      errors.push(`目标容器已不存在：${expected.node_id}`);
    }
  });

  (preconditions.insertion_points || []).forEach((point) => {
    const parent = ResumeDom.findNode(document, point.parent_id);
    if (!parent || parent.node.type !== 'element') {
      errors.push(`插入位置已不存在：${point.parent_id}`);
      return;
    }
    if (point.kind === 'after') {
      const anchor = ResumeDom.findNode(document, point.anchor_node_id);
      if (!anchor || String(anchor.parent && anchor.parent.id || '') !== String(point.parent_id)) {
        errors.push(`插入锚点已不存在：${point.anchor_node_id}`);
      }
    }
  });

  (preconditions.sibling_ranges || []).forEach((range) => {
    if (!validateSiblingRange(document, range)) {
      errors.push(`待调整的相邻内容结构已变化：${(range.member_node_ids || []).join('、')}`);
    }
  });

  (preconditions.absent_node_ids || []).forEach((nodeId) => {
    if (ResumeDom.findNode(document, nodeId)) errors.push(`新增节点 ID 已被占用：${nodeId}`);
  });

  return { valid: errors.length === 0, errors };
}

function clonePreconditions(value) {
  return value && (value.format === FORMAT || LEGACY_FORMATS.has(value.format))
    ? deepClone(value)
    : null;
}

module.exports = {
  FORMAT,
  buildOperationPreconditions,
  clonePreconditions,
  operationDependencies,
  validateOperationPreconditions,
};
