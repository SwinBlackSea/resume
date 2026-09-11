'use strict';

const { problem } = require('../util');
const { csrfToken, validToken, equalSecret } = require('./crypto');

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || raw.length > 16_384) throw problem.unauthorized();
  const matches = raw.split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  // Reject duplicate path/domain cookies instead of selecting an attacker value.
  if (matches.length > 1) throw problem.unauthorized('登录状态不明确，请重新登录');
  if (!matches.length) return null;
  const token = matches[0].slice(name.length + 1);
  if (!validToken(token)) throw problem.unauthorized();
  return token;
}

function cookie(config, name, token, maxAgeSeconds) {
  if (token !== '' && !validToken(token)) throw new TypeError('账号 cookie 格式不合法');
  return `${name}=${token}; Path=${config.basePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
    + (config.secure ? '; Secure' : '');
}
function sessionCookie(config, token) {
  return cookie(config, config.cookieName, token, Math.floor(config.absoluteMs / 1000));
}
function clearSessionCookie(config) { return cookie(config, config.cookieName, '', 0); }
function loginCookie(config, token) {
  return cookie(config, config.bindingCookieName, token, Math.floor(config.challengeMs / 1000));
}
function clearLoginCookie(config) { return cookie(config, config.bindingCookieName, '', 0); }

function assertSameOrigin(req, config) {
  const headers = req.headers || {};
  if (!config.publicOrigin || headers.origin !== config.publicOrigin
    || headers['sec-fetch-site'] === 'cross-site') {
    throw problem.forbidden('请在当前站点重新操作');
  }
}

/** Apply to all unsafe requests, including raw uploads and login/logout. */
function assertCsrf(req, config, token) {
  assertSameOrigin(req, config);
  if (!validToken(token)
    || !equalSecret(req.headers['x-csrf-token'], csrfToken(token))) {
    throw problem.forbidden('页面状态已更新，请刷新后重试');
  }
}

function setPrivateHeaders(res) {
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  // Add to, rather than overwrite, any existing representation variance.
  const previous = res.getHeader('vary');
  const values = new Set(String(previous || '').split(',').map((item) => item.trim()).filter(Boolean));
  values.add('Cookie');
  res.setHeader('vary', [...values].join(', '));
}

module.exports = {
  readCookie, sessionCookie, clearSessionCookie, loginCookie, clearLoginCookie,
  assertSameOrigin, assertCsrf, setPrivateHeaders,
};
