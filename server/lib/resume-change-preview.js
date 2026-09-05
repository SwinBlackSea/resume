'use strict';

/**
 * AI 建议的通用展示层。
 *
 * target_resume_document 是新协议的目标状态；operations / resume_json 只用于兼容
 * 旧建议。preview 由当前草稿与可合并后的目标结果派生，不能反向生成写入动作，
 * 也不参与并发或权限判断。
 */
const ResumeDom = require('../../resume-dom');
const { mergeResumeDocuments } = require('./resume-three-way-merge');
const { hashJson } = require('./util');

const FORMAT = 'resume-change-preview-v1';

function count(counts, key) {
  return Number(counts && counts[key] || 0);
}

function summarizeCounts(counts) {
  const added = count(counts, 'added');
  const removed = count(counts, 'removed');
  const text = count(counts, 'text');
  const moved = count(counts, 'moved');
  const structure = count(counts, 'structure');
  const visual = count(counts, 'style') + count(counts, 'attributes');
  const parts = [];

  if (added && removed) {
    parts.push(`将${removed}项内容调整为${added}项`);
  } else if (added) {
    parts.push(`新增${added}项内容`);
  } else if (removed) {
    parts.push(`删除${removed}项内容`);
  }
  if (text) parts.push(`修改${text}处文字`);
  if (moved) parts.push(`调整${moved}项内容的位置`);
  if (structure) parts.push(`调整${structure}处内容结构`);
  if (visual) parts.push(`调整${visual}处显示效果`);

  return parts.join('，') || '调整简历内容';
}

function sideItems(changes, side, documentValue) {
  const textKey = `${side}_text`;
  const orderKey = `${side}_order`;
  const excludedType = side === 'before' ? 'added' : 'removed';
  const byNode = new Map();

  changes.forEach((change) => {
    if (change.type === excludedType) return;
    const nodeId = String(change.node_id || '');
    if (!nodeId) return;
    const existing = byNode.get(nodeId);
    const item = existing || {
      node_id: nodeId,
      label: String(change.label || ''),
      text: String(change[textKey] || ''),
      order: Number.isFinite(change[orderKey]) ? change[orderKey] : Number.MAX_SAFE_INTEGER,
      change_types: [],
    };
    if (!item.text && change[textKey]) item.text = String(change[textKey]);
    if (!item.label && change.label) item.label = String(change.label);
    if (!item.change_types.includes(change.type)) item.change_types.push(change.type);
    byNode.set(nodeId, item);
  });

  const document = ResumeDom.toResumeDocument(documentValue);
  const topLevelItems = [...byNode.values()].filter((item) => {
    const found = ResumeDom.findNode(document, item.node_id);
    if (!found) return true;
    return !found.ancestors.some((ancestor) => byNode.has(String(ancestor.id)));
  });

  return topLevelItems
    .sort((left, right) => left.order - right.order || left.node_id.localeCompare(right.node_id))
    .map(({ order, ...item }) => item);
}

function groupedChildTexts(documentValue, nodeId) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const found = ResumeDom.findNode(document, nodeId);
  if (
    !found
    || found.node.type !== 'element'
    || found.node.editable
  ) {
    return [];
  }
  const texts = [];
  const visit = (node) => {
    if (node.type === 'element' && node.editable) {
      const text = ResumeDom.nodeText(node).trim();
      if (text) texts.push(text);
      return;
    }
    (node.children || []).forEach(visit);
  };
  (found.node.children || []).forEach(visit);
  return texts;
}

function displayText(items, documentValue) {
  return items
    .map((item) => {
      const groupedTexts = groupedChildTexts(documentValue, item.node_id);
      return groupedTexts.length
        ? groupedTexts.join('\n')
        : item.text.trim() || '（空白内容）';
    })
    .join('\n');
}

function semanticItemCount(items, documentValue) {
  return items.reduce((total, item) => {
    const groupedTexts = groupedChildTexts(documentValue, item.node_id);
    return total + (groupedTexts.length || 1);
  }, 0);
}

function singleModuleLabel(items, documentValue) {
  if (items.length !== 1) return '';
  const document = ResumeDom.toResumeDocument(documentValue);
  const found = ResumeDom.findNode(document, items[0].node_id);
  if (!found || found.node.type !== 'element' || found.node.tag !== 'section') return '';
  const title = (found.node.children || []).find((child) =>
    child.type === 'element' && /^h[1-6]$/.test(String(child.tag || '')));
  const titleText = title ? ResumeDom.nodeText(title).trim() : '';
  if (titleText) return titleText.slice(0, 40);
  const explicit = String(found.node.label || items[0].label || '').trim();
  return explicit.slice(0, 40);
}

function textTokens(text) {
  return (
    String(text || '')
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)
    || []
  );
}

function sameContent(beforeText, afterText, order = 'preserve') {
  const beforeTokens = textTokens(beforeText);
  const afterTokens = textTokens(afterText);
  if (order === 'reorder') {
    beforeTokens.sort();
    afterTokens.sort();
  }
  return beforeTokens.join('\u001f') === afterTokens.join('\u001f');
}

function summarizeSemanticChange({
  comparison,
  beforeItems,
  afterItems,
  beforeText,
  afterText,
  constraints,
  before,
  after,
}) {
  const counts = comparison.counts || {};
  const beforeCount = semanticItemCount(beforeItems, before);
  const afterCount = semanticItemCount(afterItems, after);
  const hasTopology = [
    count(counts, 'added'),
    count(counts, 'removed'),
    count(counts, 'structure'),
  ].some(Boolean);
  const hasMoved = count(counts, 'moved') > 0;
  const editingIdentityIds = Array.from(new Set(
    comparison.changes
      .filter((change) => {
        if (!['added', 'removed', 'structure'].includes(change.type)) return false;
        const left = ResumeDom.findNode(before, change.node_id);
        const right = ResumeDom.findNode(after, change.node_id);
        return Boolean(left && left.node.editable) !== Boolean(right && right.node.editable);
      })
      .map((change) => String(change.node_id)),
  ));
  const beforeEditingCount = editingIdentityIds.filter((nodeId) => {
    const found = ResumeDom.findNode(before, nodeId);
    return found && found.node.editable;
  }).length;
  const afterEditingCount = editingIdentityIds.filter((nodeId) => {
    const found = ResumeDom.findNode(after, nodeId);
    return found && found.node.editable;
  }).length;
  const hasStructure = hasTopology || hasMoved || editingIdentityIds.length > 0;
  const visualAttributeCount = comparison.changes.filter((change) =>
    change.type === 'attributes').length;
  const visualCount = count(counts, 'style') + visualAttributeCount;
  const hasVisual = visualCount > 0;
  const contentOrder = constraints && constraints.content_order === 'reorder'
    ? 'reorder'
    : 'preserve';
  const contentPreserved = constraints && constraints.content === 'preserve'
    ? true
    : sameContent(beforeText, afterText, contentOrder);
  const removedModuleLabel = afterCount === 0
    ? singleModuleLabel(beforeItems, before)
    : '';
  const addedModuleLabel = beforeCount === 0
    ? singleModuleLabel(afterItems, after)
    : '';
  const addedIds = new Set(
    comparison.changes
      .filter((change) => change.type === 'added')
      .map((change) => String(change.node_id)),
  );
  const removedIds = new Set(
    comparison.changes
      .filter((change) => change.type === 'removed')
      .map((change) => String(change.node_id)),
  );
  const wrappedItems = comparison.changes.filter((change) => {
    if (change.type !== 'moved') return false;
    const found = ResumeDom.findNode(after, change.node_id);
    return found && found.ancestors.some((ancestor) => addedIds.has(String(ancestor.id)));
  });
  const unwrappedItems = comparison.changes.filter((change) => {
    if (change.type !== 'moved') return false;
    const found = ResumeDom.findNode(before, change.node_id);
    return found && found.ancestors.some((ancestor) => removedIds.has(String(ancestor.id)));
  });
  const parts = [];

  if (
    editingIdentityIds.length
    && beforeEditingCount !== afterEditingCount
    && contentPreserved
  ) {
    if (beforeEditingCount > afterEditingCount) {
      parts.push(`将${beforeEditingCount}个 AI 编辑节点合并为${afterEditingCount}个`);
    } else if (afterEditingCount > beforeEditingCount) {
      parts.push(`将${beforeEditingCount}个 AI 编辑节点拆分为${afterEditingCount}个`);
    } else {
      parts.push('调整 AI 编辑节点');
    }
    parts.push(contentPreserved ? '文字保持不变' : '同时调整文字');
  } else if (hasStructure) {
    if (wrappedItems.length) {
      parts.push(`将${wrappedItems.length}项内容归入同一区域`);
    } else if (unwrappedItems.length) {
      parts.push(`将${unwrappedItems.length}项内容移出原分组`);
    } else if (beforeCount > afterCount && afterCount > 0) {
      parts.push(`将${beforeCount}项内容合并为${afterCount}项`);
    } else if (afterCount > beforeCount && beforeCount > 0) {
      parts.push(`将${beforeCount}项内容拆分为${afterCount}项`);
    } else if (hasTopology && beforeCount === afterCount && beforeCount > 0) {
      parts.push(`调整${beforeCount}项内容的组织方式`);
    } else if (hasMoved) {
      parts.push(`调整${count(counts, 'moved')}项内容的位置`);
    } else if (!beforeCount && afterCount) {
      parts.push(
        addedModuleLabel
          ? `新增“${addedModuleLabel}”模块`
          : `新增${afterCount}项内容`,
      );
    } else if (beforeCount && !afterCount) {
      parts.push(
        removedModuleLabel
          ? `删除“${removedModuleLabel}”模块`
          : `删除${beforeCount}项内容`,
      );
    } else {
      parts.push('调整内容结构');
    }
    if (contentPreserved) {
      parts.push('文字保持不变');
    } else if (count(counts, 'text')) {
      parts.push(`修改${count(counts, 'text')}处文字`);
    } else if (beforeCount > 0 && afterCount > 0) {
      parts.push('同时调整文字');
    }
  } else if (count(counts, 'text')) {
    parts.push(`修改${count(counts, 'text')}处文字`);
  }

  if (hasVisual) parts.push(`调整${visualCount}处显示效果`);

  const semanticBeforeCount = beforeEditingCount
    || wrappedItems.length
    || unwrappedItems.length
    || beforeCount;
  const semanticAfterCount = afterEditingCount
    || wrappedItems.length
    || unwrappedItems.length
    || afterCount;
  return {
    summary: parts.join('，') || summarizeCounts(counts),
    semantics: {
      content: contentPreserved ? 'preserved' : 'modified',
      structure: hasStructure ? 'modified' : 'preserved',
      style: hasVisual ? 'modified' : 'preserved',
      before_item_count: semanticBeforeCount,
      after_item_count: semanticAfterCount,
      grouping: wrappedItems.length
        ? 'grouped'
        : unwrappedItems.length
          ? 'ungrouped'
          : 'unchanged',
      editing_nodes: editingIdentityIds.length ? 'modified' : 'unchanged',
    },
  };
}

function buildChangePreview(beforeValue, afterValue, options = {}) {
  const before = ResumeDom.toResumeDocument(beforeValue);
  const after = ResumeDom.toResumeDocument(afterValue);
  const documentComparison = ResumeDom.compareDocuments(before, after);
  const metadataChanges = [
    ['page_setup', 'style', '页面设置'],
    ['styles', 'style', '整体样式'],
    ['assets', 'style', '文档资源'],
    ['annotations', 'structure', '文档标记'],
  ].filter(([key]) => hashJson(before[key]) !== hashJson(after[key]))
    .map(([metadataKey, type, label]) => ({
      type,
      node_id: '',
      label,
      metadata_key: metadataKey,
    }));
  const comparison = {
    ...documentComparison,
    equal: documentComparison.equal && metadataChanges.length === 0,
    changes: documentComparison.changes.concat(metadataChanges),
    counts: {
      ...(documentComparison.counts || {}),
      style: count(documentComparison.counts, 'style')
        + metadataChanges.filter((change) => change.type === 'style').length,
      structure: count(documentComparison.counts, 'structure')
        + metadataChanges.filter((change) => change.type === 'structure').length,
    },
  };
  const beforeItems = sideItems(comparison.changes, 'before', before);
  const afterItems = sideItems(comparison.changes, 'after', after);
  const beforeText = displayText(beforeItems, before);
  const afterText = displayText(afterItems, after);
  const semantic = summarizeSemanticChange({
    comparison,
    beforeItems,
    afterItems,
    beforeText,
    afterText,
    constraints: options.constraints,
    before,
    after,
  });
  const changes = comparison.changes.map((change) => {
    const {
      before_text: beforeText,
      after_text: afterText,
      ...metadata
    } = change;
    return metadata;
  });

  return {
    format: FORMAT,
    complete: true,
    summary: semantic.summary,
    semantics: semantic.semantics,
    based_on_revision: Number.isFinite(options.revision) ? options.revision : null,
    before: {
      text: beforeText,
    },
    after: {
      text: afterText,
    },
    changes,
    counts: comparison.counts,
  };
}

function previewProposalOnResume(proposal, resume, revision) {
  if (!proposal || typeof proposal !== 'object') return null;
  const before = ResumeDom.toResumeDocument(resume);
  let after;
  if (
    proposal.merge_strategy === 'three_way_target_document'
    && proposal.base_resume_json
    && proposal.target_resume_document
  ) {
    after = mergeResumeDocuments({
      base: proposal.base_resume_json,
      target: proposal.target_resume_document,
      current: before,
    }).document;
  } else if (Array.isArray(proposal.operations) && proposal.operations.length) {
    after = ResumeDom.applyDocumentOperations(before, proposal.operations, { allowStructure: true });
  } else if (proposal.resume_json && typeof proposal.resume_json === 'object') {
    after = ResumeDom.toResumeDocument(proposal.resume_json);
  } else {
    return null;
  }
  const preview = buildChangePreview(before, after, {
    revision,
    constraints: proposal.change_policy && proposal.change_policy.constraints
      || proposal.change_constraints,
  });
  if (!preview.changes.length) {
    const target = proposal.scope_id ? ResumeDom.findNode(before, proposal.scope_id) : null;
    const currentText = target
      ? ResumeDom.nodeText(target.node).trim()
      : String(proposal.suggestion || '').trim();
    preview.already_satisfied = true;
    preview.summary = '当前内容已符合建议';
    preview.before.text = currentText || '（当前简历已包含建议结果）';
    preview.after.text = preview.before.text;
  }
  return preview;
}

module.exports = {
  FORMAT,
  buildChangePreview,
  previewProposalOnResume,
  summarizeCounts,
  summarizeSemanticChange,
};
