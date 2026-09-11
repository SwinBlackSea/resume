'use strict';

const db = require('./db');
const { problem } = require('./util');
const ResumeDom = require('../../resume-dom');
const { getBuiltinLayout, listBuiltinLayouts, readBuiltinReferenceImage } = require('./builtin-layouts');

const ROLES = ['personal', 'job', 'layout'];
const ROLE_RULES = {
  personal: '求职者本人提供的信息和照片；这是个人事实材料，不写入独立资料档案。',
  job: '目标岗位要求；不得把招聘要求当作求职者已有经历。',
  layout: '仅参考模块组织和排版。不得采用其中他人的姓名、经历、联系方式或头像。',
};
const LEGACY_LAYOUTS = [
  { id: 'quiet', name: '简约 · 单栏', detail: '清晰层次，舒展留白', accent: '#26343d' },
  { id: 'editorial', name: '雅致 · 双栏', detail: '重点突出，信息分区', accent: '#756653' },
  { id: 'modern', name: '现代 · 紧凑', detail: '紧凑有序，适合丰富经历', accent: '#345e63' },
];
const LAYOUTS = listBuiltinLayouts();
function findLayout(id) { return getBuiltinLayout(id) || LEGACY_LAYOUTS.find((item) => item.id === id); }

function layoutDocument(id) {
  const selected = LEGACY_LAYOUTS.find((item) => item.id === id);
  if (!selected) throw problem.badRequest('请选择有效的简历样式');
  const block = (name, title) => ({ id: `reference-${name}`, type: 'element', tag: 'section',
    semantic: { kind: 'section' }, style: { 'margin-bottom': '20px' }, children: [
      { id: `reference-${name}-title`, type: 'element', tag: 'h2', semantic: { kind: 'heading' },
        text: title, editable: true, style: { 'font-size': '15px', color: selected.accent,
          'border-bottom': `1px solid ${selected.accent}`, 'padding-bottom': '6px' }, children: [] },
    ] });
  return ResumeDom.toResumeDocument({ schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'layout-reference', type: 'element', tag: 'article', semantic: { kind: 'document' },
      style: { 'font-family': 'Arial, sans-serif', 'font-size': '13px', 'line-height': '1.65',
        color: '#263238', 'background-color': '#ffffff', padding: '40px',
        ...(id === 'editorial' ? { display: 'grid', 'grid-template-columns': '2fr 1fr', gap: '24px' } : {}),
        ...(id === 'modern' ? { padding: '30px', 'line-height': '1.5' } : {}) },
      children: [
        { id: 'reference-name', type: 'element', tag: 'header', semantic: { kind: 'section' },
          style: { 'grid-column': '1 / -1', 'margin-bottom': '24px' }, children: [
            { id: 'reference-name-text', type: 'element', tag: 'h1', semantic: { kind: 'heading' },
              text: '姓名', editable: true, style: { 'font-size': '30px', color: selected.accent }, children: [] },
          ] },
        block('overview', '职业概况'), block('experience', '工作经历'),
        block('education', '教育背景'), block('skills', '专业能力'),
      ] } });
}

function loadIntake(id, user) {
  const row = db.get('SELECT * FROM home_intakes WHERE id = ? AND owner_id = ?', [id, user.id]);
  if (!row) throw problem.notFound('本次材料不存在，请重新打开首页');
  return { ...row, state: JSON.parse(row.state_json || '{}') };
}

function materialView(value, intake) {
  if (!value) return { status: 'empty' };
  if (value.kind === 'image') {
    const upload = db.get('SELECT original_name,status FROM uploads WHERE id=? AND owner_id=?',
      [value.upload_id, intake.owner_id]);
    const asset = db.get('SELECT id FROM document_assets WHERE id=? AND owner_id=?', [value.asset_id, intake.owner_id]);
    return { ...value, name: upload?.original_name || '截图',
      status: upload?.status === 'ready' && asset ? 'ready' : 'failed',
      preview_url: `/api/v1/document-assets/${value.asset_id}/content`,
      error: upload?.status === 'ready' && asset ? null : '图片已不可用，请重新上传' };
  }
  if (value.kind === 'builtin') {
    if (!findLayout(value.layout_id)) return { ...value, status: 'failed', error: '该样式已不可用，请重新选择' };
    try { if (getBuiltinLayout(value.layout_id)) readBuiltinReferenceImage(value.layout_id); }
    catch (error) { return { ...value, status: 'failed', error: error.detail || error.message }; }
    return { ...value, status: 'ready' };
  }
  if (value.kind === 'link') {
    const expired = value.status === 'checking'
      && Date.now() - Date.parse(value.verification_started_at || 0) > 60000;
    return { kind: 'link', url: value.url, title: value.title || '',
      status: expired ? 'failed' : value.status,
      error: expired ? '验证未完成，请重新粘贴链接或上传岗位截图。' : value.error || null };
  }
  const row = db.get(`SELECT d.status, d.quality_report, d.error_message_safe AS error_message, u.original_name
    FROM document_imports d JOIN uploads u ON u.id = d.upload_id
    WHERE d.id = ? AND d.owner_id = ? AND d.project_id = ?`,
  [value.document_import_id, intake.owner_id, intake.project_id]);
  if (!row) return { ...value, status: 'failed', error: '附件已不可用，请重新上传' };
  const safe = JSON.parse(row.quality_report || '{}').safe_to_review !== false;
  const ready = ['ready', 'needs_review', 'applied'].includes(row.status) && safe;
  return { ...value, name: row.original_name, status: ready ? 'ready' : (
    row.status === 'failed' || !safe ? 'failed' : 'processing'),
  error: !safe ? '识别内容不完整，请换清晰文件' : row.error_message || null };
}

function intakeView(intake) {
  const materials = Object.fromEntries(ROLES.map((role) => [role, materialView(intake.state[role], intake)]));
  const project = db.get('SELECT current_job_id FROM resume_projects WHERE id = ?', [intake.project_id]);
  const draft = db.get('SELECT resume_json, revision FROM resume_drafts WHERE project_id = ?', [intake.project_id]);
  const completed = Boolean(draft && ResumeDom.plainText(JSON.parse(draft.resume_json)).trim());
  const conversation = db.get(`SELECT id FROM ai_conversations WHERE project_id = ? AND owner_id = ?
    AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1`, [intake.project_id, intake.owner_id]);
  const attempted = Boolean(conversation && db.get('SELECT id FROM ai_messages WHERE conversation_id=? AND role=? LIMIT 1',
    [conversation.id, 'user']));
  return { id: intake.id, project_id: intake.project_id, conversation_id: conversation?.id, attempted,
    materials, ready: ROLES.every((role) => materials[role].status === 'ready'),
    generated: completed, revision: draft?.revision, job_id: project?.current_job_id || null };
}

function authorizeGeneration({ intakeId, user, projectId, conversationId }) {
  const intake = loadIntake(intakeId, user);
  const view = intakeView(intake);
  if (intake.project_id !== projectId || view.conversation_id !== conversationId) {
    throw problem.badRequest('材料不属于当前简历或对话');
  }
  if (!view.ready) throw problem.conflict('HOME_MATERIALS_NOT_READY', '请先准备好个人信息、岗位信息和简历样式');
  const documentIds = ROLES.flatMap((role) => intake.state[role]?.document_import_id || []);
  const link = intake.state.job?.kind === 'link' ? intake.state.job : null;
  return {
    attachment_ids: [], document_import_ids: documentIds,
    link_materials: link ? [{ url: link.url, resolved_url: link.resolved_url, text: link.text }] : [],
    home_materials: {
      intake_id: intake.id, role_rules: ROLE_RULES,
      roles: Object.fromEntries(ROLES.map((role) => [role, {
        kind: intake.state[role].kind,
        document_import_id: intake.state[role].document_import_id || null,
        upload_id: intake.state[role].upload_id || null,
        ...(intake.state[role].kind === 'image' ? { asset_id: intake.state[role].asset_id } : {}),
        ...(role === 'layout' && intake.state.layout.kind === 'builtin'
          ? (getBuiltinLayout(intake.state.layout.layout_id)
            ? { builtin_reference_id: intake.state.layout.layout_id,
              reference_instructions: '以随请求提供的同名样式图片作为版式参考，组织可编辑的完整简历。只参考结构、字号、间距、配色；不得采用图中的姓名、联系方式、经历、头像，不得把整张样式图当作正文图片。' }
            : { reference_document: layoutDocument(intake.state.layout.layout_id) }) : {}),
      }])),
    },
  };
}

function taskHomeMaterials(conversationId, taskId, user, projectId) {
  const row = db.get(`SELECT model_metadata_json FROM ai_messages WHERE conversation_id = ?
    AND task_id = ? AND owner_id = ? AND role = 'user'
    AND json_extract(model_metadata_json, '$.home_materials.intake_id') IS NOT NULL
    ORDER BY created_at, id LIMIT 1`, [conversationId, taskId, user.id]);
  if (!row) return null;
  // The message freezes role identities for this task; later homepage material
  // replacements cannot change what an already accepted request means.
  const value = JSON.parse(row.model_metadata_json).home_materials;
  const intake = loadIntake(value.intake_id, user);
  if (intake.project_id !== projectId) throw problem.badRequest('材料任务归属不一致');
  return value;
}

module.exports = { ROLES, ROLE_RULES, LAYOUTS, findLayout, layoutDocument, loadIntake, intakeView,
  authorizeGeneration, taskHomeMaterials };
