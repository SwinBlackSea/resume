'use strict';

/**
 * 把画布上的 +/- 意图编译为服务端可信的 ResumeDocument 结构操作。
 *
 * 客户端只提交 action + node_id，不提交待插入子树。节点类型、父子位置、
 * 新 ID 和可删除范围全部由当前草稿确定，避免把通用结构写权限交给浏览器。
 */
const ResumeDom = require('../../resume-dom');
const { uuidv7, deepClone } = require('./util');
const { insertionLayout, removalLayout } = require('./manual-flow-layout');

const STRIPPED_ATTRIBUTES = new Set([
  'id',
  'data-ai-scope',
  'data-block-id',
  'data-bullet-id',
  'data-template-slot',
  'data-suggestion',
]);

function safeCloneAttributes(attributes) {
  return Object.fromEntries(
    Object.entries(attributes || {})
      .filter(([name]) => (
        !STRIPPED_ATTRIBUTES.has(name)
        && !/^data-(?:.*-)?id$/i.test(name)
      ))
      .map(([name, value]) => {
        if (name !== 'class') return [name, value];
        return [
          name,
          String(value || '')
            .split(/\s+/)
            .filter((token) => token && token !== 'has-ai-note')
            .join(' '),
        ];
      })
      .filter(([, value]) => value !== ''),
  );
}

function actionError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function freshId(prefix = 'manual') {
  return `${prefix}-${uuidv7()}`;
}

function classes(node) {
  return String(node && node.attributes && node.attributes.class || '')
    .split(/\s+/)
    .filter(Boolean);
}

function isEditorOnly(node) {
  return classes(node).includes('ai-marker')
    || String(node && node.attributes && node.attributes['data-editor-only'] || '') === 'true';
}

function blankClone(source, { placeholder = '点击输入内容' } = {}) {
  const groupIds = new Map();

  function cloneNode(node, root = false) {
    if (!node || isEditorOnly(node)) return null;
    if (node.type === 'text') {
      return { id: freshId('text'), type: 'text', value: '' };
    }
    const copy = deepClone(node);
    copy.id = freshId('node');
    delete copy.binding;
    copy.attributes = safeCloneAttributes(copy.attributes);
    if (copy.semantic && copy.semantic.group_id) {
      const previous = copy.semantic.group_id;
      if (!groupIds.has(previous)) groupIds.set(previous, freshId('group'));
      copy.semantic.group_id = groupIds.get(previous);
    }
    if (copy.text !== undefined) copy.text = '';
    copy.children = (node.children || [])
      .map((child) => cloneNode(child, false))
      .filter(Boolean);
    if (root && copy.editable === true) {
      copy.attributes = {
        ...copy.attributes,
        'data-manual-empty': 'true',
        'data-empty-placeholder': placeholder,
      };
    }
    return copy;
  }

  return cloneNode(source, true);
}

function duplicateClone(source) {
  const groupIds = new Map();
  const nodeIds = new Map();

  function cloneNode(node) {
    if (!node || isEditorOnly(node)) return null;
    const copy = deepClone(node);
    const nextId = freshId(node.type === 'text' ? 'text' : 'node');
    nodeIds.set(String(node.id), nextId);
    copy.id = nextId;
    delete copy.binding;
    if (node.type !== 'text') {
      copy.attributes = safeCloneAttributes(copy.attributes);
      if (copy.semantic && copy.semantic.group_id) {
        const previous = String(copy.semantic.group_id);
        if (!groupIds.has(previous)) groupIds.set(previous, freshId('group'));
        copy.semantic.group_id = groupIds.get(previous);
      }
      copy.children = (node.children || [])
        .map((child) => cloneNode(child))
        .filter(Boolean);
    }
    return copy;
  }

  return { node: cloneNode(source), nodeIds };
}

function editableDescendants(node, result = []) {
  if (!node || node.type !== 'element') return result;
  if (node.editable === true) {
    result.push(node);
    return result;
  }
  (node.children || []).forEach((child) => editableDescendants(child, result));
  return result;
}

function genericParagraph(reference) {
  const style = reference && reference.tag === 'p' ? deepClone(reference.style || {}) : {};
  return {
    id: freshId('paragraph'),
    type: 'element',
    tag: 'p',
    attributes: {
      class: 'editable',
      'data-manual-empty': 'true',
      'data-empty-placeholder': '点击输入内容',
    },
    style,
    children: [],
    text: '',
    editable: true,
    label: reference && reference.label ? reference.label : '正文内容',
    semantic: { kind: 'paragraph' },
  };
}

function nearestSection(found) {
  return found.ancestors
    .slice()
    .reverse()
    .find((node) => ResumeDom.semanticKind(node) === 'section') || null;
}

function sectionContentSubtree(section, titleId) {
  function containsTitle(node) {
    return node.id === titleId || (node.children || []).some(containsTitle);
  }
  const candidates = [];
  for (const child of section.children || []) {
    if (isEditorOnly(child) || child.id === titleId) continue;
    if (containsTitle(child)) {
      const nested = sectionContentSubtree(child, titleId);
      if (nested) candidates.push(nested);
    } else candidates.push(child);
  }
  return candidates.at(-1) || null;
}

function buildSection(section, title) {
  const duplicated = duplicateClone(section);
  return {
    node: duplicated.node,
    focusNodeId: duplicated.nodeIds.get(String(title.id)) || duplicated.node.id,
  };
}

function compileManualNodeAction(documentValue, action, nodeId) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const normalizedAction = String(action || '');
  const exactSelection = ['duplicate_node', 'delete_node'].includes(normalizedAction);
  const capability = exactSelection
    ? ResumeDom.manualSelectionCapabilities(document, nodeId)
    : ResumeDom.manualStructureCapabilities(document, nodeId);
  if (!capability) {
    throw actionError('MANUAL_NODE_ACTION_UNAVAILABLE', '这处内容不支持直接增删');
  }
  const allowed = new Set([
    ...(capability.add || []).filter((item) => item.enabled).map((item) => item.action),
    ...(capability.remove_choices || [capability.remove])
      .filter((item) => item && item.enabled !== false).map((item) => item.action),
  ].filter(Boolean));
  if (!allowed.has(normalizedAction)) {
    const disabledAdd = (capability.add || []).some(
      (item) => item.action === normalizedAction && item.enabled === false,
    );
    const disabledRemove = (capability.remove_choices || [capability.remove])
      .some((item) => item && item.action === normalizedAction && item.enabled === false);
    throw actionError(
      disabledAdd || disabledRemove
        ? 'FIXED_LAYOUT_ACTION_UNAVAILABLE'
        : 'MANUAL_NODE_ACTION_UNAVAILABLE',
      disabledAdd || disabledRemove
        ? '这份简历的页面底图包含原文字，请让 AI 一起调整版面'
        : '这处内容不支持这个增删操作',
    );
  }

  const found = ResumeDom.findNode(document, capability.node_id);
  if (!found || !found.parent) {
    throw actionError('MANUAL_NODE_TARGET_MISSING', '这处内容已经不存在，请刷新后重试');
  }

  if (['remove', 'remove_content', 'delete_node'].includes(normalizedAction)) {
    const choice = (capability.remove_choices || [capability.remove])
      .find((item) => item.action === normalizedAction);
    const targetIds = choice.target_ids || [choice.target_id];
    if (targetIds.some((id) => !ResumeDom.findNode(document, id)?.parent)) {
      throw actionError('MANUAL_NODE_TARGET_MISSING', '要删除的内容已经不存在');
    }
    return {
      operations: removalLayout(document, targetIds.map(id => ResumeDom.findNode(document, id).node))
        .concat(targetIds.slice().reverse().map((id) => ({ op: 'remove_node', node_id: id }))),
      changedNodeIds: targetIds,
      focusNodeId: null,
      label: choice.label,
    };
  }

  if (['add_sibling', 'add_content_sibling', 'duplicate_node'].includes(normalizedAction)) {
    const targetIds = normalizedAction === 'add_content_sibling'
      ? [found.node.id] : capability.target_ids || [found.node.id];
    const targets = targetIds.map((id) => ResumeDom.findNode(document, id));
    const duplicated = duplicateClone({
      id: 'temporary-clone-group', type: 'element', tag: 'div',
      children: targets.map((target) => target.node),
    });
    const nodes = duplicated.node.children;
    const parent = targets[0].parent;
    const preparation = [];
    preparation.push(...insertionLayout(document, targets.map(target => target.node), nodes));
    if (ResumeDom.semanticKind(targets[0].node) === 'table_row') {
      const rows = parent.children || [];
      targets.forEach((target, index) => {
        const available = rows.length - rows.findIndex((row) => row.id === target.node.id);
        (target.node.children || []).forEach((cell, cellIndex) => {
          const raw = cell.attributes && cell.attributes.rowspan;
          if (raw !== undefined && (Number(raw) === 0 || Number(raw) > available)) {
            const span = String(available);
            preparation.push({ op: 'set_attributes', node_id: cell.id, attributes: { rowspan: span } });
            nodes[index].children[cellIndex].attributes.rowspan = span;
          }
        });
      });
    }
    return {
      operations: preparation.concat(nodes.map((node, index) => ({
        op: 'insert_node',
        parent_id: parent.id,
        after_node_id: index ? nodes[index - 1].id : targets.at(-1).node.id,
        node,
      }))),
      changedNodeIds: nodes.map((node) => node.id),
      focusNodeId: duplicated.nodeIds.get(String(
        exactSelection ? (editableDescendants(found.node)[0] || found.node).id : found.node.id,
      )) || nodes[0].id,
      label: capability.add.find((item) => item.action === normalizedAction).label,
    };
  }

  const section = nearestSection(found);
  const sectionFound = section && ResumeDom.findNode(document, section.id);
  if (!sectionFound || !sectionFound.parent) {
    throw actionError('MANUAL_NODE_TARGET_MISSING', '当前模块结构已经变化，请刷新后重试');
  }

  if (normalizedAction === 'add_section_content') {
    const reference = sectionContentSubtree(sectionFound.node, found.node.id);
    const referenceFound = reference && ResumeDom.findNode(document, reference.id);
    const duplicated = reference ? duplicateClone(reference) : null;
    const node = duplicated ? duplicated.node : genericParagraph(null);
    const referenceFocus = reference
      ? editableDescendants(reference, [])[0] || reference
      : null;
    return {
      operations: (reference ? insertionLayout(document, [reference], [node]) : []).concat([{
        op: 'insert_node',
        parent_id: referenceFound ? referenceFound.parent.id : sectionFound.node.id,
        after_node_id: reference ? reference.id : (sectionFound.node.children || []).at(-1)?.id,
        node,
      }]),
      changedNodeIds: [node.id],
      focusNodeId: duplicated && referenceFocus
        ? duplicated.nodeIds.get(String(referenceFocus.id)) || node.id
        : node.id,
      label: '增加模块内容',
    };
  }

  if (normalizedAction === 'add_section_after') {
    const built = buildSection(sectionFound.node, found.node);
    return {
      operations: insertionLayout(document, [sectionFound.node], [built.node]).concat([{
        op: 'insert_node',
        parent_id: sectionFound.parent.id,
        after_node_id: sectionFound.node.id,
        node: built.node,
      }]),
      changedNodeIds: [built.node.id],
      focusNodeId: built.focusNodeId,
      label: '新增同级模块',
    };
  }

  throw actionError('MANUAL_NODE_ACTION_UNAVAILABLE', '这处内容不支持这个增删操作');
}

module.exports = {
  compileManualNodeAction,
  blankClone,
  duplicateClone,
  genericParagraph,
};
