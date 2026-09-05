'use strict';

/**
 * 模型只表达“这些现有区域修改完成后是什么样”，本模块负责把最小目标子树
 * 和紧凑新增声明确定性地装配成完整 ResumeDocument。它不是 JSON Patch，
 * 也不依赖多个 DOM 操作的执行顺序。
 */
const ResumeDom = require('../../../resume-dom');
const { deepClone, hashJson } = require('../util');

const TARGET_FRAGMENTS_FORMAT = 'resume-target-fragments-v2';
const LEGACY_TARGET_FRAGMENTS_FORMAT = 'resume-target-fragments-v1';
const SUPPORTED_FORMATS = new Set([
  TARGET_FRAGMENTS_FORMAT,
  LEGACY_TARGET_FRAGMENTS_FORMAT,
]);
const MAX_FRAGMENT_CHANGES = 64;
const MAX_FRAGMENT_CHARS = 200000;

function fragmentError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function normalizeEnvelope(raw) {
  if (Array.isArray(raw)) {
    return {
      format: LEGACY_TARGET_FRAGMENTS_FORMAT,
      changes: raw,
      insertions: [],
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fragmentError('TARGET_FRAGMENTS_INVALID', '目标子树必须是对象');
  }
  const format = String(raw.format || TARGET_FRAGMENTS_FORMAT);
  if (!SUPPORTED_FORMATS.has(format)) {
    throw fragmentError('TARGET_FRAGMENTS_INVALID', `不支持的目标子树协议：${format}`);
  }
  if (Object.hasOwn(raw, 'changes') && !Array.isArray(raw.changes)) {
    throw fragmentError(
      'TARGET_FRAGMENTS_INVALID',
      '目标子树协议中的 changes 必须是数组',
    );
  }
  if (Object.hasOwn(raw, 'insertions') && !Array.isArray(raw.insertions)) {
    throw fragmentError(
      'TARGET_FRAGMENTS_INVALID',
      '目标子树协议中的 insertions 必须是数组',
    );
  }
  if (
    format === LEGACY_TARGET_FRAGMENTS_FORMAT
    && Array.isArray(raw.insertions)
    && raw.insertions.length
  ) {
    throw fragmentError(
      'TARGET_FRAGMENTS_INVALID',
      `${LEGACY_TARGET_FRAGMENTS_FORMAT} 不支持紧凑新增声明`,
    );
  }
  return {
    format,
    changes: Array.isArray(raw.changes) ? raw.changes : [],
    insertions: Array.isArray(raw.insertions) ? raw.insertions : [],
  };
}

function normalizeChanges(envelope) {
  const seen = new Set();
  return envelope.changes.map((rawChange, index) => {
    if (!rawChange || typeof rawChange !== 'object' || Array.isArray(rawChange)) {
      throw fragmentError(
        'TARGET_FRAGMENT_INVALID',
        `第 ${index + 1} 个目标子树变化不是对象`,
        { change_index: index },
      );
    }
    const targetId = String(rawChange.target_id || '').trim();
    if (!targetId) {
      throw fragmentError(
        'TARGET_FRAGMENT_TARGET_MISSING',
        `第 ${index + 1} 个目标子树变化缺少 target_id`,
        { change_index: index },
      );
    }
    if (seen.has(targetId)) {
      throw fragmentError(
        'TARGET_FRAGMENT_DUPLICATE',
        `目标节点重复：${targetId}`,
        { change_index: index, target_id: targetId },
      );
    }
    seen.add(targetId);
    const hasReplacement = Object.hasOwn(rawChange, 'replacement_subtree')
      || Object.hasOwn(rawChange, 'replacement');
    if (!hasReplacement) {
      throw fragmentError(
        'TARGET_FRAGMENT_REPLACEMENT_MISSING',
        `目标节点 ${targetId} 缺少 replacement_subtree；删除节点时请明确返回 null`,
        { change_index: index, target_id: targetId },
      );
    }
    const replacement = Object.hasOwn(rawChange, 'replacement_subtree')
      ? rawChange.replacement_subtree
      : rawChange.replacement;
    if (replacement !== null && (
      !replacement
      || typeof replacement !== 'object'
      || Array.isArray(replacement)
    )) {
      throw fragmentError(
        'TARGET_FRAGMENT_REPLACEMENT_INVALID',
        `目标节点 ${targetId} 的 replacement_subtree 必须是节点对象或 null`,
        { change_index: index, target_id: targetId },
      );
    }
    if (replacement && String(replacement.id || '') !== targetId) {
      throw fragmentError(
        'TARGET_FRAGMENT_ID_MISMATCH',
        `替换子树必须沿用目标节点 ID：${targetId}`,
        {
          change_index: index,
          target_id: targetId,
          replacement_id: replacement.id || null,
        },
      );
    }
    return {
      target_id: targetId,
      replacement_subtree: replacement === null ? null : deepClone(replacement),
    };
  });
}

function normalizeInsertions(envelope) {
  const rootIds = new Set();
  const locations = new Set();
  return envelope.insertions.map((rawInsertion, index) => {
    if (
      !rawInsertion
      || typeof rawInsertion !== 'object'
      || Array.isArray(rawInsertion)
    ) {
      throw fragmentError(
        'TARGET_INSERTION_INVALID',
        `第 ${index + 1} 个新增声明不是对象`,
        { insertion_index: index },
      );
    }
    const parentId = String(rawInsertion.parent_id || '').trim();
    if (!parentId) {
      throw fragmentError(
        'TARGET_INSERTION_PARENT_MISSING',
        `第 ${index + 1} 个新增声明缺少 parent_id`,
        { insertion_index: index },
      );
    }
    if (!Object.hasOwn(rawInsertion, 'after_id')) {
      throw fragmentError(
        'TARGET_INSERTION_ANCHOR_MISSING',
        `第 ${index + 1} 个新增声明缺少 after_id；插入开头时请明确返回 null`,
        { insertion_index: index, parent_id: parentId },
      );
    }
    const afterId = rawInsertion.after_id === null
      ? null
      : String(rawInsertion.after_id || '').trim();
    if (rawInsertion.after_id !== null && !afterId) {
      throw fragmentError(
        'TARGET_INSERTION_ANCHOR_INVALID',
        `第 ${index + 1} 个新增声明的 after_id 无效`,
        { insertion_index: index, parent_id: parentId },
      );
    }
    const locationKey = `${parentId}\u001f${afterId || ''}`;
    if (locations.has(locationKey)) {
      throw fragmentError(
        'TARGET_INSERTION_DUPLICATE_LOCATION',
        `同一插入位置只能声明一次：${parentId} / ${afterId || '开头'}`,
        { insertion_index: index, parent_id: parentId, after_id: afterId },
      );
    }
    locations.add(locationKey);
    const rawSubtrees = Array.isArray(rawInsertion.new_subtrees)
      ? rawInsertion.new_subtrees
      : [];
    if (!rawSubtrees.length) {
      throw fragmentError(
        'TARGET_INSERTION_EMPTY',
        `第 ${index + 1} 个新增声明没有 new_subtrees`,
        { insertion_index: index, parent_id: parentId, after_id: afterId },
      );
    }
    const newSubtrees = rawSubtrees.map((subtree, subtreeIndex) => {
      if (
        !subtree
        || typeof subtree !== 'object'
        || Array.isArray(subtree)
        || subtree.type !== 'element'
      ) {
        throw fragmentError(
          'TARGET_INSERTION_SUBTREE_INVALID',
          `第 ${index + 1} 个新增声明的第 ${subtreeIndex + 1} 个子树必须是元素节点`,
          {
            insertion_index: index,
            subtree_index: subtreeIndex,
            parent_id: parentId,
          },
        );
      }
      const rootId = String(subtree.id || '').trim();
      if (!rootId) {
        throw fragmentError(
          'TARGET_INSERTION_ID_MISSING',
          `第 ${index + 1} 个新增声明的第 ${subtreeIndex + 1} 个子树缺少 id`,
          {
            insertion_index: index,
            subtree_index: subtreeIndex,
            parent_id: parentId,
          },
        );
      }
      if (rootIds.has(rootId)) {
        throw fragmentError(
          'TARGET_INSERTION_ID_DUPLICATE',
          `新增节点 ID 重复：${rootId}`,
          {
            insertion_index: index,
            subtree_index: subtreeIndex,
            parent_id: parentId,
            node_id: rootId,
          },
        );
      }
      rootIds.add(rootId);
      return deepClone(subtree);
    });
    return {
      parent_id: parentId,
      after_id: afterId,
      new_subtrees: newSubtrees,
    };
  });
}

function normalizeFragments(raw) {
  const envelope = normalizeEnvelope(raw);
  if (JSON.stringify(envelope).length > MAX_FRAGMENT_CHARS) {
    throw fragmentError('TARGET_FRAGMENTS_TOO_LARGE', '目标子树结果过大');
  }
  const changes = normalizeChanges(envelope);
  const insertions = normalizeInsertions(envelope);
  const unitCount = changes.length
    + insertions.reduce((total, insertion) => total + insertion.new_subtrees.length, 0);
  if (!unitCount) {
    throw fragmentError('TARGET_FRAGMENTS_EMPTY', '目标子树没有包含任何变化');
  }
  if (unitCount > MAX_FRAGMENT_CHANGES) {
    throw fragmentError(
      'TARGET_FRAGMENTS_TOO_MANY',
      `目标子树一次不能超过 ${MAX_FRAGMENT_CHANGES} 个变化区域或新增节点`,
    );
  }
  return {
    format: envelope.format,
    changes,
    insertions,
  };
}

function collectElementIds(node, ids = []) {
  if (!node || typeof node !== 'object') return ids;
  if (node.type === 'element') {
    const nodeId = String(node.id || '').trim();
    if (!nodeId) {
      throw fragmentError('TARGET_INSERTION_DESCENDANT_ID_MISSING', '新增元素节点缺少 id');
    }
    ids.push(nodeId);
    (node.children || []).forEach((child) => collectElementIds(child, ids));
  }
  return ids;
}

function assertTargets(base, normalized) {
  const targetIds = new Set(normalized.changes.map((change) => change.target_id));
  const deletionIds = new Set(
    normalized.changes
      .filter((change) => change.replacement_subtree === null)
      .map((change) => change.target_id),
  );
  normalized.changes.forEach((change) => {
    const found = ResumeDom.findNode(base, change.target_id);
    if (!found) {
      throw fragmentError(
        'TARGET_FRAGMENT_TARGET_NOT_FOUND',
        `目标子树节点不存在：${change.target_id}`,
        { target_id: change.target_id },
      );
    }
    if (found.node.id === base.root.id && change.replacement_subtree === null) {
      throw fragmentError('TARGET_FRAGMENT_ROOT_DELETE', '不能删除简历根节点');
    }
    const overlappingAncestor = found.ancestors.find((ancestor) =>
      targetIds.has(String(ancestor.id)));
    if (overlappingAncestor) {
      throw fragmentError(
        'TARGET_FRAGMENT_OVERLAP',
        `目标子树不能相互嵌套：${overlappingAncestor.id} → ${change.target_id}`,
        {
          target_id: change.target_id,
          ancestor_target_id: overlappingAncestor.id,
        },
      );
    }
  });

  const existingIds = new Set(collectElementIds(base.root));
  const insertedIds = new Set();
  normalized.insertions.forEach((insertion, insertionIndex) => {
    const parent = ResumeDom.findNode(base, insertion.parent_id);
    if (!parent || parent.node.type !== 'element') {
      throw fragmentError(
        'TARGET_INSERTION_PARENT_NOT_FOUND',
        `新增位置的父节点不存在：${insertion.parent_id}`,
        { insertion_index: insertionIndex, parent_id: insertion.parent_id },
      );
    }
    if (
      targetIds.has(insertion.parent_id)
      || parent.ancestors.some((ancestor) => targetIds.has(String(ancestor.id)))
    ) {
      throw fragmentError(
        'TARGET_INSERTION_OVERLAP',
        `新增位置不能位于被整体替换的目标子树中：${insertion.parent_id}`,
        { insertion_index: insertionIndex, parent_id: insertion.parent_id },
      );
    }
    if (insertion.after_id !== null) {
      const anchor = (parent.node.children || []).find(
        (child) => String(child.id || '') === insertion.after_id,
      );
      if (!anchor) {
        throw fragmentError(
          'TARGET_INSERTION_ANCHOR_NOT_FOUND',
          `新增位置的锚点不是父节点的直接子节点：${insertion.after_id}`,
          {
            insertion_index: insertionIndex,
            parent_id: insertion.parent_id,
            after_id: insertion.after_id,
          },
        );
      }
      if (deletionIds.has(insertion.after_id)) {
        throw fragmentError(
          'TARGET_INSERTION_ANCHOR_DELETED',
          `新增位置的锚点同时被删除：${insertion.after_id}`,
          {
            insertion_index: insertionIndex,
            parent_id: insertion.parent_id,
            after_id: insertion.after_id,
          },
        );
      }
    }
    insertion.new_subtrees.forEach((subtree) => {
      collectElementIds(subtree).forEach((nodeId) => {
        if (existingIds.has(nodeId) || insertedIds.has(nodeId)) {
          throw fragmentError(
            'TARGET_INSERTION_ID_OCCUPIED',
            `新增节点 ID 已存在或重复：${nodeId}`,
            {
              insertion_index: insertionIndex,
              parent_id: insertion.parent_id,
              node_id: nodeId,
            },
          );
        }
        insertedIds.add(nodeId);
      });
    });
  });
}

function collectNodeIds(node, ids = new Set()) {
  if (!node || typeof node !== 'object') return ids;
  if (node.id) ids.add(String(node.id));
  (node.children || []).forEach((child) => collectNodeIds(child, ids));
  return ids;
}

function indexNodes(node, result = new Map()) {
  if (!node || typeof node !== 'object') return result;
  if (node.id) result.set(String(node.id), node);
  (node.children || []).forEach((child) => indexNodes(child, result));
  return result;
}

function mergeCompactRecord(baseValue, rawValue) {
  if (rawValue === null) return {};
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return deepClone(rawValue);
  }
  const result = {
    ...(baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
      ? deepClone(baseValue)
      : {}),
  };
  Object.entries(rawValue).forEach(([key, value]) => {
    if (value === null) delete result[key];
    else result[key] = deepClone(value);
  });
  return result;
}

function replaceCompactText(baseNode, text) {
  if (!baseNode || baseNode.type !== 'element') return deepClone(baseNode);
  try {
    const temporary = ResumeDom.normalizeDocument({
      version: ResumeDom.VERSION,
      root: deepClone(baseNode),
    });
    return ResumeDom.applyOperations(temporary, [{
      op: 'replace_text',
      node_id: String(baseNode.id),
      text: String(text == null ? '' : text),
    }]).root;
  } catch (_) {
    const fallback = deepClone(baseNode);
    fallback.text = String(text == null ? '' : text);
    fallback.children = [];
    return fallback;
  }
}

/**
 * 模型上下文省略展示字段后，v2 变化片段允许只返回真正改变的节点字段。
 * 现有 ID 的缺省字段从基准文档继承；显式 null 表示删除字段。这样模型
 * 不需要复制坐标、CSS 和富文本 run，也不会因为省略它们而破坏排版。
 */
function hydrateCompactNode(rawNode, baseIndex) {
  if (!rawNode || typeof rawNode !== 'object' || Array.isArray(rawNode)) {
    return deepClone(rawNode);
  }
  const nodeId = String(rawNode.id || '');
  const baseNode = nodeId ? baseIndex.get(nodeId) : null;
  if (!baseNode) return deepClone(rawNode);

  let result = Object.hasOwn(rawNode, 'text') && !Object.hasOwn(rawNode, 'children')
    ? replaceCompactText(baseNode, rawNode.text)
    : deepClone(baseNode);
  Object.entries(rawNode).forEach(([key, value]) => {
    if (key === 'children' || key === 'attributes' || key === 'style' || key === 'semantic') {
      return;
    }
    if (key === 'text') {
      if (!Object.hasOwn(rawNode, 'children')) return;
      if (value === null) delete result.text;
      else result.text = String(value == null ? '' : value);
      return;
    }
    if (value === null) delete result[key];
    else result[key] = deepClone(value);
  });
  if (Object.hasOwn(rawNode, 'attributes')) {
    result.attributes = mergeCompactRecord(baseNode.attributes, rawNode.attributes);
  }
  if (Object.hasOwn(rawNode, 'style')) {
    result.style = mergeCompactRecord(baseNode.style, rawNode.style);
  }
  if (Object.hasOwn(rawNode, 'semantic')) {
    result.semantic = mergeCompactRecord(baseNode.semantic, rawNode.semantic);
  }
  if (Object.hasOwn(rawNode, 'children')) {
    if (!Array.isArray(rawNode.children)) {
      throw fragmentError(
        'TARGET_FRAGMENT_CHILDREN_INVALID',
        `目标节点 ${nodeId} 的 children 必须是数组`,
        { target_id: nodeId },
      );
    }
    result.children = rawNode.children.map((child) => hydrateCompactNode(child, baseIndex));
    if (!Object.hasOwn(rawNode, 'text')) delete result.text;
  }
  return result;
}

function hydrateCompactFragments(base, normalized) {
  if (normalized.format !== TARGET_FRAGMENTS_FORMAT) return normalized;
  const baseIndex = indexNodes(base.root);
  return {
    ...normalized,
    changes: normalized.changes.map((change) => ({
      ...change,
      _compact_text_target: Boolean(
        change.replacement_subtree
        && Object.hasOwn(change.replacement_subtree, 'text')
        && !Object.hasOwn(change.replacement_subtree, 'children')
      ),
      replacement_subtree: change.replacement_subtree === null
        ? null
        : hydrateCompactNode(change.replacement_subtree, baseIndex),
    })),
  };
}

function ownNodeSignature(node) {
  const own = deepClone(node);
  if (own && typeof own === 'object') delete own.children;
  return hashJson(own);
}

function directChildIds(node) {
  return (node && node.children || []).map((child) => String(child.id || ''));
}

function sameRelativeOrder(left, right) {
  const rightSet = new Set(right);
  const sharedLeft = left.filter((id) => rightSet.has(id));
  const leftSet = new Set(left);
  const sharedRight = right.filter((id) => leftSet.has(id));
  return hashJson(sharedLeft) === hashJson(sharedRight);
}

function changedDirectChildren(beforeNode, afterNode) {
  const beforeById = new Map(
    (beforeNode.children || []).map((child) => [String(child.id || ''), child]),
  );
  return (afterNode.children || [])
    .filter((child) => {
      const before = beforeById.get(String(child.id || ''));
      return before && hashJson(before) !== hashJson(child);
    })
    .map((child) => String(child.id || ''));
}

function isCollapsedPresentationTextTarget(node) {
  if (!node || node.type !== 'element' || node.editable !== true) return false;
  const children = (node.children || []).filter((child) => child && child.type === 'element');
  return Boolean(children.length) && children.every((child) => (
    ['inline', 'layout_line', 'decoration'].includes(ResumeDom.semanticKind(child))
  ));
}

/**
 * v2 的 changes 必须是真正的最小变化根：
 * - 节点自身字段变化时，该节点就是必要目标；
 * - 调序、包裹或跨父节点移动必须以共同父节点为目标；
 * - 仅某个后代变化，或仅简单增删直接子节点时，返回整个祖先会被拒绝。
 */
function assertMinimalTargets(base, normalized) {
  if (normalized.format !== TARGET_FRAGMENTS_FORMAT) return;
  const baseIds = collectNodeIds(base.root);
  const replacementOwners = new Map();
  normalized.changes.forEach((change) => {
    if (!change.replacement_subtree) return;
    collectNodeIds(change.replacement_subtree).forEach((nodeId) => {
      const owners = replacementOwners.get(nodeId) || new Set();
      owners.add(change.target_id);
      replacementOwners.set(nodeId, owners);
    });
  });

  normalized.changes.forEach((change) => {
    const replacement = change.replacement_subtree;
    if (replacement === null) return;
    const before = ResumeDom.findNode(base, change.target_id).node;
    if (ownNodeSignature(before) !== ownNodeSignature(replacement)) return;

    const beforeIds = directChildIds(before);
    const afterIds = directChildIds(replacement);
    if (!sameRelativeOrder(beforeIds, afterIds)) return;

    const beforeSet = new Set(beforeIds);
    const afterSet = new Set(afterIds);
    const removed = beforeIds.filter((id) => !afterSet.has(id));
    const added = afterIds.filter((id) => !beforeSet.has(id));
    const replacementIds = collectNodeIds(replacement);
    const structuralMoveRequired = (
      removed.some((nodeId) => (
        replacementIds.has(nodeId)
        || Array.from(replacementOwners.get(nodeId) || [])
          .some((ownerId) => ownerId !== change.target_id)
      ))
      || added.some((nodeId) => baseIds.has(nodeId))
      || added.some((nodeId) => {
        const addedNode = (replacement.children || [])
          .find((child) => String(child.id || '') === nodeId);
        return Array.from(collectNodeIds(addedNode))
          .some((descendantId) => descendantId !== nodeId && baseIds.has(descendantId));
      })
    );
    if (structuralMoveRequired) return;

    const changedChildren = changedDirectChildren(before, replacement);
    if (
      change._compact_text_target
      && isCollapsedPresentationTextTarget(before)
    ) return;
    if (!removed.length && !added.length && !changedChildren.length) return;
    throw fragmentError(
      'TARGET_FRAGMENT_NOT_MINIMAL',
      `目标子树 ${change.target_id} 不是最小变化区域；请只返回实际变化的子节点，新增内容使用 insertions`,
      {
        target_id: change.target_id,
        changed_child_ids: changedChildren,
        removed_child_ids: removed,
        added_child_ids: added,
      },
    );
  });
}

function materializeTargetFragments(baseValue, rawFragments) {
  const base = ResumeDom.toResumeDocument(baseValue);
  const normalized = hydrateCompactFragments(base, normalizeFragments(rawFragments));
  assertTargets(base, normalized);
  assertMinimalTargets(base, normalized);
  const replacements = new Map(
    normalized.changes.map((change) => [change.target_id, change.replacement_subtree]),
  );
  const insertionsByParent = new Map();
  normalized.insertions.forEach((insertion) => {
    const byAnchor = insertionsByParent.get(insertion.parent_id) || new Map();
    byAnchor.set(insertion.after_id, insertion.new_subtrees);
    insertionsByParent.set(insertion.parent_id, byAnchor);
  });

  function rebuild(node) {
    if (replacements.has(String(node.id))) {
      const replacement = replacements.get(String(node.id));
      return replacement === null ? null : deepClone(replacement);
    }
    if (!node || node.type !== 'element') return deepClone(node);
    const byAnchor = insertionsByParent.get(String(node.id)) || new Map();
    const children = [];
    (byAnchor.get(null) || []).forEach((subtree) => children.push(deepClone(subtree)));
    (node.children || []).forEach((child) => {
      const rebuilt = rebuild(child);
      if (rebuilt) children.push(rebuilt);
      (byAnchor.get(String(child.id || '')) || [])
        .forEach((subtree) => children.push(deepClone(subtree)));
    });
    return {
      ...deepClone(node),
      children,
    };
  }

  const root = rebuild(base.root);
  if (!root) throw fragmentError('TARGET_FRAGMENT_ROOT_DELETE', '不能删除简历根节点');
  let document;
  try {
    document = ResumeDom.toResumeDocument({
      ...deepClone(base),
      root,
    }, { allowLegacyAiScope: false });
  } catch (error) {
    throw fragmentError(
      error.code || 'TARGET_FRAGMENT_DOCUMENT_INVALID',
      `目标子树无法形成合法简历：${error.message}`,
      { cause_code: error.code || null },
    );
  }
  return {
    format: normalized.format,
    changes: normalized.changes.map((change) => {
      const { _compact_text_target: _ignored, ...publicChange } = change;
      return publicChange;
    }),
    insertions: normalized.insertions,
    document,
  };
}

module.exports = {
  TARGET_FRAGMENTS_FORMAT,
  LEGACY_TARGET_FRAGMENTS_FORMAT,
  MAX_FRAGMENT_CHANGES,
  normalizeTargetFragments: normalizeFragments,
  materializeTargetFragments,
  assertMinimalTargets,
};
