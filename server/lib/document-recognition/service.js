'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { parseDocx, convertDoc } = require('./docx');
const { parsePdf } = require('./pdf');
const { recognizeImage } = require('./ocr');
const { extractPageScene, extractRasterPageScene } = require('./page-scene');
const { analyzeDocument } = require('./semantic-analyzer');
const { buildContentCandidate, buildLayoutCandidate } = require('./candidates');
const { buildQualityReport } = require('./quality');
const {
  PARSER_VERSION,
  SUPPORTED_FORMATS,
  IMAGE_FORMATS,
  MAX_FILE_SIZE,
  MAX_PAGES,
  RECOMMENDED_MAX_PAGES,
} = require('./constants');
const { DocumentRecognitionError } = require('./errors');

function extensionOf(name) {
  return (String(name).split('.').pop() || '').toLowerCase();
}

function validateInput({ inputPath, originalName }) {
  const format = extensionOf(originalName || inputPath);
  if (!SUPPORTED_FORMATS.has(format)) {
    throw new DocumentRecognitionError(
      'DOCUMENT_FORMAT_UNSUPPORTED',
      '目前支持 PDF、DOCX、DOC、PNG、JPG 和 WEBP',
    );
  }
  const stat = fs.statSync(inputPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new DocumentRecognitionError('FILE_MISSING', '没有读取到文件内容');
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new DocumentRecognitionError('FILE_TOO_LARGE', '文件超过 20 MB');
  }
  const header = fs.readFileSync(inputPath).subarray(0, 16);
  const hex = header.toString('hex');
  const valid =
    (format === 'pdf' && header.toString('latin1', 0, 4) === '%PDF')
    || (format === 'docx' && hex.startsWith('504b0304'))
    || (format === 'doc' && hex.startsWith('d0cf11e0a1b11ae1'))
    || (format === 'png' && hex.startsWith('89504e470d0a1a0a'))
    || (['jpg', 'jpeg'].includes(format) && hex.startsWith('ffd8ff'))
    || (
      format === 'webp'
      && header.toString('latin1', 0, 4) === 'RIFF'
      && header.toString('latin1', 8, 12) === 'WEBP'
    );
  if (!valid) {
    throw new DocumentRecognitionError('FILE_UNSAFE', '文件内容与扩展名不一致，已拒绝');
  }
  return format;
}

async function parseImage(filePath, workDir, format) {
  const output = path.join(workDir, 'page-1.png');
  await sharp(filePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 8 })
    .toFile(output);
  const metadata = await sharp(output).metadata();
  const ocr = await recognizeImage(output, 1);
  return {
    pageCount: 1,
    pages: [{
      number: 1,
      width: metadata.width || null,
      height: metadata.height || null,
      blocks: ocr.blocks,
    }],
    previews: [{
      page: 1,
      path: output,
      mime_type: 'image/png',
      width: metadata.width || null,
      height: metadata.height || null,
    }],
    nativeText: ocr.blocks.map((block) => block.text).join('\n'),
    warnings: ['OCR_USED', ...(ocr.warning ? [ocr.warning] : [])],
    ocrModel: ocr.model,
    format,
  };
}

async function fillMissingPdfText(parsed) {
  let ocrModel = 'not-used';
  for (const page of parsed.pages) {
    if ((page.blocks || []).some((block) => block.text.trim())) continue;
    const preview = parsed.previews.find((item) => item.page === page.number);
    if (!preview) continue;
    const ocr = await recognizeImage(preview.path, page.number);
    page.blocks = ocr.blocks;
    ocrModel = ocr.model;
    parsed.warnings.push('TEXT_LAYER_MISSING', 'OCR_USED');
    if (ocr.warning) parsed.warnings.push(ocr.warning);
  }
  return ocrModel;
}

function mergePageScenes(baseScene, rasterScene) {
  if (!baseScene) return rasterScene;
  const rasterPages = new Map((rasterScene.pages || []).map((page) => [Number(page.number), page]));
  const rasterBackgrounds = new Map(
    (rasterScene.backgrounds || []).map((background) => [Number(background.page), background]),
  );
  const pages = (baseScene.pages || []).map((page) =>
    rasterPages.get(Number(page.number)) || page);
  const backgrounds = (baseScene.backgrounds || []).map((background) =>
    rasterBackgrounds.get(Number(background.page)) || background);
  const textNodeCount = pages.reduce(
    (sum, page) => sum + (Array.isArray(page.text_nodes) ? page.text_nodes.length : 0),
    0,
  );
  return {
    ...baseScene,
    has_text_layer: textNodeCount > 0,
    text_node_count: textNodeCount,
    pages,
    backgrounds,
  };
}

async function recognizeDocument({ inputPath, originalName, mimeType, workDir }) {
  fs.mkdirSync(workDir, { recursive: true });
  const format = validateInput({ inputPath, originalName });
  let parsed;
  let ocrModel = 'not-used';
  let canonicalPdf = null;
  let pageScene = null;

  if (format === 'pdf') {
    canonicalPdf = inputPath;
    parsed = await parsePdf(inputPath, { workDir });
    ocrModel = await fillMissingPdfText(parsed);
  } else if (format === 'docx') {
    const native = await parseDocx(inputPath, { workDir });
    canonicalPdf = native.previewPdf || null;
    const preview = native.previewPdf
      ? await parsePdf(native.previewPdf, { workDir })
      : { pages: [], previews: [], pageCount: native.pageCount || 1 };
    parsed = {
      pageCount: preview.pageCount || native.pageCount || 1,
      geometryPages: preview.pages,
      pages: preview.pages.length
        ? preview.pages.map((page) => ({
            ...page,
            blocks: native.blocks.filter((block) => block.page === page.number),
          }))
        : [{ number: 1, width: 595.28, height: 841.89, blocks: native.blocks }],
      previews: preview.previews,
      nativeText: native.nativeText,
      warnings: native.warnings,
      nativeDocument: native.document,
    };
  } else if (format === 'doc') {
    const converted = await convertDoc(inputPath, workDir);
    const native = await parseDocx(converted, { workDir });
    canonicalPdf = native.previewPdf || null;
    const preview = native.previewPdf
      ? await parsePdf(native.previewPdf, { workDir })
      : { pages: [], previews: [], pageCount: native.pageCount || 1 };
    parsed = {
      pageCount: preview.pageCount || native.pageCount || 1,
      geometryPages: preview.pages,
      pages: preview.pages.length
        ? preview.pages.map((page) => ({
            ...page,
            blocks: native.blocks.filter((block) => block.page === page.number),
          }))
        : [{ number: 1, width: 595.28, height: 841.89, blocks: native.blocks }],
      previews: preview.previews,
      nativeText: native.nativeText,
      warnings: ['LEGACY_DOC_CONVERTED', ...native.warnings],
      nativeDocument: native.document,
    };
  } else if (IMAGE_FORMATS.has(format)) {
    parsed = await parseImage(inputPath, workDir, format);
    ocrModel = parsed.ocrModel;
  }

  if (!parsed || parsed.pageCount > MAX_PAGES) {
    throw new DocumentRecognitionError('DOCUMENT_PAGE_LIMIT', `最多支持 ${MAX_PAGES} 页`);
  }
  if (canonicalPdf) {
    try {
      pageScene = await extractPageScene(canonicalPdf, workDir);
    } catch (error) {
      parsed.warnings = [...(parsed.warnings || []), error.code || 'PAGE_SCENE_EXTRACTION_FAILED'];
    }
  }
  const rasterPageNumbers = pageScene
    ? new Set(
        (pageScene.pages || [])
          .filter((page) => page.background_contains_text)
          .map((page) => Number(page.number)),
      )
    : new Set((parsed.pages || []).map((page) => Number(page.number)));
  const rasterPages = (parsed.pages || []).filter(
    (page) =>
      rasterPageNumbers.has(Number(page.number))
      && (page.blocks || []).some((block) => block.text && block.bbox),
  );
  if (rasterPages.length) {
    try {
      const rasterScene = await extractRasterPageScene({
        pages: rasterPages,
        previews: parsed.previews,
        workDir,
      });
      pageScene = mergePageScenes(pageScene, rasterScene);
      parsed.warnings = [...(parsed.warnings || []), 'OCR_BACKGROUND_CLEANED'];
    } catch (error) {
      parsed.warnings = [...(parsed.warnings || []), error.code || 'PAGE_SCENE_EXTRACTION_FAILED'];
    }
  }
  const blocks = parsed.pages.flatMap((page) => page.blocks || []);
  const semanticResult = await analyzeDocument({ blocks, previews: parsed.previews });
  const warnings = [
    ...(parsed.warnings || []),
    ...(parsed.pageCount > RECOMMENDED_MAX_PAGES ? ['PAGE_COUNT_RECOMMENDED_EXCEEDED'] : []),
    ...(semanticResult.warning ? [semanticResult.warning] : []),
  ];
  const contentCandidate = buildContentCandidate({
    blocks,
    pages: parsed.pages,
    semantic: semanticResult.semantic,
    format,
    nativeDocument: parsed.nativeDocument,
    geometryPages: parsed.geometryPages,
    pageScene,
  });
  const layoutCandidate = buildLayoutCandidate({
    pages: parsed.pages,
    semantic: semanticResult.semantic,
    format,
    nativeDocument: parsed.nativeDocument,
    pageScene,
  });
  const qualityReport = buildQualityReport({
    blocks,
    nativeText: parsed.nativeText,
    pageCount: parsed.pageCount,
    warnings,
    semantic: semanticResult.semantic,
    format,
  });
  return {
    detected_format: format,
    detected_mime: mimeType || '',
    page_count: parsed.pageCount,
    parser_version: PARSER_VERSION,
    model_version: semanticResult.model,
    ocr_model: ocrModel,
    content_candidate: contentCandidate,
    layout_candidate: layoutCandidate,
    quality_report: qualityReport,
    warning_codes: qualityReport.warning_codes,
    previews: parsed.previews,
    scene_backgrounds: pageScene && pageScene.has_text_layer ? pageScene.backgrounds : [],
  };
}

module.exports = { recognizeDocument, validateInput, parseImage };
