'use strict';

const db = require('./db');
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MATERIAL_ROLES = ['personal', 'job', 'layout'];

// Display projection only: never mutate model attachment IDs or rebuild material
// context from the current intake (which may have changed since this message).
function messageAttachments(row, metadata) {
  const attachments = [];
  const shownUploads = new Set();
  const shownImports = new Set();
  function append(upload, extra = {}) {
    if (!upload || shownUploads.has(upload.id)) return;
    shownUploads.add(upload.id);
    attachments.push({ id: upload.id, file_name: upload.original_name,
      preview_url: `/api/v1/uploads/${upload.id}/preview`, ...extra });
  }
  for (const id of Array.isArray(metadata.attachment_ids) ? metadata.attachment_ids : []) {
    append(db.get('SELECT id, original_name FROM uploads WHERE id=? AND owner_id=?', [id, row.owner_id]));
  }
  const frozen = metadata.home_materials;
  const intake = frozen && db.get(`SELECT h.project_id FROM home_intakes h
    JOIN ai_conversations c ON c.project_id=h.project_id AND c.owner_id=h.owner_id
    WHERE h.id=? AND h.owner_id=? AND c.id=?`,
  [frozen.intake_id, row.owner_id, row.conversation_id]);
  if (row.role === 'user' && intake) {
    for (const role of MATERIAL_ROLES) {
      const material = frozen.roles?.[role];
      if (!material || !material.upload_id) continue;
      const upload = db.get(`SELECT id, original_name, mime_type FROM uploads
        WHERE id=? AND owner_id=? AND status='ready'`, [material.upload_id, row.owner_id]);
      if (!upload || !IMAGE_TYPES.has(upload.mime_type)) continue;
      if (material.kind === 'image') {
        const asset = db.get('SELECT id FROM document_assets WHERE id=? AND owner_id=?',
          [material.asset_id, row.owner_id]);
        if (asset) append(upload, { material_role: role,
          preview_url: `/api/v1/document-assets/${asset.id}/content` });
      } else if (material.document_import_id) {
        // Older homepage screenshots went through document recognition. Keep
        // their existing task metadata and show the original image, not just a
        // generic filename chip; Word/PDF remain document attachments.
        const imported = db.get(`SELECT id FROM document_imports
          WHERE id=? AND upload_id=? AND owner_id=? AND project_id=?`,
        [material.document_import_id, upload.id, row.owner_id, intake.project_id]);
        if (imported) {
          append(upload, { material_role: role });
          shownImports.add(imported.id);
        }
      }
    }
  }
  const documents = (Array.isArray(metadata.document_import_ids) ? metadata.document_import_ids : [])
    .filter(id => !shownImports.has(id)).flatMap(id => {
      const item = db.get(`SELECT d.id, u.original_name FROM document_imports d
        JOIN uploads u ON u.id=d.upload_id AND u.owner_id=d.owner_id
        WHERE d.id=? AND d.owner_id=?`, [id, row.owner_id]);
      return item ? [{ id: item.id, file_name: item.original_name }] : [];
    });
  return { attachments, documents };
}

module.exports = { messageAttachments };
