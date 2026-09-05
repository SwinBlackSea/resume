(function initResumeDom(globalObject, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalObject) globalObject.ResumeDom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createResumeDomApi() {
  'use strict';

  const VERSION = 'resume-dom-v1';
  const RESUME_DOCUMENT_VERSION = 'resume-document-v3';
  const AGGREGATE_VERSION = 'resume-aggregate-v2';
  const TEMPLATE_DOCUMENT_VERSION = 'template-document-v1';
  const BINDINGS_VERSION = 'layout-bindings-v1';
  const AI_CONTEXT_VERSION = 'resume-ai-context-v1';
  const MAX_DEPTH = 40;
  const MAX_NODES = 5000;
  const SEMANTIC_KINDS = new Set([
    'document',
    'page',
    'header',
    'section',
    'section_title',
    'document_title',
    'group',
    'entry',
    'entry_header',
    'paragraph',
    'list',
    'list_item',
    'table',
    'table_row',
    'table_cell',
    'figure',
    'caption',
    'inline',
    'layout_line',
    'decoration',
    'separator',
    'unknown',
  ]);
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
  const TEXT_BLOCK_TAGS = new Set([
    'article', 'section', 'header', 'footer', 'main', 'aside', 'div',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'figure', 'figcaption',
  ]);
  const SAFE_ATTRIBUTE = /^(?:id|class|title|role|type|href|src|alt|width|height|colspan|rowspan|viewBox|d|fill|stroke|stroke-width|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|points|transform|preserveAspectRatio|data-[\w-]+|aria-[\w-]+)$/;
  const SAFE_STYLE_NAME = /^(?:--[\w-]+|[a-z][a-z0-9-]*)$/i;
  const UNSAFE_CSS_VALUE = /(?:expression\s*\(|javascript\s*:|@import|behavior\s*:|url\s*\()/i;
  const UNSAFE_URL = /^\s*(?:javascript|vbscript):/i;
  const DATA_URL = /^\s*data:/i;
  const SAFE_IMAGE_DATA_URL = /^\s*data:image\/(?:png|jpe?g|gif|webp);base64,/i;

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function operationError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details && typeof details === 'object') Object.assign(error, details);
    return error;
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

  function semanticToken(value, fallback) {
    const token = String(value || '').trim().toLowerCase();
    return /^[a-z][a-z0-9_-]{0,63}$/.test(token) ? token : fallback;
  }

  function safeSemantic(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = semanticToken(value.kind, '');
    if (!SEMANTIC_KINDS.has(kind)) return null;
    const result = { kind };
    const subtype = semanticToken(value.subtype, '');
    if (subtype) result.subtype = subtype;
    const groupId = cleanId(value.group_id, '');
    if (groupId) result.group_id = groupId;
    const level = Number(value.level);
    if (Number.isInteger(level) && level >= 1 && level <= 9) result.level = level;
    if (value.continuation === true) result.continuation = true;
    return result;
  }

  function semanticKind(node) {
    const explicit = node && node.semantic && semanticToken(node.semantic.kind, '');
    if (explicit && SEMANTIC_KINDS.has(explicit)) return explicit;
    if (!node || node.type === 'text') return 'inline';
    if (rawHasClass(node, 'imported-scene-background')) return 'decoration';
    if (rawHasClass(node, 'imported-document-page')) return 'page';
    if (rawHasClass(node, 'resume-top')) return 'header';
    if (rawHasClass(node, 'resume-row')) return 'entry_header';
    if (rawHasClass(node, 'resume-section')) return 'section';
    if (node.tag === 'article') return 'document';
    if (node.tag === 'header' || node.tag === 'footer') return 'header';
    if (node.tag === 'section' || node.tag === 'main' || node.tag === 'aside') return 'section';
    if (node.tag === 'h1') return 'document_title';
    if (/^h[2-6]$/.test(node.tag || '')) return 'section_title';
    if (node.tag === 'p' || node.tag === 'dd' || node.tag === 'dt') return 'paragraph';
    if (node.tag === 'ul' || node.tag === 'ol' || node.tag === 'dl') return 'list';
    if (node.tag === 'li') return 'list_item';
    if (node.tag === 'table') return 'table';
    if (node.tag === 'tr') return 'table_row';
    if (node.tag === 'td' || node.tag === 'th') return 'table_cell';
    if (node.tag === 'figure' || node.tag === 'img' || node.tag === 'svg') return 'figure';
    if (node.tag === 'figcaption') return 'caption';
    if (node.tag === 'hr') return 'separator';
    if (['span', 'strong', 'em', 'b', 'i', 'small', 'time', 'a'].includes(node.tag)) {
      return 'inline';
    }
    if (node.editable) return 'paragraph';
    return 'group';
  }

  function rawHasClass(node, className) {
    return String(node && node.attributes && node.attributes.class || '')
      .split(/\s+/)
      .includes(className);
  }

  function pxValuesToPt(style) {
    const result = {};
    Object.entries(style || {}).forEach(([name, value]) => {
      result[name] = String(value).replace(/(-?\d+(?:\.\d+)?)px\b/g, '$1pt');
    });
    return result;
  }

  function paddingTokens(value) {
    const tokens = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    if (tokens.length === 1) return [tokens[0], tokens[0], tokens[0], tokens[0]];
    if (tokens.length === 2) return [tokens[0], tokens[1], tokens[0], tokens[1]];
    if (tokens.length === 3) return [tokens[0], tokens[1], tokens[2], tokens[1]];
    return tokens.slice(0, 4);
  }

  function percentLengthToPt(value, total) {
    const match = String(value || '').match(/^(-?\d+(?:\.\d+)?)%$/);
    if (!match) return value;
    return `${Number(((Number(match[1]) / 100) * total).toFixed(2))}pt`;
  }

  function pointNumber(value) {
    const match = String(value || '').match(/^(-?\d+(?:\.\d+)?)pt$/);
    return match ? Number(match[1]) : 0;
  }

  function importedFontMetricScale(page) {
    const family = String(page.style && page.style['font-family'] || '').toLowerCase();
    if (
      family.includes('noto sans sc')
      || family.includes('noto sans cjk')
      || family.includes('source han sans')
    ) return 1.448;
    return 1.2;
  }

  function upgradeImportedLineMetrics(page) {
    if (String(page.attributes && page.attributes['data-font-metric-scale'] || '')) return;
    const scale = importedFontMetricScale(page);
    const defaultFontSize = pointNumber(page.style && page.style['font-size']);

    function visit(node) {
      if (!node || node.type !== 'element') return;
      if (['h1', 'h2', 'p'].includes(node.tag)) {
        const lineHeight = Number(node.style && node.style['line-height']);
        if (Number.isFinite(lineHeight) && lineHeight > 0) {
          const childFontSizes = (node.children || [])
            .filter((child) => child && child.type === 'element')
            .map((child) => pointNumber(child.style && child.style['font-size']))
            .filter((value) => value > 0);
          const ownFontSize = pointNumber(node.style && node.style['font-size']);
          const fontSize = ownFontSize || (
            childFontSizes.length ? Math.max(...childFontSizes) : defaultFontSize
          );
          if (fontSize) {
            node.style['line-height'] = `${
              Number((lineHeight * fontSize * scale).toFixed(2))
            }pt`;
          }
        }
      }
      (node.children || []).forEach(visit);
    }

    visit(page);
    page.attributes = {
      ...(page.attributes || {}),
      'data-font-metric-scale': String(scale),
    };
  }

  /**
   * document-recognition-v2 初版把 Word 的 pt 逻辑值写成了 px，且页面宽度使用 100%。
   * 在读取旧草稿时升级为固定 pt 画布，再由前端对整页统一缩放。
   */
  function upgradeImportedNativeUnits(root) {
    if (!rawHasClass(root, 'imported-native-resume')) return root;

    function convertSubtree(node) {
      if (!node || node.type !== 'element') return;
      node.style = pxValuesToPt(node.style || {});
      (node.children || []).forEach(convertSubtree);
    }

    function visit(node) {
      if (!node || node.type !== 'element') return;
      if (rawHasClass(node, 'imported-document-page')) {
        if (String(node.attributes && node.attributes['data-layout-unit'] || '') !== 'pt') {
          const ratio = String(node.style && node.style['aspect-ratio'] || '')
            .match(/([\d.]+)\s*\/\s*([\d.]+)/);
          let widthPt = ratio ? Number(ratio[1]) : 595.3;
          let heightPt = ratio ? Number(ratio[2]) : 841.9;
          if (widthPt > 2000 || heightPt > 2000) {
            widthPt /= 20;
            heightPt /= 20;
          }
          widthPt = Number((widthPt || 595.3).toFixed(2));
          heightPt = Number((heightPt || 841.9).toFixed(2));
          const padding = paddingTokens(node.style && node.style.padding);
          convertSubtree(node);
          node.attributes = {
            ...(node.attributes || {}),
            'data-layout-unit': 'pt',
            'data-page-width-pt': String(widthPt),
            'data-page-height-pt': String(heightPt),
          };
          node.style.width = `${widthPt}pt`;
          node.style['min-height'] = `${heightPt}pt`;
          node.style['aspect-ratio'] = `${widthPt} / ${heightPt}`;
          node.style['margin-top'] = '0';
          if (padding.length) {
            node.style.padding = [
              percentLengthToPt(padding[0], heightPt),
              percentLengthToPt(padding[1], widthPt),
              percentLengthToPt(padding[2], heightPt),
              percentLengthToPt(padding[3], widthPt),
            ].join(' ');
          }
        }
        upgradeImportedLineMetrics(node);
        return;
      }
      (node.children || []).forEach(visit);
    }

    visit(root);
    return root;
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
      const semantic = safeSemantic(raw.semantic);
      if (semantic) normalized.semantic = semantic;
      if (raw.format === 'spaced-characters') normalized.format = raw.format;
      if (raw.binding && typeof raw.binding === 'object') normalized.binding = clone(raw.binding);
      if (!VOID_TAGS.has(tag)) {
        normalized.children = (Array.isArray(raw.children) ? raw.children : [])
          .map((child) => normalizeNode(child, depth + 1));
      }
      return normalized;
    }

    const root = upgradeImportedNativeUnits(
      normalizeNode(source.root || elementNode('resume-root', 'article'), 0),
    );

    // v2.4.0 曾用 data-ai-scope=true 把“外层整体 AI 范围”和 editable
    // 子节点叠在一起。读取旧文档时无损升级为一个真实 editable 节点：
    // 子元素只保留段落与行内格式，不再拥有第二套编辑身份。
    function removeDescendantEditingIdentity(node) {
      (node.children || []).forEach((child) => {
        if (child && child.type === 'element') {
          delete child.editable;
          removeDescendantEditingIdentity(child);
        }
      });
    }
    (function migrateLegacyAiScope(node) {
      if (!node || node.type !== 'element') return;
      (node.children || []).forEach(migrateLegacyAiScope);
      const hasRetiredScope = Boolean(
        node.attributes
        && Object.prototype.hasOwnProperty.call(node.attributes, 'data-ai-scope'),
      );
      if (hasRetiredScope && options && options.allowLegacyAiScope === false) {
        throw operationError(
          'AI_SCOPE_ATTRIBUTE_FORBIDDEN',
          'data-ai-scope 已停用；一个编辑节点必须对应一个真实内容节点',
          { node_id: node.id },
        );
      }
      if (String(node.attributes && node.attributes['data-ai-scope'] || '') === 'true') {
        node.attributes = { ...(node.attributes || {}) };
        delete node.attributes['data-ai-scope'];
        node.editable = true;
        removeDescendantEditingIdentity(node);
      } else if (hasRetiredScope) {
        node.attributes = { ...(node.attributes || {}) };
        delete node.attributes['data-ai-scope'];
      }
    })(root);

    // 强制不变量：一个可编辑节点内部不能再包含另一个可编辑节点。
    // 内部仍可保留 p、span、strong 等格式元素，但它们不是独立编辑目标。
    (function assertSingleEditingIdentity(node, editableAncestorId) {
      if (!node || node.type !== 'element') return;
      if (node.editable && editableAncestorId) {
        throw operationError(
          'NESTED_EDITABLE_NODE',
          `可编辑节点不能嵌套：${editableAncestorId} → ${node.id}`,
          { ancestor_node_id: editableAncestorId, node_id: node.id },
        );
      }
      const nextAncestorId = node.editable ? node.id : editableAncestorId;
      (node.children || []).forEach((child) =>
        assertSingleEditingIdentity(child, nextAncestorId));
    })(root, null);

    if (root.type !== 'element') throw new Error('DOM 文档根节点必须是元素');
    return { version: VERSION, root };
  }

  function rawFindNode(node, nodeId) {
    if (!node) return null;
    if (node.id === nodeId) return node;
    for (const child of node.children || []) {
      const found = rawFindNode(child, nodeId);
      if (found) return found;
    }
    return null;
  }

  function hasImportedPages(documentValue) {
    let found = false;
    const document = normalizeDocument(documentValue);
    (function visit(node) {
      if (found || !node || node.type !== 'element') return;
      if (rawHasClass(node, 'imported-document-page')) {
        found = true;
        return;
      }
      (node.children || []).forEach(visit);
    })(document.root);
    return found;
  }

  function editableNodes(documentValue) {
    const document = normalizeDocument(documentValue);
    const result = [];
    (function visit(node, pageId) {
      if (!node || node.type !== 'element') return;
      const nextPageId = rawHasClass(node, 'imported-document-page') ? node.id : pageId;
      if (node.editable) {
        result.push({ node, page_id: nextPageId || null });
        return;
      }
      (node.children || []).forEach((child) => visit(child, nextPageId));
    })(document.root, null);
    return result;
  }

  function extractContentDocument(documentValue) {
    const document = normalizeDocument(documentValue);
    if (!hasImportedPages(document)) return document;
    const groups = new Map();
    editableNodes(document).forEach(({ node, page_id: pageId }) => {
      const groupId = pageId || 'main';
      if (!groups.has(groupId)) groups.set(groupId, []);
      const tag = /^h[1-6]$/.test(node.tag || '') ? node.tag : 'p';
      groups.get(groupId).push(elementNode(
        node.id,
        tag,
        { class: 'editable' },
        [],
        {
          text: exportNodeText(node),
          editable: true,
          label: node.label || '正文',
          binding: node.binding ? clone(node.binding) : null,
        },
      ));
    });
    const sections = Array.from(groups.entries()).map(([pageId, children], index) =>
      elementNode(
        `content-${cleanId(pageId, `page-${index + 1}`)}`,
        'section',
        { class: 'resume-section' },
        children,
        { label: `第 ${index + 1} 页内容` },
      ));
    return normalizeDocument({
      version: VERSION,
      root: elementNode(
        'resume-root',
        'article',
        { class: 'resume-dom-root resume-content-document' },
        sections,
      ),
    }, { dedupeIds: true });
  }

  function collectTextCarriers(node, result) {
    if (!node) return result;
    if (node.type === 'text') {
      result.push({ node_id: node.id, field: 'value', length: String(node.value || '').length });
      return result;
    }
    if (node.text !== undefined) {
      result.push({ node_id: node.id, field: 'text', length: String(node.text || '').length });
    }
    (node.children || []).forEach((child) => collectTextCarriers(child, result));
    return result;
  }

  function createTemplateDocument(documentValue) {
    const source = normalizeDocument(documentValue);
    if (!hasImportedPages(source)) return null;
    const result = clone(source);
    (function blank(node, insideSlot) {
      if (!node) return;
      const isSlot = node.type === 'element' && node.editable;
      const nextInsideSlot = insideSlot || isSlot;
      if (isSlot) {
        node.attributes = {
          ...(node.attributes || {}),
          'data-template-slot': node.id,
        };
        delete node.binding;
      }
      if (nextInsideSlot) {
        if (node.type === 'text') node.value = '';
        else if (node.text !== undefined) node.text = '';
      }
      (node.children || []).forEach((child) => blank(child, nextInsideSlot));
    })(result.root, false);
    return normalizeDocument(result);
  }

  function createLayoutBindings(contentDocument, renderedDocument, templateDocument) {
    const content = normalizeDocument(contentDocument);
    const rendered = normalizeDocument(renderedDocument || content);
    const template = templateDocument ? normalizeDocument(templateDocument) : null;
    const items = [];
    const contentEntries = editableNodes(content);
    contentEntries.forEach(({ node }, index) => {
      const renderedNode = rawFindNode(rendered.root, node.id);
      const templateNode = template && rawFindNode(template.root, node.id);
      items.push({
        content_node_id: node.id,
        template_node_id: templateNode ? templateNode.id : null,
        region_id: templateNode ? 'imported-page' : 'main',
        order: index,
        segments: renderedNode ? collectTextCarriers(renderedNode, []) : [],
      });
    });
    return { version: BINDINGS_VERSION, items };
  }

  function alignLayoutBindings(contentDocument, templateDocument, blueprint) {
    const contentEntries = editableNodes(contentDocument);
    const template = templateDocument ? normalizeDocument(templateDocument) : null;
    const slots = blueprint && Array.isArray(blueprint.items)
      ? blueprint.items
          .filter((item) => item && item.template_node_id)
          .slice()
          .sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
      : [];
    if (!template || !slots.length) {
      return createLayoutBindings(contentDocument, contentDocument, templateDocument);
    }

    const usedSlots = new Set();
    const items = [];
    const unmatched = [];
    contentEntries.forEach(({ node }, index) => {
      const exact = slots.find(
        (slot) =>
          !usedSlots.has(slot.template_node_id)
          && slot.content_node_id === node.id
          && rawFindNode(template.root, slot.template_node_id),
      );
      if (!exact) {
        unmatched.push({ node, index });
        return;
      }
      usedSlots.add(exact.template_node_id);
      items.push({
        ...clone(exact),
        content_node_id: node.id,
        order: index,
      });
    });

    const remainingSlots = slots.filter(
      (slot) =>
        !usedSlots.has(slot.template_node_id)
        && rawFindNode(template.root, slot.template_node_id),
    );
    unmatched.forEach(({ node, index }, unmatchedIndex) => {
      const slot = remainingSlots[unmatchedIndex];
      items.push(slot
        ? {
            ...clone(slot),
            content_node_id: node.id,
            order: index,
          }
        : {
            content_node_id: node.id,
            template_node_id: null,
            region_id: 'main',
            order: index,
            segments: [],
          });
    });
    items.sort((left, right) => left.order - right.order);
    return { version: BINDINGS_VERSION, items };
  }

  function applyTextToTemplateSlot(templateRoot, binding, text) {
    const slot = rawFindNode(templateRoot, binding.template_node_id);
    if (!slot) return false;
    const segments = Array.isArray(binding.segments) ? binding.segments : [];
    if (!segments.length) {
      slot.text = text;
      slot.children = [];
      return true;
    }
    let offset = 0;
    segments.forEach((segment, index) => {
      const carrier = rawFindNode(templateRoot, segment.node_id);
      if (!carrier) return;
      const remaining = text.length - offset;
      const count = index === segments.length - 1
        ? Math.max(0, remaining)
        : Math.max(0, Math.min(remaining, Number(segment.length || 0)));
      const value = text.slice(offset, offset + count);
      if (segment.field === 'value' && carrier.type === 'text') carrier.value = value;
      else if (carrier.type === 'element') carrier.text = value;
      offset += count;
    });
    if (offset < text.length) {
      const last = segments[segments.length - 1];
      const carrier = last && rawFindNode(templateRoot, last.node_id);
      if (carrier) {
        if (last.field === 'value' && carrier.type === 'text') carrier.value += text.slice(offset);
        else if (carrier.type === 'element') carrier.text = String(carrier.text || '') + text.slice(offset);
      }
    }
    return true;
  }

  function composeAggregateDocument(resume) {
    const content = normalizeDocument(resume.content_document);
    const templateDocument = resume.template_document && resume.template_document.document;
    if (!templateDocument) return content;
    const rendered = clone(normalizeDocument(templateDocument));
    const bindings = resume.layout_bindings && Array.isArray(resume.layout_bindings.items)
      ? resume.layout_bindings.items
      : [];
    const mapped = new Set();
    bindings.forEach((binding) => {
      if (!binding || !binding.content_node_id || !binding.template_node_id) return;
      const contentNode = rawFindNode(content.root, binding.content_node_id);
      if (!contentNode) return;
      if (applyTextToTemplateSlot(rendered.root, binding, exportNodeText(contentNode))) {
        mapped.add(binding.content_node_id);
      }
    });
    const unmapped = editableNodes(content)
      .map((entry) => entry.node)
      .filter((node) => !mapped.has(node.id));
    if (unmapped.length) {
      rendered.root.children.push(elementNode(
        'resume-unmapped-content',
        'section',
        { class: 'resume-section imported-unmapped-content' },
        unmapped.map((node) => clone(node)),
        { label: '补充内容' },
      ));
    }
    return normalizeDocument(rendered, { dedupeIds: true });
  }

  function templateParts(template) {
    const source = template && typeof template === 'object' ? template : {};
    const schema = clone(source.schema || source);
    return {
      template_version_id: source.template_version_id || null,
      schema,
      document: schema.document_template ? normalizeDocument(schema.document_template) : null,
      binding_blueprint: schema.binding_blueprint
        && Array.isArray(schema.binding_blueprint.items)
        ? clone(schema.binding_blueprint)
        : null,
    };
  }

  function createResumeAggregate(resume, template) {
    const result = clone(resume && typeof resume === 'object' ? resume : {});
    const rendered = result.dom_document && result.dom_document.root
      ? normalizeDocument(result.dom_document)
      : legacyResumeToDom(result);
    const parts = templateParts(template || result.template_document || {});
    const content = result.content_document && result.content_document.root
      ? normalizeDocument(result.content_document)
      : extractContentDocument(rendered);
    const documentTemplate = parts.document || createTemplateDocument(rendered);
    const bindings = parts.binding_blueprint
      ? alignLayoutBindings(content, documentTemplate, parts.binding_blueprint)
      : createLayoutBindings(content, rendered, documentTemplate);
    result.resume_model_version = AGGREGATE_VERSION;
    result.content_document = content;
    result.template_document = {
      version: TEMPLATE_DOCUMENT_VERSION,
      template_version_id: parts.template_version_id
        || (result.template_document && result.template_document.template_version_id)
        || null,
      schema: parts.schema,
      document: documentTemplate,
    };
    result.layout_bindings = bindings;
    result.dom_document = composeAggregateDocument(result);
    return result;
  }

  function applyTemplate(resume, template) {
    const current = resume && resume.content_document
      ? createResumeAggregate(resume, resume.template_document)
      : createResumeAggregate(resume, null);
    const parts = templateParts(template);
    const documentTemplate = parts.document;
    current.template_document = {
      version: TEMPLATE_DOCUMENT_VERSION,
      template_version_id: parts.template_version_id,
      schema: parts.schema,
      document: documentTemplate,
    };
    current.layout_bindings = parts.binding_blueprint
      ? alignLayoutBindings(
          current.content_document,
          documentTemplate,
          parts.binding_blueprint,
        )
      : createLayoutBindings(
          current.content_document,
          current.content_document,
          documentTemplate,
        );
    current.layout_hints = {
      ...(current.layout_hints || {}),
      layout: parts.schema.layout || 'classic',
      max_pages: parts.schema.page && parts.schema.page.max_pages || 2,
    };
    current.dom_document = composeAggregateDocument(current);
    return current;
  }

  function ensureDocument(resume, options) {
    if (resume && resume.resume_document && resume.resume_document.root) {
      return normalizeDocument(resume.resume_document, options);
    }
    if (resume && resume.schema_version === RESUME_DOCUMENT_VERSION && resume.root) {
      return normalizeDocument(resume, options);
    }
    if (resume && resume.content_document && resume.template_document && resume.layout_bindings) {
      return composeAggregateDocument(resume);
    }
    if (resume && resume.dom_document && resume.dom_document.root) {
      return normalizeDocument(resume.dom_document, options);
    }
    return legacyResumeToDom(resume || {});
  }

  function plainObject(value, fallback) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? clone(value)
      : clone(fallback);
  }

  /**
   * 当前唯一持久化模型。旧字段只参与读取，输出不再包含模板、槽位绑定或 legacy 正文字段。
   */
  function toResumeDocument(resume, options) {
    const source = resume && resume.resume_document
      ? resume.resume_document
      : (resume && typeof resume === 'object' ? resume : {});
    const document = ensureDocument(resume || {}, options);
    const legacyLayout = source.layout_hints && typeof source.layout_hints === 'object'
      ? source.layout_hints
      : {};
    return {
      schema_version: RESUME_DOCUMENT_VERSION,
      root: document.root,
      page_setup: plainObject(source.page_setup, {
        size: 'A4',
        orientation: 'portrait',
        margins: {},
        max_pages: legacyLayout.max_pages || null,
      }),
      styles: plainObject(source.styles, {}),
      assets: Array.isArray(source.assets) ? clone(source.assets).slice(0, 500) : [],
      annotations: Array.isArray(source.annotations)
        ? clone(source.annotations).slice(0, 5000)
        : [],
    };
  }

  function applyDocumentOperations(resumeDocument, operations, options) {
    const before = toResumeDocument(resumeDocument);
    const changed = applyOperations(before, operations, options);
    return toResumeDocument({
      ...before,
      root: changed.root,
    });
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

  function isAiEditableNode(node) {
    return Boolean(node && node.type === 'element' && node.editable === true);
  }

  /**
   * AI 作用范围只认真实 editable 节点。
   * 如果客户端传入一个节点内部的格式元素，则规范到唯一 editable 祖先；
   * 不存在父子两套并列 AI 身份。
   */
  function resolveAiScopeNode(documentValue, nodeId) {
    const requested = findNode(documentValue, nodeId);
    if (!requested) return null;
    const candidates = requested.ancestors.concat(requested.node).reverse();
    const editable = candidates.find(isAiEditableNode);
    if (!editable) return null;
    const resolved = editable.id === requested.node.id
      ? requested
      : findNode(requested.document, editable.id);
    return {
      ...resolved,
      requested_node_id: String(nodeId),
      canonicalized: editable.id !== requested.node.id,
    };
  }

  function childText(node, reader) {
    const children = node && node.children || [];
    const separator = node
      && node.editable
      && children.filter((child) => child && child.type === 'element').length > 1
      && children.every((child) => (
        child.type !== 'element' || TEXT_BLOCK_TAGS.has(String(child.tag || ''))
      ))
      ? '\n'
      : '';
    return children.map(reader).join(separator);
  }

  function nodeText(node) {
    if (!node) return '';
    if (node.type === 'text') return String(node.value || '');
    if (node.text !== undefined) return String(node.text || '');
    return childText(node, nodeText);
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
    if (
      result.content_document
      && result.layout_bindings
      && Array.isArray(result.layout_bindings.items)
    ) {
      const content = normalizeDocument(result.content_document);
      result.layout_bindings.items.forEach((layoutBinding) => {
        if (!layoutBinding || !layoutBinding.content_node_id) return;
        const renderedNode = rawFindNode(
          document.root,
          layoutBinding.template_node_id || layoutBinding.content_node_id,
        );
        const contentNode = rawFindNode(content.root, layoutBinding.content_node_id);
        if (!renderedNode || !contentNode) return;
        contentNode.text = exportNodeText(renderedNode);
        contentNode.children = [];
      });
      result.content_document = normalizeDocument(content);
    }
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
    result.dom_document = result.content_document
      ? composeAggregateDocument(result)
      : document;
    return result;
  }

  function sharedPrefixLength(left, right) {
    const limit = Math.min(left.length, right.length);
    let index = 0;
    while (index < limit && left[index] === right[index]) index += 1;
    return index;
  }

  function sharedSuffixLength(left, right, prefixLength) {
    const limit = Math.min(left.length, right.length) - prefixLength;
    let index = 0;
    while (
      index < limit
      && left[left.length - 1 - index] === right[right.length - 1 - index]
    ) index += 1;
    return index;
  }

  function collectVisibleTextCarriers(node, carriers) {
    if (!node || isEditorOnly(node)) return carriers;
    if (node.type === 'text') {
      carriers.push({
        node,
        field: 'value',
        value: String(node.value || ''),
      });
      return carriers;
    }
    if (node.text !== undefined) {
      carriers.push({
        node,
        field: 'text',
        value: String(node.text || ''),
      });
    }
    (node.children || []).forEach((child) =>
      collectVisibleTextCarriers(child, carriers));
    return carriers;
  }

  /**
   * 只重新分配文字载荷，不改变任何元素、属性、样式或节点 ID。
   *
   * 多个行内载荷存在时，用旧文本与新文本的公共前后缀固定不变区域，
   * 再把真正变化的中间区域按原载荷边界映射回现有节点。这样标题中的
   * strong/em/span 等样式不会因为一次文字修改被清空。
   */
  function replaceInlineTextPreservingMarkup(node, text) {
    const carriers = collectVisibleTextCarriers(node, []);
    if (!carriers.length) {
      if (node.type === 'text') node.value = text;
      else node.text = text;
      return;
    }
    if (carriers.length === 1) {
      carriers[0].node[carriers[0].field] = text;
      return;
    }

    const before = carriers.map((carrier) => carrier.value).join('');
    if (!before.length) {
      carriers.forEach((carrier, index) => {
        carrier.node[carrier.field] = index === 0 ? text : '';
      });
      return;
    }

    const prefixLength = sharedPrefixLength(before, text);
    const suffixLength = sharedSuffixLength(before, text, prefixLength);
    const oldMiddleLength = before.length - prefixLength - suffixLength;
    const newMiddleLength = text.length - prefixLength - suffixLength;
    const mapBoundary = (offset) => {
      if (offset <= prefixLength) return offset;
      if (offset >= before.length - suffixLength) {
        return text.length - (before.length - offset);
      }
      if (oldMiddleLength <= 0) return prefixLength;
      return prefixLength + Math.round(
        ((offset - prefixLength) / oldMiddleLength) * newMiddleLength,
      );
    };

    let oldOffset = 0;
    let previousNewOffset = 0;
    carriers.forEach((carrier, index) => {
      oldOffset += carrier.value.length;
      const mapped = index === carriers.length - 1
        ? text.length
        : Math.max(previousNewOffset, Math.min(text.length, mapBoundary(oldOffset)));
      carrier.node[carrier.field] = text.slice(previousNewOffset, mapped);
      previousNewOffset = mapped;
    });
  }

  function editableBlockChildren(node) {
    if (!node || node.type !== 'element' || node.editable !== true) return [];
    const visible = (node.children || []).filter((child) => {
      if (!child || isEditorOnly(child)) return false;
      if (child.type === 'text') return String(child.value || '').trim() !== '';
      return true;
    });
    if (
      !visible.length
      || visible.some((child) => (
        child.type !== 'element'
        || !TEXT_BLOCK_TAGS.has(String(child.tag || ''))
      ))
    ) return [];
    return visible;
  }

  function replaceNodeTextPreservingStructure(node, text, nodeId) {
    if (node.type === 'text') {
      node.value = text;
      return;
    }
    const blockChildren = editableBlockChildren(node);
    if (!blockChildren.length) {
      replaceInlineTextPreservingMarkup(node, text);
      return;
    }

    const segments = text.split('\n');
    if (segments.length !== blockChildren.length) {
      throw operationError(
        'EDITABLE_BLOCK_COUNT_MISMATCH',
        `当前内容包含 ${blockChildren.length} 个段落；修改文字时必须保持段落数量，增删段落请使用结构操作`,
        {
          node_id: nodeId,
          expected_blocks: blockChildren.length,
          received_blocks: segments.length,
        },
      );
    }
    // 旧实现可能把新文字写到容器自身、同时保留段落子节点。统一修复为
    // “容器负责组织，段落负责文字”，避免再次渲染成新旧文字叠加。
    delete node.text;
    blockChildren.forEach((child, index) =>
      replaceInlineTextPreservingMarkup(child, segments[index]));
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
        const text = String(operation.text == null ? '' : operation.text)
          .replace(/\r\n?/g, '\n');
        replaceNodeTextPreservingStructure(found.node, text, targetId);
        document = normalizeDocument(found.document);
        return;
      }

      if (!allowStructure) throw new Error('当前操作只允许修改节点文字');

      if (op === 'insert_node') {
        const parent = findNode(document, operation.parent_id);
        if (!parent || parent.node.type !== 'element') {
          throw operationError('PARENT_NOT_FOUND', `父节点不存在：${operation.parent_id}`, {
            parent_id: operation.parent_id,
          });
        }
        const children = parent.node.children || (parent.node.children = []);
        let index = Number.isInteger(operation.index) ? operation.index : children.length;
        if (operation.after_node_id) {
          const afterIndex = children.findIndex((child) => child.id === operation.after_node_id);
          if (afterIndex < 0) {
            throw operationError(
              'ANCHOR_PARENT_MISMATCH',
              `插入锚点不属于目标父节点：${operation.after_node_id}`,
              {
                parent_id: operation.parent_id,
                anchor_node_id: operation.after_node_id,
              },
            );
          }
          index = afterIndex + 1;
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
          throw operationError('MOVE_TARGET_NOT_FOUND', '移动节点或目标容器不存在', {
            node_id: targetId,
            parent_id: operation.parent_id,
          });
        }
        if (
          parent.node.id === found.node.id
          || parent.ancestors.some((ancestor) => ancestor.id === found.node.id)
        ) {
          throw operationError('MOVE_CYCLE', '不能把节点移动到自身或其子节点中');
        }
        const moving = clone(found.node);
        found.parent.children.splice(found.index, 1);
        document = normalizeDocument(found.document);
        const refreshedParent = findNode(document, operation.parent_id);
        const children = refreshedParent.node.children || (refreshedParent.node.children = []);
        let index = Number.isInteger(operation.index)
          ? operation.index
          : children.length;
        if (operation.after_node_id) {
          const afterIndex = children.findIndex((child) => child.id === operation.after_node_id);
          if (afterIndex < 0) {
            throw operationError(
              'ANCHOR_PARENT_MISMATCH',
              `移动锚点不属于目标父节点：${operation.after_node_id}`,
              {
                parent_id: operation.parent_id,
                anchor_node_id: operation.after_node_id,
              },
            );
          }
          index = afterIndex + 1;
        }
        index = Math.max(0, Math.min(index, children.length));
        children.splice(index, 0, moving);
        document = normalizeDocument(refreshedParent.document);
        return;
      }

      if (op === 'wrap_nodes') {
        const parent = findNode(document, operation.parent_id);
        const nodeIds = Array.from(new Set(
          (Array.isArray(operation.node_ids) ? operation.node_ids : []).map(String),
        ));
        if (!parent || parent.node.type !== 'element') {
          throw operationError('PARENT_NOT_FOUND', `父节点不存在：${operation.parent_id}`, {
            parent_id: operation.parent_id,
          });
        }
        if (!nodeIds.length) {
          throw operationError('WRAP_NODES_EMPTY', '包裹操作至少需要一个节点');
        }
        const children = parent.node.children || (parent.node.children = []);
        const indexes = nodeIds.map((nodeId) =>
          children.findIndex((child) => String(child.id) === nodeId));
        if (indexes.some((index) => index < 0)) {
          throw operationError('WRAP_NODE_PARENT_MISMATCH', '待包裹节点不属于同一目标父节点');
        }
        const ordered = indexes.slice().sort((left, right) => left - right);
        if (ordered.some((index, offset) => index !== ordered[0] + offset)) {
          throw operationError('WRAP_NODES_NOT_CONTIGUOUS', '待包裹节点必须在文档中连续相邻');
        }
        if (indexes.some((index, offset) => index !== ordered[offset])) {
          throw operationError('WRAP_NODES_OUT_OF_ORDER', '待包裹节点顺序必须与文档一致');
        }
        const wrapper = clone(operation.node || {});
        if (!wrapper.id || wrapper.type !== 'element') {
          throw operationError('WRAPPER_INVALID', '包裹操作需要完整的容器节点');
        }
        if (
          String(wrapper.text || '')
          || (Array.isArray(wrapper.children) && wrapper.children.length)
        ) {
          throw operationError('WRAPPER_NOT_EMPTY', '包裹容器不能预先包含文字或子节点');
        }
        wrapper.children = children.slice(ordered[0], ordered[ordered.length - 1] + 1);
        children.splice(ordered[0], ordered.length, wrapper);
        document = normalizeDocument(parent.document);
        return;
      }

      if (op === 'merge_editable_nodes') {
        const parent = findNode(document, operation.parent_id);
        const nodeIds = Array.from(new Set(
          (Array.isArray(operation.node_ids) ? operation.node_ids : []).map(String),
        ));
        if (!parent || parent.node.type !== 'element') {
          throw operationError('PARENT_NOT_FOUND', `父节点不存在：${operation.parent_id}`);
        }
        if (nodeIds.length < 2) {
          throw operationError('MERGE_NODES_TOO_FEW', '合并编辑节点至少需要两个节点');
        }
        const children = parent.node.children || (parent.node.children = []);
        const indexes = nodeIds.map((nodeId) =>
          children.findIndex((child) => String(child.id) === nodeId));
        if (indexes.some((index) => index < 0)) {
          throw operationError('MERGE_NODE_PARENT_MISMATCH', '待合并节点不属于同一目标父节点');
        }
        const ordered = indexes.slice().sort((left, right) => left - right);
        if (
          ordered.some((index, offset) => index !== ordered[0] + offset)
          || indexes.some((index, offset) => index !== ordered[offset])
        ) {
          throw operationError('MERGE_NODES_NOT_CONTIGUOUS', '待合并编辑节点必须连续且顺序一致');
        }
        const selected = children.slice(ordered[0], ordered[ordered.length - 1] + 1);
        if (selected.some((node) => !isAiEditableNode(node))) {
          throw operationError('MERGE_NODE_NOT_EDITABLE', '待合并内容必须都是独立编辑节点');
        }
        const wrapper = clone(operation.node || {});
        if (!wrapper.id || wrapper.type !== 'element') {
          throw operationError('MERGE_WRAPPER_INVALID', '合并操作需要完整的新编辑节点');
        }
        if (
          String(wrapper.text || '')
          || (Array.isArray(wrapper.children) && wrapper.children.length)
        ) {
          throw operationError('MERGE_WRAPPER_NOT_EMPTY', '新编辑节点不能预先包含文字或子节点');
        }
        wrapper.editable = true;
        wrapper.attributes = { ...(wrapper.attributes || {}) };
        delete wrapper.attributes['data-ai-scope'];
        wrapper.children = selected.map((node) => {
          const child = clone(node);
          delete child.editable;
          return child;
        });
        children.splice(ordered[0], ordered.length, wrapper);
        document = normalizeDocument(parent.document);
        return;
      }

      if (op === 'split_editable_node') {
        const found = findNode(document, targetId);
        if (!found || found.node.type !== 'element' || !found.node.editable) {
          throw operationError(
            'SPLIT_TARGET_NOT_EDITABLE',
            `待拆分的编辑节点不存在：${targetId}`,
          );
        }
        if (String(found.node.text || '')) {
          throw operationError(
            'SPLIT_TARGET_HAS_OWN_TEXT',
            '当前编辑节点没有可直接提升为独立节点的段落结构',
          );
        }
        const children = found.node.children || [];
        if (
          children.length < 2
          || children.some((child) => child.type !== 'element')
        ) {
          throw operationError(
            'SPLIT_BLOCKS_INVALID',
            '拆分编辑节点至少需要两个完整的内部段落',
          );
        }
        delete found.node.editable;
        children.forEach((child) => {
          child.editable = true;
        });
        document = normalizeDocument(found.document);
        return;
      }

      if (op === 'unwrap_node') {
        const found = findNode(document, targetId);
        if (!found || !found.parent || found.node.type !== 'element') {
          throw operationError('UNWRAP_TARGET_NOT_FOUND', `待拆分的内容组不存在：${targetId}`);
        }
        if (String(found.node.text || '')) {
          throw operationError('UNWRAP_OWN_TEXT', '内容组自身包含文字，不能在不丢失内容的情况下拆分');
        }
        const children = (found.node.children || []).map(clone);
        found.parent.children.splice(found.index, 1, ...children);
        document = normalizeDocument(found.document);
        return;
      }

      if (op === 'set_attributes' || op === 'set_style') {
        const found = findNode(document, targetId);
        if (!found || found.node.type !== 'element') throw new Error(`DOM 节点不存在：${targetId}`);
        if (op === 'set_attributes') {
          if (Object.hasOwn(operation.attributes || {}, 'data-ai-scope')) {
            throw operationError(
              'AI_SCOPE_ATTRIBUTE_FORBIDDEN',
              'data-ai-scope 已停用；合并或拆分必须形成真实编辑节点',
            );
          }
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
    return own + childText(node, exportNodeText);
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
        order: entries.size,
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
    const stableSiblingIdsByParent = new Map();
    sharedIds.forEach((id) => {
      const left = before.entries.get(id);
      const right = after.entries.get(id);
      if (left.parent_id !== right.parent_id) return;
      const parentId = String(left.parent_id || '');
      const ids = stableSiblingIdsByParent.get(parentId) || new Set();
      ids.add(id);
      stableSiblingIdsByParent.set(parentId, ids);
    });
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
        before_order: entry.order,
        after_order: null,
        before_node_type: entry.node.type === 'element'
          ? `${entry.node.type}:${entry.node.tag}`
          : entry.node.type,
        after_node_type: null,
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
        before_order: null,
        after_order: entry.order,
        before_node_type: null,
        after_node_type: entry.node.type === 'element'
          ? `${entry.node.type}:${entry.node.tag}`
          : entry.node.type,
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
        before_order: left.order,
        after_order: right.order,
        before_node_type: left.node.type === 'element'
          ? `${left.node.type}:${left.node.tag}`
          : left.node.type,
        after_node_type: right.node.type === 'element'
          ? `${right.node.type}:${right.node.tag}`
          : right.node.type,
      };
      const leftType = left.node.type === 'element' ? `${left.node.type}:${left.node.tag}` : left.node.type;
      const rightType = right.node.type === 'element' ? `${right.node.type}:${right.node.tag}` : right.node.type;
      if (leftType !== rightType) {
        changes.push({ ...base, type: 'structure' });
        return;
      }
      if (
        Boolean(left.node.editable) !== Boolean(right.node.editable)
        || !sameValue(left.node.semantic || null, right.node.semantic || null)
      ) {
        changes.push({ ...base, type: 'structure' });
      }
      if (ownNodeText(left.node) !== ownNodeText(right.node)) {
        changes.push({ ...base, type: 'text' });
      }
      if (
        left.parent_id !== right.parent_id
        || previousSharedSibling(
          left,
          stableSiblingIdsByParent.get(String(left.parent_id || '')) || new Set(),
        ) !== previousSharedSibling(
          right,
          stableSiblingIdsByParent.get(String(right.parent_id || '')) || new Set(),
        )
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

    function tableBlock(node) {
      const rowNodes = [];
      function collectRows(current) {
        if (!current || current.type !== 'element') return;
        if (current.tag === 'tr') {
          rowNodes.push(current);
          return;
        }
        (current.children || []).forEach(collectRows);
      }
      (node.children || []).forEach(collectRows);
      const rows = rowNodes.map((row) => ({
        node_id: row.id,
        cells: (row.children || [])
          .filter((cell) => cell.type === 'element' && ['td', 'th'].includes(cell.tag))
          .map((cell) => {
            const lines = (cell.children || [])
              .filter((child) => !isEditorOnly(child))
              .map((child) => exportNodeText(child).trim())
              .filter(Boolean);
            return {
              node_id: cell.id,
              text: lines.join('\n') || exportNodeText(cell).trim(),
              lines,
              colspan: Math.max(1, Number(cell.attributes && cell.attributes.colspan || 1)),
              rowspan: Math.max(1, Number(cell.attributes && cell.attributes.rowspan || 1)),
              style: clone(cell.style || {}),
            };
          }),
      })).filter((row) => row.cells.length);
      if (rows.length) {
        output.blocks.push({
          type: 'table',
          node_id: node.id,
          rows,
          style: clone(node.style || {}),
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
      if (node.tag === 'table') {
        tableBlock(node);
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

  /**
   * 给模型使用的只读语义投影。完整 ResumeDocument 仍是唯一事实对象；
   * 此投影只在单次请求内生成，省略坐标、CSS、背景和资源，保留稳定 ID、
   * 语义父子关系、编辑边界和全部可见文字。
   */
  function toAiContextDocument(documentValue) {
    const source = documentValue
      && documentValue.root
      && documentValue.schema_version !== RESUME_DOCUMENT_VERSION
      ? { dom_document: documentValue }
      : documentValue;
    const document = toResumeDocument(source);
    let nodeCount = 0;
    let textChars = 0;

    function compactNode(node) {
      if (!node || isEditorOnly(node)) return null;
      const kind = semanticKind(node);
      if (kind === 'decoration') return null;
      if (node.type === 'text') {
        const text = String(node.value || '');
        if (!text) return null;
        nodeCount += 1;
        textChars += text.length;
        return { id: node.id, kind: 'inline', text };
      }

      const semantic = safeSemantic(node.semantic) || { kind };
      const visibleChildren = (node.children || [])
        .filter((child) => child && !isEditorOnly(child));
      const childKinds = visibleChildren.map((child) => semanticKind(child));
      const presentationOnly = visibleChildren.length > 0 && childKinds.every(
        (childKind) => ['inline', 'layout_line', 'decoration'].includes(childKind),
      );
      const result = {
        id: node.id,
        kind,
        tag: node.tag,
      };
      if (semantic.subtype) result.subtype = semantic.subtype;
      if (semantic.group_id) result.group_id = semantic.group_id;
      if (semantic.level) result.level = semantic.level;
      if (semantic.continuation) result.continuation = true;
      if (node.editable) result.editable = true;
      if (node.label) result.label = node.label;

      if (presentationOnly) {
        const text = exportNodeText(node);
        if (text) {
          result.text = text;
          textChars += text.length;
        }
      } else {
        if (node.text !== undefined) {
          result.text = String(node.text || '');
          textChars += result.text.length;
        }
        const children = visibleChildren.map(compactNode).filter(Boolean);
        if (children.length) result.children = children;
      }
      nodeCount += 1;
      return result;
    }

    return {
      schema_version: AI_CONTEXT_VERSION,
      source_schema_version: RESUME_DOCUMENT_VERSION,
      root: compactNode(document.root),
      page_setup: {
        size: document.page_setup && document.page_setup.size || 'A4',
        orientation: document.page_setup && document.page_setup.orientation || 'portrait',
        max_pages: document.page_setup && document.page_setup.max_pages || null,
      },
      stats: {
        node_count: nodeCount,
        text_chars: textChars,
      },
    };
  }

  /**
   * 父节点不重复写入持久化 JSON；需要定位、增删或移动时从 children
   * 一次性建立运行时索引，避免 parent_id 与真实树发生双写漂移。
   */
  function buildSemanticIndex(documentValue) {
    const source = documentValue
      && documentValue.root
      && documentValue.schema_version !== RESUME_DOCUMENT_VERSION
      ? { dom_document: documentValue }
      : documentValue;
    const document = toResumeDocument(source);
    const entries = new Map();
    (function visit(node, parentId, index, depth) {
      entries.set(String(node.id), {
        node,
        node_id: String(node.id),
        parent_id: parentId,
        child_ids: (node.children || []).map((child) => String(child.id)),
        index,
        depth,
        kind: semanticKind(node),
      });
      (node.children || []).forEach((child, childIndex) =>
        visit(child, String(node.id), childIndex, depth + 1));
    })(document.root, null, 0, 0);
    return { document, entries };
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
      ...(node.semantic && node.semantic.kind
        ? { 'data-semantic-kind': node.semantic.kind }
        : {}),
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
      if (node.semantic && node.semantic.kind) {
        element.dataset.semanticKind = node.semantic.kind;
      }
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
    RESUME_DOCUMENT_VERSION,
    AGGREGATE_VERSION,
    TEMPLATE_DOCUMENT_VERSION,
    BINDINGS_VERSION,
    AI_CONTEXT_VERSION,
    ALLOWED_TAGS,
    SEMANTIC_KINDS,
    normalizeDocument,
    ensureDocument,
    toResumeDocument,
    applyDocumentOperations,
    attachDocument,
    createResumeAggregate,
    applyTemplate,
    extractContentDocument,
    createTemplateDocument,
    createLayoutBindings,
    alignLayoutBindings,
    composeAggregateDocument,
    legacyResumeToDom,
    findNode,
    isAiEditableNode,
    resolveAiScopeNode,
    nodeText,
    syncLegacyBindings,
    applyOperations,
    compareDocuments,
    semanticKind,
    toAiContextDocument,
    buildSemanticIndex,
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
