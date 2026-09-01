'use strict';
/**
 * 模板定义与内部 Template Schema（TECH §6.2、§10.2）。
 *
 * 系统模板首期三款：经典商务、现代分栏、极简留白。
 * 自定义模板支持 JPG/PNG/PDF/DOC/DOCX，统一转换为内部 Template Schema；
 * 无法解析时返回 TEMPLATE_UNSUPPORTED，由用户改用系统模板。
 */
const db = require('./db');
const { uuidv7, nowIso, sha256, problem } = require('./util');

const PARSER_VERSION = 'parser-1';

/** 内部 Template Schema（TECH §10.2）。 */
const SYSTEM_TEMPLATES = [
  {
    key: 'classic',
    name: '经典商务',
    description: '稳重清晰，适合多数岗位',
    schema: {
      page: { size: 'A4', margin: { top: 58, right: 64, bottom: 64, left: 64 }, max_pages: 2, unit: 'pt' },
      regions: [{ id: 'main', columns: 1, flow: 'vertical' }],
      typography: { font: 'Noto Sans SC', base_size: 9.5, line_height: 1.75, color: '#414448' },
      section_rules: {
        order: ['summary', 'experience', 'projects', 'education', 'skills'],
        titles: {
          summary: '个人优势',
          experience: '工作经历',
          projects: '项目经历',
          education: '教育经历',
          skills: '专业技能',
        },
        title_style: { rule: true, size: 12, letter_spacing: 1.5, color: '#1d1d1f' },
      },
      constraints: { max_bullets_per_item: 6, keep_with_next: true },
      assets: {},
      layout: 'classic',
    },
  },
  {
    key: 'modern',
    name: '现代分栏',
    description: '更有识别度，突出重点',
    schema: {
      page: { size: 'A4', margin: { top: 52, right: 56, bottom: 56, left: 56 }, max_pages: 2, unit: 'pt' },
      regions: [
        { id: 'main', columns: 1, flow: 'vertical' },
        { id: 'aside', columns: 1, width: 0.28, flow: 'vertical' },
      ],
      typography: { font: 'Noto Sans SC', base_size: 9.5, line_height: 1.75, color: '#414448', accent: '#0066cc' },
      section_rules: {
        order: ['summary', 'experience', 'projects', 'education', 'skills'],
        titles: {
          summary: '个人优势',
          experience: '工作经历',
          projects: '项目经历',
          education: '教育经历',
          skills: '专业技能',
        },
        title_style: { rule: true, size: 12, letter_spacing: 1.5, color: '#0066cc' },
      },
      constraints: { max_bullets_per_item: 6, keep_with_next: true },
      assets: {},
      layout: 'modern',
    },
  },
  {
    key: 'minimal',
    name: '极简留白',
    description: '克制轻盈，强调内容',
    schema: {
      page: { size: 'A4', margin: { top: 66, right: 70, bottom: 70, left: 70 }, max_pages: 2, unit: 'pt' },
      regions: [{ id: 'main', columns: 1, flow: 'vertical' }],
      typography: { font: 'Noto Sans SC', base_size: 10, line_height: 1.85, color: '#55555a' },
      section_rules: {
        order: ['summary', 'experience', 'projects', 'education', 'skills'],
        titles: {
          summary: '个人优势',
          experience: '工作经历',
          projects: '项目经历',
          education: '教育经历',
          skills: '专业技能',
        },
        title_style: { rule: false, size: 11, letter_spacing: 2, color: '#55555a' },
      },
      constraints: { max_bullets_per_item: 5, keep_with_next: true },
      assets: {},
      layout: 'minimal',
    },
  },
];

/** 确保系统模板已入库，返回 {key → template_version}。 */
function ensureSystemTemplates() {
  const result = {};
  for (const template of SYSTEM_TEMPLATES) {
    let definition = db.get(
      "SELECT * FROM template_definitions WHERE name = ? AND kind = 'system' AND owner_id IS NULL",
      [template.name],
    );
    if (!definition) {
      const id = uuidv7();
      db.run(
        `INSERT INTO template_definitions (id, owner_id, name, kind, status, created_at, updated_at)
         VALUES (?, NULL, ?, 'system', 'ready', ?, ?)`,
        [id, template.name, nowIso(), nowIso()],
      );
      definition = db.get('SELECT * FROM template_definitions WHERE id = ?', [id]);
    }
    let version = db.get(
      'SELECT * FROM template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1',
      [definition.id],
    );
    const schemaJson = JSON.stringify({ key: template.key, ...template.schema });
    if (!version) {
      const versionId = uuidv7();
      db.run(
        `INSERT INTO template_versions (id, template_id, owner_id, version, schema_json, parser_version, checksum, created_at)
         VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
        [versionId, definition.id, schemaJson, PARSER_VERSION, sha256(schemaJson), nowIso()],
      );
      version = db.get('SELECT * FROM template_versions WHERE id = ?', [versionId]);
    }
    result[template.key] = {
      definition_id: definition.id,
      version_id: version.id,
      key: template.key,
      name: template.name,
      description: template.description,
      version: version.version,
      schema: JSON.parse(version.schema_json),
    };
  }
  return result;
}

/** 解析自定义模板：受支持的格式生成内部 Schema，否则抛出 TEMPLATE_UNSUPPORTED。 */
function buildCustomTemplate({ user, originalName, size }) {
  const extension = (originalName.split('.').pop() || '').toLowerCase();
  const imageExt = ['jpg', 'jpeg', 'png'];
  const supported = [...imageExt, 'pdf', 'doc', 'docx'];
  if (!supported.includes(extension)) {
    throw problem.unprocessable(
      'TEMPLATE_UNSUPPORTED',
      `不支持的文件格式 .${extension}；请改用 JPG、PNG、PDF 或 Word 模板`,
    );
  }
  if (size > 20 * 1024 * 1024) {
    throw problem.unprocessable('TEMPLATE_UNSUPPORTED', '文件超过 20 MB，请压缩后上传');
  }
  // 图片作为背景式模板，使用预定义安全区（TECH §10.2）
  const isImage = imageExt.includes(extension);
  const schema = {
    page: { size: 'A4', margin: { top: 64, right: 64, bottom: 64, left: 64 }, max_pages: isImage ? 1 : 3, unit: 'pt' },
    regions: [{ id: 'main', columns: 1, flow: 'vertical' }],
    typography: { font: 'Noto Sans SC', base_size: 9.5, line_height: 1.75, color: '#414448' },
    section_rules: {
      order: ['summary', 'experience', 'projects', 'education', 'skills'],
      titles: {
        summary: '个人优势',
        experience: '工作经历',
        projects: '项目经历',
        education: '教育经历',
        skills: '专业技能',
      },
      title_style: { rule: true, size: 12, letter_spacing: 1.5, color: '#1d1d1f' },
    },
    constraints: { max_bullets_per_item: 6, keep_with_next: true },
    assets: isImage
      ? { background: { type: 'image', name: originalName, safe_area: 'preset' } }
      : { file: { type: extension, name: originalName } },
    layout: 'custom',
    custom: true,
  };
  return { schema, extension, isImage };
}

/** 创建自定义模板定义与版本。 */
function createCustomTemplate({ user, originalName, size, uploadId }) {
  const { schema, extension, isImage } = buildCustomTemplate({ user, originalName, size });
  return db.tx(() => {
    const definitionId = uuidv7();
    db.run(
      `INSERT INTO template_definitions (id, owner_id, name, kind, status, template_upload_id, created_at, updated_at)
       VALUES (?, ?, ?, 'custom', 'ready', ?, ?, ?)`,
      [definitionId, user.id, originalName || '自定义模板', uploadId || null, nowIso(), nowIso()],
    );
    const schemaJson = JSON.stringify(schema);
    const versionId = uuidv7();
    db.run(
      `INSERT INTO template_versions (id, template_id, owner_id, version, schema_json, parser_version, checksum, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [versionId, definitionId, user.id, schemaJson, PARSER_VERSION, sha256(schemaJson), nowIso()],
    );
    return {
      definition_id: definitionId,
      version_id: versionId,
      key: 'custom',
      name: originalName || '自定义模板',
      description: `自定义模板 · ${extension.toUpperCase()}${isImage ? ' · 背景式' : ''}`,
      version: 1,
      schema,
    };
  });
}

module.exports = {
  SYSTEM_TEMPLATES,
  PARSER_VERSION,
  ensureSystemTemplates,
  buildCustomTemplate,
  createCustomTemplate,
};
