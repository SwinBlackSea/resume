'use strict';
/**
 * 认证与授权（TECH §12）。
 * MVP 为个人账号模式：用户只能访问自己的项目、文件、模板、草稿和版本。
 * 所有资源查询同时校验 owner_id，禁止只凭 UUID；跨用户访问返回 404。
 */
const db = require('./db');
const { problem, sha256 } = require('./util');

const DEMO_EMAIL = 'demo@resume-planet.local';

/** 解析当前操作者。生产替换为会话 / JWT 校验。 */
function resolveUser(req) {
  const wanted = req.headers['x-user-id'];
  if (wanted) {
    const user = db.get('SELECT * FROM users WHERE id = ? AND status = ?', [wanted, 'active']);
    if (!user) throw problem.unauthorized('用户不存在或已停用');
    return user;
  }
  const demo = db.get('SELECT * FROM users WHERE email = ?', [DEMO_EMAIL]);
  if (!demo) throw problem.serverError('演示账号未初始化');
  return demo;
}

/** 资源归属校验：不属于当前用户一律 404，避免资源枚举。 */
function assertOwner(resource, user, label = '资源') {
  if (!resource) throw problem.notFound(`${label}不存在`);
  if (resource.owner_id !== user.id) throw problem.notFound(`${label}不存在`);
  return resource;
}

/** 按 id 加载资源并校验归属。 */
function loadOwned(table, id, user, label = '资源') {
  return assertOwner(db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]), user, label);
}

/** 请求指纹：日志不记录简历正文，IP 只保留哈希。 */
function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  return sha256(ip).slice(0, 16);
}

module.exports = { resolveUser, assertOwner, loadOwned, ipHash, DEMO_EMAIL };
