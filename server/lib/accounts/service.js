'use strict';

const { uuidv7, problem } = require('../util');
const { accountConfig, requireEnabled } = require('./config');
const { randomToken, validToken, hashToken, csrfToken, equalSecret } = require('./crypto');

const loginFailed = () => problem.unauthorized('登录未完成，请检查后重试');
function publicUser(user) {
  return { id: user.id, display_name: user.display_name };
}
function publicSession(row, currentId) {
  return { id: row.id, current: row.id === currentId, provider: row.provider,
    created_at: row.created_at, last_seen_at: row.last_seen_at,
    expires_at: Math.min(row.idle_expires_at, row.absolute_expires_at) };
}

/**
 * Adapter contract: verify(proof, serverChallenge) must validate the provider's
 * complete authentication protocol and return { verified:true, subject,
 * displayName? }. Never pass client-supplied identity claims straight through.
 *
 * No adapters are bundled: choosing and implementing a real sign-in mechanism
 * is a release gate, not silently replaced with a demo or test verifier.
 */
function createAccountService({ repository: repo, config: input = {}, adapters = {}, clock = Date.now }) {
  const config = accountConfig(input);
  const registry = new Map(Object.entries(adapters));
  for (const [key, adapter] of registry) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || !adapter || typeof adapter.verify !== 'function') {
      throw new TypeError('账号身份适配器不合法');
    }
  }
  function provider(key) {
    requireEnabled(config);
    const adapter = registry.get(key);
    if (!adapter) throw loginFailed();
    return adapter;
  }
  function rate(bucket) {
    if (typeof bucket !== 'string' || !/^[a-f0-9]{64}$/.test(bucket)) {
      throw new TypeError('登录必须提供服务端生成的限流身份');
    }
    const result = repo.consumeRate(bucket, { limit: 10, windowMs: 5 * 60_000, now: clock() });
    if (!result.allowed) throw problem.tooMany('操作频繁，请稍后重试');
  }
  function issue(user, providerName, now, authenticatedAt = now) {
    const token = randomToken();
    const row = { id: uuidv7(), user_id: user.id, token_hash: hashToken(token), provider: providerName,
      authenticated_at: authenticatedAt, created_at: now, last_seen_at: now,
      idle_expires_at: now + config.idleMs, absolute_expires_at: now + config.absoluteMs };
    repo.insertSession(row);
    for (const stale of repo.activeSessions(user.id, now).filter((item) => item.id !== row.id)
      .slice(config.maxSessions - 1)) {
      repo.revokeSession(stale.id, user.id, now, 'session_limit');
    }
    return { user: publicUser(user), session: publicSession(row, row.id), token, csrf_token: csrfToken(token) };
  }
  function resolve(token, { touch = true } = {}) {
    requireEnabled(config);
    if (!validToken(token)) throw problem.unauthorized();
    return repo.transaction(() => {
      const now = clock();
      const row = repo.sessionByHash(hashToken(token));
      if (!row || row.revoked_at !== null || row.idle_expires_at <= now || row.absolute_expires_at <= now) {
        throw problem.unauthorized();
      }
      const user = repo.user(row.user_id);
      if (!user || user.status !== 'active') throw problem.unauthorized();
      if (touch) {
        const idleExpires = Math.min(now + config.idleMs, row.absolute_expires_at);
        if (!repo.touchSession(row.id, now, idleExpires)) throw problem.unauthorized();
        row.last_seen_at = now;
        row.idle_expires_at = idleExpires;
      }
      return { user: publicUser(user), session: publicSession(row, row.id), csrf_token: csrfToken(token) };
    });
  }

  return {
    config,
    providers: () => config.enabled ? [...registry.keys()] : [],
    /** Internal registration port; hash/proof preparation happens beforehand. */
    registerAccount(providerName, { subject, displayName }, persistCredential) {
      provider(providerName);
      if (config.registration !== 'open') throw problem.forbidden('当前暂未开放注册');
      if (typeof subject !== 'string' || !subject.length || subject.length > 512
        || typeof persistCredential !== 'function') throw new TypeError('账号注册参数不合法');
      return repo.transaction(() => {
        if (repo.identity(providerName, subject)) {
          throw problem.badRequest('无法创建账号，请尝试其他用户名或直接登录');
        }
        const now = clock();
        const user = repo.createUserAndIdentity({ provider: providerName, subject,
          displayName: String(displayName || '用户').slice(0, 80), now });
        const persisted = persistCredential(user, now);
        if (persisted && typeof persisted.then === 'function') throw new TypeError('凭证写入必须处于同一同步事务');
        const result = issue(user, providerName, now);
        repo.event('login_success', user.id, now);
        return result;
      });
    },
    beginLogin(providerName, { rateBucket } = {}) {
      provider(providerName);
      rate(rateBucket);
      const now = clock(), token = randomToken(), binding = randomToken(), id = uuidv7();
      repo.insertChallenge({ id, token_hash: hashToken(token), binding_hash: hashToken(binding),
        provider: providerName, purpose: 'login', created_at: now,
        expires_at: now + config.challengeMs, max_attempts: config.challengeAttempts });
      // binding must go only to an HttpOnly cookie at the HTTP boundary.
      return { challenge_token: token, browser_binding: binding, expires_at: now + config.challengeMs };
    },
    async completeLogin(providerName, proof, { challengeToken, browserBinding, rateBucket } = {}) {
      const adapter = provider(providerName);
      rate(rateBucket);
      if (!validToken(challengeToken) || !validToken(browserBinding)) throw loginFailed();
      const challenge = repo.challenge(hashToken(challengeToken));
      if (!challenge || challenge.provider !== providerName || challenge.purpose !== 'login'
        || !equalSecret(challenge.binding_hash, hashToken(browserBinding))
        || !repo.attemptChallenge(challenge.id, clock())) throw loginFailed();
      let identity;
      try {
        identity = await adapter.verify(proof, Object.freeze({
          id: challenge.id, provider: providerName, purpose: 'login', expires_at: challenge.expires_at,
        }));
      } catch (_) {
        repo.event('login_failed', null, clock());
        throw loginFailed();
      }
      if (!identity || identity.verified !== true || typeof identity.subject !== 'string'
        || !identity.subject.length || identity.subject.length > 512) {
        repo.event('login_failed', null, clock());
        throw loginFailed();
      }
      return repo.transaction(() => {
        const now = clock();
        if (!repo.consumeChallenge(challenge.id, now)) throw loginFailed();
        if (adapter.revalidate && adapter.revalidate(identity) !== true) {
          repo.event('login_failed', null, now);
          return null;
        }
        const known = repo.identity(providerName, identity.subject);
        let user = known && repo.user(known.user_id);
        if (!known && config.registration === 'open') {
          const name = typeof identity.displayName === 'string' ? identity.displayName.trim() : '';
          user = repo.createUserAndIdentity({ provider: providerName, subject: identity.subject,
            displayName: name.slice(0, 80) || '用户', now });
        }
        if (!user || user.status !== 'active') {
          // Commit challenge consumption on a denied account, preventing replay.
          repo.event('login_failed', null, now);
          return null;
        }
        const result = issue(user, providerName, now);
        repo.event('login_success', user.id, now);
        return result;
      }) || Promise.reject(loginFailed());
    },
    resolve,
    listSessions(token) {
      const current = resolve(token);
      return repo.activeSessions(current.user.id, clock())
        .map((row) => publicSession(row, current.session.id));
    },
    revokeSession(token, sessionId) {
      return repo.transaction(() => {
        const current = resolve(token);
        if (!repo.session(sessionId, current.user.id)) throw problem.notFound('登录记录不存在');
        repo.revokeSession(sessionId, current.user.id, clock(), 'user_revoked');
        repo.event('session_revoked', current.user.id, clock());
        return { ok: true, current: sessionId === current.session.id };
      });
    },
    revokeAll(token) {
      return repo.transaction(() => {
        const current = resolve(token);
        const stored = repo.session(current.session.id, current.user.id);
        if (clock() - stored.authenticated_at > 5 * 60_000) {
          throw problem.unauthorized('请重新登录后管理所有设备');
        }
        repo.revokeAll(current.user.id, clock(), 'user_revoked_all');
        repo.event('sessions_revoked', current.user.id, clock());
        return { ok: true };
      });
    },
    rotateSession(token) {
      return repo.transaction(() => {
        const current = resolve(token, { touch: false });
        const old = repo.session(current.session.id, current.user.id);
        repo.revokeSession(old.id, old.user_id, clock(), 'rotated');
        const result = issue(repo.user(old.user_id), old.provider, clock(), old.authenticated_at);
        // Rotation changes the secret, not the maximum authenticated lifetime.
        const remaining = old.absolute_expires_at;
        repo.clampSessionExpiry(result.session.id, remaining);
        result.session.expires_at = Math.min(result.session.expires_at, remaining);
        repo.event('session_rotated', old.user_id, clock());
        return result;
      });
    },
    cleanup: () => repo.cleanup({ now: clock(), retentionMs: config.auditRetentionMs }),
  };
}

module.exports = { createAccountService };
