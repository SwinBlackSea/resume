'use strict';

const { uuidv7, problem } = require('../util');
const { migrateAccounts } = require('./schema');
const { sqliteAccountRepository } = require('./repository');
const { hashPassword, assertNewPassword, normalizeUsername } = require('./passwords');

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}
function inspectLegacyOwner(database, ownerId) {
  const rows = ownerId
    ? database.prepare('SELECT id,status,email FROM users WHERE id=?').all(ownerId)
    : database.prepare("SELECT id,status,email FROM users WHERE email='demo@resume-planet.local'").all();
  if (rows.length !== 1 || rows[0].status !== 'active') {
    throw new Error('旧共享账号无法唯一确认，请明确核实 owner-id；未修改任何资料');
  }
  const owner = rows[0];
  const existing = hasTable(database, 'account_password_credentials')
    && database.prepare("SELECT user_id,must_change_password FROM account_password_credentials WHERE username='admin'").get();
  if (existing && existing.user_id !== owner.id) throw new Error('admin 已属于其他账号，禁止自动合并资料');
  const counts = {};
  for (const table of ['resume_projects', 'resume_drafts', 'resume_versions', 'uploads', 'document_assets']) {
    if (hasTable(database, table)) {
      counts[table] = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_id=?`).get(owner.id).count;
    }
  }
  return { owner_id: owner.id, initialized: Boolean(existing),
    must_change_password: existing ? Boolean(existing.must_change_password) : true, retained: counts };
}

/**
 * admin/admin exists only as a disabled bootstrap credential. HTTP login rejects
 * must_change_password before issuing a session, even when the password matches.
 */
async function bootstrapLegacyAdmin(database, { ownerId, apply = false, now = Date.now() } = {}) {
  const inspection = inspectLegacyOwner(database, ownerId);
  if (!apply || inspection.initialized) return { ...inspection, applied: false };
  const passwordHash = await hashPassword('admin', { allowBootstrap: true });
  const repo = sqliteAccountRepository(database);
  return repo.transaction(() => {
    migrateAccounts(database, now);
    const checked = inspectLegacyOwner(database, inspection.owner_id);
    if (checked.initialized) return { ...checked, applied: false };
    if (repo.identity('password', 'admin')) throw new Error('admin 身份已存在，请先人工核实');
    database.prepare('INSERT INTO account_identities(id,user_id,provider,subject,created_at) VALUES(?,?,?,?,?)')
      .run(uuidv7(), inspection.owner_id, 'password', 'admin', now);
    database.prepare(`INSERT INTO account_password_credentials
      (user_id,username,password_hash,must_change_password,created_at,updated_at) VALUES(?,'admin',?,1,?,?)`)
      .run(inspection.owner_id, passwordHash, now, now);
    database.prepare("INSERT INTO account_metadata(user_id,role) VALUES(?,'superadmin')").run(inspection.owner_id);
    return { ...inspection, initialized: true, must_change_password: true, applied: true };
  });
}

async function resetPassword(database, { username, password, apply = false, now = Date.now() }) {
  username = normalizeUsername(username);
  const row = database.prepare('SELECT user_id FROM account_password_credentials WHERE username=?').get(username);
  if (!row) throw new Error('账号不存在；未创建或认领任何资料');
  assertNewPassword(password, username);
  if (!apply) return { user_id: row.user_id, applied: false };
  const encoded = await hashPassword(password);
  const repo = sqliteAccountRepository(database);
  return repo.transaction(() => {
    const active = repo.user(row.user_id);
    if (!active || active.status !== 'active') throw problem.forbidden('账号不可用，请先核实账号状态');
    database.prepare(`UPDATE account_password_credentials SET password_hash=?,must_change_password=0,updated_at=?
      WHERE user_id=?`).run(encoded, now, row.user_id);
    repo.revokeAll(row.user_id, now, 'operator_password_reset');
    // Credentials are also fenced by the post-verification hash check.
    repo.event('password_reset', row.user_id, now);
    return { user_id: row.user_id, applied: true, all_sessions_revoked: true };
  });
}

module.exports = { inspectLegacyOwner, bootstrapLegacyAdmin, resetPassword };
