'use strict';

/**
 * 把“@简历 · 具体内容”的稳定节点解析为语义焦点区域。
 *
 * 普通正文只包含自身；容器包含自身子树；标题代表从该标题开始、到下一个
 * 同级或更高层级标题之前的语义焦点。焦点用于帮助模型理解“这个模块”，
 * 不是写权限边界；真正写入仍由明确 DOM 操作、用户确认和并发前置条件控制。
 */
const ResumeDom = require('../../resume-dom');

function hasClass(node, className) {
  return String(node && node.attributes && node.attributes.class || '')
    .split(/\s+/)
    .includes(className);
}

function headingLevel(node) {
  const match = String(node && node.tag || '').match(/^h([1-6])$/);
  if (match) return Number(match[1]);
  return hasClass(node, 'imported-heading') ? 2 : null;
}

function collectIds(node, result = new Set()) {
  if (!node || typeof node !== 'object') return result;
  if (node.id) result.add(String(node.id));
  (node.children || []).forEach((child) => collectIds(child, result));
  return result;
}

function resolveResumeScope(documentValue, scopeId) {
  const document = ResumeDom.ensureDocument(documentValue);
  const found = ResumeDom.resolveAiScopeNode(document, scopeId);
  if (!found) return null;
  const effectiveScopeId = String(found.node.id);

  const roots = [found.node];
  const level = headingLevel(found.node);
  let boundaryNodeId = null;
  if (level && found.parent) {
    const siblings = found.parent.children || [];
    for (let index = found.index + 1; index < siblings.length; index += 1) {
      const sibling = siblings[index];
      const siblingLevel = headingLevel(sibling);
      if (siblingLevel && siblingLevel <= level) {
        boundaryNodeId = String(sibling.id);
        break;
      }
      roots.push(sibling);
    }
  }

  const nodeIds = new Set();
  roots.forEach((node) => collectIds(node, nodeIds));
  return {
    scope_id: effectiveScopeId,
    requested_scope_id: String(scopeId),
    canonicalized: effectiveScopeId !== String(scopeId),
    kind: level ? 'heading_region' : ((found.node.children || []).length ? 'subtree' : 'node'),
    parent_id: found.parent ? String(found.parent.id) : null,
    root_node_ids: roots.map((node) => String(node.id)),
    node_ids: Array.from(nodeIds),
    boundary_node_id: boundaryNodeId,
    text: roots.map((node) => ResumeDom.nodeText(node)).filter(Boolean).join('\n'),
  };
}

module.exports = {
  headingLevel,
  resolveResumeScope,
};
