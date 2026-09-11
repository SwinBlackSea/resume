'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { migrateAccounts } = require('../server/lib/accounts/schema');
const { sqliteAccountRepository } = require('../server/lib/accounts/repository');
const { accountConfig } = require('../server/lib/accounts/config');
const { createAccountService } = require('../server/lib/accounts/service');
const { createPasswordAccounts } = require('../server/lib/accounts/password-service');
const { randomToken, hashToken, csrfToken, privacyBucket, equalSecret } = require('../server/lib/accounts/crypto');
const http = require('../server/lib/accounts/http');
const { bootstrapLegacyAdmin, inspectLegacyOwner, resetPassword } = require('../server/lib/accounts/admin');
const { hashPassword } = require('../server/lib/accounts/passwords');
const { createAccountRuntime } = require('../server/lib/accounts/runtime');

function fixture(options = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,phone TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO users VALUES('legacy-owner','demo@resume-planet.local',NULL,'旧用户','active','2026','2026');
    CREATE TABLE test_business(owner_id TEXT,body TEXT);
    INSERT INTO test_business VALUES('legacy-owner','既有正文保持原样');`);
  migrateAccounts(database, 1);
  const repository = sqliteAccountRepository(database);
  let now = 1000;
  const config = { enabled: true, publicOrigin: 'https://resume.example', basePath: '/resume',
    idleMs: 60_000, absoluteMs: 180_000, registration: 'open', ...options };
  const adapters = { test: { verify: async (proof) => proof && proof.ok
    ? { verified: true, subject: proof.subject || 'person-a' } : null } };
  const service = createAccountService({ repository, config, adapters, clock: () => now });
  let count = 0;
  const bucket = () => privacyBucket('test-privacy-secret-is-long-enough-1234', 'login', String(count++));
  async function login(subject = 'person-a') {
    const challenge = service.beginLogin('test', { rateBucket: bucket() });
    return service.completeLogin('test', { ok: true, subject }, {
      challengeToken: challenge.challenge_token, browserBinding: challenge.browser_binding, rateBucket: bucket(),
    });
  }
  return { database, repository, config, service, bucket, login,
    now: () => now, advance: (value) => { now += value; } };
}

test('账号迁移是显式、幂等且不认领旧 owner，不允许未来数据库降级', () => {
  const f = fixture();
  const before = f.database.prepare('SELECT * FROM users').all();
  migrateAccounts(f.database, 99);
  assert.deepEqual(f.database.prepare('SELECT * FROM users').all(), before);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_identities').get().n, 0);
  assert.equal(f.database.prepare('SELECT body FROM test_business').get().body, '既有正文保持原样');
  f.database.prepare('INSERT INTO account_schema_versions VALUES(3,100)').run();
  assert.throws(() => migrateAccounts(f.database), /高于当前代码/);
  f.database.close();
});

test('账号默认关闭、默认禁止注册，未知供应商不回退 demo', async () => {
  const f = fixture({ registration: 'closed' });
  await assert.rejects(f.login(), { status: 401 });
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.throws(() => f.service.beginLogin('missing', { rateBucket: f.bucket() }), { status: 401 });
  const off = createAccountService({ repository: f.repository });
  assert.deepEqual(off.providers(), []);
  assert.throws(() => off.resolve(randomToken()), { status: 401 });
  f.database.close();
});

test('令牌哈希持久化、公开视图不含 secret、身份不会按旧邮箱合并', async () => {
  const f = fixture();
  const result = await f.login();
  assert.notEqual(result.user.id, 'legacy-owner');
  assert.equal(result.token.length, 43);
  const stored = f.database.prepare('SELECT * FROM account_sessions').get();
  assert.equal(stored.token_hash, hashToken(result.token));
  assert.equal(JSON.stringify(stored).includes(result.token), false);
  const resolved = f.service.resolve(result.token);
  assert.equal(resolved.user.id, result.user.id);
  assert.equal(resolved.csrf_token, csrfToken(result.token));
  assert.equal('token_hash' in resolved.session, false);
  assert.equal('token' in resolved, false);
  f.database.close();
});

test('一次性挑战绑定浏览器、供应商、过期与尝试预算，成功不能重放', async () => {
  const f = fixture({ challengeMs: 30_000, challengeAttempts: 2 });
  const c = f.service.beginLogin('test', { rateBucket: f.bucket() });
  const opts = { challengeToken: c.challenge_token, browserBinding: c.browser_binding, rateBucket: f.bucket() };
  await assert.rejects(f.service.completeLogin('test', { ok: true }, { ...opts, browserBinding: randomToken() }), { status: 401 });
  await assert.rejects(f.service.completeLogin('test', { ok: false }, opts), { status: 401 });
  await f.service.completeLogin('test', { ok: true }, opts);
  await assert.rejects(f.service.completeLogin('test', { ok: true }, opts), { status: 401 });
  const expired = f.service.beginLogin('test', { rateBucket: f.bucket() });
  f.advance(30_001);
  await assert.rejects(f.service.completeLogin('test', { ok: true }, {
    challengeToken: expired.challenge_token, browserBinding: expired.browser_binding, rateBucket: f.bucket(),
  }), { status: 401 });
  f.database.close();
});

test('并发完成同一挑战只能建立一个会话', async () => {
  const f = fixture();
  const c = f.service.beginLogin('test', { rateBucket: f.bucket() });
  const opts = { challengeToken: c.challenge_token, browserBinding: c.browser_binding, rateBucket: f.bucket() };
  const results = await Promise.allSettled([
    f.service.completeLogin('test', { ok: true }, opts),
    f.service.completeLogin('test', { ok: true }, opts),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  f.database.close();
});

test('禁用用户与吊销立即生效，其他 owner 无法撤销会话', async () => {
  const f = fixture();
  const a = await f.login('a'), b = await f.login('b');
  assert.throws(() => f.service.revokeSession(b.token, a.session.id), { status: 404 });
  f.service.revokeSession(a.token, a.session.id);
  assert.throws(() => f.service.resolve(a.token), { status: 401 });
  f.database.prepare("UPDATE users SET status='disabled' WHERE id=?").run(b.user.id);
  assert.throws(() => f.service.resolve(b.token), { status: 401 });
  f.database.close();
});

test('闲置过期、活跃滑动、绝对过期与轮转不会延长认证寿命', async () => {
  const f = fixture();
  const a = await f.login('a');
  f.advance(60_001);
  assert.throws(() => f.service.resolve(a.token), { status: 401 });
  const b = await f.login('b');
  f.advance(50_000); f.service.resolve(b.token);
  f.advance(50_000);
  const c = f.service.rotateSession(b.token);
  assert.throws(() => f.service.resolve(b.token), { status: 401 });
  f.advance(50_000); f.service.resolve(c.token);
  f.advance(30_001);
  assert.throws(() => f.service.resolve(c.token), { status: 401 });
  f.database.close();
});

test('单用户活跃会话数有界且不影响另一账号', async () => {
  const f = fixture({ maxSessions: 2 });
  const a = await f.login('a'); f.advance(1);
  const b = await f.login('a'); f.advance(1);
  const other = await f.login('b'); f.advance(1);
  const c = await f.login('a');
  assert.throws(() => f.service.resolve(a.token), { status: 401 });
  assert.equal(f.service.listSessions(c.token).length, 2);
  assert.equal(f.service.resolve(b.token).user.id, c.user.id);
  assert.equal(f.service.resolve(other.token).user.id, other.user.id);
  f.database.close();
});

test('限流计数跨 repository 共用数据库、到期恢复、无原始身份落库', () => {
  const f = fixture();
  const second = sqliteAccountRepository(f.database), key = f.bucket();
  assert.equal(f.repository.consumeRate(key, { limit: 1, windowMs: 1000, now: 0 }).allowed, true);
  assert.equal(second.consumeRate(key, { limit: 1, windowMs: 1000, now: 1 }).allowed, false);
  assert.equal(second.consumeRate(key, { limit: 1, windowMs: 1000, now: 1000 }).allowed, true);
  assert.equal(f.database.prepare('SELECT bucket_hash FROM account_rate_limits').get().bucket_hash, key);
  f.database.close();
});

test('清理只处理有界过期中间记录，身份、活跃会话和业务数据不删除', async () => {
  const f = fixture({ absoluteMs: 30 * 24 * 60 * 60_000, idleMs: 24 * 60 * 60_000 });
  const a = await f.login();
  f.service.beginLogin('test', { rateBucket: f.bucket() });
  f.advance(10 * 60_000);
  const cleaned = f.repository.cleanup({ now: f.now(), retentionMs: 1000, batchSize: 1 });
  assert.equal(cleaned.challenges, 1);
  assert.equal(f.service.resolve(a.token).user.id, a.user.id);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_identities').get().n, 1);
  assert.equal(f.database.prepare('SELECT body FROM test_business').get().body, '既有正文保持原样');
  f.database.close();
});

test('HTTPS、部署前缀、重复 Cookie、同源和 CSRF 安全边界', () => {
  assert.throws(() => accountConfig({ enabled: true }), /publicOrigin/);
  assert.throws(() => accountConfig({ enabled: true, publicOrigin: 'http://example.com' }), /HTTPS/);
  assert.throws(() => accountConfig({ publicOrigin: 'https://example.com/unsafe' }), /HTTPS/);
  assert.throws(() => accountConfig({ basePath: '/resume/../other' }), /basePath/);
  const config = accountConfig({ publicOrigin: 'https://resume.example', basePath: '/resume' });
  const token = randomToken();
  const cookie = http.sessionCookie(config, token);
  assert.match(cookie, /Path=\/resume\/; HttpOnly; SameSite=Lax/);
  assert.match(cookie, /; Secure$/);
  assert.equal(http.readCookie({ headers: { cookie: config.cookieName + '=' + token } }, config.cookieName), token);
  assert.throws(() => http.readCookie({ headers: { cookie: `${config.cookieName}=${token}; ${config.cookieName}=${randomToken()}` } }, config.cookieName), { status: 401 });
  const req = { headers: { origin: 'https://resume.example', 'x-csrf-token': csrfToken(token) } };
  assert.doesNotThrow(() => http.assertCsrf(req, config, token));
  assert.throws(() => http.assertCsrf({ headers: { ...req.headers, origin: 'https://evil.example' } }, config, token), { status: 403 });
  assert.throws(() => http.assertCsrf({ headers: { origin: req.headers.origin } }, config, token), { status: 403 });
  assert.equal(equalSecret('汉'.repeat(43), 'a'.repeat(43)), false);
  assert.match(http.clearSessionCookie(config), /Max-Age=0/);
});

test('真实 scrypt 注册登录与改密，保留旧 owner，弱 admin 不可通过 HTTP 登录', async () => {
  const f = fixture({ idleMs: 60_000, absoluteMs: 600_000 });
  const passwords = createPasswordAccounts({ database: f.database, config: f.config, clock: f.now });
  const buckets = () => ({ registerBucket: f.bucket(), startBucket: f.bucket(), finishBucket: f.bucket() });
  const password = 'a private long test phrase 90210';
  const created = await passwords.register({ username: 'alice_test', password }, buckets());
  assert.equal(created.user.username, 'alice_test');
  assert.notEqual(created.user.id, 'legacy-owner');
  const row = f.database.prepare('SELECT * FROM account_password_credentials').get();
  assert.match(row.password_hash, /^scrypt\$v1\$131072\$8\$1\$/);
  assert.equal(row.password_hash.includes(password), false);
  const second = await passwords.login({ username: 'ALICE_TEST', password }, buckets());
  assert.equal(second.user.id, created.user.id);
  const changed = await passwords.changePassword(second.token, {
    current_password: password, new_password: 'a completely different test phrase 60210',
  }, { rateBucket: f.bucket() });
  assert.throws(() => passwords.resolve(created.token), { status: 401 });
  assert.throws(() => passwords.resolve(second.token), { status: 401 });
  assert.equal(passwords.resolve(changed.token).user.username, 'alice_test');
  await assert.rejects(passwords.login({ username: 'alice_test', password }, buckets()), { status: 401 });
  await assert.rejects(passwords.register({ username: 'admin', password }, buckets()), { status: 400 });
  assert.equal(f.database.prepare('SELECT body FROM test_business').get().body, '既有正文保持原样');
  f.database.close();
});

test('admin 本机预检不写入，重复初始化原子保留旧 owner，弱初始化不能公开登录', async () => {
  const f = fixture();
  const before = f.database.prepare('SELECT * FROM users').all();
  const preflight = await bootstrapLegacyAdmin(f.database);
  assert.equal(preflight.applied, false);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_password_credentials').get().n, 0);
  const initialized = await Promise.all([
    bootstrapLegacyAdmin(f.database, { apply: true }),
    bootstrapLegacyAdmin(f.database, { apply: true }),
  ]);
  assert.equal(initialized.filter((value) => value.applied).length, 1);
  assert.deepEqual(f.database.prepare('SELECT * FROM users').all(), before);
  assert.equal(inspectLegacyOwner(f.database).owner_id, 'legacy-owner');
  const passwords = createPasswordAccounts({ database: f.database, config: f.config, clock: f.now });
  await assert.rejects(passwords.login({ username: 'admin', password: 'admin' }, {
    startBucket: f.bucket(), finishBucket: f.bucket(),
  }), { status: 401 });
  const runtime = createAccountRuntime({ database: f.database, config: f.config,
    rateSecret: 'an isolated admin runtime testing secret 3181' });
  assert.throws(() => runtime.assertReleaseReady(), /受控初始化/);
  await resetPassword(f.database, { username: 'admin', password: 'a controlled strong admin phrase 5391', apply: true });
  assert.equal(runtime.assertReleaseReady(), true);
  const signed = await passwords.login({ username: 'admin', password: 'a controlled strong admin phrase 5391' }, {
    startBucket: f.bucket(), finishBucket: f.bucket(),
  });
  assert.equal(signed.user.id, 'legacy-owner');
  assert.equal(f.database.prepare('SELECT body FROM test_business').get().body, '既有正文保持原样');
  assert.deepEqual(f.database.prepare('SELECT * FROM users').all(), before);
  f.database.close();
});

test('注册会话写入失败回滚用户和凭证，不留下注册成功但登录失败的半成品', async () => {
  const f = fixture();
  const passwords = createPasswordAccounts({ database: f.database, config: f.config, clock: f.now });
  f.database.exec(`CREATE TRIGGER test_fail_account_session BEFORE INSERT ON account_sessions
    BEGIN SELECT RAISE(ABORT, 'injected session failure'); END;`);
  await assert.rejects(passwords.register({ username: 'atomic_register', password: 'an atomic registration test phrase 1122' }, {
    registerBucket: f.bucket(), startBucket: f.bucket(), finishBucket: f.bucket(),
  }), /injected session failure/);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_password_credentials').get().n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_identities').get().n, 0);
  f.database.close();
});

test('旧密码正在验证时被运维重置，迟到验证不得建立新会话', async () => {
  const f = fixture();
  const passwords = createPasswordAccounts({ database: f.database, config: f.config, clock: f.now });
  const body = { username: 'racing_user', password: 'an existing racing password phrase 1171' };
  const created = await passwords.register(body, {
    registerBucket: f.bucket(), startBucket: f.bucket(), finishBucket: f.bucket(),
  });
  const nextHash = await hashPassword('a replacement racing password phrase 7371');
  const pendingLogin = passwords.login(body, { startBucket: f.bucket(), finishBucket: f.bucket() });
  f.database.prepare('UPDATE account_password_credentials SET password_hash=? WHERE user_id=?')
    .run(nextHash, created.user.id);
  await assert.rejects(pendingLogin, { status: 401 });
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM account_sessions').get().n, 1);
  f.database.close();
});
