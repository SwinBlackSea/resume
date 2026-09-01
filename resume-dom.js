(function initResumeDom(globalObject, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalObject) globalObject.ResumeDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createResumeDomApi() {
  'use strict';

  const VERSION = 'resume-dom-v1';
  const MAX_DEPTH = 40;
  const MAX_NODES = 5000;
  const ALLOWED_TAGS = new Set([
    'article', 'section', 'header', 'footer', 'main', 'aside', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'strong', 'em', 'b', 'i', 'small',
    'time', 'a', 'button',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'img', 'figure', 'figcaption', 'br', 'hr',
    'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text',
  ]);
  const VOID_TAGS = new Set(['img', 'br', 'hr']);
  const SAFE_ATTRIBUTE = /^(?:id|class|title|role|type|href|src|alt|width|height|colspan|rowspan|viewBox|d|fill|stroke|stroke-width|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|points|transform|preserveAspectRatio|data-[\w-]+|aria-[\w-]+)$/;
  const SAFE_STYLE_NAME = /^(?:--[\w-]+|[a-z][a-z0-9-]*)$/i;
  const UNSAFE_CSS_VALUE = /(?:expression\s*\(|javascript\s*:|@import|behavior\s*:|url\s*\()/i;
  const UNSAFE_URL = /^\s*(?:javascript|vbscript):/i;
  const DATA_URL = /^\s*data:/i;
  const SAFE_IMAGE_DATA_URL = /^\s*data:image\/(?:png|jpe?g|gif|webp);base64,/i;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function cleanId(value, fallback) {
    const id = String(value || '').trim();
    if (/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return id;
    return fallback;
  }

  function textNode(id, value) {
    return { id, type: 'text', value: String(value == null ? '' : value) };
  }

  function elementNode(id, tag, attributes, children, options) {
    return {
      id,
      type: 'element',
      tag,
      attributes: attributes || {},
      children: children || [],
      ...(options || {}),
    };
  }

  function periodOf(item) {
    const start = item.start || item.start_date || '';
    const end = item.end || item.end_date || '';
    if (!start && !end) return '';
    return `${start} — ${end || '至今'}`;
  }

  function editableTextElement(id, tag, value, options) {
    return elementNode(id, tag, (options && options.attributes) || {}, [], {
      text: String(value == null ? '' : value),
      editable: true,
      label: (options && options.label) || '',
      binding: (options && options.binding) || null,
      format: (options && options.format) || null,
    });
  }

  function legacyItemId(prefix, item, index) {
    return cleanId(item && item.id, `${prefix}-${index + 1}`);
  }

  function legacyResumeToDom(resume) {
    const value = resume && typeof resume === 'object' ? resume : {};
    const basics = value.basics || {};
    const rootChildren = [];
    const contact = [value.headline, basics.city, basics.phone, basics.email]
      .filter(Boolean)
      .join('　|　');
    rootChildren.push(elementNode('resume-header', 'div', { class: 'resume-top' }, [
      editableTextElement('resume-name', 'h1', basics.name || '', {
        label: '姓名',
        binding: { kind: 'legacy_path', path: 'basics.name' },
        format: 'spaced-characters',
      }),
      editableTextElement('resume-contact', 'p', contact, {
        label: '联系方式',
      }),
    ]));

    if (value.summary) {
      rootChildren.push(elementNode('section-summary', 'section', { class: 'resume-section' }, [
        editableTextElement('section-summary-title', 'h2', '个人优势', { label: '模块标题' }),
        editableTextElement('summary', 'p', value.summary, {
          attributes: { class: 'editable', 'data-bullet-id': 'summary' },
          label: '个人优势',
          binding: { kind: 'legacy_path', path: 'summary' },
        }),
      ], { label: '个人优势' }));
    }

    const addTimelineSection = (key, title, items, itemMapper) => {
      if (!items.length) return;
      const sectionChildren = [
        editableTextElement(`section-${key}-title`, 'h2', title, { label: '模块标题' }),
      ];
      items.forEach((item, itemIndex) => {
        const itemId = legacyItemId(key, item, itemIndex);
        const mapped = itemMapper(item);
        sectionChildren.push(elementNode(`${itemId}-row`, 'div', { class: 'resume-row' }, [
          textNode(`${itemId}-organization`, mapped.organization),
          textNode(`${itemId}-space-1`, ' '),
          editableTextElement(`${itemId}-role`, 'span', mapped.role, {
            attributes: { class: 'role' },
            label: mapped.roleLabel || '角色',
            binding: {
              kind: 'legacy_item',
              collection: key,
              item_id: item.id || null,
              item_index: itemIndex,
              field: mapped.roleField,
            },
          }),
          editableTextElement(`${itemId}-period`, 'time', periodOf(item), {
            label: '时间',
          }),
        ], { label: mapped.organization || title }));
        if ((item.bullets || []).length) {
          sectionChildren.push(elementNode(`${itemId}-bullets`, 'ul', {}, (item.bullets || []).map((bullet, bulletIndex) => {
            const bulletValue = typeof bullet === 'string' ? { text: bullet } : bullet;
            const bulletId = cleanId(bulletValue.id, `${itemId}-bullet-${bulletIndex + 1}`);
            const children = [];
            if (bulletValue.ai_note) {
              children.push(elementNode(`${bulletId}-ai-note`, 'button', {
                class: 'ai-marker',
                'data-suggestion': bulletValue.ai_note.suggestion || '',
                type: 'button',
              }, [], {
                text: `✦ ${bulletValue.ai_note.label || ''}`,
              }));
            }
            return elementNode(bulletId, 'li', {
              id: bulletId,
              class: `editable${bulletValue.ai_note ? ' has-ai-note' : ''}`,
              'data-bullet-id': bulletId,
            }, children, {
              text: bulletValue.text || '',
              editable: true,
              label: `${title}内容`,
              binding: {
                kind: 'legacy_bullet',
                collection: key,
                item_id: item.id || null,
                item_index: itemIndex,
                bullet_id: bulletValue.id || null,
                bullet_index: bulletIndex,
              },
            });
          })));
        }
      });
      rootChildren.push(elementNode(`section-${key}`, 'section', { class: 'resume-section' }, sectionChildren, {
        label: title,
      }));
    };

    addTimelineSection('experience', '工作经历', value.experience || [], (item) => ({
      organization: item.organization || '',
      organizationField: 'organization',
      organizationLabel: '公司',
      role: item.title || '',
      roleField: 'title',
      roleLabel: '职位',
    }));
    addTimelineSection('projects', '项目经历', value.projects || [], (item) => ({
      organization: item.name || item.organization || '',
      organizationField: item.name !== undefined ? 'name' : 'organization',
      organizationLabel: '项目',
      role: item.role || item.title || '',
      roleField: item.role !== undefined ? 'role' : 'title',
      roleLabel: '角色',
    }));

    const education = value.education || [];
    if (education.length) {
      const children = [
        editableTextElement('section-education-title', 'h2', '教育经历', { label: '模块标题' }),
      ];
      education.forEach((item, index) => {
        const itemId = legacyItemId('education', item, index);
        children.push(elementNode(`${itemId}-row`, 'div', { class: 'resume-row' }, [
          textNode(`${itemId}-school`, item.school || item.organization || ''),
          textNode(`${itemId}-space`, ' '),
          editableTextElement(`${itemId}-major`, 'span', item.major || '', {
            attributes: { class: 'role' },
            label: '专业',
            binding: {
              kind: 'legacy_item',
              collection: 'education',
              item_id: item.id || null,
              item_index: index,
              field: 'major',
            },
          }),
          editableTextElement(`${itemId}-period`, 'time', periodOf(item), { label: '时间' }),
        ]));
      });
      rootChildren.push(elementNode('section-education', 'section', { class: 'resume-section' }, children, {
        label: '教育经历',
      }));
    }

    const skills = value.skills || [];
    if (skills.length) {
      rootChildren.push(elementNode('section-skills', 'section', { class: 'resume-section' }, [
        editableTextElement('section-skills-title', 'h2', '专业技能', { label: '模块标题' }),
        editableTextElement('skills', 'p', skills
          .map((skill) => (typeof skill === 'string' ? skill : skill.name))
          .filter(Boolean)
          .join('　'), {
          label: '专业技能',
          binding: { kind: 'legacy_skills_joined' },
        }),
      ], { label: '专业技能' }));
    }

    return normalizeDocument({
      version: VERSION,
      root: elementNode('resume-root', 'article', { class: 'resume-dom-root' }, rootChildren),
    }, { dedupeIds: true });
  }

  function safeAttributes(attributes) {
    const result = {};
    Object.entries(attributes || {}).forEach(([name, raw]) => {
      if (!SAFE_ATTRIBUTE.test(name) || /^on/i.test(name)) return;
      const value = String(raw == null ? '' : raw);
      if (name === 'href' || name === 'src') {
        if (UNSAFE_URL.test(value)) return;
        if (DATA_URL.test(value) && !(name === 'src' && SAFE_IMAGE_DATA_URL.test(value))) return;
      }
      result[name] = value;
    });
    return result;
  }

  function safeStyle(style) {
    const result = {};
    Object.entries(style || {}).forEach(([name, raw]) => {
      const cssName = String(name || '').trim();
      const value = String(raw == null ? '' : raw).trim();
      if (!SAFE_STYLE_NAME.test(cssName) || UNSAFE_CSS_VALUE.test(value)) return;
      result[cssName] = value;
    });
    return result;
  }

  function normalizeDocument(input, options) {
    const source = input && input.root ? input : { version: VERSION, root: input };
    let nodeCount = 0;
    let autoId = 0;
    const ids = new Set();

    function normalizeNode(raw, depth) {
      if (!raw || typeof raw !== 'object') throw new Error('DOM 节点必须是对象');
      if (depth > MAX_DEPTH) throw new Error(`DOM 节点嵌套不能超过 ${MAX_DEPTH} 层`);
      nodeCount += 1;
      if (nodeCount > MAX_NODES) throw new Error(`DOM 节点数量不能超过 ${MAX_NODES}`);
      autoId += 1;
      const preferredId = cleanId(raw.id, `dom-node-${autoId}`);
      let id = preferredId;
      if (ids.has(id) && options && options.dedupeIds) {
        let suffix = 2;
        while (ids.has(`${preferredId}-${suffix}`)) suffix += 1;
        id = `${preferredId}-${suffix}`;
      } else if (ids.has(id)) {
        throw new Error(`DOM 节点 ID 重复：${id}`);
      }
      ids.add(id);

      if (raw.type === 'text') {
        return { id, type: 'text', value: String(raw.value == null ? '' : raw.value) };
      }

      const tag = String(raw.tag || 'div').toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) throw new Error(`不支持的 DOM 标签：${tag}`);
      const normalized = {
        id,
        type: 'element',
        tag,
        attributes: safeAttributes(raw.attributes),
        style: safeStyle(raw.style),
        children: [],
      };
      if (raw.text !== undefined) normalized.text = String(raw.text == null ? '' : raw.text);
      if (raw.editable === true) normalized.editable = true;
      if (raw.label) normalized.label = String(raw.label).slice(0, 120);
      if (raw.format === 'spaced-characters') normalized.format = raw.format;
      if (raw.binding && typeof raw.binding === 'object') normalized.binding = clone(raw.binding);
      if (!VOID_TAGS.has(tag)) {
        normalized.children = (Array.isArray(raw.children) ? raw.children : [])
          .map((child) => normalizeNode(child, depth + 1));
      }
      return normalized;
    }

    const root = normalizeNode(source.root || elementNode('resume-root', 'article'), 0);
    if (root.type !== 'element') throw new Error('DOM 文档根节点必须是元素');
    return { version: VERSION, root };
  }

  function ensureDocument(resume) {
    if (resume && resume.dom_document && resume.dom_document.root) {
      return normalizeDocument(resume.dom_document);
    }
    return legacyResumeToDom(resume || {});
  }

  function attachDocument(resume) {
    const result = clone(resume && typeof resume === 'object' ? resume : {});
    result.dom_document = ensureDocument(result);
    return result;
  }

  function walk(documentValue, visitor) {
    const document = normalizeDocument(documentValue);
    function visit(node, parent, index, depth) {
      if (visitor(node, parent, index, depth) === false) return;
      (node.children || []).forEach((child, childIndex) => visit(child, node, childIndex, depth + 1));
    }
    visit(document.root, null, 0, 0);
    return document;
  }

  function findNode(documentValue, nodeId) {
    const document = normalizeDocument(documentValue);
    let found = null;
    function visit(node, parent, index, ancestors) {
      if (found) return;
      if (node.id === nodeId) {
        found = { node, parent, index, ancestors };
        return;
      }
      (node.children || []).forEach((child, childIndex) =>
        visit(child, node, childIndex, ancestors.concat(node)));
    }
    visit(document.root, null, 0, []);
    return found ? { ...found, document } : null;
  }

  function nodeText(node) {
    if (!node) return '';
    if (node.type === 'text') return String(node.value || '');
    if (node.text !== undefined) return String(node.text || '');
    return (node.children || []).map(nodeText).join('');
  }

  function setPath(target, path, value) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (!cursor[parts[index]] || typeof cursor[parts[index]] !== 'object') cursor[parts[index]] = {};
      cursor = cursor[parts[index]];
    }
    cursor[parts[parts.length - 1]] = value;
  }

  function itemFromBinding(resume, binding) {
    const list = resume[binding.collection] || [];
    if (binding.item_id) {
      const matched = list.find((item) => item && item.id === binding.item_id);
      if (matched) return matched;
    }
    return list[binding.item_index] || null;
  }

  function syncLegacyBindings(resume, documentValue) {
    const result = clone(resume || {});
    const document = normalizeDocument(documentValue);
    walk(document, (node) => {
      const binding = node.binding;
      if (!binding) return;
      const value = nodeText(node);
      if (binding.kind === 'legacy_path') {
        setPath(result, binding.path, value);
      } else if (binding.kind === 'legacy_item') {
        const item = itemFromBinding(result, binding);
        if (item && binding.field) item[binding.field] = value;
      } else if (binding.kind === 'legacy_bullet') {
        const item = itemFromBinding(result, binding);
        if (!item) return;
        const bullets = item.bullets || [];
        let bullet = binding.bullet_id
          ? bullets.find((entry) => entry && typeof entry === 'object' && entry.id === binding.bullet_id)
          : null;
        if (!bullet) bullet = bullets[binding.bullet_index];
        if (typeof bullet === 'string') bullets[binding.bullet_index] = value;
        else if (bullet) bullet.text = value;
      } else if (binding.kind === 'legacy_skill') {
        const skills = result.skills || [];
        let skill = binding.item_id
          ? skills.find((entry) => entry && typeof entry === 'object' && entry.id === binding.item_id)
          : skills[binding.item_index];
        if (typeof skill === 'string') skills[binding.item_index] = value;
        else if (skill) skill.name = value;
      } else if (binding.kind === 'legacy_skills_joined') {
        const values = value.split(/[　,，、|｜\n]+/).map((item) => item.trim()).filter(Boolean);
        result.skills = values.map((name, index) => {
          const previous = (result.skills || [])[index];
          return previous && typeof previous === 'object' ? { ...previous, name } : name;
        });
      }
    });
    result.dom_document = document;
    return result;
  }

  function applyOperations(documentValue, operations, options) {
    let document = normalizeDocument(documentValue);
    const lockedNodeId = options && options.lockedNodeId ? String(options.lockedNodeId) : null;
    const allowStructure = !(options && options.allowStructure === false);

    (operations || []).forEach((rawOperation, operationIndex) => {
      const operation = rawOperation && typeof rawOperation === 'object' ? rawOperation : {};
      const op = String(operation.op || '');
      const targetId = String(operation.node_id || '');
      if (lockedNodeId && targetId !== lockedNodeId) {
        throw new Error(`第 ${operationIndex + 1} 个操作超出锁定节点`);
      }

      if (op === 'replace_text') {
        const found = findNode(document, targetId);
        if (!found) throw new Error(`DOM 节点不存在：${targetId}`);
        if (found.node.type === 'text') found.node.value = String(operation.text == null ? '' : operation.text);
        else {
          found.node.text = String(operation.text == null ? '' : operation.text);
        }
        document = normalizeDocument(found.document);
        return;
      }

      if (!allowStructure) throw new Error('当前作用范围只允许修改选中内容');

      if (op === 'insert_node') {
        const parent = findNode(document, operation.parent_id);
        if (!parent || parent.node.type !== 'element') throw new Error(`父节点不存在：${operation.parent_id}`);
        const children = parent.node.children || (parent.node.children = []);
        let index = Number.isInteger(operation.index) ? operation.index : children.length;
        if (operation.after_node_id) {
          const afterIndex = children.findIndex((child) => child.id === operation.after_node_id);
          if (afterIndex >= 0) index = afterIndex + 1;
        }
        index = Math.max(0, Math.min(index, children.length));
        children.splice(index, 0, clone(operation.node));
        document = normalizeDocument(parent.document);
        return;
      }

      if (op === 'remove_node') {
        const found = findNode(document, targetId);
        if (!found || !found.parent) throw new Error(`不能删除 DOM 根节点或节点不存在：${targetId}`);
        found.parent.children.splice(found.index, 1);
        document = normalizeDocument(found.document);
        return;
      }

      if (op === 'move_node') {
        const found = findNode(document, targetId);
        const parent = findNode(document, operation.parent_id);
        if (!found || !found.parent || !parent || parent.node.type !== 'element') {
          throw new Error('移动节点或目标容器不存在');
        }
        if (
          parent.node.id === found.node.id
          || parent.ancestors.some((ancestor) => ancestor.id === found.node.id)
        ) {
          throw new Error('不能把节点移动到自身或其子节点中');
        }
        const moving = clone(found.node);
        found.parent.children.splice(found.index, 1);
        document = normalizeDocument(found.document);
        const refreshedParent = findNode(document, operation.parent_id);
        const children = refreshedParent.node.children || (refreshedParent.node.children = []);
        const index = Number.isInteger(operation.index)
          ? Math.max(0, Math.min(operation.index, children.length))
          : children.length;
        children.splice(index, 0, moving);
        document = normalizeDocument(refreshedParent.document);
        return;
      }

      if (op === 'set_attributes' || op === 'set_style') {
        const found = findNode(document, targetId);
        if (!found || found.node.type !== 'element') throw new Error(`DOM 节点不存在：${targetId}`);
        if (op === 'set_attributes') {
          found.node.attributes = safeAttributes({ ...(found.node.attributes || {}), ...(operation.attributes || {}) });
        } else {
          found.node.style = safeStyle({ ...(found.node.style || {}), ...(operation.style || {}) });
        }
        document = normalizeDocument(found.document);
        return;
      }

      throw new Error(`不支持的 DOM 操作：${op || '空操作'}`);
    });
    return document;
  }

  function plainText(documentValue) {
    const document = normalizeDocument(documentValue);
    const blocks = [];
    walk(document, (node) => {
      if (node.type === 'element' && (node.editable || /^h[1-6]$/.test(node.tag))) {
        const value = exportNodeText(node).trim();
        if (value) blocks.push(value);
        return false;
      }
      return undefined;
    });
    return blocks.join('\n');
  }

  function hasClass(node, className) {
    return String(node && node.attributes && node.attributes.class || '')
      .split(/\s+/)
      .includes(className);
  }

  function isEditorOnly(node) {
    return Boolean(
      node
      && node.type === 'element'
      && (
        (node.tag === 'button' && hasClass(node, 'ai-marker'))
        || String(node.attributes && node.attributes['data-editor-only'] || '') === 'true'
      )
    );
  }

  function exportNodeText(node) {
    if (!node || isEditorOnly(node)) return '';
    if (node.type === 'text') return String(node.value || '');
    const own = node.text !== undefined ? String(node.text || '') : '';
    return own + (node.children || []).map(exportNodeText).join('');
  }

  function stableObject(value) {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableObject(value[key]);
      return result;
    }, {});
  }

  function sameValue(left, right) {
    return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
  }

  function ownNodeText(node) {
    if (!node || isEditorOnly(node)) return '';
    if (node.type === 'text') return String(node.value || '');
    return node.text === undefined ? '' : String(node.text || '');
  }

  function flattenDocument(documentValue) {
    const document = normalizeDocument(documentValue);
    const entries = new Map();

    function visit(node, parent, index, ancestors) {
      if (isEditorOnly(node)) return;
      const siblings = parent
        ? (parent.children || []).filter((child) => !isEditorOnly(child))
        : [node];
      const visibleIndex = parent ? siblings.findIndex((child) => child.id === node.id) : 0;
      entries.set(node.id, {
        node,
        parent_id: parent ? parent.id : null,
        index: visibleIndex >= 0 ? visibleIndex : index,
        sibling_ids: siblings.map((child) => child.id),
        ancestors,
      });
      (node.children || []).forEach((child, childIndex) =>
        visit(child, node, childIndex, ancestors.concat(node)));
    }

    visit(document.root, null, 0, []);
    return { document, entries };
  }

  function nodeLabel(entry) {
    const node = entry.node;
    if (node.label) return node.label;
    if (node.type === 'element' && /^h[1-6]$/.test(node.tag)) {
      return exportNodeText(node).trim() || node.id;
    }
    for (let index = entry.ancestors.length - 1; index >= 0; index -= 1) {
      const ancestor = entry.ancestors[index];
      if (ancestor.label) return ancestor.label;
      if (ancestor.type === 'element' && ancestor.tag === 'section') {
        const heading = (ancestor.children || []).find(
          (child) => child.type === 'element' && /^h[1-6]$/.test(child.tag),
        );
        const headingText = heading ? exportNodeText(heading).trim() : '';
        if (headingText) return headingText;
      }
    }
    return node.id;
  }

  function previousSharedSibling(entry, sharedIds) {
    const siblings = entry.sibling_ids || [];
    const position = siblings.indexOf(entry.node.id);
    for (let index = position - 1; index >= 0; index -= 1) {
      if (sharedIds.has(siblings[index])) return siblings[index];
    }
    return null;
  }

  /**
   * 比较两份任意 Resume DOM。差异只依赖稳定节点 ID，不依赖固定简历区块。
   * 新增/删除只报告最外层节点，避免一个新增模块被重复计算为几十处变化。
   */
  function compareDocuments(beforeValue, afterValue) {
    const before = flattenDocument(beforeValue);
    const after = flattenDocument(afterValue);
    const beforeIds = new Set(before.entries.keys());
    const afterIds = new Set(after.entries.keys());
    const sharedIds = new Set([...beforeIds].filter((id) => afterIds.has(id)));
    const changes = [];

    before.entries.forEach((entry, id) => {
      if (afterIds.has(id)) return;
      if (entry.parent_id && !afterIds.has(entry.parent_id)) return;
      changes.push({
        type: 'removed',
        node_id: id,
        label: nodeLabel(entry),
        before_text: exportNodeText(entry.node).trim(),
        after_text: '',
        before_parent_id: entry.parent_id,
        after_parent_id: null,
      });
    });

    after.entries.forEach((entry, id) => {
      if (beforeIds.has(id)) return;
      if (entry.parent_id && !beforeIds.has(entry.parent_id)) return;
      changes.push({
        type: 'added',
        node_id: id,
        label: nodeLabel(entry),
        before_text: '',
        after_text: exportNodeText(entry.node).trim(),
        before_parent_id: null,
        after_parent_id: entry.parent_id,
      });
    });

    sharedIds.forEach((id) => {
      const left = before.entries.get(id);
      const right = after.entries.get(id);
      const base = {
        node_id: id,
        label: nodeLabel(right) || nodeLabel(left),
        before_text: exportNodeText(left.node).trim(),
        after_text: exportNodeText(right.node).trim(),
        before_parent_id: left.parent_id,
        after_parent_id: right.parent_id,
      };
      const leftType = left.node.type === 'element' ? `${left.node.type}:${left.node.tag}` : left.node.type;
      const rightType = right.node.type === 'element' ? `${right.node.type}:${right.node.tag}` : right.node.type;
      if (leftType !== rightType) {
        changes.push({ ...base, type: 'structure' });
        return;
      }
      if (ownNodeText(left.node) !== ownNodeText(right.node)) {
        changes.push({ ...base, type: 'text' });
      }
      if (
        left.parent_id !== right.parent_id
        || previousSharedSibling(left, sharedIds) !== previousSharedSibling(right, sharedIds)
      ) {
        changes.push({ ...base, type: 'moved' });
      }
      if (left.node.type === 'element') {
        if (!sameValue(left.node.attributes || {}, right.node.attributes || {})) {
          changes.push({ ...base, type: 'attributes' });
        }
        if (!sameValue(left.node.style || {}, right.node.style || {})) {
          changes.push({ ...base, type: 'style' });
        }
      }
    });

    const order = {
      removed: 0,
      added: 1,
      structure: 2,
      text: 3,
      moved: 4,
      attributes: 5,
      style: 6,
    };
    changes.sort((left, right) =>
      (order[left.type] - order[right.type]) || left.node_id.localeCompare(right.node_id));
    const counts = changes.reduce((result, change) => {
      result[change.type] = (result[change.type] || 0) + 1;
      return result;
    }, { added: 0, removed: 0, text: 0, moved: 0, structure: 0, attributes: 0, style: 0 });

    return {
      equal: changes.length === 0,
      changes,
      counts,
      changed_node_ids: {
        before: [...new Set(changes.filter((change) => change.type !== 'added').map((change) => change.node_id))],
        after: [...new Set(changes.filter((change) => change.type !== 'removed').map((change) => change.node_id))],
      },
    };
  }

  /**
   * 将任意 Resume DOM 展开成打印渲染器可消费的通用内容块。
   * HTML 保留完整 DOM；PDF/DOCX 使用这些语义块做跨格式降级。
   */
  function toRenderBlocks(documentValue) {
    const document = normalizeDocument(documentValue);
    const output = { header: null, blocks: [] };
    const headingTags = /^h([1-6])$/;

    function pushText(type, node, extra) {
      const text = exportNodeText(node).trim();
      if (text) output.blocks.push({ type, text, node_id: node.id, ...(extra || {}) });
    }

    function rowBlock(node) {
      const children = (node.children || []).filter((child) => !isEditorOnly(child));
      const trailingNode = children.find((child) => child.type === 'element' && child.tag === 'time');
      const meaningful = children.filter((child) => {
        if (child === trailingNode) return false;
        return exportNodeText(child).trim();
      });
      const main = meaningful.length ? exportNodeText(meaningful[0]).trim() : '';
      const secondary = meaningful.slice(1).map(exportNodeText).join('').trim();
      const trailing = trailingNode ? exportNodeText(trailingNode).trim() : '';
      const text = exportNodeText(node).trim();
      if (text) {
        output.blocks.push({
          type: 'row',
          text,
          main: main || text,
          secondary,
          trailing,
          node_id: node.id,
        });
      }
    }

    function visit(node, context) {
      if (!node || isEditorOnly(node)) return;
      if (node.type === 'text') {
        if (String(node.value || '').trim()) pushText('paragraph', node);
        return;
      }
      const headingMatch = node.tag.match(headingTags);
      if (headingMatch) {
        pushText('heading', node, { level: Number(headingMatch[1]) });
        return;
      }
      if (node.tag === 'li') {
        pushText(context && context.ordered ? 'numbered' : 'bullet', node);
        return;
      }
      if (node.tag === 'hr') {
        output.blocks.push({ type: 'rule', node_id: node.id });
        return;
      }
      if (node.tag === 'img') {
        const alt = String(node.attributes && node.attributes.alt || '').trim();
        if (alt) output.blocks.push({ type: 'paragraph', text: alt, node_id: node.id });
        return;
      }
      if (hasClass(node, 'resume-row') || node.tag === 'tr') {
        rowBlock(node);
        return;
      }
      if (['p', 'dt', 'dd', 'figcaption'].includes(node.tag)) {
        pushText('paragraph', node);
        return;
      }
      if (node.text !== undefined && String(node.text).trim()) {
        pushText('paragraph', node);
      }
      (node.children || []).forEach((child) =>
        visit(child, { ordered: node.tag === 'ol' || Boolean(context && context.ordered) }));
    }

    (document.root.children || []).forEach((node) => {
      if (node.type === 'element' && (node.tag === 'header' || hasClass(node, 'resume-top'))) {
        const visibleChildren = (node.children || []).filter((child) => !isEditorOnly(child));
        const titleNode = visibleChildren.find(
          (child) => child.type === 'element' && child.tag === 'h1',
        ) || visibleChildren[0];
        const subtitle = visibleChildren
          .filter((child) => child !== titleNode)
          .map(exportNodeText)
          .join(' ')
          .trim();
        output.header = {
          title: titleNode ? exportNodeText(titleNode).trim() : '',
          subtitle,
          node_id: node.id,
        };
        return;
      }
      visit(node, {});
    });
    return output;
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function styleText(style) {
    return Object.entries(safeStyle(style))
      .map(([name, value]) => `${name}:${value}`)
      .join(';');
  }

  function renderNodeToHtml(node, options) {
    if (options && options.forExport && isEditorOnly(node)) return '';
    if (node.type === 'text') return escapeHtml(node.value);
    const attrs = {
      ...(node.attributes || {}),
      'data-node-id': node.id,
      ...(node.editable ? { 'data-resume-editable': 'true' } : {}),
    };
    const style = styleText(node.style);
    if (style) attrs.style = style;
    const attributeText = Object.entries(attrs)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
    const rawText = node.text !== undefined
      ? (node.format === 'spaced-characters' ? String(node.text).split('').join(' ') : node.text)
      : null;
    const content = (rawText !== null ? escapeHtml(rawText) : '')
      + (node.children || []).map((child) => renderNodeToHtml(child, options)).join('');
    if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attributeText}>`;
    return `<${node.tag}${attributeText}>${content}</${node.tag}>`;
  }

  function renderToHtml(documentValue, options) {
    const document = normalizeDocument(documentValue);
    const root = document.root;
    if (options && options.includeRoot) return renderNodeToHtml(root, options);
    return (root.children || []).map((node) => renderNodeToHtml(node, options)).join('');
  }

  class Renderer {
    constructor(rootElement, options) {
      if (!rootElement || typeof rootElement.replaceChildren !== 'function') {
        throw new Error('ResumeDom.Renderer 需要有效的 DOM 容器');
      }
      this.rootElement = rootElement;
      this.options = options || {};
      this.document = null;
    }

    createNode(node) {
      const ownerDocument = this.rootElement.ownerDocument;
      if (node.type === 'text') return ownerDocument.createTextNode(node.value || '');
      const svg = node.tag === 'svg' || (this.options.svgNamespace && this.options.svgNamespace.has(node.tag));
      const element = svg
        ? ownerDocument.createElementNS('http://www.w3.org/2000/svg', node.tag)
        : ownerDocument.createElement(node.tag);
      element.dataset.nodeId = node.id;
      if (node.editable) element.dataset.resumeEditable = 'true';
      Object.entries(node.attributes || {}).forEach(([name, value]) => {
        element.setAttribute(name, value);
      });
      Object.entries(node.style || {}).forEach(([name, value]) => {
        element.style.setProperty(name, value);
      });
      if (node.text !== undefined) {
        element.appendChild(ownerDocument.createTextNode(node.format === 'spaced-characters'
          ? String(node.text).split('').join(' ')
          : String(node.text)));
      }
      (node.children || []).forEach((child) => element.appendChild(this.createNode(child)));
      return element;
    }

    render(documentValue) {
      this.document = normalizeDocument(documentValue);
      const fragment = this.rootElement.ownerDocument.createDocumentFragment();
      (this.document.root.children || []).forEach((node) => fragment.appendChild(this.createNode(node)));
      this.rootElement.replaceChildren(fragment);
      if (typeof this.options.afterRender === 'function') {
        this.options.afterRender(this.rootElement, this.document);
      }
      return this.document;
    }

    elementFor(nodeId) {
      const cssApi = this.rootElement.ownerDocument.defaultView
        && this.rootElement.ownerDocument.defaultView.CSS;
      const escaped = cssApi && cssApi.escape
        ? cssApi.escape(String(nodeId))
        : String(nodeId).replace(/"/g, '\\"');
      return this.rootElement.querySelector(`[data-node-id="${escaped}"]`);
    }
  }

  return {
    VERSION,
    ALLOWED_TAGS,
    normalizeDocument,
    ensureDocument,
    attachDocument,
    legacyResumeToDom,
    findNode,
    nodeText,
    syncLegacyBindings,
    applyOperations,
    compareDocuments,
    plainText,
    exportNodeText,
    toRenderBlocks,
    renderToHtml,
    Renderer,
    elementNode,
    textNode,
    clone,
  };
});
