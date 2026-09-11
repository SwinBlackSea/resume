'use strict';

// Additive only: users.id remains the permanent business owner. No inferred
// email matching, data reassignment, seed data or existing-table ALTERs.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(provider, subject)
);
CREATE INDEX IF NOT EXISTS ix_account_identities_user ON account_identities(user_id);
CREATE TABLE IF NOT EXISTS account_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS ix_account_sessions_user ON account_sessions(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_account_sessions_expiry ON account_sessions(absolute_expires_at);
CREATE TABLE IF NOT EXISTS account_challenges (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  binding_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_account_challenges_expiry ON account_challenges(expires_at);
CREATE TABLE IF NOT EXISTS account_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  requests INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_account_rate_limits_expiry ON account_rate_limits(expires_at);
CREATE TABLE IF NOT EXISTS account_security_events (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_account_security_events_time ON account_security_events(created_at);
CREATE TABLE IF NOT EXISTS account_metadata (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','superadmin')),
  last_login_at INTEGER,
  auth_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_admin_actions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_account_admin_actions_time ON account_admin_actions(created_at);
`;

/** Caller explicitly supplies a database. Importing this module never opens one. */
function migrateAccounts(database, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('迁移时间不合法');
  database.exec('SAVEPOINT account_schema_migration');
  try {
    database.exec(SCHEMA);
    const latest = database.prepare('SELECT MAX(version) AS version FROM account_schema_versions').get();
    if (latest.version > 2) throw new Error('账号数据库版本高于当前代码，拒绝降级运行');
    database.prepare('INSERT OR IGNORE INTO account_schema_versions(version, applied_at) VALUES (1, ?)')
      .run(now);
    if (latest.version < 2 || latest.version === null) {
      database.exec(`INSERT OR IGNORE INTO account_metadata(user_id,role,last_login_at)
        SELECT c.user_id,CASE WHEN c.username='admin' AND EXISTS (
          SELECT 1 FROM account_identities i WHERE i.user_id=c.user_id
          AND i.provider='password' AND i.subject='admin') THEN 'superadmin' ELSE 'user' END,
          (SELECT MAX(e.created_at) FROM account_security_events e
            WHERE e.user_id=c.user_id AND e.event_type='login_success')
        FROM account_password_credentials c`);
      database.prepare('INSERT INTO account_schema_versions(version,applied_at) VALUES(2,?)').run(now);
    }
    database.exec('RELEASE SAVEPOINT account_schema_migration');
  } catch (error) {
    database.exec('ROLLBACK TO SAVEPOINT account_schema_migration');
    database.exec('RELEASE SAVEPOINT account_schema_migration');
    throw error;
  }
}

module.exports = { migrateAccounts };
