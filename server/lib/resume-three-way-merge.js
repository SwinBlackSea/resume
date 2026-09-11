'use strict';

/**
 * ResumeDocument 三方合并。
 *
 * A（base）是模型读取的草稿，B（target）是模型给出的目标文档，
 * C（current）是用户点击“应用修改”时的最新草稿。本模块计算：
 *
 *   D = merge(A → B, C)
 *
 * AI 未涉及的字段和节点保留 C；AI 明确修改的字段、位置和删除采用 B。
 * 只有目标节点/父节点客观不存在、ID 被并发占用或合并后形成非法结构时失败。
 */
const ResumeDom = require('../../resume-dom');
const { canonicalJson, deepClone, hashJson } = require('./util');

const FORMAT = 'resume-three-way-merge-v1';

function mergeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function sameValue(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function nodeShell(node) {
  const shell = deepClone(node);
  delete shell.children;
  return shell;
}

function flatten(documentValue) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const entries = new Map();
  const children = new Map();

  function visit(node, parentId, index, depth) {
    const id = String(node.id);
    entries.set(id, {
      id,
      node: deepClone(node),
      shell: nodeShell(node),
      parent_id: parentId,
      index,
      depth,
    });
    const childIds = (node.children || []).map((child) => String(child.id));
    children.set(id, childIds);
    (node.children || []).forEach((child, childIndex) => {
      visit(child, id, childIndex, depth + 1);
    });
  }

  visit(document.root, null, 0, 0);
  return { document, entries, children };
}

function previousSharedSibling(flat, entry, sharedIds) {
  if (!entry || !entry.parent_id) return null;
  const siblings = flat.children.get(String(entry.parent_id)) || [];
  const position = siblings.indexOf(String(entry.id));
  for (let index = position - 1; index >= 0; index -= 1) {
    if (sharedIds.has(siblings[index])) return siblings[index];
  }
  return null;
}

function locationChanged(baseFlat, targetFlat, nodeId, sharedIds) {
  const left = baseFlat.entries.get(nodeId);
  const right = targetFlat.entries.get(nodeId);
  if (!left || !right) return true;
  if (String(left.parent_id || '') !== String(right.parent_id || '')) return true;
  return previousSharedSibling(baseFlat, left, sharedIds)
    !== previousSharedSibling(targetFlat, right, sharedIds);
}

function childSequenceChanged(baseFlat, targetFlat, nodeId) {
  return !sameValue(
    baseFlat.children.get(nodeId) || [],
    targetFlat.children.get(nodeId) || [],
  );
}

function mergeValue(base, target, current, path, overriddenPaths) {
  if (sameValue(target, base)) return deepClone(current);
  if (sameValue(current, base) || sameValue(current, target)) return deepClone(target);

  if (isPlainObject(base) && isPlainObject(target) && isPlainObject(current)) {
    const result = {};
    const keys = new Set([
      ...Object.keys(base),
      ...Object.keys(target),
      ...Object.keys(current),
    ]);
    keys.forEach((key) => {
      const merged = mergeValue(
        base[key],
        target[key],
        current[key],
        `${path}.${key}`,
        overriddenPaths,
      );
      if (merged !== undefined) result[key] = merged;
    });
    return result;
  }

  overriddenPaths.push(path);
  return deepClone(target);
}

function relationOf(flat, nodeId) {
  const entry = flat.entries.get(nodeId);
  return entry
    ? { parent_id: entry.parent_id, index: entry.index }
    : null;
}

function documentChangeCount(before, after) {
  const left = ResumeDom.toResumeDocument(before);
  const right = ResumeDom.toResumeDocument(after);
  const nodeChanges = ResumeDom.compareDocuments(left, right).changes.length;
  const metadataChanges = ['page_setup', 'styles', 'assets', 'annotations']
    .filter((key) => !sameValue(left[key], right[key])).length;
  return nodeChanges + metadataChanges;
}

function sameRelation(left, right) {
  return Boolean(left && right)
    && String(left.parent_id || '') === String(right.parent_id || '')
    && left.index === right.index;
}

function topLevelChangedNodeIds(before, after) {
  const comparison = ResumeDom.compareDocuments(before, after);
  const candidates = Array.from(new Set(
    comparison.changes.map((change) => String(change.node_id || '')).filter(Boolean),
  ));
  const beforeDocument = ResumeDom.toResumeDocument(before);
  const afterDocument = ResumeDom.toResumeDocument(after);
  const candidateSet = new Set(candidates);
  return candidates.filter((nodeId) => {
    const found = ResumeDom.findNode(afterDocument, nodeId)
      || ResumeDom.findNode(beforeDocument, nodeId);
    return !found || !found.ancestors.some((ancestor) =>
      candidateSet.has(String(ancestor.id)));
  });
}

function mergeResumeDocuments({ base, target, current }) {
  const baseFlat = flatten(base);
  const targetFlat = flatten(target);
  const currentFlat = flatten(current);
  const baseRootId = String(baseFlat.document.root.id);
  const targetRootId = String(targetFlat.document.root.id);
  const currentRootId = String(currentFlat.document.root.id);

  if (targetRootId !== baseRootId) {
    throw mergeError(
      'TARGET_ROOT_CHANGED',
      'AI 返回的目标文档改变了根节点 ID',
      { base_root_id: baseRootId, target_root_id: targetRootId },
    );
  }
  if (currentRootId !== baseRootId) {
    throw mergeError(
      'CURRENT_ROOT_CHANGED',
      '当前草稿已经切换为另一份文档',
      { base_root_id: baseRootId, current_root_id: currentRootId },
    );
  }

  const baseIds = new Set(baseFlat.entries.keys());
  const targetIds = new Set(targetFlat.entries.keys());
  const currentIds = new Set(currentFlat.entries.keys());
  const sharedIds = new Set([...baseIds].filter((id) => targetIds.has(id)));
  const addedIds = new Set([...targetIds].filter((id) => !baseIds.has(id)));
  const removedIds = new Set([...baseIds].filter((id) => !targetIds.has(id)));
  const relationChangedIds = new Set();
  const touchedIds = new Set();

  sharedIds.forEach((nodeId) => {
    const ownChanged = !sameValue(
      baseFlat.entries.get(nodeId).shell,
      targetFlat.entries.get(nodeId).shell,
    );
    const moved = locationChanged(baseFlat, targetFlat, nodeId, sharedIds);
    const childrenChanged = childSequenceChanged(baseFlat, targetFlat, nodeId);
    if (moved) relationChangedIds.add(nodeId);
    if (ownChanged || moved || childrenChanged) touchedIds.add(nodeId);
  });
  addedIds.forEach((nodeId) => touchedIds.add(nodeId));
  removedIds.forEach((nodeId) => touchedIds.add(nodeId));

  const includedIds = new Set(
    [...currentIds].filter((nodeId) => !removedIds.has(nodeId)),
  );
  const overriddenPaths = [];

  addedIds.forEach((nodeId) => {
    if (currentIds.has(nodeId)) {
      const sameConcurrentNode = sameValue(
        targetFlat.entries.get(nodeId).node,
        currentFlat.entries.get(nodeId).node,
      ) && sameRelation(
        relationOf(targetFlat, nodeId),
        relationOf(currentFlat, nodeId),
      );
      if (!sameConcurrentNode) {
        throw mergeError(
          'ADDED_NODE_ID_OCCUPIED',
          'AI 新增内容使用的节点 ID 已被当前草稿占用',
          { node_id: nodeId },
        );
      }
    }
    includedIds.add(nodeId);
  });

  sharedIds.forEach((nodeId) => {
    if (currentIds.has(nodeId)) return;
    if (touchedIds.has(nodeId)) {
      throw mergeError(
        'CHANGED_NODE_MISSING',
        'AI 要修改的内容在当前草稿中已经不存在',
        { node_id: nodeId },
      );
    }
    includedIds.delete(nodeId);
  });

  const shells = new Map();
  includedIds.forEach((nodeId) => {
    const baseEntry = baseFlat.entries.get(nodeId);
    const targetEntry = targetFlat.entries.get(nodeId);
    const currentEntry = currentFlat.entries.get(nodeId);
    if (addedIds.has(nodeId)) {
      shells.set(nodeId, deepClone(targetEntry.shell));
      return;
    }
    if (baseEntry && targetEntry && currentEntry) {
      shells.set(nodeId, mergeValue(
        baseEntry.shell,
        targetEntry.shell,
        currentEntry.shell,
        `nodes.${nodeId}`,
        overriddenPaths,
      ));
      return;
    }
    if (currentEntry) shells.set(nodeId, deepClone(currentEntry.shell));
  });

  const parentById = new Map();
  includedIds.forEach((nodeId) => {
    if (nodeId === baseRootId) {
      parentById.set(nodeId, null);
      return;
    }
    if (addedIds.has(nodeId) || relationChangedIds.has(nodeId)) {
      parentById.set(nodeId, targetFlat.entries.get(nodeId).parent_id);
      const baseRelation = relationOf(baseFlat, nodeId);
      const currentRelation = relationOf(currentFlat, nodeId);
      const targetRelation = relationOf(targetFlat, nodeId);
      if (
        baseRelation
        && currentRelation
        && !sameRelation(baseRelation, currentRelation)
        && !sameRelation(currentRelation, targetRelation)
      ) {
        overriddenPaths.push(`nodes.${nodeId}.location`);
      }
      return;
    }
    const currentEntry = currentFlat.entries.get(nodeId);
    parentById.set(nodeId, currentEntry ? currentEntry.parent_id : null);
  });

  // AI 删除某个容器时，当前草稿后来插入到该容器中的新节点也随容器删除。
  // 其余父节点丢失均表示目标结构已无法可靠重放。
  let pruned = true;
  while (pruned) {
    pruned = false;
    [...includedIds].forEach((nodeId) => {
      if (nodeId === baseRootId) return;
      const parentId = parentById.get(nodeId);
      if (parentId && includedIds.has(String(parentId))) return;
      const controlledByTarget = addedIds.has(nodeId) || relationChangedIds.has(nodeId);
      if (controlledByTarget) {
        throw mergeError(
          'TARGET_PARENT_MISSING',
          'AI 修改所需的目标位置在当前草稿中已经不存在',
          { node_id: nodeId, parent_id: parentId || null },
        );
      }
      includedIds.delete(nodeId);
      shells.delete(nodeId);
      parentById.delete(nodeId);
      pruned = true;
    });
  }

  // 防止 A→B 与 A→C 的并发移动组合成循环结构。
  includedIds.forEach((nodeId) => {
    const seen = new Set([nodeId]);
    let parentId = parentById.get(nodeId);
    while (parentId) {
      if (seen.has(String(parentId))) {
        throw mergeError(
          'MERGED_STRUCTURE_CYCLE',
          'AI 修改与当前结构组合后形成了循环层级',
          { node_id: nodeId, parent_id: parentId },
        );
      }
      seen.add(String(parentId));
      parentId = parentById.get(String(parentId));
    }
  });

  const childrenByParent = new Map();
  includedIds.forEach((nodeId) => {
    const parentId = parentById.get(nodeId);
    if (!parentId) return;
    const children = childrenByParent.get(String(parentId)) || [];
    children.push(nodeId);
    childrenByParent.set(String(parentId), children);
  });

  childrenByParent.forEach((assignedIds, parentId) => {
    const assigned = new Set(assignedIds);
    const currentOrder = (currentFlat.children.get(parentId) || [])
      .filter((nodeId) => assigned.has(nodeId));
    const targetOrder = (targetFlat.children.get(parentId) || [])
      .filter((nodeId) => assigned.has(nodeId));
    const controlled = new Set(targetOrder.filter((nodeId) =>
      addedIds.has(nodeId) || relationChangedIds.has(nodeId)));
    const result = currentOrder.filter((nodeId) => !controlled.has(nodeId));

    targetOrder.forEach((nodeId, targetIndex) => {
      if (!controlled.has(nodeId)) return;
      const previous = targetOrder
        .slice(0, targetIndex)
        .reverse()
        .find((candidate) => result.includes(candidate));
      const next = targetOrder
        .slice(targetIndex + 1)
        .find((candidate) => result.includes(candidate));
      if (previous) {
        result.splice(result.indexOf(previous) + 1, 0, nodeId);
      } else if (next) {
        result.splice(result.indexOf(next), 0, nodeId);
      } else {
        result.splice(Math.min(targetIndex, result.length), 0, nodeId);
      }
    });

    assignedIds.forEach((nodeId) => {
      if (!result.includes(nodeId)) result.push(nodeId);
    });
    childrenByParent.set(parentId, result);
  });

  function buildNode(nodeId, stack = new Set()) {
    if (stack.has(nodeId)) {
      throw mergeError('MERGED_STRUCTURE_CYCLE', '合并后的简历结构包含循环节点', {
        node_id: nodeId,
      });
    }
    const shell = shells.get(nodeId);
    if (!shell) {
      throw mergeError('MERGED_NODE_MISSING', '合并后的简历缺少必要节点', {
        node_id: nodeId,
      });
    }
    const nextStack = new Set(stack);
    nextStack.add(nodeId);
    const node = deepClone(shell);
    if (node.type === 'element') {
      node.children = (childrenByParent.get(nodeId) || [])
        .map((childId) => buildNode(childId, nextStack));
    } else {
      delete node.children;
    }
    return node;
  }

  const baseDocument = baseFlat.document;
  const targetDocument = targetFlat.document;
  const currentDocument = currentFlat.document;
  const metadata = {};
  ['page_setup', 'styles', 'assets', 'annotations'].forEach((key) => {
    metadata[key] = mergeValue(
      baseDocument[key],
      targetDocument[key],
      currentDocument[key],
      key,
      overriddenPaths,
    );
  });

  let document;
  try {
    document = ResumeDom.toResumeDocument({
      schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
      root: buildNode(baseRootId),
      ...metadata,
    });
  } catch (error) {
    throw mergeError(
      error.code || 'MERGED_DOCUMENT_INVALID',
      `合并后的简历结构无效：${error.message}`,
      { cause_code: error.code || null },
    );
  }

  const currentComparison = ResumeDom.compareDocuments(baseDocument, currentDocument);
  return {
    format: FORMAT,
    document,
    rebased: !currentComparison.equal,
    ai_change_count: documentChangeCount(baseDocument, targetDocument),
    current_change_count: documentChangeCount(baseDocument, currentDocument),
    applied_change_count: documentChangeCount(currentDocument, document),
    changed_node_ids: topLevelChangedNodeIds(currentDocument, document),
    overridden_paths: Array.from(new Set(overriddenPaths)),
  };
}

function canMergeResumeDocuments(input) {
  try {
    const result = mergeResumeDocuments(input);
    return { valid: true, result, errors: [] };
  } catch (error) {
    return {
      valid: false,
      result: null,
      errors: [{
        code: error.code || 'RESUME_MERGE_FAILED',
        message: error.message,
        node_id: error.node_id || null,
        parent_id: error.parent_id || null,
      }],
    };
  }
}

module.exports = {
  FORMAT,
  mergeResumeDocuments,
  canMergeResumeDocuments,
  topLevelChangedNodeIds,
};
