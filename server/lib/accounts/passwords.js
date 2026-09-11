'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { problem } = require('../util');
const scrypt = promisify(crypto.scrypt);
const PARAMETERS = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const COMMON = new Set(['passwordpassword', '123456789012345', '1234567890123456',
  'password123456789', 'qwertyuiopasdfgh', 'administrator', 'adminadminadminadmin',
  'thisisapassword', 'correcthorsebatterystaple']);
let running = 0;
const pending = [];

/** Bound the memory-intensive work and its queue, including unknown accounts. */
async function derive(password, salt) {
  if (running >= 2) {
    if (pending.length >= 8) throw problem.tooMany('登录请求较多，请稍后重试');
    await new Promise((resolve, reject) => {
      const item = { resolve, reject, timer: null };
      item.timer = setTimeout(() => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(problem.tooMany('登录请求较多，请稍后重试'));
      }, 10_000);
      item.timer.unref?.();
      pending.push(item);
    });
  } else running += 1;
  try { return await scrypt(password, salt, 32, PARAMETERS); }
  finally {
    const next = pending.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else running -= 1;
  }
}

function normalizedPassword(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return null;
  return value.normalize('NFC');
}
function assertNewPassword(value, username = '') {
  const password = normalizedPassword(value);
  const count = password === null ? 0 : Array.from(password).length;
  if (count < 15 || count > 128) {
    throw problem.badRequest('密码请使用 15–128 个字符，可以是一句容易记住的话');
  }
  const normalized = password.toLowerCase();
  if (COMMON.has(normalized) || /^(.)\1+$/u.test(password)
    || (username && normalized === username.toLowerCase())) {
    throw problem.badRequest('这个密码过于常见，请换一个更难猜到的密码');
  }
  return password;
}

async function hashPassword(value, { allowBootstrap = false } = {}) {
  const password = allowBootstrap ? normalizedPassword(value) : assertNewPassword(value);
  if (password === null) throw problem.badRequest('密码格式不正确');
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$v1$131072$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function verifyPassword(value, encoded) {
  const password = normalizedPassword(value);
  const match = typeof encoded === 'string'
    && /^scrypt\$v1\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(encoded);
  // Unknown/disabled identities pay the same KDF cost; no user existence signal.
  const salt = match ? Buffer.from(match[1], 'base64url') : Buffer.alloc(16, 0x6a);
  const expected = match ? Buffer.from(match[2], 'base64url') : Buffer.alloc(32);
  const actual = await derive(password === null ? '' : password, salt);
  return Boolean(password !== null && match && crypto.timingSafeEqual(actual, expected));
}

function normalizeUsername(value) {
  if (typeof value !== 'string') throw problem.badRequest('请输入用户名');
  const username = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,31}$/.test(username)) {
    throw problem.badRequest('用户名使用 3–32 位英文字母、数字、短横线或下划线，以字母开头');
  }
  return username;
}

module.exports = { hashPassword, verifyPassword, assertNewPassword, normalizeUsername };
