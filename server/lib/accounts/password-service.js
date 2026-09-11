'use strict';

const { problem } = require('../util');
const { requireEnabled } = require('./config');
const { sqliteAccountRepository } = require('./repository');
const { createAccountService } = require('./service');
const { hashPassword, verifyPassword, assertNewPassword, normalizeUsername } = require('./passwords');

const FAILED = '登录未完成，请检查用户名和密码后重试';

function createPasswordAccounts({ database, config, clock = Date.now }) {
  const repository = sqliteAccountRepository(database);
  const credential = (username) => database.prepare(
    `SELECT c.*,COALESCE(m.auth_revision,0) AS auth_revision FROM account_password_credentials c
      LEFT JOIN account_metadata m ON m.user_id=c.user_id WHERE c.username = ?`).get(username);
  const byUser = (userId) => database.prepare(
    'SELECT * FROM account_password_credentials WHERE user_id = ?').get(userId);
  const passwordAdapter = {
    async verify(proof) {
      let username = '';
      try { username = normalizeUsername(proof && proof.username); } catch (_) { /* same KDF */ }
      const row = username && credential(username);
      const valid = await verifyPassword(proof && proof.password, row && row.password_hash);
      if (!valid || row.must_change_password) throw problem.unauthorized(FAILED);
      return { verified: true, subject: row.username, credentialVersion: row.password_hash, authRevision: row.auth_revision };
    },
    revalidate(identity) {
      const row = credential(identity.subject);
      return Boolean(row && !row.must_change_password && row.password_hash === identity.credentialVersion
        && row.auth_revision === identity.authRevision);
    },
  };
  const sessions = createAccountService({ repository, config, adapters: { password: passwordAdapter }, clock });
  const view = (result) => {
    const row = byUser(result.user.id);
    const metadata = repository.metadata(result.user.id);
    return { ...result, authenticated: true, user: { ...result.user, username: row && row.username,
      role: metadata ? metadata.role : 'user' } };
  };
  function limit(bucket, scope) {
    if (typeof bucket !== 'string' || !/^[a-f0-9]{64}$/.test(bucket)) {
      throw new TypeError('账号写操作必须提供服务端限流身份');
    }
    const result = repository.consumeRate(bucket, { limit: scope === 'register' ? 5 : 10,
      windowMs: 5 * 60_000, now: clock() });
    if (!result.allowed) throw problem.tooMany('操作频繁，请稍后重试');
  }
  async function login(body, { startBucket, finishBucket }) {
    const challenge = sessions.beginLogin('password', { rateBucket: startBucket });
    const result = await sessions.completeLogin('password', body, {
      challengeToken: challenge.challenge_token,
      browserBinding: challenge.browser_binding,
      rateBucket: finishBucket,
    });
    return view(result);
  }
  return {
    sessions, repository, config: sessions.config,
    resolve: (token, options) => view(sessions.resolve(token, options)),
    login,
    async register(body, { registerBucket, startBucket, finishBucket }) {
      requireEnabled(sessions.config);
      if (sessions.config.registration !== 'open') throw problem.forbidden('当前暂未开放注册');
      limit(registerBucket, 'register');
      const username = normalizeUsername(body && body.username);
      assertNewPassword(body && body.password, username);
      // Hash even reserved/duplicate names: don't create a cheap timing oracle.
      const encoded = await hashPassword(body.password);
      const result = repository.transaction(() => {
        if (username === 'admin' || credential(username)
          || repository.identity('password', username)) return null;
        return sessions.registerAccount('password', { subject: username, displayName: username }, (created, now) => {
          database.prepare(`INSERT INTO account_password_credentials
            (user_id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)`)
            .run(created.id, username, encoded, now, now);
        });
      });
      if (!result) throw problem.badRequest('无法创建账号，请尝试其他用户名或直接登录');
      return view(result);
    },
    async changePassword(token, body, { rateBucket }) {
      limit(rateBucket, 'password');
      const current = sessions.resolve(token);
      const previous = byUser(current.user.id);
      if (!previous || !await verifyPassword(body && body.current_password, previous.password_hash)) {
        throw problem.unprocessable('PASSWORD_INCORRECT', '当前密码不正确，请重新输入');
      }
      const next = assertNewPassword(body && body.new_password, previous.username);
      if (await verifyPassword(next, previous.password_hash)) {
        throw problem.badRequest('新密码不能与当前密码相同');
      }
      const encoded = await hashPassword(next);
      return repository.transaction(() => {
        const latest = byUser(current.user.id);
        if (!latest || latest.password_hash !== previous.password_hash) {
          throw problem.conflict('ACCOUNT_CHANGED', '密码已被修改，请重新登录');
        }
        // Revalidate the session after both expensive password operations.
        sessions.resolve(token, { touch: false });
        const now = clock();
        database.prepare(`UPDATE account_password_credentials SET password_hash = ?,
          must_change_password = 0, updated_at = ? WHERE user_id = ?`).run(encoded, now, current.user.id);
        const result = sessions.rotateSession(token);
        database.prepare(`UPDATE account_sessions SET authenticated_at = ? WHERE id = ?`)
          .run(now, result.session.id);
        database.prepare(`UPDATE account_sessions SET revoked_at = ?, revoke_reason = 'password_changed'
          WHERE user_id = ? AND id <> ? AND revoked_at IS NULL`).run(now, current.user.id, result.session.id);
        return view(result);
      });
    },
  };
}

module.exports = { createPasswordAccounts };
