'use strict';
const { problem, uuidv7 } = require('../util');

function createAccountManagement({ database, accounts, clock = Date.now }) {
  const repo = accounts.repository;
  function authorize(token) {
    const current = accounts.resolve(token, { touch: false });
    if (repo.metadata(current.user.id)?.role !== 'superadmin') throw problem.forbidden('仅超级管理员可管理账号');
    return current.user;
  }
  function target(id) {
    const row = database.prepare(`SELECT u.id,u.status,m.role FROM users u
      JOIN account_password_credentials c ON c.user_id=u.id
      JOIN account_metadata m ON m.user_id=u.id WHERE u.id=?`).get(id);
    if (!row) throw problem.notFound('账号不存在');
    return row;
  }
  function mutate(token, id, action, status) {
    return repo.transaction(() => {
      const actor = authorize(token), account = target(id);
      if (account.role === 'superadmin' || account.id === actor.id) {
        throw problem.forbidden('超级管理员账号请通过自己的账号设置管理');
      }
      const now = clock();
      if (status) database.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?')
        .run(status, new Date(now).toISOString(), id);
      database.prepare('UPDATE account_metadata SET auth_revision=auth_revision+1 WHERE user_id=?').run(id);
      repo.revokeAll(id, now, 'admin_' + action);
      database.prepare('INSERT INTO account_admin_actions(id,actor_id,target_id,action,created_at) VALUES(?,?,?,?,?)')
        .run(uuidv7(), actor.id, id, action, now);
      return { ok: true };
    });
  }
  return {
    list(token, { query = '', offset = 0 } = {}) {
      authorize(token);
      if (typeof query !== 'string' || query.length > 64 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
        throw problem.badRequest('账号查询条件不正确');
      }
      const filter = query.trim().toLowerCase();
      const total = database.prepare(`SELECT COUNT(*) AS n FROM account_password_credentials
        WHERE instr(username,?)>0`).get(filter).n;
      const items = database.prepare(`SELECT u.id,c.username,u.status,m.role,c.created_at,m.last_login_at
        FROM account_password_credentials c JOIN users u ON u.id=c.user_id
        JOIN account_metadata m ON m.user_id=u.id WHERE instr(c.username,?)>0
        ORDER BY CASE m.role WHEN 'superadmin' THEN 0 ELSE 1 END,c.created_at,u.id LIMIT 50 OFFSET ?`)
        .all(filter, offset);
      return { items, total, offset, limit: 50 };
    },
    setStatus(token, id, status) {
      if (!['active', 'disabled'].includes(status)) throw problem.badRequest('账号状态不正确');
      return mutate(token, id, status === 'active' ? 'enabled' : 'disabled', status);
    },
    revokeSessions: (token, id) => mutate(token, id, 'sessions_revoked'),
  };
}
module.exports = { createAccountManagement };
