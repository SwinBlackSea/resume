'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const sharp = require('sharp');
const { runCommand } = require('./command');
const { DocumentRecognitionError } = require('./errors');
const { MAX_PAGES } = require('./constants');

function parsePdfInfo(raw) {
  const values = {};
  String(raw).split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match) values[match[1].trim().toLowerCase().replace(/\s+/g, '_')] = match[2].trim();
  });
  const pageSize = String(values.page_size || '').match(/([\d.]+)\s+x\s+([\d.]+)\s+pts/i);
  return {
    pages: Number(values.pages || 0),
    encrypted: /^yes/i.test(values.encrypted || ''),
    width: pageSize ? Number(pageSize[1]) : 595.28,
    height: pageSize ? Number(pageSize[2]) : 841.89,
  };
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function wordText(word) {
  if (word === undefined || word === null) return '';
  const value =
    typeof word === 'string' || typeof word === 'number'
      ? String(word)
      : String(word['#text'] || word.text || '');
  return value.normalize('NFKC');
}

function parseBboxXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
    processEntities: false,
  });
  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (_) {
    throw new DocumentRecognitionError('DOCUMENT_CORRUPTED', 'PDF 文字坐标无法解析');
  }
  const documentNode =
    (parsed && parsed.doc)
    || (parsed && parsed.html && parsed.html.body && parsed.html.body.doc)
    || null;
  const pageNodes = asArray(documentNode && documentNode.page);
  const pages = [];
  pageNodes.forEach((page, pageIndex) => {
    const lines = [];
    asArray(page.flow).forEach((flow) => {
      asArray(flow.block).forEach((block) => {
        asArray(block.line).forEach((line) => {
          const words = asArray(line.word);
          const text = words.map(wordText).filter(Boolean).join(' ').replace(/\s+([,.;:!?，。；：！？])/g, '$1').trim();
          if (!text) return;
          const xs = words.flatMap((word) => [Number(word.xMin), Number(word.xMax)]).filter(Number.isFinite);
          const ys = words.flatMap((word) => [Number(word.yMin), Number(word.yMax)]).filter(Number.isFinite);
          lines.push({
            text,
            bbox: xs.length && ys.length
              ? {
                  x: Math.min(...xs),
                  y: Math.min(...ys),
                  width: Math.max(...xs) - Math.min(...xs),
                  height: Math.max(...ys) - Math.min(...ys),
                }
              : null,
          });
        });
      });
    });
    const heights = lines.map((line) => line.bbox && line.bbox.height).filter(Number.isFinite).sort((a, b) => a - b);
    const medianHeight = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    pages.push({
      number: pageIndex + 1,
      width: Number(page.width || 595.28),
      height: Number(page.height || 841.89),
      blocks: lines.map((line, index) => ({
        id: `block-${pageIndex + 1}-${index + 1}`,
        page: pageIndex + 1,
        order: index,
        kind:
          line.bbox
          && medianHeight
          && line.bbox.height > medianHeight * 1.22
          && line.text.length <= 40
            ? 'heading'
            : 'paragraph',
        text: line.text,
        confidence: 1,
        bbox: line.bbox,
      })),
    });
  });
  return pages;
}

async function renderPdfPages(filePath, workDir, pageCount) {
  const prefix = path.join(workDir, 'page');
  await runCommand(
    'pdftoppm',
    ['-png', '-r', '120', '-f', '1', '-l', String(pageCount), filePath, prefix],
    { cwd: workDir, timeout: 90000, errorCode: 'DOCUMENT_RENDER_FAILED' },
  );
  const previews = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const file = `${prefix}-${page}.png`;
    if (!fs.existsSync(file)) continue;
    const metadata = await sharp(file).metadata();
    previews.push({
      page,
      path: file,
      mime_type: 'image/png',
      width: metadata.width || null,
      height: metadata.height || null,
    });
  }
  return previews;
}

async function parsePdf(filePath, { workDir }) {
  const infoResult = await runCommand(
    'pdfinfo',
    [filePath],
    { cwd: workDir, timeout: 30000, errorCode: 'DOCUMENT_CORRUPTED' },
  );
  const info = parsePdfInfo(infoResult.stdout);
  if (info.encrypted) {
    throw new DocumentRecognitionError('DOCUMENT_ENCRYPTED', '加密 PDF 暂不支持，请先解除密码');
  }
  if (!info.pages || info.pages > MAX_PAGES) {
    throw new DocumentRecognitionError(
      'DOCUMENT_PAGE_LIMIT',
      info.pages ? `文件共有 ${info.pages} 页，最多支持 ${MAX_PAGES} 页` : '无法读取 PDF 页数',
    );
  }
  const bboxPath = path.join(workDir, 'layout.xml');
  await runCommand(
    'pdftotext',
    ['-bbox-layout', '-enc', 'UTF-8', filePath, bboxPath],
    { cwd: workDir, timeout: 60000, errorCode: 'DOCUMENT_TEXT_EXTRACTION_FAILED' },
  );
  const bboxXml = fs.existsSync(bboxPath) ? fs.readFileSync(bboxPath, 'utf8') : '';
  let pages = parseBboxXml(bboxXml);
  if (!pages.length) {
    pages = Array.from({ length: info.pages }, (_, index) => ({
      number: index + 1,
      width: info.width,
      height: info.height,
      blocks: [],
    }));
  }
  const previews = await renderPdfPages(filePath, workDir, info.pages);
  return {
    pageCount: info.pages,
    pages,
    previews,
    nativeText: pages.flatMap((page) => page.blocks).map((block) => block.text).join('\n'),
    warnings: [],
  };
}

module.exports = { parsePdf, parsePdfInfo, parseBboxXml, renderPdfPages };
