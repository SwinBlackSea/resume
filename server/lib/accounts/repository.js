'use strict';

const { uuidv7 } = require('../util');

/** Synchronous storage port. It never imports the application database module. */
function sqliteAccountRepository(database) {
  if (!database.prepare('PRAGMA foreign_keys').get().foreign_keys) {
    throw new Error('账号数据库必须启用 foreign_keys');
  }
  let depth = 0;
  const get = (sql, args = []) => database.prepare(sql).get(...args) || null;
  const run = (sql, args = []) => database.prepare(sql).run(...args);
  const all = (sql, args = []) => database.prepare(sql).all(...args);
  const transaction = (fn) => {
    const savepoint = `account_write_${depth++}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new TypeError('账号数据库事务不可跨越异步操作');
      }
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally { depth -= 1; }
  };
  return {
    transaction,
    user: (id) => get('SELECT id, email, display_name, status FROM users WHERE id = ?', [id]),
    metadata: (id) => get('SELECT role,last_login_at,auth_revision FROM account_metadata WHERE user_id=?', [id]),
    identity: (provider, subject) => get(
      'SELECT * FROM account_identities WHERE provider = ? AND subject = ?', [provider, subject]),
    /** Internal provisioning port, not a public user-id claim endpoint. */
    createUserAndIdentity({ provider, subject, displayName, now }) {
      return transaction(() => {
        const userId = uuidv7();
        const timestamp = new Date(now).toISOString();
        run(`INSERT INTO users(id,email,phone,display_name,status,created_at,updated_at)
          VALUES (?,NULL,NULL,?,'active',?,?)`, [userId, displayName, timestamp, timestamp]);
        run('INSERT INTO account_identities(id,user_id,provider,subject,created_at) VALUES (?,?,?,?,?)',
          [uuidv7(), userId, provider, subject, now]);
        return this.user(userId);
      });
    },
    insertSession(row) {
      run(`INSERT INTO account_sessions
        (id,user_id,token_hash,provider,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [row.id, row.user_id, row.token_hash, row.provider,
        row.authenticated_at, row.created_at, row.last_seen_at, row.idle_expires_at, row.absolute_expires_at]);
    },
    clampSessionExpiry: (id, expiry) => run(`UPDATE account_sessions
      SET absolute_expires_at = MIN(absolute_expires_at, ?), idle_expires_at = MIN(idle_expires_at, ?)
      WHERE id = ?`, [expiry, expiry, id]),
    sessionByHash: (hash) => get('SELECT * FROM account_sessions WHERE token_hash = ?', [hash]),
    session: (id, userId) => get('SELECT * FROM account_sessions WHERE id = ? AND user_id = ?', [id, userId]),
    activeSessions: (userId, now) => all(`SELECT * FROM account_sessions WHERE user_id = ?
      AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?
      ORDER BY created_at DESC, id DESC`, [userId, now, now]),
    touchSession: (id, now, idleExpires) => run(`UPDATE account_sessions SET last_seen_at = ?, idle_expires_at = ?
      WHERE id = ? AND revoked_at IS NULL AND idle_expires_at > ? AND absolute_expires_at > ?`,
    [now, idleExpires, id, now, now]).changes,
    revokeSession: (id, userId, now, reason) => run(`UPDATE account_sessions SET revoked_at = ?, revoke_reason = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, [now, reason, id, userId]).changes,
    revokeAll: (userId, now, reason) => run(`UPDATE account_sessions SET revoked_at = ?, revoke_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL`, [now, reason, userId]).changes,
    insertChallenge(row) {
      run(`INSERT INTO account_challenges
        (id,token_hash,binding_hash,provider,purpose,created_at,expires_at,max_attempts)
        VALUES (?,?,?,?,?,?,?,?)`, [row.id, row.token_hash, row.binding_hash,
        row.provider, row.purpose, row.created_at, row.expires_at, row.max_attempts]);
    },
    challenge: (hash) => get('SELECT * FROM account_challenges WHERE token_hash = ?', [hash]),
    attemptChallenge: (id, now) => run(`UPDATE account_challenges SET attempts = attempts + 1
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < max_attempts`,
    [id, now]).changes,
    consumeChallenge: (id, now) => run(`UPDATE account_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts <= max_attempts`,
    [now, id, now]).changes,
    consumeRate(bucketHash, { limit, windowMs, now }) {
      return transaction(() => {
        run(`INSERT INTO account_rate_limits(bucket_hash,window_start,expires_at,requests)
          VALUES (?,?,?,1) ON CONFLICT(bucket_hash) DO UPDATE SET
          window_start = CASE WHEN expires_at <= excluded.window_start THEN excluded.window_start ELSE window_start END,
          requests = CASE WHEN expires_at <= excluded.window_start THEN 1 ELSE MIN(requests + 1, 2147483647) END,
          expires_at = CASE WHEN expires_at <= excluded.window_start THEN excluded.expires_at ELSE expires_at END`,
        [bucketHash, now, now + windowMs]);
        const row = get('SELECT requests,expires_at FROM account_rate_limits WHERE bucket_hash = ?', [bucketHash]);
        return { allowed: row.requests <= limit, retryAfterMs: Math.max(0, row.expires_at - now) };
      });
    },
    event(type, userId, now) {
      const allowed = ['login_success', 'login_failed', 'session_revoked', 'sessions_revoked', 'session_rotated', 'password_reset'];
      if (!allowed.includes(type)) throw new TypeError('未知账号审计事件');
      run('INSERT INTO account_security_events(id,user_id,event_type,created_at) VALUES (?,?,?,?)',
        [uuidv7(), userId || null, type, now]);
      if (type === 'login_success' && userId) {
        run(`INSERT INTO account_metadata(user_id,last_login_at) VALUES(?,?)
          ON CONFLICT(user_id) DO UPDATE SET last_login_at=MAX(COALESCE(last_login_at,0),excluded.last_login_at)`,
        [userId, now]);
      }
    },
    /** Bounded batches, no business data, no active-session or identity deletion. */
    cleanup({ now, retentionMs, batchSize = 250 }) {
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(retentionMs) || retentionMs < 0
        || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new TypeError('账号清理参数不合法');
      }
      return transaction(() => ({
        adminActions: run(`DELETE FROM account_admin_actions WHERE id IN
          (SELECT id FROM account_admin_actions WHERE created_at <= ? LIMIT ?)`,
        [now - retentionMs, batchSize]).changes,
        challenges: run(`DELETE FROM account_challenges WHERE id IN
          (SELECT id FROM account_challenges WHERE expires_at <= ? LIMIT ?)`, [now, batchSize]).changes,
        rateLimits: run(`DELETE FROM account_rate_limits WHERE bucket_hash IN
          (SELECT bucket_hash FROM account_rate_limits WHERE expires_at <= ? LIMIT ?)`, [now, batchSize]).changes,
        sessions: run(`DELETE FROM account_sessions WHERE id IN
          (SELECT id FROM account_sessions WHERE
          (revoked_at IS NOT NULL AND revoked_at <= ?) OR absolute_expires_at <= ? OR idle_expires_at <= ?
          LIMIT ?)`, [now - retentionMs, now - retentionMs, now - retentionMs, batchSize]).changes,
        events: run(`DELETE FROM account_security_events WHERE id IN
          (SELECT id FROM account_security_events WHERE created_at <= ? LIMIT ?)`,
        [now - retentionMs, batchSize]).changes,
      }));
    },
  };
}

module.exports = { sqliteAccountRepository };
