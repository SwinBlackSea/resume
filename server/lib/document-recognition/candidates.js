'use strict';

const ResumeDom = require('../../../resume-dom');
const { sha256 } = require('../util');

function stableNodeId(prefix, block, index) {
  return `${prefix}-${sha256(`${block.id}:${block.text}`).slice(0, 10)}-${index + 1}`;
}

function pt(value, divisor = 20) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return `${Number((number / divisor).toFixed(2))}pt`;
}

function percent(value, total) {
  const number = Number(value);
  const base = Number(total);
  if (!Number.isFinite(number) || !Number.isFinite(base) || base <= 0) return undefined;
  return `${Number(((number / base) * 100).toFixed(3))}%`;
}

function compactStyle(style) {
  return Object.fromEntries(
    Object.entries(style || {}).filter(([, value]) => value !== undefined && value !== ''),
  );
}

function semantic(kind, extra = {}) {
  return { kind, ...extra };
}

function blockSemanticKind(block, fallback = 'paragraph') {
  const kind = String(block && (block.semantic_kind || block.kind) || '').toLowerCase();
  if (kind === 'title' || kind === 'document_title') return 'document_title';
  if (kind === 'heading' || kind === 'section_title') return 'section_title';
  return fallback;
}

function fontFamily(value) {
  const family = String(value || '').trim();
  if (!family) return undefined;
  return `"${family.replace(/"/g, '')}","PingFang SC","Microsoft YaHei",sans-serif`;
}

function runCss(style) {
  const value = style || {};
  return compactStyle({
    'font-family': fontFamily(value.font_family),
    'font-size': Number.isFinite(Number(value.font_size))
      ? `${Number(value.font_size)}pt`
      : undefined,
    'font-weight': value.bold === true ? '700' : (value.bold === false ? '400' : undefined),
    'font-style': value.italic === true ? 'italic' : undefined,
    'text-decoration': value.underline === true ? 'underline' : undefined,
    color: value.color,
    'background-color': value.background,
    'letter-spacing': Number.isFinite(Number(value.letter_spacing))
      ? `${Number(value.letter_spacing)}pt`
      : undefined,
    'vertical-align': value.vertical_align === 'superscript'
      ? 'super'
      : (value.vertical_align === 'subscript' ? 'sub' : undefined),
  });
}

function borderCss(border) {
  if (!border || border.kind === 'none') return border && border.kind === 'none' ? 'none' : undefined;
  const width = Math.max(1, Number(border.size || 8) / 8);
  const kind = ['double', 'dashed', 'dotted'].includes(border.kind) ? border.kind : 'solid';
  return `${Number(width.toFixed(2))}pt ${kind} ${border.color || '#000000'}`;
}

function paragraphCss(properties, typography = {}) {
  const value = properties || {};
  const borders = value.borders || {};
  const lineMultiple = Number.isFinite(Number(value.line))
    ? Number(value.line) / 240
    : undefined;
  const fontSize = Number(typography.fontSize);
  const fontMetricScale = Number(typography.fontMetricScale);
  const calibratedLineHeight =
    Number.isFinite(lineMultiple)
    && Number.isFinite(fontSize)
    && fontSize > 0
    && Number.isFinite(fontMetricScale)
    && fontMetricScale > 0
      ? `${Number((lineMultiple * fontSize * fontMetricScale).toFixed(2))}pt`
      : undefined;
  const autoLineHeight = calibratedLineHeight || (
    Number.isFinite(lineMultiple) ? Number(lineMultiple.toFixed(3)) : undefined
  );
  const exactLineHeight = Number.isFinite(Number(value.line)) ? pt(value.line) : undefined;
  const hanging = Number(value.hanging || 0);
  const firstLine = Number(value.first_line || 0);
  return compactStyle({
    margin: `${pt(value.before || 0)} 0 ${pt(value.after || 0)}`,
    'line-height': value.line_rule && value.line_rule !== 'auto'
      ? exactLineHeight
      : autoLineHeight,
    'text-align': value.align === 'both' || value.align === 'distribute'
      ? 'justify'
      : value.align,
    'margin-left': pt(value.left),
    'margin-right': pt(value.right),
    'text-indent': hanging ? pt(-hanging) : pt(firstLine),
    'padding-left': hanging ? pt(hanging) : undefined,
    'padding-top': borders.top && borders.top.space ? `${borders.top.space}pt` : undefined,
    'padding-right': borders.right && borders.right.space ? `${borders.right.space}pt` : undefined,
    'padding-bottom': borders.bottom && borders.bottom.space ? `${borders.bottom.space}pt` : undefined,
    'padding-left': hanging
      ? pt(hanging)
      : (borders.left && borders.left.space ? `${borders.left.space}pt` : undefined),
    'border-top': borderCss(borders.top),
    'border-right': borderCss(borders.right),
    'border-bottom': borderCss(borders.bottom),
    'border-left': borderCss(borders.left),
    'background-color': value.background,
    'white-space': 'pre-wrap',
    'overflow-wrap': 'anywhere',
    'box-sizing': 'border-box',
    'min-width': '0',
  });
}

function tableBorderStyles(borders) {
  const value = borders || {};
  return compactStyle({
    'border-top': borderCss(value.top),
    'border-right': borderCss(value.right),
    'border-bottom': borderCss(value.bottom),
    'border-left': borderCss(value.left),
  });
}

function paragraphRuns(paragraph) {
  return (paragraph.runs || []).filter((run) => run.text || run.page_break);
}

function paragraphFontSize(paragraph, fallback) {
  const explicitSizes = (paragraph.runs || [])
    .map((run) => Number(run.style && run.style.font_size))
    .filter((value) => Number.isFinite(value) && value > 0);
  return explicitSizes.length ? Math.max(...explicitSizes) : (Number(fallback) || 0);
}

function importedParagraphNode(paragraph, context = {}) {
  const runs = paragraphRuns(paragraph);
  const visibleRuns = runs.filter((run) => run.text);
  const resolvedFontSize = paragraphFontSize(paragraph, context.defaultFontSize);
  const firstText = visibleRuns[0] ? visibleRuns[0].text.trim() : '';
  const lastText = visibleRuns.length ? visibleRuns[visibleRuns.length - 1].text.trim() : '';
  const bulletRow = visibleRuns.length >= 2 && /^[•●▪·\-–—]$/.test(firstText);
  const timelineRow =
    visibleRuns.length >= 3
    && /(?:19|20)\d{2}|至今|present/i.test(lastText)
    && visibleRuns[0].style
    && visibleRuns[0].style.bold;
  const useRichRuns = visibleRuns.length > 1;
  const children = useRichRuns
    ? visibleRuns.map((run, index) => ResumeDom.elementNode(
      `${paragraph.id}-run-${index + 1}`,
      'span',
      {},
      [],
      {
        text: bulletRow || timelineRow ? run.text.trim() : run.text,
      },
    )).map((node, index) => ({
      ...node,
      style: runCss(visibleRuns[index].style),
    }))
    : [];
  const tag = paragraph.kind === 'title' ? 'h1' : (paragraph.kind === 'heading' ? 'h2' : 'p');
  const style = {
    ...paragraphCss(paragraph.properties, {
      fontSize: resolvedFontSize,
      fontMetricScale: context.fontMetricScale,
    }),
    ...(useRichRuns ? {} : runCss(visibleRuns[0] && visibleRuns[0].style)),
    ...(bulletRow ? {
      display: 'grid',
      'grid-template-columns': 'auto minmax(0,1fr)',
      'column-gap': '4pt',
      'align-items': 'baseline',
    } : {}),
    ...(timelineRow ? {
      display: 'grid',
      'grid-template-columns': 'auto minmax(0,1fr) auto',
      'column-gap': '10pt',
      'align-items': 'baseline',
    } : {}),
  };
  return {
    ...ResumeDom.elementNode(
      `import-${paragraph.id}`,
      tag,
      {
        class: `editable imported-paragraph imported-${paragraph.kind}`,
        ...(paragraph.block_id ? { 'data-block-id': paragraph.block_id } : {}),
        ...(useRichRuns ? { 'data-rich-text': 'true' } : {}),
        ...(bulletRow ? { 'data-rich-layout': 'bullet' } : {}),
        ...(timelineRow ? { 'data-rich-layout': 'timeline' } : {}),
      },
      children,
      {
        ...(useRichRuns ? {} : { text: paragraph.text }),
        editable: true,
        label: paragraph.kind === 'heading' || paragraph.kind === 'title'
          ? '标题'
          : paragraph.text.trim().slice(0, 36) || '正文',
        semantic: semantic(
          paragraph.kind === 'title'
            ? 'document_title'
            : (paragraph.kind === 'heading' ? 'section_title' : 'paragraph'),
        ),
      },
    ),
    style: compactStyle(style),
  };
}

function cellCss(cell, table) {
  const margins = cell.margins || {};
  const gridTotal = (table.grid || []).reduce((sum, value) => sum + Number(value || 0), 0);
  const width = cell.width || 0;
  return compactStyle({
    width: width && gridTotal ? percent(width, gridTotal) : undefined,
    padding: [
      pt(margins.top || 0),
      pt(margins.right || 0),
      pt(margins.bottom || 0),
      pt(margins.left || 0),
    ].join(' '),
    'vertical-align': cell.vertical_align === 'center'
      ? 'middle'
      : (cell.vertical_align || 'top'),
    'background-color': cell.background,
    ...tableBorderStyles(cell.borders),
    'box-sizing': 'border-box',
    'min-width': '0',
  });
}

function importedTableNode(table, context = {}) {
  const gridWidth = (table.grid || []).reduce(
    (sum, value) => sum + (Number(value) || 0),
    0,
  );
  const tableStyle = compactStyle({
    width: gridWidth ? pt(gridWidth) : '100%',
    'max-width': '100%',
    'table-layout': 'fixed',
    'border-collapse': table.cell_spacing ? 'separate' : 'collapse',
    'border-spacing': table.cell_spacing ? pt(table.cell_spacing) : '0',
    'margin-left': table.alignment === 'center'
      ? 'auto'
      : (table.alignment === 'right' ? 'auto' : '0'),
    'margin-right': table.alignment === 'center' ? 'auto' : '0',
    ...tableBorderStyles(table.borders),
  });
  const rows = table.rows.map((row) => ResumeDom.elementNode(
    `import-${row.id}`,
    'tr',
    {},
    row.cells.map((cell) => ({
      ...ResumeDom.elementNode(
        `import-${cell.id}`,
        'td',
        {
          ...(cell.col_span > 1 ? { colspan: String(cell.col_span) } : {}),
          ...(cell.vertical_merge ? { 'data-vertical-merge': cell.vertical_merge } : {}),
        },
        cell.children.map((child) => (
          child.type === 'table'
            ? importedTableNode(child, context)
            : importedParagraphNode(child, context)
        )),
        { semantic: semantic('table_cell') },
      ),
      style: cellCss(cell, table),
    })),
    { semantic: semantic('table_row') },
  ));
  return {
    ...ResumeDom.elementNode(
      `import-${table.id}`,
      'table',
      { class: 'imported-table' },
      [ResumeDom.elementNode(`import-${table.id}-body`, 'tbody', {}, rows)],
      { semantic: semantic('table') },
    ),
    style: tableStyle,
  };
}

function comparisonText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function collectNativeParagraphs(nativeDocument) {
  const paragraphs = [];
  function visit(child) {
    if (!child) return;
    if (child.type === 'paragraph') {
      if (child.text && child.text.trim()) paragraphs.push(child);
      return;
    }
    if (child.type === 'table') {
      child.rows.forEach((row) => row.cells.forEach(
        (cell) => cell.children.forEach(visit),
      ));
    }
  }
  (nativeDocument.pages || []).forEach((page) => page.children.forEach(visit));
  return paragraphs;
}

function collectNativePageBlocks(page) {
  const blocks = [];
  function visit(child) {
    if (!child) return;
    if (child.type === 'paragraph') {
      if (child.block_id && child.text && child.text.trim()) {
        blocks.push({
          id: child.block_id,
          page: page.number,
          kind: child.kind === 'paragraph' ? 'paragraph' : 'heading',
          semantic_kind: child.kind,
          text: child.text,
        });
      }
      return;
    }
    if (child.type === 'table') {
      child.rows.forEach((row) => row.cells.forEach(
        (cell) => cell.children.forEach(visit),
      ));
    }
  }
  (page.children || []).forEach(visit);
  return blocks;
}

function firstPageBySection(blocks, sections) {
  const membership = new Map();
  sections.forEach((section, sectionIndex) => {
    if (section.title_block_id) membership.set(String(section.title_block_id), sectionIndex);
    (section.block_ids || []).forEach((id) => membership.set(String(id), sectionIndex));
  });
  const result = new Map();
  blocks.forEach((block) => {
    const sectionIndex = membership.get(String(block.id));
    if (sectionIndex === undefined) return;
    const pageNumber = Number(block.page || 1);
    const current = result.get(sectionIndex);
    if (current === undefined || pageNumber < current) result.set(sectionIndex, pageNumber);
  });
  return result;
}

function deriveFontMetricScale(nativeDocument, geometryPages) {
  if (!Array.isArray(geometryPages) || !geometryPages.length) return 1.2;
  const geometryBlocks = geometryPages.flatMap((page) => page.blocks || []);
  const candidates = [];
  collectNativeParagraphs(nativeDocument).forEach((paragraph) => {
    const nativeText = comparisonText(paragraph.text);
    if (!nativeText) return;
    const fontSize = paragraphFontSize(
      paragraph,
      nativeDocument.defaults
      && nativeDocument.defaults.run
      && nativeDocument.defaults.run.font_size,
    );
    if (!fontSize) return;
    const match = geometryBlocks.find((block) => {
      const geometryText = comparisonText(block.text);
      if (!geometryText || !block.bbox || !Number(block.bbox.height)) return false;
      const sampleLength = Math.min(geometryText.length, nativeText.length, 12);
      return sampleLength >= 2
        && geometryText.slice(0, sampleLength) === nativeText.slice(0, sampleLength);
    });
    if (!match) return;
    const scale = Number(match.bbox.height) / fontSize;
    if (scale >= 0.9 && scale <= 2) candidates.push(scale);
  });
  if (!candidates.length) return 1.2;
  candidates.sort((left, right) => left - right);
  return Number(candidates[Math.floor(candidates.length / 2)].toFixed(4));
}

function wrapPageChildrenBySemanticSections(children, blocks, semanticValue, pageNumber) {
  const ordered = orderedBlocks(blocks || [], semanticValue || {});
  const sections = effectiveSections(ordered, semanticValue || {});
  const membership = new Map();
  sections.forEach((section, sectionIndex) => {
    if (section.title_block_id) membership.set(String(section.title_block_id), sectionIndex);
    (section.block_ids || []).forEach((id) => membership.set(String(id), sectionIndex));
  });
  const sectionFirstPages = firstPageBySection(ordered, sections);
  const runs = [];
  let current = null;
  (children || []).forEach((node) => {
    const blockId = node
      && node.attributes
      && node.attributes['data-block-id'];
    const explicitIndex = blockId && membership.has(String(blockId))
      ? membership.get(String(blockId))
      : null;
    const sectionIndex = explicitIndex !== null
      ? explicitIndex
      : (current ? current.section_index : -1);
    if (!current || current.section_index !== sectionIndex) {
      current = { section_index: sectionIndex, nodes: [] };
      runs.push(current);
    }
    current.nodes.push(node);
  });
  return runs.map((run, runIndex) => {
    const sectionInfo = run.section_index >= 0 ? sections[run.section_index] : null;
    const titleBlock = sectionInfo && sectionInfo.title_block_id
      ? ordered.find((block) => String(block.id) === String(sectionInfo.title_block_id))
      : null;
    const groupId = run.section_index >= 0
      ? `import-section-${run.section_index + 1}`
      : `import-unclassified-${pageNumber}-${runIndex + 1}`;
    return {
      ...ResumeDom.elementNode(
        `${groupId}-page-${pageNumber}-part-${runIndex + 1}`,
        'section',
        {
          class: 'imported-semantic-section',
          'data-semantic-section-id': groupId,
        },
        run.nodes,
        {
          label: titleBlock
            ? String(titleBlock.text || '').slice(0, 60)
            : `第 ${pageNumber} 页内容`,
          semantic: semantic('section', {
            group_id: groupId,
            ...(sectionFirstPages.has(run.section_index)
              && sectionFirstPages.get(run.section_index) !== Number(pageNumber)
              ? { continuation: true }
              : {}),
          }),
        },
      ),
      style: { display: 'contents' },
    };
  });
}

function buildNativeDomDocument(nativeDocument, geometryPages, semanticValue = {}) {
  const section = nativeDocument.section || {};
  const width = Number(section.width || 11906);
  const height = Number(section.height || 16838);
  const widthPt = Number((width / 20).toFixed(2));
  const heightPt = Number((height / 20).toFixed(2));
  const margins = section.margins || {};
  const fontMetricScale = deriveFontMetricScale(nativeDocument, geometryPages);
  const context = {
    defaultFontSize:
      nativeDocument.defaults
      && nativeDocument.defaults.run
      && nativeDocument.defaults.run.font_size,
    fontMetricScale,
  };
  const allBlocks = (nativeDocument.pages || []).flatMap(collectNativePageBlocks);
  const rootChildren = nativeDocument.pages.map((page) => {
    const children = page.children.map((child) => (
      child.type === 'table'
        ? importedTableNode(child, context)
        : importedParagraphNode(child, context)
    ));
    const structuredChildren = wrapPageChildrenBySemanticSections(
      children,
      allBlocks,
      semanticValue,
      page.number,
    );
    return {
      ...ResumeDom.elementNode(
        `imported-page-${page.number}`,
        'section',
        {
          class: 'imported-document-page',
          'data-imported-page': String(page.number),
          'data-layout-unit': 'pt',
          'data-page-width-pt': String(widthPt),
          'data-page-height-pt': String(heightPt),
          'data-font-metric-scale': String(fontMetricScale),
        },
        structuredChildren,
        { label: `第 ${page.number} 页`, semantic: semantic('page') },
      ),
      style: compactStyle({
        width: `${widthPt}pt`,
        'min-height': `${heightPt}pt`,
        'aspect-ratio': `${widthPt} / ${heightPt}`,
        padding: [
          pt(margins.top || 0),
          pt(margins.right || 0),
          pt(margins.bottom || 0),
          pt(margins.left || 0),
        ].join(' '),
        'box-sizing': 'border-box',
        'background-color': '#FFFFFF',
        'font-family': fontFamily(
          nativeDocument.defaults
          && nativeDocument.defaults.run
          && nativeDocument.defaults.run.font_family,
        ),
        'font-size': nativeDocument.defaults
          && nativeDocument.defaults.run
          && nativeDocument.defaults.run.font_size
          ? `${nativeDocument.defaults.run.font_size}pt`
          : undefined,
        color: nativeDocument.defaults
          && nativeDocument.defaults.run
          && nativeDocument.defaults.run.color,
        'margin-top': '0',
        overflow: 'hidden',
      }),
    };
  });
  return ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: ResumeDom.elementNode(
      'resume-root',
      'article',
      { class: 'resume-dom-root imported-resume imported-native-resume' },
      rootChildren,
      { semantic: semantic('document') },
    ),
  });
}

function buildPositionedDomDocument(pages, semanticValue = {}) {
  const allBlocks = (pages || []).flatMap((page, pageIndex) => (
    (page.blocks || []).map((block) => ({
      ...block,
      page: block.page || page.number || pageIndex + 1,
    }))
  ));
  const rootChildren = pages.map((page, pageIndex) => {
    const width = Number(page.width || 595.28);
    const height = Number(page.height || 841.89);
    const children = (page.blocks || []).filter((block) => block.text).map((block, index) => {
      const bbox = block.bbox || {};
      const positioned = Number.isFinite(Number(bbox.x)) && Number.isFinite(Number(bbox.y));
      return {
        ...ResumeDom.elementNode(
          stableNodeId('import-positioned', block, index),
          blockSemanticKind(block) === 'document_title'
            ? 'h1'
            : (blockSemanticKind(block) === 'section_title' ? 'h2' : 'p'),
          {
            class: 'editable imported-positioned-text',
            'data-block-id': block.id,
          },
          [],
          {
            text: block.text,
            editable: true,
            label: blockSemanticKind(block) === 'paragraph' ? '正文' : '标题',
            semantic: semantic(blockSemanticKind(block)),
          },
        ),
        style: compactStyle(positioned ? {
          position: 'absolute',
          left: percent(bbox.x, width),
          top: percent(bbox.y, height),
          width: percent(Math.max(Number(bbox.width || 0), width - Number(bbox.x || 0)), width),
          margin: '0',
          'font-size': `${Number(Math.max(7, Number(bbox.height || 10) * 0.82).toFixed(2))}px`,
          'line-height': '1.12',
          'white-space': 'pre-wrap',
          'overflow-wrap': 'anywhere',
        } : {
          margin: '4px 0',
          'font-size': '10px',
          'line-height': '1.5',
        }),
      };
    });
    const structuredChildren = wrapPageChildrenBySemanticSections(
      children,
      allBlocks,
      semanticValue,
      page.number || pageIndex + 1,
    );
    return {
      ...ResumeDom.elementNode(
        `imported-page-${page.number || pageIndex + 1}`,
        'section',
        { class: 'imported-document-page imported-positioned-page' },
        structuredChildren,
        {
          label: `第 ${page.number || pageIndex + 1} 页`,
          semantic: semantic('page'),
        },
      ),
      style: {
        position: 'relative',
        width: '100%',
        'aspect-ratio': `${width} / ${height}`,
        'background-color': '#FFFFFF',
        'box-sizing': 'border-box',
        'margin-top': pageIndex ? '18px' : '0',
        overflow: 'hidden',
      },
    };
  });
  return ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: ResumeDom.elementNode(
      'resume-root',
      'article',
      { class: 'resume-dom-root imported-resume imported-positioned-resume' },
      rootChildren,
      { semantic: semantic('document') },
    ),
  });
}

function sceneSpanNode(span, pageNumber, lineIndex, spanIndex) {
  const bbox = span.relative_bbox || span.bbox || {};
  const width = Math.max(0, Number(bbox.width || 0));
  const height = Math.max(1, Number(bbox.height || span.font_size || 10));
  return {
    ...ResumeDom.elementNode(
      `scene-${pageNumber}-line-${lineIndex + 1}-span-${spanIndex + 1}`,
      'span',
      {
        class: 'imported-scene-span',
        'data-scene-text-width-pt': String(Number(width.toFixed(3))),
      },
      [],
      { text: span.text || '', semantic: semantic('inline') },
    ),
    style: compactStyle({
      position: 'absolute',
      left: `${Number(Number(bbox.x || 0).toFixed(3))}pt`,
      top: `${Number(Number(bbox.y || 0).toFixed(3))}pt`,
      'font-family': fontFamily(span.font_family),
      'font-size': `${Number(Number(span.font_size || height).toFixed(3))}pt`,
      'font-weight': span.bold ? '700' : '400',
      'font-style': span.italic ? 'italic' : 'normal',
      color: span.color || '#000000',
      'line-height': `${Number(height.toFixed(3))}pt`,
      'white-space': 'pre',
      'transform-origin': 'left top',
      'z-index': '1',
    }),
  };
}

function bboxMatchScore(left, right) {
  if (!left || !right) return 0;
  const leftX2 = Number(left.x || 0) + Number(left.width || 0);
  const leftY2 = Number(left.y || 0) + Number(left.height || 0);
  const rightX2 = Number(right.x || 0) + Number(right.width || 0);
  const rightY2 = Number(right.y || 0) + Number(right.height || 0);
  const width = Math.max(
    0,
    Math.min(leftX2, rightX2) - Math.max(Number(left.x || 0), Number(right.x || 0)),
  );
  const height = Math.max(
    0,
    Math.min(leftY2, rightY2) - Math.max(Number(left.y || 0), Number(right.y || 0)),
  );
  const intersection = width * height;
  const minimumArea = Math.max(
    1,
    Math.min(
      Number(left.width || 0) * Number(left.height || 0),
      Number(right.width || 0) * Number(right.height || 0),
    ),
  );
  return Math.min(1, intersection / minimumArea);
}

function alignSceneLines(page, blocks) {
  const pageBlocks = blocks
    .filter((block) => Number(block.page) === Number(page.number))
    .sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
  const states = pageBlocks.map((block) => ({
    block,
    normalized: comparisonText(block.text),
    matched: '',
  }));
  let cursor = 0;
  return (page.text_nodes || []).map((line, lineIndex) => {
    const lineText = comparisonText(line.text);
    let best = null;
    states.forEach((state, stateIndex) => {
      if (!lineText || !state.normalized) return;
      const remaining = state.normalized.slice(state.matched.length);
      let score = 0;
      if (remaining.startsWith(lineText)) score = 180 + Math.min(20, lineText.length);
      else if (state.normalized === lineText) score = 170;
      else if (state.normalized.includes(lineText)) {
        score = 110 + (lineText.length / state.normalized.length) * 30;
      } else if (lineText.includes(state.normalized)) {
        score = 90 + (state.normalized.length / lineText.length) * 20;
      }
      score += bboxMatchScore(line.bbox, state.block.bbox) * 100;
      score -= Math.abs(stateIndex - cursor) * 0.35;
      if (!best || score > best.score) best = { state, stateIndex, score };
    });
    if (!best || best.score < 45) best = null;
    if (best) {
      const state = best.state;
      if (state.normalized.slice(state.matched.length).startsWith(lineText)) {
        state.matched += lineText;
      } else if (!state.matched) {
        state.matched = lineText;
      }
      if (state.matched.length >= state.normalized.length) {
        cursor = Math.max(cursor, best.stateIndex + 1);
      } else {
        cursor = Math.max(cursor, best.stateIndex);
      }
    }
    return {
      ...line,
      line_index: lineIndex,
      block: best ? best.state.block : null,
    };
  });
}

function effectiveSections(blocks, semanticValue) {
  const explicit = semanticValue && Array.isArray(semanticValue.sections)
    ? semanticValue.sections
    : [];
  const sections = explicit.length ? explicit.map((section) => ({
    title_block_id: section.title_block_id || null,
    block_ids: [...(section.block_ids || [])],
  })) : inferredSections(blocks);
  const assigned = new Set();
  sections.forEach((section) => {
    if (section.title_block_id) assigned.add(String(section.title_block_id));
    section.block_ids.forEach((id) => assigned.add(String(id)));
  });
  blocks.forEach((block) => {
    if (assigned.has(String(block.id))) return;
    const semanticKind = blockSemanticKind(block);
    if (!sections.length || semanticKind === 'section_title' || semanticKind === 'document_title') {
      sections.push({
        title_block_id: semanticKind === 'paragraph' ? null : block.id,
        block_ids: semanticKind === 'paragraph' ? [block.id] : [],
      });
    } else {
      sections[sections.length - 1].block_ids.push(block.id);
    }
    assigned.add(String(block.id));
  });
  return sections;
}

function sceneLineNode(line, pageNumber, origin) {
  const bbox = line.bbox || {};
  const x = Number(bbox.x || 0);
  const y = Number(bbox.y || 0);
  const width = Math.max(1, Number(bbox.width || 1));
  const height = Math.max(1, Number(bbox.height || 10));
  const dominant = (line.spans || [])[0] || {};
  const direction = line.direction || { x: 1, y: 0 };
  const angle = Math.atan2(Number(direction.y || 0), Number(direction.x || 1)) * 180 / Math.PI;
  return {
    ...ResumeDom.elementNode(
      `scene-${pageNumber}-line-${line.line_index + 1}`,
      'span',
      {
        class: 'imported-scene-line',
        'data-scene-line': String(line.line_index + 1),
      },
      (line.spans || []).map((span, spanIndex) =>
        sceneSpanNode(span, pageNumber, line.line_index, spanIndex)),
      { semantic: semantic('layout_line') },
    ),
    style: compactStyle({
      position: 'absolute',
      display: 'block',
      left: `${Number((x - origin.x).toFixed(3))}pt`,
      top: `${Number((y - origin.y).toFixed(3))}pt`,
      width: `${Number(width.toFixed(3))}pt`,
      height: `${Number(height.toFixed(3))}pt`,
      margin: '0',
      padding: '0',
      border: '0',
      'font-family': fontFamily(dominant.font_family),
      'font-size': dominant.font_size
        ? `${Number(Number(dominant.font_size).toFixed(3))}pt`
        : undefined,
      'font-weight': dominant.bold ? '700' : '400',
      'font-style': dominant.italic ? 'italic' : 'normal',
      color: dominant.color || '#000000',
      'line-height': `${Number(height.toFixed(3))}pt`,
      'white-space': 'pre',
      'overflow-wrap': 'normal',
      'transform-origin': 'left top',
      transform: Math.abs(angle) > 0.01 ? `rotate(${Number(angle.toFixed(3))}deg)` : undefined,
      'z-index': '1',
    }),
  };
}

function sceneBlockNode(lines, pageNumber, block, sectionInfo, groupIndex) {
  const boxes = lines.map((line) => line.bbox || {});
  const left = Math.min(...boxes.map((box) => Number(box.x || 0)));
  const top = Math.min(...boxes.map((box) => Number(box.y || 0)));
  const right = Math.max(...boxes.map(
    (box) => Number(box.x || 0) + Math.max(1, Number(box.width || 1)),
  ));
  const bottom = Math.max(...boxes.map(
    (box) => Number(box.y || 0) + Math.max(1, Number(box.height || 10)),
  ));
  const isTitle = Boolean(
    sectionInfo
    && sectionInfo.title_block_id
    && block
    && String(sectionInfo.title_block_id) === String(block.id),
  );
  const firstDocumentTitle = isTitle
    && pageNumber === 1
    && groupIndex === 0
    && /(?:简历|resume)/i.test(String(block && block.text || ''));
  const kind = firstDocumentTitle
    ? 'document_title'
    : (isTitle ? 'section_title' : blockSemanticKind(block));
  const tag = kind === 'document_title' ? 'h1' : (kind === 'section_title' ? 'h2' : 'p');
  const blockId = block && block.id
    ? String(block.id)
    : `scene-${pageNumber}-block-${groupIndex + 1}`;
  const text = lines.map((line) => String(line.text || '')).join('');
  return {
    ...ResumeDom.elementNode(
      `import-${blockId}`,
      tag,
      {
        class: 'editable imported-scene-text',
        'data-rich-text': 'true',
        'data-block-id': blockId,
      },
      lines.map((line) => sceneLineNode(line, pageNumber, { x: left, y: top })),
      {
        editable: true,
        label: kind === 'paragraph' ? text.trim().slice(0, 60) || '正文' : '标题',
        semantic: semantic(kind, { group_id: blockId }),
      },
    ),
    style: {
      position: 'absolute',
      left: `${Number(left.toFixed(3))}pt`,
      top: `${Number(top.toFixed(3))}pt`,
      width: `${Number(Math.max(1, right - left).toFixed(3))}pt`,
      height: `${Number(Math.max(1, bottom - top).toFixed(3))}pt`,
      margin: '0',
      padding: '0',
      border: '0',
      'box-sizing': 'border-box',
      'z-index': '1',
    },
  };
}

function buildPageSceneDomDocument(pageScene, blocks = [], semanticValue = {}) {
  const pages = Array.isArray(pageScene && pageScene.pages) ? pageScene.pages : [];
  const ordered = orderedBlocks(blocks, semanticValue);
  const sections = effectiveSections(ordered, semanticValue);
  const membership = new Map();
  sections.forEach((section, sectionIndex) => {
    if (section.title_block_id) membership.set(String(section.title_block_id), sectionIndex);
    (section.block_ids || []).forEach((id) => membership.set(String(id), sectionIndex));
  });
  const sectionFirstPages = firstPageBySection(ordered, sections);
  const rootChildren = pages.map((page, pageIndex) => {
    const pageNumber = page.number || pageIndex + 1;
    const width = Math.max(1, Number(page.width || 595.28));
    const height = Math.max(1, Number(page.height || 841.89));
    const background = {
      ...ResumeDom.elementNode(
        `scene-${pageNumber}-background`,
        'img',
        {
          class: 'imported-scene-background',
          alt: '',
          'data-scene-background-page': String(pageNumber),
          'aria-hidden': 'true',
        },
        [],
        { semantic: semantic('decoration') },
      ),
      style: {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '100%',
        height: '100%',
        'object-fit': 'fill',
        'pointer-events': 'none',
        'z-index': '0',
      },
    };
    const aligned = alignSceneLines(page, blocks);
    const grouped = [];
    const byBlock = new Map();
    aligned.forEach((line) => {
      const key = line.block && line.block.id
        ? String(line.block.id)
        : `unmapped-${pageNumber}-${line.line_index + 1}`;
      let group = byBlock.get(key);
      if (!group) {
        group = { key, block: line.block, lines: [], first_index: line.line_index };
        byBlock.set(key, group);
        grouped.push(group);
      }
      group.lines.push(line);
    });
    const sectionGroups = new Map();
    grouped.forEach((group, groupIndex) => {
      const sectionIndex = group.block && membership.has(String(group.block.id))
        ? membership.get(String(group.block.id))
        : -1;
      const key = String(sectionIndex);
      const bucket = sectionGroups.get(key) || {
        section_index: sectionIndex,
        first_index: group.first_index,
        nodes: [],
      };
      bucket.first_index = Math.min(bucket.first_index, group.first_index);
      bucket.nodes.push(sceneBlockNode(
        group.lines,
        pageNumber,
        group.block,
        sectionIndex >= 0 ? sections[sectionIndex] : null,
        groupIndex,
      ));
      sectionGroups.set(key, bucket);
    });
    const semanticSections = Array.from(sectionGroups.values())
      .sort((leftBucket, rightBucket) => leftBucket.first_index - rightBucket.first_index)
      .map((bucket, bucketIndex) => {
        const sectionInfo = bucket.section_index >= 0 ? sections[bucket.section_index] : null;
        const titleBlock = sectionInfo && sectionInfo.title_block_id
          ? ordered.find((block) => String(block.id) === String(sectionInfo.title_block_id))
          : null;
        const groupId = bucket.section_index >= 0
          ? `import-section-${bucket.section_index + 1}`
          : `import-unclassified-${pageNumber}-${bucketIndex + 1}`;
        return {
          ...ResumeDom.elementNode(
            `${groupId}-page-${pageNumber}`,
            'section',
            {
              class: 'imported-semantic-section',
              'data-semantic-section-id': groupId,
            },
            bucket.nodes,
            {
              label: titleBlock
                ? String(titleBlock.text || '').slice(0, 60)
                : `第 ${pageNumber} 页内容`,
              semantic: semantic('section', {
                group_id: groupId,
                ...(sectionFirstPages.has(bucket.section_index)
                  && sectionFirstPages.get(bucket.section_index) !== Number(pageNumber)
                  ? { continuation: true }
                  : {}),
              }),
            },
          ),
          style: { display: 'contents' },
        };
      });
    return {
      ...ResumeDom.elementNode(
        `imported-page-${pageNumber}`,
        'section',
        {
          class: 'imported-document-page imported-scene-page',
          'data-imported-page': String(pageNumber),
          'data-layout-unit': 'pt',
          'data-page-width-pt': String(Number(width.toFixed(3))),
          'data-page-height-pt': String(Number(height.toFixed(3))),
          'data-background-contains-text': String(Boolean(page.background_contains_text)),
        },
        [background, ...semanticSections],
        { label: `第 ${pageNumber} 页`, semantic: semantic('page') },
      ),
      style: {
        position: 'relative',
        width: `${Number(width.toFixed(3))}pt`,
        height: `${Number(height.toFixed(3))}pt`,
        'min-height': `${Number(height.toFixed(3))}pt`,
        'aspect-ratio': `${Number(width.toFixed(3))} / ${Number(height.toFixed(3))}`,
        padding: '0',
        'box-sizing': 'border-box',
        'background-color': '#FFFFFF',
        'margin-top': '0',
        overflow: 'hidden',
      },
    };
  });
  return ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: ResumeDom.elementNode(
      'resume-root',
      'article',
      { class: 'resume-dom-root imported-resume imported-scene-resume' },
      rootChildren,
      { semantic: semantic('document') },
    ),
  });
}

function orderedBlocks(blocks, semantic) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const ordered = [];
  (semantic.reading_order || []).forEach((id) => {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  });
  blocks.forEach((block) => {
    if (byId.has(block.id)) {
      ordered.push(block);
      byId.delete(block.id);
    }
  });
  return ordered;
}

function inferredSections(blocks) {
  const result = [];
  let current = { title_block_id: null, block_ids: [] };
  blocks.forEach((block) => {
    const kind = blockSemanticKind(block);
    const isHeading = kind === 'section_title' || kind === 'document_title';
    if (isHeading && (current.title_block_id || current.block_ids.length)) {
      result.push(current);
      current = { title_block_id: block.id, block_ids: [] };
    } else if (isHeading && !current.title_block_id && !current.block_ids.length) {
      current.title_block_id = block.id;
    } else {
      current.block_ids.push(block.id);
    }
  });
  if (current.title_block_id || current.block_ids.length) result.push(current);
  return result;
}

function buildContentCandidate({
  blocks,
  pages,
  semantic,
  format,
  nativeDocument,
  geometryPages,
  pageScene,
}) {
  const ordered = orderedBlocks(blocks, semantic);
  if (pageScene && pageScene.has_text_layer && Array.isArray(pageScene.pages)) {
    const domDocument = buildPageSceneDomDocument(pageScene, ordered, semantic);
    return {
      format,
      plain_text: ordered.map((block) => block.text).join('\n'),
      blocks: ordered,
      structure: nativeDocument || null,
      page_scene: {
        version: pageScene.version,
        render_dpi: pageScene.render_dpi,
        text_node_count: pageScene.text_node_count,
      },
      resume_json: {
        basics: {},
        headline: '',
        summary: '',
        experience: [],
        projects: [],
        education: [],
        skills: [],
        generation_notes: [],
        validation_issues: [],
        layout_hints: {},
        dom_document: domDocument,
      },
    };
  }
  if (nativeDocument && Array.isArray(nativeDocument.pages)) {
    const domDocument = buildNativeDomDocument(nativeDocument, geometryPages, semantic);
    return {
      format,
      plain_text: ordered.map((block) => block.text).join('\n'),
      blocks: ordered,
      structure: nativeDocument,
      resume_json: {
        basics: {},
        headline: '',
        summary: '',
        experience: [],
        projects: [],
        education: [],
        skills: [],
        generation_notes: [],
        validation_issues: [],
        layout_hints: {},
        dom_document: domDocument,
      },
    };
  }
  if (
    Array.isArray(pages)
    && pages.length
    && pages.some((page) => (page.blocks || []).some((block) => block.bbox))
  ) {
    const domDocument = buildPositionedDomDocument(pages, semantic);
    return {
      format,
      plain_text: ordered.map((block) => block.text).join('\n'),
      blocks: ordered,
      resume_json: {
        basics: {},
        headline: '',
        summary: '',
        experience: [],
        projects: [],
        education: [],
        skills: [],
        generation_notes: [],
        validation_issues: [],
        layout_hints: {},
        dom_document: domDocument,
      },
    };
  }
  const byId = new Map(ordered.map((block) => [block.id, block]));
  const sections =
    semantic.sections && semantic.sections.length
      ? semantic.sections
      : inferredSections(ordered);
  const rootChildren = [];
  const consumed = new Set();

  sections.forEach((section, sectionIndex) => {
    const children = [];
    const titleBlock = section.title_block_id ? byId.get(section.title_block_id) : null;
    if (titleBlock) {
      consumed.add(titleBlock.id);
      children.push(
        ResumeDom.elementNode(
          stableNodeId('import-heading', titleBlock, sectionIndex),
          blockSemanticKind(titleBlock) === 'document_title' ? 'h1' : 'h2',
          { class: 'editable', 'data-block-id': titleBlock.id },
          [],
          {
            text: titleBlock.text,
            editable: true,
            label: '标题',
            semantic: semantic(blockSemanticKind(titleBlock, 'section_title')),
          },
        ),
      );
    }
    (section.block_ids || []).forEach((id, blockIndex) => {
      const block = byId.get(id);
      if (!block || consumed.has(id)) return;
      consumed.add(id);
      children.push(
        ResumeDom.elementNode(
          stableNodeId('import-block', block, blockIndex),
          blockSemanticKind(block) === 'document_title'
            ? 'h1'
            : (blockSemanticKind(block) === 'section_title' ? 'h2' : 'p'),
          { class: 'editable', 'data-block-id': block.id },
          [],
          {
            text: block.text,
            editable: true,
            label: blockSemanticKind(block) === 'paragraph' ? '正文' : '标题',
            semantic: semantic(blockSemanticKind(block)),
          },
        ),
      );
    });
    if (children.length) {
      rootChildren.push(
        ResumeDom.elementNode(
          `import-section-${sectionIndex + 1}`,
          'section',
          { class: 'resume-section' },
          children,
          {
            label: titleBlock ? titleBlock.text.slice(0, 60) : `第 ${sectionIndex + 1} 部分`,
            semantic: semantic('section', { group_id: `import-section-${sectionIndex + 1}` }),
          },
        ),
      );
    }
  });

  ordered.forEach((block, index) => {
    if (consumed.has(block.id)) return;
    rootChildren.push(
      ResumeDom.elementNode(
        stableNodeId('import-block', block, index),
        blockSemanticKind(block) === 'document_title'
          ? 'h1'
          : (blockSemanticKind(block) === 'section_title' ? 'h2' : 'p'),
        { class: 'editable', 'data-block-id': block.id },
        [],
        {
          text: block.text,
          editable: true,
          label: blockSemanticKind(block) === 'paragraph' ? '正文' : '标题',
          semantic: semantic(blockSemanticKind(block)),
        },
      ),
    );
  });

  const domDocument = ResumeDom.normalizeDocument({
    version: ResumeDom.VERSION,
    root: ResumeDom.elementNode(
      'resume-root',
      'article',
      { class: 'resume-dom-root imported-resume' },
      rootChildren,
      { semantic: semantic('document') },
    ),
  });
  const plainText = ordered.map((block) => block.text).join('\n');
  return {
    format,
    plain_text: plainText,
    blocks: ordered,
    resume_json: {
      basics: {},
      headline: '',
      summary: '',
      experience: [],
      projects: [],
      education: [],
      skills: [],
      generation_notes: [],
      validation_issues: [],
      layout_hints: {},
      dom_document: domDocument,
    },
  };
}

function buildLayoutCandidate({ pages, semantic, format, nativeDocument, pageScene }) {
  const firstPage = pages[0] || { width: 595.28, height: 841.89 };
  const nativeSection = nativeDocument && nativeDocument.section;
  const nativeWidth = nativeSection ? Number(nativeSection.width || 11906) / 20 : null;
  const nativeHeight = nativeSection ? Number(nativeSection.height || 16838) / 20 : null;
  const nativeMargins = nativeSection && nativeSection.margins;
  const nativeRun = nativeDocument && nativeDocument.defaults && nativeDocument.defaults.run;
  const nativeParagraph =
    nativeDocument && nativeDocument.defaults && nativeDocument.defaults.paragraph;
  const columns = semantic.layout.columns === 2 ? 2 : 1;
  return {
    format,
    schema: {
      document: {
        engine: 'resume-dom-v1',
        structure: 'dynamic',
        root_node_id: 'resume-root',
        allowed_content: 'safe-dom',
      },
      page: {
        size: 'A4',
        source_width: nativeWidth || firstPage.width || null,
        source_height: nativeHeight || firstPage.height || null,
        margin: nativeMargins
          ? {
              top: Number(nativeMargins.top || 0) / 20,
              right: Number(nativeMargins.right || 0) / 20,
              bottom: Number(nativeMargins.bottom || 0) / 20,
              left: Number(nativeMargins.left || 0) / 20,
            }
          : { top: 54, right: 58, bottom: 58, left: 58 },
        max_pages: Math.max(1, pages.length),
        unit: 'pt',
      },
      regions:
        columns === 2
          ? [
              { id: 'main', columns: 1, width: semantic.layout.main_column_ratio, flow: 'vertical' },
              {
                id: 'aside',
                columns: 1,
                width: Number((1 - semantic.layout.main_column_ratio).toFixed(2)),
                flow: 'vertical',
              },
            ]
          : [{ id: 'main', columns: 1, flow: 'vertical' }],
      typography: {
        font: (nativeRun && nativeRun.font_family) || 'Noto Sans SC',
        base_size: (nativeRun && nativeRun.font_size) || 9.5,
        line_height:
          nativeParagraph && nativeParagraph.line
            ? Number((Number(nativeParagraph.line) / 240).toFixed(3))
            : 1.7,
        color: (nativeRun && nativeRun.color) || '#414448',
      },
      section_rules: {
        order: [],
        titles: {},
        title_style: { rule: true, size: 12, color: '#1d1d1f' },
      },
      constraints: { keep_with_next: true },
      assets: pageScene && pageScene.has_text_layer
        ? { scene_background_artifact_ids: [] }
        : {},
      layout: pageScene && pageScene.has_text_layer
        ? 'imported-scene'
        : (nativeDocument
        ? 'imported-native'
        : (pages.some((page) => (page.blocks || []).some((block) => block.bbox))
          ? 'imported-positioned'
          : (columns === 2 ? 'imported-two-column' : 'imported-single-column'))),
      imported: true,
      fidelity: pageScene && pageScene.has_text_layer
        ? 'rendered-page-scene'
        : (nativeDocument ? 'native-structure' : 'positioned-text'),
      page_scene_version: pageScene && pageScene.has_text_layer ? pageScene.version : null,
      visual_style: semantic.layout.visual_style || '',
    },
    pages: pages.map((page) => ({
      number: page.number,
      width: page.width || null,
      height: page.height || null,
      block_count: (page.blocks || []).length,
    })),
  };
}

function blankResume() {
  return {
    basics: {},
    headline: '',
    summary: '',
    experience: [],
    projects: [],
    education: [],
    skills: [],
    generation_notes: [],
    validation_issues: [],
    layout_hints: {},
    dom_document: ResumeDom.normalizeDocument({
      version: ResumeDom.VERSION,
      root: ResumeDom.elementNode('resume-root', 'article', { class: 'resume-dom-root' }, []),
    }),
  };
}

module.exports = {
  buildContentCandidate,
  buildLayoutCandidate,
  buildNativeDomDocument,
  buildPositionedDomDocument,
  buildPageSceneDomDocument,
  blankResume,
};
