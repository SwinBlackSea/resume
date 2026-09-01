'use strict';
/**
 * 审计日志（TECH §5.1 AuditModule、§9.6）。
 * 每次确认、拒绝、应用和撤销均记录来源消息、操作者、时间和前后值。
 * 日志不记录简历正文、OCR 全文、音频和签名 URL。
 */
const db = require('./db');
const { uuidv7, nowIso } = require('./util');

function log({ ownerId, actorId, action, resourceType = '', resourceId = '', requestId = '', ipHash = '', metadata = {} }) {
  db.run(
    `INSERT INTO audit_logs (id, owner_id, actor_id, action, resource_type, resource_id, request_id, ip_hash, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv7(),
      ownerId || null,
      actorId || ownerId || null,
      action,
      resourceType,
      resourceId,
      requestId,
      ipHash,
      JSON.stringify(metadata),
      nowIso(),
    ],
  );
}

module.exports = { log };
