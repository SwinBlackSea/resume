'use strict';

const { problem } = require('../util');

function boundedInteger(value, fallback, min, max, label) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new TypeError(`账号配置 ${label} 不合法`);
  }
  return result;
}

/**
 * No environment access or deployment side effects. The composition root must
 * explicitly supply its public origin/path, policy and registered adapters.
 */
function accountConfig(input = {}) {
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new TypeError('账号配置 enabled 必须是布尔值');
  }
  const enabled = input.enabled === true;
  let publicOrigin = null;
  let secure = true;
  if (input.publicOrigin) {
    const parsed = new URL(input.publicOrigin);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || parsed.pathname !== '/' || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol !== 'https:' && !(input.allowInsecureLoopback === true && loopback))) {
      throw new TypeError('账号 publicOrigin 必须是 HTTPS 站点，不包含路径或凭据');
    }
    publicOrigin = parsed.origin;
    secure = parsed.protocol === 'https:';
  }
  if (enabled && !publicOrigin) throw new TypeError('启用账号必须配置 publicOrigin');
  let basePath = input.basePath === undefined ? '/' : input.basePath;
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(basePath)) {
    throw new TypeError('账号 basePath 必须是安全的部署路径');
  }
  if (!basePath.endsWith('/')) basePath += '/';
  const registration = input.registration === undefined ? 'closed' : input.registration;
  if (!['closed', 'open'].includes(registration)) throw new TypeError('账号注册策略尚未支持');
  const idleMs = boundedInteger(input.idleMs, 30 * 60_000, 60_000, 24 * 60 * 60_000, 'idleMs');
  const absoluteMs = boundedInteger(input.absoluteMs, 12 * 60 * 60_000,
    idleMs, 30 * 24 * 60 * 60_000, 'absoluteMs');
  return Object.freeze({
    enabled, publicOrigin, basePath, secure, registration, idleMs, absoluteMs,
    cookieName: secure ? '__Secure-resume_session' : 'resume_session_local',
    bindingCookieName: secure ? '__Secure-resume_login' : 'resume_login_local',
    challengeMs: boundedInteger(input.challengeMs, 5 * 60_000, 30_000, 15 * 60_000, 'challengeMs'),
    challengeAttempts: boundedInteger(input.challengeAttempts, 5, 1, 10, 'challengeAttempts'),
    maxSessions: boundedInteger(input.maxSessions, 10, 1, 50, 'maxSessions'),
    auditRetentionMs: boundedInteger(input.auditRetentionMs, 30 * 24 * 60 * 60_000,
      24 * 60 * 60_000, 90 * 24 * 60 * 60_000, 'auditRetentionMs'),
  });
}

function requireEnabled(config) {
  if (!config || config.enabled !== true) throw problem.unauthorized('账号登录尚未开放');
}

module.exports = { accountConfig, requireEnabled };
