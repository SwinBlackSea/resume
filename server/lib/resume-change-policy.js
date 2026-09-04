'use strict';

/**
 * AI 简历修改的一致性策略。
 *
 * Resume Harness 负责把用户语义整理为机器可读约束；本模块不猜测自然语言，
 * 只比较操作执行前后的真实 ResumeDocument。它不执行写入，也不根据摘要反推操作。
 */
const ResumeDom = require('../../resume-dom');
const { deepClone, hashJson } = require('./util');

const CONSTRAINTS_FORMAT = 'resume-change-constraints-v2-region-boundaries';
const AUTHORIZATION_FORMAT = 'resume-change-authorization-v2-region-boundaries';
const LEGACY_AUTHORIZATION_FORMAT = 'resume-change-authorization-v1';
const CONTENT_MODES = new Set(['preserve', 'modify']);
const CONTENT_ORDERS = new Set(['preserve', 'reorder']);
const CHANGE_MODES = new Set(['preserve', 'modify']);

function policyError(code, message, details = {}) {
  return { code, message, ...details };
}

function existingRegionIds(documentValue, ids) {
  const document = ResumeDom.toResumeDocument(documentValue);
  return Array.from(new Set((ids || []).map(String).filter(Boolean)))
    .filter((nodeId) => ResumeDom.findNode(document, nodeId));
}

function uniqueIds(ids) {
  return Array.from(new Set((ids || []).map(String).filter(Boolean)));
}

function defaultRegionIds(documentValue, context = {}) {
  const document = ResumeDom.toResumeDocument(documentValue);
  if (context.scopeType === 'RESUME_DOCUMENT') return [document.root.id];
  const scopeRegion = context.scopeRegion || {};
  const roots = existingRegionIds(document, scopeRegion.root_node_ids);
  if (roots.length) return roots;
  return existingRegionIds(document, [context.scopeId]);
}

function topLevelRegionRoots(documentValue, ids) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const requested = new Set(uniqueIds(ids));
  return uniqueIds(ids).filter((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found) return false;
    return !found.ancestors.some((ancestor) => requested.has(String(ancestor.id)));
  });
}

function describeAllowedRegions(documentValue, ids) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const roots = topLevelRegionRoots(document, ids);
  const byParent = new Map();
  const standalone = [];

  roots.forEach((nodeId) => {
    const found = ResumeDom.findNode(document, nodeId);
    if (!found || !found.parent) {
      standalone.push({
        kind: 'subtree',
        member_node_ids: [nodeId],
      });
      return;
    }
    const parentId = String(found.parent.id);
    const entries = byParent.get(parentId) || [];
    entries.push({ nodeId, index: found.index, parent: found.parent });
    byParent.set(parentId, entries);
  });

  byParent.forEach((entries, parentId) => {
    entries.sort((left, right) => left.index - right.index);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const siblings = run[0].parent.children || [];
      const start = run[0].index;
      const end = run[run.length - 1].index;
      standalone.push({
        kind: 'sibling_range',
        parent_id: parentId,
        member_node_ids: run.map((entry) => entry.nodeId),
        before_anchor_id: start > 0 ? String(siblings[start - 1].id) : null,
        after_boundary_id: end + 1 < siblings.length ? String(siblings[end + 1].id) : null,
      });
      run = [];
    };
    entries.forEach((entry) => {
      if (run.length && entry.index !== run[run.length - 1].index + 1) flush();
      run.push(entry);
    });
    flush();
  });

  return standalone;
}

function implicitTextRewriteConstraints(documentValue, context = {}) {
  const allowedRegionIds = defaultRegionIds(documentValue, context);
  return {
    format: CONSTRAINTS_FORMAT,
    content: 'modify',
    content_order: 'preserve',
    structure: 'preserve',
    style: 'preserve',
    allowed_region_ids: allowedRegionIds,
    allowed_regions: describeAllowedRegions(documentValue, allowedRegionIds),
    reason: '兼容单节点文字改写',
  };
}

function normalizeChangeConstraints(raw, documentValue, context = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (context.allowImplicitTextRewrite) {
      return implicitTextRewriteConstraints(documentValue, context);
    }
    const error = new Error('结构或整份简历修改缺少 change_constraints');
    error.code = 'CHANGE_CONSTRAINTS_MISSING';
    throw error;
  }
  const content = String(raw.content || '');
  const contentOrder = String(raw.content_order || 'preserve');
  const structure = String(raw.structure || '');
  const style = String(raw.style || '');
  if (!CONTENT_MODES.has(content)) {
    const error = new Error('change_constraints.content 只能是 preserve 或 modify');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  if (!CONTENT_ORDERS.has(contentOrder)) {
    const error = new Error('change_constraints.content_order 只能是 preserve 或 reorder');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  if (!CHANGE_MODES.has(structure)) {
    const error = new Error('change_constraints.structure 只能是 preserve 或 modify');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  if (!CHANGE_MODES.has(style)) {
    const error = new Error('change_constraints.style 只能是 preserve 或 modify');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  const requestedRegions = Array.isArray(raw.allowed_region_ids)
    ? raw.allowed_region_ids
    : [];
  const defaultRegions = defaultRegionIds(documentValue, context);
  const requestedExistingRegions = existingRegionIds(documentValue, requestedRegions);
  const allowedRegionIds = uniqueIds([
    ...defaultRegions,
    ...requestedExistingRegions,
  ]);
  if (!allowedRegionIds.length) {
    const error = new Error('change_constraints 没有可定位的允许修改区域');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  if (
    requestedRegions.length
    && requestedExistingRegions.length !== new Set(requestedRegions.map(String)).size
  ) {
    const error = new Error('change_constraints.allowed_region_ids 包含不存在的节点');
    error.code = 'CHANGE_CONSTRAINTS_INVALID';
    throw error;
  }
  return {
    format: CONSTRAINTS_FORMAT,
    content,
    content_order: contentOrder,
    structure,
    style,
    allowed_region_ids: allowedRegionIds,
    allowed_regions: describeAllowedRegions(documentValue, allowedRegionIds),
    ...(raw.reason ? { reason: String(raw.reason).slice(0, 240) } : {}),
  };
}

function composeChangeConstraints(previous, latest, documentValue, context = {}) {
  if (!previous) return normalizeChangeConstraints(latest, documentValue, context);
  const left = previous.format === CONSTRAINTS_FORMAT
    ? deepClone(previous)
    : normalizeChangeConstraints(previous, documentValue, context);
  const right = latest.format === CONSTRAINTS_FORMAT
    ? deepClone(latest)
    : normalizeChangeConstraints(latest, documentValue, context);
  return {
    format: CONSTRAINTS_FORMAT,
    content: left.content === 'modify' || right.content === 'modify' ? 'modify' : 'preserve',
    content_order: left.content_order === 'reorder' || right.content_order === 'reorder'
      ? 'reorder'
      : 'preserve',
    structure: left.structure === 'modify' || right.structure === 'modify'
      ? 'modify'
      : 'preserve',
    style: left.style === 'modify' || right.style === 'modify' ? 'modify' : 'preserve',
    allowed_region_ids: Array.from(new Set([
      ...left.allowed_region_ids,
      ...right.allowed_region_ids,
    ])),
    allowed_regions: [
      ...(left.allowed_regions || describeAllowedRegions(documentValue, left.allowed_region_ids)),
      ...(right.allowed_regions || describeAllowedRegions(documentValue, right.allowed_region_ids)),
    ].filter((region, index, regions) => (
      regions.findIndex((candidate) => hashJson(candidate) === hashJson(region)) === index
    )),
  };
}

function contentTokens(documentValue) {
  return (
    ResumeDom.plainText(ResumeDom.toResumeDocument(documentValue))
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)
    || []
  );
}

function contentSignature(documentValue, order) {
  const tokens = contentTokens(documentValue);
  if (order === 'reorder') tokens.sort();
  return tokens.join('\u001f');
}

function nodeBelongsToRegions(documentValue, nodeId, allowedIds) {
  const found = ResumeDom.findNode(documentValue, nodeId);
  if (!found) return false;
  const path = [found.node.id, ...found.ancestors.map((node) => node.id)].map(String);
  return path.some((id) => allowedIds.has(id));
}

function directChildInsideRegionSlot(documentValue, nodeId, region) {
  if (!region || region.kind !== 'sibling_range' || !region.parent_id) return false;
  const document = ResumeDom.toResumeDocument(documentValue);
  const found = ResumeDom.findNode(document, nodeId);
  if (!found || !found.parent || String(found.parent.id) !== String(region.parent_id)) {
    return false;
  }
  const siblings = found.parent.children || [];
  const beforeIndex = region.before_anchor_id
    ? siblings.findIndex((node) => String(node.id) === String(region.before_anchor_id))
    : -1;
  const boundaryIndex = region.after_boundary_id
    ? siblings.findIndex((node) => String(node.id) === String(region.after_boundary_id))
    : siblings.length;
  if (region.before_anchor_id && beforeIndex < 0) return false;
  if (region.after_boundary_id && boundaryIndex < 0) return false;
  return found.index > beforeIndex && found.index < boundaryIndex;
}

function nodeInsideRegion(documentValue, nodeId, region) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const found = ResumeDom.findNode(document, nodeId);
  if (!found) return false;
  const pathNodes = [found.node, ...found.ancestors];
  const memberIds = new Set((region.member_node_ids || []).map(String));
  if (pathNodes.some((node) => memberIds.has(String(node.id)))) return true;
  return pathNodes.some((node) => directChildInsideRegionSlot(document, node.id, region));
}

function nodeInsideAllowedRegions(documentValue, nodeId, allowedIds, regions) {
  return nodeBelongsToRegions(documentValue, nodeId, allowedIds)
    || regions.some((region) => nodeInsideRegion(documentValue, nodeId, region));
}

function changeInsideRegions(change, before, after, allowedIds, regions) {
  if (change.type === 'added') {
    return nodeInsideAllowedRegions(after, change.node_id, allowedIds, regions)
      || nodeInsideAllowedRegions(after, change.after_parent_id, allowedIds, regions);
  }
  if (change.type === 'removed') {
    return nodeInsideAllowedRegions(before, change.node_id, allowedIds, regions)
      || nodeInsideAllowedRegions(before, change.before_parent_id, allowedIds, regions);
  }
  const beforeInside = nodeInsideAllowedRegions(before, change.node_id, allowedIds, regions);
  const afterInside = nodeInsideAllowedRegions(after, change.node_id, allowedIds, regions);
  return beforeInside && afterInside;
}

function metadataChanges(before, after) {
  const result = [];
  if (hashJson(before.page_setup || {}) !== hashJson(after.page_setup || {})) {
    result.push('page_setup');
  }
  if (hashJson(before.styles || {}) !== hashJson(after.styles || {})) result.push('styles');
  if (hashJson(before.assets || []) !== hashJson(after.assets || [])) result.push('assets');
  if (hashJson(before.annotations || []) !== hashJson(after.annotations || [])) {
    result.push('annotations');
  }
  return result;
}

function evaluateChange(beforeValue, afterValue, constraintsValue) {
  const before = ResumeDom.toResumeDocument(beforeValue);
  const after = ResumeDom.toResumeDocument(afterValue);
  const constraints = deepClone(constraintsValue);
  const comparison = ResumeDom.compareDocuments(before, after);
  const metadata = metadataChanges(before, after);
  const structureChanges = comparison.changes.filter((change) =>
    ['added', 'removed', 'moved', 'structure'].includes(change.type));
  const styleChanges = comparison.changes.filter((change) =>
    change.type === 'style'
      || change.type === 'attributes');
  const allowedIds = new Set((constraints.allowed_region_ids || []).map(String));
  const allowedRegions = Array.isArray(constraints.allowed_regions)
    ? constraints.allowed_regions
    : describeAllowedRegions(before, constraints.allowed_region_ids);
  const outside = comparison.changes.filter(
    (change) => !changeInsideRegions(change, before, after, allowedIds, allowedRegions),
  );
  const rootAllowed = allowedIds.has(String(before.root.id))
    || allowedIds.has(String(after.root.id));
  const errors = [];

  if (outside.length || (metadata.length && !rootAllowed)) {
    errors.push(policyError(
      'OUTSIDE_ALLOWED_REGION',
      '实际修改超出了本轮允许调整的简历区域',
      {
        node_ids: Array.from(new Set(outside.map((change) => change.node_id))),
        metadata,
      },
    ));
  }
  if (constraints.structure === 'preserve' && (structureChanges.length || metadata.includes('annotations'))) {
    errors.push(policyError(
      'STRUCTURE_NOT_ALLOWED',
      '本轮只允许保留原结构，但实际建议改变了节点结构或顺序',
      { node_ids: Array.from(new Set(structureChanges.map((change) => change.node_id))) },
    ));
  }
  if (constraints.style === 'preserve' && (styleChanges.length || metadata.some(
    (key) => ['page_setup', 'styles', 'assets'].includes(key),
  ))) {
    errors.push(policyError(
      'STYLE_NOT_ALLOWED',
      '本轮只允许保留原样式，但实际建议改变了显示属性',
      { node_ids: Array.from(new Set(styleChanges.map((change) => change.node_id))) },
    ));
  }
  if (
    constraints.content === 'preserve'
    && contentSignature(before, constraints.content_order)
      !== contentSignature(after, constraints.content_order)
  ) {
    errors.push(policyError(
      'CONTENT_NOT_PRESERVED',
      constraints.content_order === 'reorder'
        ? '本轮结构调整必须保留全部原文字，但实际建议新增、删除或改写了内容'
        : '本轮结构调整必须完整保留原文字和顺序，但实际建议新增、删除、改写或重排了内容',
    ));
  }

  return {
    valid: errors.length === 0,
    errors,
    constraints,
    comparison,
    dimensions: {
      content: contentSignature(before, 'preserve') === contentSignature(after, 'preserve')
        ? 'preserved'
        : 'modified',
      structure: structureChanges.length || metadata.includes('annotations')
        ? 'modified'
        : 'preserved',
      style: styleChanges.length || metadata.some(
        (key) => ['page_setup', 'styles', 'assets'].includes(key),
      )
        ? 'modified'
        : 'preserved',
    },
  };
}

function changePayloadHash(operations, replacementResume) {
  return hashJson(
    Array.isArray(operations) && operations.length
      ? { operations }
      : { resume_json: replacementResume || null },
  );
}

function authorizeChange({
  before,
  after,
  constraints,
  operations,
  replacementResume,
  revision,
}) {
  const result = evaluateChange(before, after, constraints);
  if (!result.valid) {
    const error = new Error(result.errors.map((item) => item.message).join('；'));
    error.code = 'RESUME_CHANGE_POLICY_VIOLATION';
    error.policy_errors = result.errors;
    throw error;
  }
  return {
    format: AUTHORIZATION_FORMAT,
    constraints: deepClone(constraints),
    change_payload_hash: changePayloadHash(operations, replacementResume),
    base_document_hash: hashJson(ResumeDom.toResumeDocument(before)),
    proposed_document_hash: hashJson(ResumeDom.toResumeDocument(after)),
    validated_on_revision: Number.isFinite(revision) ? revision : null,
    dimensions: result.dimensions,
  };
}

function validateAuthorizedChange({
  authorization,
  before,
  after,
  operations,
  replacementResume,
  revision,
  allowUserContentOverride = false,
}) {
  if (
    !authorization
    || ![AUTHORIZATION_FORMAT, LEGACY_AUTHORIZATION_FORMAT].includes(authorization.format)
  ) {
    return {
      valid: true,
      legacy: true,
      errors: [],
    };
  }
  if (
    authorization.change_payload_hash
    !== changePayloadHash(operations, replacementResume)
  ) {
    return {
      valid: false,
      errors: [policyError(
        'AUTHORIZED_CHANGE_MISMATCH',
        '待应用的简历操作与已通过校验的建议不一致',
      )],
    };
  }
  const result = evaluateChange(before, after, authorization.constraints);
  if (result.valid) return { ...result, content_override: false };

  const currentHash = hashJson(ResumeDom.toResumeDocument(before));
  const onlyContentPreservationFailed = result.errors.every(
    (item) => item.code === 'CONTENT_NOT_PRESERVED',
  );
  if (
    allowUserContentOverride
    && onlyContentPreservationFailed
    && currentHash !== authorization.base_document_hash
    && Number.isFinite(revision)
  ) {
    return {
      ...result,
      valid: true,
      errors: [],
      content_override: true,
      overridden_errors: result.errors,
    };
  }
  return result;
}

module.exports = {
  CONSTRAINTS_FORMAT,
  AUTHORIZATION_FORMAT,
  LEGACY_AUTHORIZATION_FORMAT,
  normalizeChangeConstraints,
  composeChangeConstraints,
  implicitTextRewriteConstraints,
  evaluateChange,
  authorizeChange,
  validateAuthorizedChange,
  changePayloadHash,
  contentTokens,
  describeAllowedRegions,
};
