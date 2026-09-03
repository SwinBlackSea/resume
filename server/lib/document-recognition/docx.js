'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const { XMLParser } = require('fast-xml-parser');
const { DocumentRecognitionError } = require('./errors');
const { MAX_UNCOMPRESSED_DOCX_SIZE } = require('./constants');
const { runCommand } = require('./command');

const REQUIRED_ENTRIES = new Set([
  '[Content_Types].xml',
  'word/document.xml',
  'word/styles.xml',
  'word/numbering.xml',
  'word/fontTable.xml',
  'word/theme/theme1.xml',
  'word/_rels/document.xml.rels',
  'docProps/app.xml',
]);

function readSelectedEntries(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) {
        reject(new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 文件已损坏或不是有效 DOCX'));
        return;
      }
      const entries = {};
      let totalSize = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch (_) {
          // yauzl 可能已自动关闭。
        }
        reject(error);
      };

      zip.on('error', () => fail(
        new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 文件压缩结构无法读取'),
      ));
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        if (!entries['word/document.xml'] || !entries['[Content_Types].xml']) {
          reject(new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 文件缺少正文结构'));
          return;
        }
        resolve(entries);
      });
      zip.on('entry', (entry) => {
        if (entry.generalPurposeBitFlag & 0x1) {
          fail(new DocumentRecognitionError('DOCUMENT_ENCRYPTED', '加密的 Word 文件暂不支持'));
          return;
        }
        totalSize += Number(entry.uncompressedSize || 0);
        if (totalSize > MAX_UNCOMPRESSED_DOCX_SIZE) {
          fail(new DocumentRecognitionError('FILE_UNSAFE', 'Word 文件解压后体积异常，已拒绝'));
          return;
        }
        const normalized = path.posix.normalize(entry.fileName);
        if (normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
          fail(new DocumentRecognitionError('FILE_UNSAFE', 'Word 文件包含不安全路径'));
          return;
        }
        if (!REQUIRED_ENTRIES.has(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            fail(new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 文件内容无法读取'));
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', () => fail(
            new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 文件内容读取失败'),
          ));
          stream.on('end', () => {
            entries[entry.fileName] = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function findItems(nodes, key, result = []) {
  (nodes || []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item[key]) result.push(item);
    Object.entries(item).forEach(([name, value]) => {
      if (name !== ':@' && Array.isArray(value)) findItems(value, key, result);
    });
  });
  return result;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function directItem(nodes, key) {
  return (nodes || []).find((item) => item && Object.hasOwn(item, key)) || null;
}

function directChildren(nodes, key) {
  const item = directItem(nodes, key);
  return item ? asArray(item[key]) : [];
}

function itemAttributes(item) {
  return (item && item[':@']) || {};
}

function directAttributes(nodes, key) {
  return itemAttributes(directItem(nodes, key));
}

function directValue(nodes, key, attribute = 'w:val') {
  const item = directItem(nodes, key);
  if (!item) return undefined;
  return itemAttributes(item)[attribute];
}

function numberValue(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

function wordBoolean(nodes, key) {
  const item = directItem(nodes, key);
  if (!item) return undefined;
  const value = String(itemAttributes(item)['w:val'] ?? 'true').toLowerCase();
  return !['0', 'false', 'off', 'none', 'nil'].includes(value);
}

function cleanColor(value) {
  const color = String(value || '').replace(/^#/, '').trim();
  return /^[0-9a-f]{6}$/i.test(color) ? `#${color.toUpperCase()}` : undefined;
}

function compact(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, entry]) => entry !== undefined && entry !== null),
  );
}

function mergeDefined(...values) {
  return Object.assign({}, ...values.map(compact));
}

function textFromNodes(nodes) {
  let text = '';
  (nodes || []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item['#text'] !== undefined) text += String(item['#text']);
    if (item['w:tab']) text += '\t';
    if (item['w:br'] || item['w:cr']) text += '\n';
    Object.entries(item).forEach(([name, value]) => {
      if (name !== ':@' && name !== '#text' && Array.isArray(value)) {
        text += textFromNodes(value);
      }
    });
  });
  return text;
}

function objectNode(value) {
  return Array.isArray(value) ? value[0] : value;
}

function objectValue(object, key, attribute = 'w:val') {
  const item = objectNode(object && object[key]);
  if (item === undefined || item === null) return undefined;
  if (typeof item !== 'object') return item;
  return item[attribute];
}

function objectBoolean(object, key) {
  if (!object || object[key] === undefined) return undefined;
  const item = objectNode(object[key]);
  const value = String(
    item && typeof item === 'object' ? (item['w:val'] ?? 'true') : 'true',
  ).toLowerCase();
  return !['0', 'false', 'off', 'none', 'nil'].includes(value);
}

function parseObjectRunProperties(properties) {
  const fonts = objectNode(properties && properties['w:rFonts']) || {};
  const size = numberValue(objectValue(properties, 'w:sz'));
  const underline = objectValue(properties, 'w:u');
  return compact({
    font_family:
      fonts['w:eastAsia'] || fonts['w:ascii'] || fonts['w:hAnsi'] || undefined,
    font_size: size === undefined ? undefined : size / 2,
    bold: objectBoolean(properties, 'w:b'),
    italic: objectBoolean(properties, 'w:i'),
    underline: underline === undefined
      ? undefined
      : !['none', 'nil', '0', 'false'].includes(String(underline).toLowerCase()),
    color: cleanColor(objectValue(properties, 'w:color')),
    background: cleanColor(objectValue(properties, 'w:shd', 'w:fill')),
  });
}

function parseObjectParagraphProperties(properties) {
  const spacing = objectNode(properties && properties['w:spacing']) || {};
  const indent = objectNode(properties && properties['w:ind']) || {};
  return compact({
    align: objectValue(properties, 'w:jc'),
    before: numberValue(spacing['w:before']),
    after: numberValue(spacing['w:after']),
    line: numberValue(spacing['w:line']),
    line_rule: spacing['w:lineRule'],
    left: numberValue(indent['w:left']),
    right: numberValue(indent['w:right']),
    first_line: numberValue(indent['w:firstLine']),
    hanging: numberValue(indent['w:hanging']),
    keep_next: objectBoolean(properties, 'w:keepNext'),
  });
}

function parseStylesXml(buffer) {
  const fallback = {
    default_run: {},
    default_paragraph: {},
    paragraph_styles: {},
    character_styles: {},
  };
  if (!buffer) return fallback;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
  });
  try {
    const parsed = parser.parse(buffer.toString('utf8'));
    const root = parsed && parsed['w:styles'];
    if (!root) return fallback;
    const defaults = root['w:docDefaults'] || {};
    const runDefault = objectNode(defaults['w:rPrDefault']) || {};
    const paragraphDefault = objectNode(defaults['w:pPrDefault']) || {};
    const rawStyles = new Map();
    asArray(root['w:style']).forEach((style) => {
      if (!style || !style['w:styleId']) return;
      rawStyles.set(String(style['w:styleId']), {
        type: String(style['w:type'] || 'paragraph'),
        based_on: String(objectValue(style, 'w:basedOn') || ''),
        run: parseObjectRunProperties(style['w:rPr'] || {}),
        paragraph: parseObjectParagraphProperties(style['w:pPr'] || {}),
      });
    });
    const resolving = new Set();
    const resolved = new Map();
    function resolveStyle(id) {
      if (!id || !rawStyles.has(id)) return { run: {}, paragraph: {} };
      if (resolved.has(id)) return resolved.get(id);
      if (resolving.has(id)) return { run: {}, paragraph: {} };
      resolving.add(id);
      const current = rawStyles.get(id);
      const parent = resolveStyle(current.based_on);
      const result = {
        run: mergeDefined(parent.run, current.run),
        paragraph: mergeDefined(parent.paragraph, current.paragraph),
      };
      resolving.delete(id);
      resolved.set(id, result);
      return result;
    }
    const paragraphStyles = {};
    const characterStyles = {};
    rawStyles.forEach((style, id) => {
      const target = style.type === 'character' ? characterStyles : paragraphStyles;
      target[id] = resolveStyle(id);
    });
    return {
      default_run: parseObjectRunProperties(runDefault['w:rPr'] || {}),
      default_paragraph: parseObjectParagraphProperties(paragraphDefault['w:pPr'] || {}),
      paragraph_styles: paragraphStyles,
      character_styles: characterStyles,
    };
  } catch (_) {
    return fallback;
  }
}

function parseRunProperties(nodes, base = {}) {
  const fonts = directAttributes(nodes, 'w:rFonts');
  const size = numberValue(directValue(nodes, 'w:sz'));
  const underline = directValue(nodes, 'w:u');
  const spacing = numberValue(directValue(nodes, 'w:spacing'));
  return mergeDefined(base, {
    font_family:
      fonts['w:eastAsia'] || fonts['w:ascii'] || fonts['w:hAnsi'] || undefined,
    font_size: size === undefined ? undefined : size / 2,
    bold: wordBoolean(nodes, 'w:b'),
    italic: wordBoolean(nodes, 'w:i'),
    underline: underline === undefined
      ? undefined
      : !['none', 'nil', '0', 'false'].includes(String(underline).toLowerCase()),
    color: cleanColor(directValue(nodes, 'w:color')),
    background:
      cleanColor(directValue(nodes, 'w:shd', 'w:fill'))
      || cleanColor(directValue(nodes, 'w:highlight')),
    letter_spacing: spacing === undefined ? undefined : spacing / 20,
    vertical_align: directValue(nodes, 'w:vertAlign'),
  });
}

function borderValue(nodes, side) {
  const attributes = directAttributes(nodes, `w:${side}`);
  if (!Object.keys(attributes).length) return undefined;
  const kind = String(attributes['w:val'] || 'single').toLowerCase();
  if (['none', 'nil'].includes(kind)) return { kind: 'none' };
  return compact({
    kind,
    color: cleanColor(attributes['w:color']) || '#000000',
    size: numberValue(attributes['w:sz']),
    space: numberValue(attributes['w:space']),
  });
}

function parseBorders(nodes, key) {
  const borderNodes = directChildren(nodes, key);
  if (!borderNodes.length) return undefined;
  return compact({
    top: borderValue(borderNodes, 'top'),
    right: borderValue(borderNodes, 'right'),
    bottom: borderValue(borderNodes, 'bottom'),
    left: borderValue(borderNodes, 'left'),
    inside_h: borderValue(borderNodes, 'insideH'),
    inside_v: borderValue(borderNodes, 'insideV'),
  });
}

function parseParagraphProperties(nodes, base = {}) {
  const spacing = directAttributes(nodes, 'w:spacing');
  const indent = directAttributes(nodes, 'w:ind');
  return mergeDefined(base, {
    align: directValue(nodes, 'w:jc'),
    before: numberValue(spacing['w:before']),
    after: numberValue(spacing['w:after']),
    line: numberValue(spacing['w:line']),
    line_rule: spacing['w:lineRule'],
    left: numberValue(indent['w:left']),
    right: numberValue(indent['w:right']),
    first_line: numberValue(indent['w:firstLine']),
    hanging: numberValue(indent['w:hanging']),
    keep_next: wordBoolean(nodes, 'w:keepNext'),
    page_break_before: wordBoolean(nodes, 'w:pageBreakBefore'),
    background: cleanColor(directValue(nodes, 'w:shd', 'w:fill')),
    borders: parseBorders(nodes, 'w:pBdr'),
    outline_level: numberValue(directValue(nodes, 'w:outlineLvl')),
    numbered: Boolean(directItem(nodes, 'w:numPr')),
  });
}

function parseRun(runChildren, styles) {
  const runProperties = directChildren(runChildren, 'w:rPr');
  const styleId = String(directValue(runProperties, 'w:rStyle') || '');
  const characterStyle = styles.character_styles[styleId] || {};
  const style = parseRunProperties(
    runProperties,
    mergeDefined(styles.default_run, characterStyle.run),
  );
  const contentNodes = (runChildren || []).filter((item) => !Object.hasOwn(item, 'w:rPr'));
  const pageBreak = findItems(contentNodes, 'w:br').some(
    (item) => String(itemAttributes(item)['w:type'] || '').toLowerCase() === 'page',
  );
  return {
    text: textFromNodes(contentNodes).replace(/\u00a0/g, ' '),
    style,
    page_break: pageBreak,
  };
}

function collectRuns(nodes, result = []) {
  (nodes || []).forEach((item) => {
    if (!item || typeof item !== 'object') return;
    if (item['w:r']) {
      result.push(item['w:r']);
      return;
    }
    Object.entries(item).forEach(([name, value]) => {
      if (name !== ':@' && Array.isArray(value)) collectRuns(value, result);
    });
  });
  return result;
}

function inferParagraphKind(text, runs, properties) {
  const nonEmpty = runs.filter((run) => run.text.trim());
  const maxSize = Math.max(0, ...nonEmpty.map((run) => Number(run.style.font_size || 0)));
  const allBold = nonEmpty.length > 0 && nonEmpty.every((run) => run.style.bold);
  const bottomBorder = properties.borders && properties.borders.bottom;
  if (properties.outline_level === 0 || (maxSize >= 18 && allBold && text.length <= 60)) {
    return 'title';
  }
  if (
    properties.outline_level !== undefined
    || (
      bottomBorder
      && bottomBorder.kind !== 'none'
      && text.length <= 60
    )
    || (maxSize >= 13 && allBold && text.length <= 36)
  ) {
    return 'heading';
  }
  return 'paragraph';
}

function parseParagraph(paragraphChildren, styles, nextId) {
  const pPr = directChildren(paragraphChildren, 'w:pPr');
  const styleId = String(directValue(pPr, 'w:pStyle') || '');
  const paragraphStyle = styles.paragraph_styles[styleId] || {};
  const properties = parseParagraphProperties(
    pPr,
    mergeDefined(styles.default_paragraph, paragraphStyle.paragraph),
  );
  const runs = collectRuns(
    (paragraphChildren || []).filter((item) => !Object.hasOwn(item, 'w:pPr')),
  ).map((children) => {
    const parsed = parseRun(children, styles);
    parsed.style = mergeDefined(paragraphStyle.run, parsed.style);
    return parsed;
  });
  const text = runs.map((run) => run.text).join('').replace(/\r/g, '');
  return {
    id: nextId('p'),
    type: 'paragraph',
    text,
    runs,
    properties,
    style_id: styleId || null,
    kind: inferParagraphKind(text.trim(), runs, properties),
    page_break: properties.page_break_before || runs.some((run) => run.page_break),
  };
}

function parseCellMargins(nodes) {
  const margins = directChildren(nodes, 'w:tcMar');
  if (!margins.length) return undefined;
  const value = (side) => numberValue(directAttributes(margins, `w:${side}`)['w:w']);
  return compact({
    top: value('top'),
    right: value('right'),
    bottom: value('bottom'),
    left: value('left'),
  });
}

function parseTable(tableChildren, styles, nextId) {
  const properties = directChildren(tableChildren, 'w:tblPr');
  const grid = directChildren(tableChildren, 'w:tblGrid')
    .filter((item) => item && item['w:gridCol'])
    .map((item) => numberValue(itemAttributes(item)['w:w']) || 0);
  const rows = (tableChildren || [])
    .filter((item) => item && item['w:tr'])
    .map((rowItem) => {
      const rowChildren = rowItem['w:tr'] || [];
      const cells = rowChildren
        .filter((item) => item && item['w:tc'])
        .map((cellItem) => {
          const cellChildren = cellItem['w:tc'] || [];
          const cellProperties = directChildren(cellChildren, 'w:tcPr');
          const widthAttributes = directAttributes(cellProperties, 'w:tcW');
          const children = [];
          cellChildren.forEach((child) => {
            if (child['w:p']) {
              children.push(parseParagraph(child['w:p'], styles, nextId));
            } else if (child['w:tbl']) {
              children.push(parseTable(child['w:tbl'], styles, nextId));
            }
          });
          return {
            id: nextId('cell'),
            width: numberValue(widthAttributes['w:w']),
            width_type: widthAttributes['w:type'] || null,
            col_span: numberValue(directValue(cellProperties, 'w:gridSpan')) || 1,
            vertical_merge: directItem(cellProperties, 'w:vMerge')
              ? String(directValue(cellProperties, 'w:vMerge') || 'continue')
              : null,
            vertical_align: directValue(cellProperties, 'w:vAlign') || null,
            background: cleanColor(directValue(cellProperties, 'w:shd', 'w:fill')),
            margins: parseCellMargins(cellProperties),
            borders: parseBorders(cellProperties, 'w:tcBorders'),
            children,
          };
        });
      return { id: nextId('row'), cells };
    });
  const widthAttributes = directAttributes(properties, 'w:tblW');
  const spacingAttributes = directAttributes(properties, 'w:tblCellSpacing');
  return {
    id: nextId('table'),
    type: 'table',
    width: numberValue(widthAttributes['w:w']),
    width_type: widthAttributes['w:type'] || null,
    alignment: directValue(properties, 'w:jc') || null,
    cell_spacing: numberValue(spacingAttributes['w:w']) || 0,
    borders: parseBorders(properties, 'w:tblBorders'),
    grid,
    rows,
  };
}

function parseSectionProperties(nodes) {
  const size = directAttributes(nodes, 'w:pgSz');
  const margins = directAttributes(nodes, 'w:pgMar');
  return {
    width: numberValue(size['w:w']) || 11906,
    height: numberValue(size['w:h']) || 16838,
    orientation: size['w:orient'] || 'portrait',
    margins: {
      top: numberValue(margins['w:top']) || 1134,
      right: numberValue(margins['w:right']) || 1134,
      bottom: numberValue(margins['w:bottom']) || 1134,
      left: numberValue(margins['w:left']) || 1134,
    },
  };
}

function flattenNativeBlocks(pages) {
  const blocks = [];
  function append(child, pageNumber) {
    if (child.type === 'paragraph') {
      const text = child.text.trim();
      if (!text) return;
      const block = {
        id: `block-${pageNumber}-${blocks.filter((entry) => entry.page === pageNumber).length + 1}`,
        page: pageNumber,
        order: blocks.filter((entry) => entry.page === pageNumber).length,
        kind: child.kind === 'paragraph' ? 'paragraph' : 'heading',
        text,
        confidence: 1,
        style: child.style_id,
        bbox: null,
        native_id: child.id,
      };
      child.block_id = block.id;
      blocks.push(block);
      return;
    }
    if (child.type === 'table') {
      child.rows.forEach((row) => row.cells.forEach((cell) => cell.children.forEach(
        (entry) => append(entry, pageNumber),
      )));
    }
  }
  pages.forEach((page) => page.children.forEach((child) => append(child, page.number)));
  return blocks;
}

function parseDocumentXml(xmlBuffer, styles = parseStylesXml(null)) {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
  });
  let parsed;
  try {
    parsed = parser.parse(xmlBuffer.toString('utf8'));
  } catch (_) {
    throw new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'Word 正文 XML 无法解析');
  }
  const bodyItem = findItems(parsed, 'w:body')[0];
  const body = bodyItem ? bodyItem['w:body'] || [] : [];
  const sectionItem = body.find((item) => item && item['w:sectPr']);
  const section = parseSectionProperties(sectionItem ? sectionItem['w:sectPr'] : []);
  let sequence = 0;
  const nextId = (kind) => `docx-${kind}-${++sequence}`;
  const pages = [{ number: 1, children: [] }];
  const currentPage = () => pages[pages.length - 1];
  const newPage = () => {
    if (!currentPage().children.length && pages.length > 1) return;
    pages.push({ number: pages.length + 1, children: [] });
  };

  body.forEach((item) => {
    if (item['w:p']) {
      const paragraph = parseParagraph(item['w:p'], styles, nextId);
      const hasText = Boolean(paragraph.text.trim());
      if (paragraph.properties.page_break_before && currentPage().children.length) newPage();
      if (hasText) currentPage().children.push(paragraph);
      if (paragraph.page_break && !paragraph.properties.page_break_before) newPage();
    } else if (item['w:tbl']) {
      currentPage().children.push(parseTable(item['w:tbl'], styles, nextId));
    }
  });
  while (pages.length > 1 && !pages[pages.length - 1].children.length) pages.pop();
  const blocks = flattenNativeBlocks(pages);
  return {
    blocks,
    document: {
      type: 'docx',
      section,
      defaults: {
        run: styles.default_run,
        paragraph: styles.default_paragraph,
      },
      pages,
    },
  };
}

function parseAppPages(buffer) {
  if (!buffer) return null;
  const match = buffer.toString('utf8').match(/<Pages>(\d+)<\/Pages>/i);
  return match ? Number(match[1]) : null;
}

async function parseDocx(filePath, { workDir, convertPreview = true } = {}) {
  const entries = await readSelectedEntries(filePath);
  const relationships = entries['word/_rels/document.xml.rels']
    ? entries['word/_rels/document.xml.rels'].toString('utf8')
    : '';
  const warnings = [];
  if (/TargetMode\s*=\s*["']External["']/i.test(relationships)) {
    warnings.push('EXTERNAL_LINKS_REMOVED');
  }
  const contentTypes = entries['[Content_Types].xml'].toString('utf8');
  if (/macroEnabled/i.test(contentTypes) || /vbaProject/i.test(contentTypes)) {
    throw new DocumentRecognitionError('FILE_UNSAFE', '包含宏的 Word 文件暂不支持');
  }
  const styles = parseStylesXml(entries['word/styles.xml']);
  const parsedDocument = parseDocumentXml(entries['word/document.xml'], styles);
  const blocks = parsedDocument.blocks;
  let previewPdf = null;
  if (convertPreview && workDir) {
    await runCommand(
      'libreoffice',
      ['--headless', '--convert-to', 'pdf', '--outdir', workDir, filePath],
      { cwd: workDir, timeout: 90000, errorCode: 'DOCUMENT_CONVERSION_FAILED' },
    );
    const expected = path.join(workDir, `${path.basename(filePath, path.extname(filePath))}.pdf`);
    if (fs.existsSync(expected)) previewPdf = expected;
  }
  return {
    blocks,
    document: parsedDocument.document,
    pageCount: parseAppPages(entries['docProps/app.xml']) || null,
    warnings,
    previewPdf,
    nativeText: blocks.map((block) => block.text).join('\n'),
  };
}

async function convertDoc(filePath, workDir) {
  await runCommand(
    'libreoffice',
    ['--headless', '--convert-to', 'docx', '--outdir', workDir, filePath],
    { cwd: workDir, timeout: 90000, errorCode: 'DOCUMENT_CONVERSION_FAILED' },
  );
  const converted = path.join(workDir, `${path.basename(filePath, path.extname(filePath))}.docx`);
  if (!fs.existsSync(converted)) {
    throw new DocumentRecognitionError('DOCUMENT_CONVERSION_FAILED', '旧版 Word 文件转换失败');
  }
  return converted;
}

module.exports = {
  parseDocx,
  convertDoc,
  readSelectedEntries,
  parseDocumentXml,
  parseStylesXml,
};
