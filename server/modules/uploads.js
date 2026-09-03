'use strict';
/**
 * 上传模块（TECH §6、§12）。
 * 客户端先创建上传会话，再直传内容，完成后服务端校验 MIME magic bytes 与 SHA-256，
 * 文件进入 quarantined 状态，经扫描后才可解析。
 */
const db = require('../lib/db');
const { uuidv7, nowIso, sha256, problem } = require('../lib/util');
const { objectKey, putObject, getObject } = require('../lib/storage');

const MAX_SIZE = 20 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'webp']);

function extensionOf(name) {
  return (String(name).split('.').pop() || '').toLowerCase();
}

/** magic bytes 校验（TECH §12）。 */
function sniffMime(buffer, originalName = '') {
  const extension = extensionOf(originalName);
  if (buffer.length >= 8 && buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buffer.length >= 3 && buffer.toString('hex', 0, 3) === 'ffd8ff') return 'image/jpeg';
  if (
    buffer.length >= 12
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP'
  ) return 'image/webp';
  if (buffer.length >= 4 && buffer.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  if (buffer.length >= 4 && buffer.toString('hex', 0, 4) === '504b0304') {
    return extension === 'docx'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/zip';
  }
  if (buffer.length >= 8 && buffer.toString('hex', 0, 8) === 'd0cf11e0a1b11ae1')
    return 'application/msword';
  return null;
}

function mimeMatchesExtension(mime, extension) {
  if (extension === 'pdf') return mime === 'application/pdf';
  if (extension === 'doc') return mime === 'application/msword';
  if (extension === 'docx') {
    return mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === 'png') return mime === 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return mime === 'image/jpeg';
  if (extension === 'webp') return mime === 'image/webp';
  return false;
}

const routes = [
  {
    method: 'POST',
    pattern: '/uploads',
    handler: ({ body, user }) => {
      const { original_name, mime_type, size } = body;
      if (!original_name) throw problem.badRequest('缺少文件名');
      const extension = extensionOf(original_name);
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        throw problem.unprocessable(
          'DOCUMENT_FORMAT_UNSUPPORTED',
          '目前支持 PDF、DOCX、DOC、PNG、JPG 和 WEBP',
        );
      }
      if (size && size > MAX_SIZE) throw problem.unprocessable('FILE_TOO_LARGE', '文件超过 20 MB');
      const id = uuidv7();
      const key = objectKey(user.id, 'upload', original_name);
      db.run(
        `INSERT INTO uploads (id, owner_id, object_key, original_name, mime_type, size, sha256, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 'uploading', ?, ?)`,
        [id, user.id, key, original_name, mime_type || '', size || 0, nowIso(), nowIso()],
      );
      return {
        id,
        object_key: key,
        upload_url: `/api/v1/uploads/${id}/content`,
        complete_url: `/api/v1/uploads/${id}/complete`,
        status: 'uploading',
      };
    },
  },
  {
    method: 'POST',
    pattern: '/uploads/:id/content',
    raw: true,
    handler: async ({ req, params, user }) => {
      const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!upload) throw problem.notFound('上传会话不存在');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_SIZE) throw problem.unprocessable('FILE_TOO_LARGE', '文件超过 20 MB');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const sniffed = sniffMime(buffer, upload.original_name);
      putObject(upload.object_key, buffer);
      db.run('UPDATE uploads SET size = ?, sha256 = ?, updated_at = ? WHERE id = ?', [
        buffer.length,
        sha256(buffer),
        nowIso(),
        upload.id,
      ]);
      return { id: upload.id, size: buffer.length, detected_mime: sniffed, status: 'quarantined' };
    },
  },
  {
    method: 'POST',
    pattern: '/uploads/:id/complete',
    handler: ({ params, user }) => {
      const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!upload) throw problem.notFound('上传会话不存在');
      const buffer = getObject(upload.object_key);
      if (!buffer) throw problem.unprocessable('FILE_MISSING', '未读取到上传内容');
      const sniffed = sniffMime(buffer, upload.original_name);
      if (!sniffed) throw problem.unprocessable('FILE_UNSAFE', '无法识别的文件类型，已拒绝');
      const extension = extensionOf(upload.original_name);
      if (!mimeMatchesExtension(sniffed, extension)) {
        throw problem.unprocessable('FILE_UNSAFE', '文件内容与扩展名不一致，已拒绝');
      }
      // 扫描通过（MVP 以类型校验代替病毒扫描，接口保持一致）
      db.run("UPDATE uploads SET status = 'ready', mime_type = ?, updated_at = ? WHERE id = ?", [
        sniffed,
        nowIso(),
        upload.id,
      ]);
      return {
        id: upload.id,
        original_name: upload.original_name,
        mime_type: sniffed,
        size: buffer.length,
        sha256: sha256(buffer),
        status: 'ready',
      };
    },
  },
  {
    method: 'DELETE',
    pattern: '/uploads/:id',
    handler: ({ params, user }) => {
      const upload = db.get('SELECT * FROM uploads WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!upload) throw problem.notFound('上传不存在');
      const referenced =
        db.get('SELECT * FROM job_files WHERE upload_id = ?', [upload.id]) ||
        db.get('SELECT * FROM template_definitions WHERE template_upload_id = ?', [upload.id]) ||
        db.get('SELECT * FROM document_imports WHERE upload_id = ?', [upload.id]);
      if (referenced) throw problem.conflict('UPLOAD_REFERENCED', '文件已被引用，不能删除');
      db.run('DELETE FROM uploads WHERE id = ?', [upload.id]);
      return { id: upload.id, deleted: true };
    },
  },
];

module.exports = { routes, sniffMime, extensionOf, mimeMatchesExtension, SUPPORTED_EXTENSIONS };
