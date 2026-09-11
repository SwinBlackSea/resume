'use strict';

const net = require('node:net');
const { createPasswordAccounts } = require('./password-service');
const { privacyBucket } = require('./crypto');
const { verifyPassword } = require('./passwords');
const { problem } = require('../util');
const { createAccountManagement } = require('./management');

function testAuthEnabled() {
  return process.env.NODE_ENV === 'test' && process.env.RESUME_TEST_AUTH === '1';
}
function peerAddress(req, trustedProxies = []) {
  const peer = String(req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!trustedProxies.includes(peer)) return peer;
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 1024) return peer;
  // Walk from the actual connection toward the client, trusting only configured
  // proxy hops. Never select an attacker-prepended leftmost X-Forwarded-For.
  const hops = forwarded.split(',').map((value) => value.trim().replace(/^::ffff:/, ''));
  if (hops.some((value) => !net.isIP(value))) return peer;
  let result = peer;
  while (hops.length && trustedProxies.includes(result)) result = hops.pop();
  return result;
}

function createAccountRuntime({ database, config, rateSecret, trustedProxies = [], clock = Date.now }) {
  if (typeof rateSecret !== 'string' || Buffer.byteLength(rateSecret) < 32) {
    throw new Error('账号必须配置至少 32 字节的独立限流哈希密钥');
  }
  if (!Array.isArray(trustedProxies) || trustedProxies.some((ip) => !net.isIP(ip))) {
    throw new Error('账号可信代理必须是明确的 IP 地址列表');
  }
  const accounts = createPasswordAccounts({ database, config, clock });
  return {
    ...accounts,
    management: createAccountManagement({ database, accounts, clock }),
    assertReleaseReady() {
      const version = database.prepare('SELECT MAX(version) AS version FROM account_schema_versions').get();
      if (version.version !== 2) throw new Error('账号数据库版本不匹配，请先本机运行 accounts-admin.js migrate 完成迁移');
      const row = database.prepare(`SELECT c.must_change_password,u.status FROM account_password_credentials c
        JOIN users u ON u.id=c.user_id WHERE c.username='admin'`).get();
      if (!row || row.must_change_password || row.status !== 'active') {
        throw new Error('账号尚未完成受控初始化：请先本机绑定旧资料并为 admin 设置强密码，拒绝公开启动');
      }
      return true;
    },
    buckets(req, username = '') {
      const peer = peerAddress(req, trustedProxies);
      return {
        registerBucket: privacyBucket(rateSecret, 'register-peer', peer),
        startBucket: privacyBucket(rateSecret, 'login-peer', peer),
        finishBucket: privacyBucket(rateSecret, 'login-account', String(username).trim().toLowerCase().slice(0, 128)),
        passwordBucket: privacyBucket(rateSecret, 'password-peer', peer),
      };
    },
    async logoutAll(token, password, rateBucket) {
      const current = accounts.resolve(token);
      const result = accounts.repository.consumeRate(rateBucket, { limit: 5, windowMs: 5 * 60_000, now: clock() });
      if (!result.allowed) throw problem.tooMany('操作频繁，请稍后重试');
      const row = database.prepare('SELECT password_hash FROM account_password_credentials WHERE user_id=?')
        .get(current.user.id);
      if (!row || !await verifyPassword(password, row.password_hash)) {
        throw problem.unprocessable('PASSWORD_INCORRECT', '密码不正确，请重新输入');
      }
      return accounts.repository.transaction(() => {
        accounts.resolve(token, { touch: false });
        const latest = database.prepare('SELECT password_hash FROM account_password_credentials WHERE user_id=?')
          .get(current.user.id);
        if (!latest || latest.password_hash !== row.password_hash) throw problem.unauthorized('请重新登录');
        accounts.repository.revokeAll(current.user.id, clock(), 'user_revoked_all');
        accounts.repository.event('sessions_revoked', current.user.id, clock());
        return { ok: true };
      });
    },
  };
}

function runtimeFromEnvironment(database) {
  if (process.env.RESUME_AUTH_MODE !== 'accounts') {
    throw new Error('生产账号模式未明确开启；请完成账号初始化并配置 RESUME_AUTH_MODE=accounts，不允许回退共享账号');
  }
  return createAccountRuntime({
    database,
    config: {
      enabled: true, registration: 'open',
      publicOrigin: process.env.RESUME_AUTH_PUBLIC_ORIGIN,
      basePath: process.env.RESUME_AUTH_BASE_PATH || '/',
      // Development HTTP is explicit and strictly loopback; never public HTTP.
      allowInsecureLoopback: process.env.RESUME_AUTH_ALLOW_LOOPBACK_HTTP === '1',
    },
    rateSecret: process.env.RESUME_AUTH_RATE_SECRET,
    trustedProxies: String(process.env.RESUME_AUTH_TRUSTED_PROXIES || '').split(',').map((ip) => ip.trim()).filter(Boolean),
  });
}

module.exports = { createAccountRuntime, runtimeFromEnvironment, testAuthEnabled, peerAddress };
