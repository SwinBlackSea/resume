'use strict';
const sharp = require('sharp');
const db = require('./db');
const { getObject, removeObject } = require('./storage');
const { problem } = require('./util');
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGES = 8;

function imageUpload(id, user, conversationId) {
  const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [id, user.id]);
  if (!upload) throw problem.notFound('图片不存在');
  if (upload.status !== 'ready') throw problem.badRequest('图片尚未上传完成');
  if (!IMAGE_TYPES.has(upload.mime_type)) throw problem.badRequest('聊天图片支持 PNG、JPG 和 WEBP');
  if (upload.chat_conversation_id && upload.chat_conversation_id !== conversationId) {
    throw problem.badRequest('图片属于另一段对话，请重新上传');
  }
  return upload;
}

async function loadChatImages(ids, user, conversationId) {
  if (!Array.isArray(ids) || ids.length > MAX_IMAGES || ids.some((id) => typeof id !== 'string')) {
    throw problem.badRequest(`每条消息最多附带 ${MAX_IMAGES} 张图片`);
  }
  return Promise.all([...new Set(ids)].map(async (id) => {
    const upload = imageUpload(id, user, conversationId);
    let image;
    try {
      const assets = require('./document-assets');
      const candidates = await assets.prepareUploadImages(id, { ownerId: user.id, conversationId });
      image = await assets.modelImage(candidates[0], user.id);
    } catch (_) {
      throw problem.badRequest('图片无法读取或分辨率过大，请重新导出为 PNG、JPG 或 WEBP');
    }
    return { ...image, id, file_name: upload.original_name };
  }));
}

function isReferenced(id) {
  return db.get(`SELECT m.id FROM ai_messages m, json_each(m.model_metadata_json, '$.attachment_ids') j
    WHERE j.value = ? LIMIT 1`, [id])
    || db.get(`SELECT h.id FROM home_intakes h, json_each(h.state_json) role
      WHERE json_extract(role.value,'$.upload_id')=? LIMIT 1`, [id])
    || db.get(`SELECT m.id FROM ai_messages m, json_each(m.model_metadata_json,'$.home_materials.roles') role
      WHERE json_extract(role.value,'$.upload_id')=? LIMIT 1`, [id])
    || db.get('SELECT id FROM job_files WHERE upload_id = ?', [id])
    || db.get('SELECT id FROM document_imports WHERE upload_id = ?', [id])
    || db.get('SELECT id FROM template_definitions WHERE template_upload_id = ?', [id]);
}

function releaseClosedChatImages(ownerId) {
  // Run after the conversation transaction commits, never unlink a file that
  // could be referenced again by a rollback. Failed deletion leaves a retryable row.
  const rows = db.all(`SELECT u.* FROM uploads u WHERE u.owner_id = ?
    AND u.chat_conversation_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM ai_conversations c WHERE c.id = u.chat_conversation_id AND c.status = 'active')`, [ownerId]);
  for (const upload of rows) {
    if (isReferenced(upload.id)) continue;
    try {
      // An applied document/history may still use the exact original object.
      // Removing chat ownership must not unlink that immutable document image.
      if (!db.get('SELECT id FROM document_assets WHERE object_key = ?', [upload.object_key])) {
        removeObject(upload.object_key);
      }
      db.run('DELETE FROM uploads WHERE id = ?', [upload.id]);
    } catch (_) { /* retain metadata for the next cleanup attempt */ }
  }
  require('./document-assets').collectUnusedAssets(ownerId, { graceMs: 0 });
}
module.exports = { loadChatImages, imageUpload, isReferenced, releaseClosedChatImages, MAX_IMAGES };
