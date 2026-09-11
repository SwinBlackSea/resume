'use strict';

const db = require('./db');
const { problem } = require('./util');
const ResumeDom = require('../../resume-dom');

// Reuse the import result, never recognize the same attachment again on a
// follow-up. Documents remain optional task material, not profile records.
function loadDocumentMaterials(ids, user, projectId, conversationId) {
  if (!Array.isArray(ids) || ids.length > 8 || ids.some((id) => typeof id !== 'string')) {
    throw problem.badRequest('每条消息最多添加 8 个文件');
  }
  return [...new Set(ids)].map((id) => {
    const row = db.get(`SELECT d.*, u.original_name, u.chat_conversation_id
      FROM document_imports d JOIN uploads u ON u.id = d.upload_id
      WHERE d.id = ? AND d.owner_id = ? AND d.project_id = ?`, [id, user.id, projectId]);
    if (!row) throw problem.notFound('补充文件不存在或属于另一份简历');
    if (row.chat_conversation_id && row.chat_conversation_id !== conversationId) {
      throw problem.badRequest('文件属于另一段对话，请重新上传');
    }
    const quality = JSON.parse(row.quality_report || '{}');
    if (!['ready', 'needs_review', 'applied'].includes(row.status) || quality.safe_to_review === false) {
      throw problem.conflict('MATERIAL_NOT_READY', '文件尚未识别成功，请查看附件状态后重试');
    }
    const candidate = JSON.parse(row.content_candidate || '{}');
    if (!candidate.resume_json) throw problem.badRequest('文件中没有可用的识别内容');
    return { id, file_name: row.original_name, warnings: JSON.parse(row.warning_codes || '[]'),
      document: ResumeDom.toAiContextDocument(candidate.resume_json, { includePresentation: true }) };
  });
}

function conversationMaterials(conversationId, user, projectId, taskId) {
  if (!taskId) throw new Error('读取聊天材料必须指定当前任务');
  const rows = db.all(`SELECT model_metadata_json FROM ai_messages
    WHERE conversation_id = ? AND owner_id = ? AND role = 'user'
      AND (task_id = ? OR (task_id IS NULL AND json_valid(model_metadata_json)
        AND json_extract(model_metadata_json, '$.task_id') = ?))
    ORDER BY created_at, id`,
  [conversationId, user.id, taskId, taskId]);
  const documentIds = new Set();
  const links = new Map();
  for (const row of rows) {
    const meta = JSON.parse(row.model_metadata_json || '{}');
    for (const id of meta.document_import_ids || []) documentIds.add(id);
    for (const item of meta.link_materials || []) links.set(item.url, item);
  }
  const homeIntake = require('./home-materials').taskHomeMaterials(conversationId, taskId, user, projectId);
  return {
    documents: [...documentIds].flatMap((id) => loadDocumentMaterials([id], user, projectId, conversationId))
      .map((item) => ({ ...item, ...(homeIntake ? { material_role: Object.entries(homeIntake.roles)
        .find(([, value]) => value.document_import_id === item.id)?.[0] || 'supplement' } : {}) })),
    links: [...links.values()],
    ...(homeIntake ? { home_intake: homeIntake } : {}),
  };
}

module.exports = { loadDocumentMaterials, conversationMaterials };
