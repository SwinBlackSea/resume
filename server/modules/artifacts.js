'use strict';
/**
 * 产物下载（TECH §11.3、§12）。
 * 下载响应强制 attachment 与安全文件名；下载 URL 最长 5 分钟；授权以数据库为准。
 */
const db = require('../lib/db');
const { sha256, problem } = require('../lib/util');
const { getObject } = require('../lib/storage');
const audit = require('../lib/audit');

const URL_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_SECRET = process.env.RESUME_DOWNLOAD_SECRET || 'resume-planet-local-secret';

/** 生成短期下载令牌（不暴露对象存储地址）。 */
function signToken(artifactId, expiresAt) {
  return sha256(`${artifactId}:${expiresAt}:${DOWNLOAD_SECRET}`).slice(0, 32);
}

const MIME_EXTENSION = {
  pdf: 'pdf',
  docx: 'docx',
  html: 'html',
  thumbnail: 'png',
};

function safeFileName(versionName, type) {
  const cleaned = String(versionName || '简历').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
  const extension = String(type || '').startsWith('import_')
    ? 'png'
    : MIME_EXTENSION[type] || type;
  return `${cleaned}.${extension}`;
}

const routes = [
  {
    method: 'GET',
    pattern: '/artifacts',
    handler: ({ user, query }) => {
      const versionId = query.get('version_id');
      const snapshotId = query.get('snapshot_id');
      const rows = versionId
        ? db.all('SELECT * FROM artifacts WHERE version_id = ? AND owner_id = ?', [versionId, user.id])
        : snapshotId
          ? db.all('SELECT * FROM artifacts WHERE snapshot_id = ? AND owner_id = ?', [snapshotId, user.id])
          : [];
      return {
        items: rows.map((row) => ({
          id: row.id,
          type: row.type,
          size: row.size,
          mime_type: row.mime_type,
          status: row.status,
          created_at: row.created_at,
        })),
      };
    },
  },
  {
    method: 'POST',
    pattern: '/artifacts/:id/download-url',
    handler: ({ params, user }) => {
      const artifact = db.get('SELECT * FROM artifacts WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!artifact) throw problem.notFound('文件不存在');
      const expiresAt = Date.now() + URL_TTL_MS;
      const token = signToken(artifact.id, expiresAt);
      return {
        artifact_id: artifact.id,
        url: `/api/v1/artifacts/${artifact.id}/download?expires=${expiresAt}&token=${token}`,
        expires_in: Math.floor(URL_TTL_MS / 1000),
        type: artifact.type,
        size: artifact.size,
      };
    },
  },
  {
    method: 'GET',
    pattern: '/artifacts/:id/download',
    raw: true,
    handler: ({ params, query, user, res, requestId, ipHash }) => {
      const artifact = db.get('SELECT * FROM artifacts WHERE id = ? AND owner_id = ?', [
        params.id,
        user.id,
      ]);
      if (!artifact) throw problem.notFound('文件不存在');
      const expires = Number(query.get('expires'));
      const token = query.get('token');
      if (!expires || !token || Date.now() > expires || token !== signToken(artifact.id, expires)) {
        throw problem.forbidden('下载链接已失效，请重新获取');
      }
      const buffer = getObject(artifact.object_key);
      if (!buffer) throw problem.notFound('文件内容不存在');
      const version = artifact.version_id
        ? db.get('SELECT name FROM resume_versions WHERE id = ?', [artifact.version_id])
        : null;
      const fileName = safeFileName(version ? version.name : '简历', artifact.type);
      const inlinePreview =
        Boolean(artifact.document_import_id)
        && query.get('view') === 'inline'
        && String(artifact.mime_type || '').startsWith('image/');
      res.writeHead(200, {
        'content-type': artifact.mime_type || 'application/octet-stream',
        'content-length': buffer.length,
        'content-disposition': `${inlinePreview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(buffer);
      audit.log({
        ownerId: user.id,
        action: 'artifact_downloaded',
        resourceType: 'artifact',
        resourceId: artifact.id,
        requestId,
        ipHash,
        metadata: { type: artifact.type },
      });
      return { __handled: true };
    },
  },
];

module.exports = { routes, signToken, safeFileName };
