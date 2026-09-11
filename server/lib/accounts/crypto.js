'use strict';

const crypto = require('node:crypto');

function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function validToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
function hashToken(value) {
  if (!validToken(value)) throw new TypeError('账号令牌格式不合法');
  return crypto.createHash('sha256').update(value).digest('hex');
}
function csrfToken(sessionToken) {
  if (!validToken(sessionToken)) throw new TypeError('账号令牌格式不合法');
  return crypto.createHash('sha256').update(`resume-csrf-v1:${sessionToken}`).digest('base64url');
}
function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string'
    || actual.length !== expected.length) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** The caller resolves the trusted peer. Never trust arbitrary forwarded headers. */
function privacyBucket(secret, scope, value) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new TypeError('限流哈希密钥至少需要 32 字节');
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(scope) || typeof value !== 'string' || value.length > 4096) {
    throw new TypeError('限流范围不合法');
  }
  return crypto.createHmac('sha256', secret).update(JSON.stringify([scope, value])).digest('hex');
}

module.exports = { randomToken, validToken, hashToken, csrfToken, equalSecret, privacyBucket };
