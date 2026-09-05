'use strict';

const fs = require('node:fs');
const sharp = require('sharp');
const { createDeepSeekClient } = require('../deepseek-client');

const SYSTEM_PROMPT = [
  '你是简历文档结构识别器。',
  '输入包含确定性解析得到的文字块 ID、文字和页面预览。',
  '你只能判断阅读顺序、标题与正文的父子分组和排版，不得改写、补充或返回新的简历文字。',
  'sections 表示真实语义分组：title_block_id 是组标题，block_ids 是该标题直接统领的内容块。',
  '所有 block_id 必须来自输入。',
  '返回 JSON：{"reading_order":["block-id"],"sections":[{"title_block_id":"block-id或null","block_ids":["block-id"]}],"layout":{"columns":1或2,"main_column_ratio":0.5到1,"visual_style":"简短标签"},"uncertain_block_ids":["block-id"]}。',
].join('\n');

function blockIsHeading(block) {
  const kind = String(block && (block.semantic_kind || block.kind) || '').toLowerCase();
  return kind === 'title'
    || kind === 'heading'
    || kind === 'document_title'
    || kind === 'section_title';
}

function appendUnassignedSections(sections, readingOrder, blocksById, assigned) {
  let current = sections.length ? sections[sections.length - 1] : null;
  readingOrder.forEach((id) => {
    if (assigned.has(id)) return;
    const block = blocksById.get(id);
    if (blockIsHeading(block)) {
      current = { title_block_id: id, block_ids: [] };
      sections.push(current);
    } else {
      if (!current) {
        current = { title_block_id: null, block_ids: [] };
        sections.push(current);
      }
      current.block_ids.push(id);
    }
    assigned.add(id);
  });
}

function enabled() {
  if (process.env.NODE_ENV === 'test') return false;
  if (String(process.env.RESUME_DOCUMENT_AI_ENABLED || 'true').toLowerCase() === 'false') return false;
  return Boolean(process.env.RESUME_LLM_API_KEY);
}

async function imagePart(preview) {
  const buffer = await sharp(preview.path)
    .rotate()
    .resize({ width: 1200, height: 1700, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return {
    type: 'image_url',
    image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` },
  };
}

function normalizeSemantic(raw, blocks) {
  const blockIds = new Set(blocks.map((block) => block.id));
  const blocksById = new Map(blocks.map((block) => [block.id, block]));
  const uniqueIds = (values) => {
    const seen = new Set();
    return (Array.isArray(values) ? values : [])
      .map(String)
      .filter((id) => blockIds.has(id) && !seen.has(id) && seen.add(id));
  };
  const readingOrder = uniqueIds(raw && raw.reading_order);
  blocks.forEach((block) => {
    if (!readingOrder.includes(block.id)) readingOrder.push(block.id);
  });
  const assigned = new Set();
  const sections = [];
  (Array.isArray(raw && raw.sections) ? raw.sections : []).forEach((section) => {
    const candidateTitleId =
      section && section.title_block_id && blockIds.has(String(section.title_block_id))
        ? String(section.title_block_id)
        : null;
    const titleId = candidateTitleId && !assigned.has(candidateTitleId)
      ? candidateTitleId
      : null;
    const ids = uniqueIds(section && section.block_ids)
      .filter((id) => id !== titleId && !assigned.has(id));
    if (titleId) assigned.add(titleId);
    ids.forEach((id) => assigned.add(id));
    if (titleId || ids.length) sections.push({ title_block_id: titleId, block_ids: ids });
  });
  appendUnassignedSections(sections, readingOrder, blocksById, assigned);
  const columns = Number(raw && raw.layout && raw.layout.columns) === 2 ? 2 : 1;
  const ratio = Number(raw && raw.layout && raw.layout.main_column_ratio);
  return {
    reading_order: readingOrder,
    sections,
    layout: {
      columns,
      main_column_ratio: Number.isFinite(ratio) ? Math.max(0.5, Math.min(1, ratio)) : 1,
      visual_style: String((raw && raw.layout && raw.layout.visual_style) || '').slice(0, 60),
    },
    uncertain_block_ids: uniqueIds(raw && raw.uncertain_block_ids),
  };
}

async function analyzeDocument({ blocks, previews }) {
  if (!enabled()) {
    return {
      semantic: normalizeSemantic({}, blocks),
      model: 'not-invoked',
      warning: 'AI_ANALYSIS_NOT_CONFIGURED',
    };
  }
  const client = createDeepSeekClient({
    temperature: 0.1,
    maxTokens: Number(
      process.env.RESUME_DOCUMENT_AI_MAX_TOKENS
      || process.env.RESUME_LLM_MAX_TOKENS
      || 10000,
    ),
  });
  try {
    const content = [
      {
        type: 'text',
        text: JSON.stringify({
          blocks: blocks.map((block) => ({
            id: block.id,
            page: block.page,
            kind: block.kind,
            semantic_kind: block.semantic_kind || block.kind,
            text: block.text,
            bbox: block.bbox,
          })),
        }),
      },
    ];
    for (const preview of (previews || []).slice(0, 2)) {
      if (fs.existsSync(preview.path)) content.push(await imagePart(preview));
    }
    const result = await client.generate({
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    });
    return {
      semantic: normalizeSemantic(result.output, blocks),
      model: `${result.provider}/${result.model}`,
      warning: null,
    };
  } catch (error) {
    console.warn(
      '[document-recognition-ai] unavailable',
      error && error.code ? error.code : 'UNKNOWN',
      error && error.status ? error.status : '',
    );
    return {
      semantic: normalizeSemantic({}, blocks),
      model: `${client.provider}/${client.model}:unavailable`,
      warning: 'AI_ANALYSIS_UNAVAILABLE',
    };
  }
}

module.exports = { analyzeDocument, normalizeSemantic, SYSTEM_PROMPT };
