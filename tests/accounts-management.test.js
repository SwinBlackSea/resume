'use strict';
const helpers = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { seedIfEmpty } = require('../server/lib/seed');
const { createServer } = require('../server/index');
const { createAccountRuntime } = require('../server/lib/accounts/runtime');
const { bootstrapLegacyAdmin, resetPassword } = require('../server/lib/accounts/admin');
const { migrateAccounts } = require('../server/lib/accounts/schema');

const origin = 'https://accounts.example';
const password = 'private account management test phrase 8135';
test('超级管理员账号管理：权限、CSRF、停用与恢复、强制退出、迟到登录和独立登录时间', async t => {
  seedIfEmpty();
  const database = helpers.db.getDb();
  await bootstrapLegacyAdmin(database, { apply: true });
  await resetPassword(database, { username: 'admin', password, apply: true });
  let now = Date.now(), peer = 0;
  const runtime = createAccountRuntime({ database, clock: () => now,
    config: { enabled: true, registration: 'open', publicOrigin: origin, basePath: '/' },
    rateSecret: 'account-management-isolated-test-secret-4218' });
  const buckets = username => runtime.buckets({ headers: {}, socket: { remoteAddress: '192.0.2.' + (++peer) } }, username);
  const admin = await runtime.login({ username: 'admin', password }, buckets('admin'));
  let member = await runtime.register({ username: 'managed_member', password, role: 'superadmin' }, buckets('managed_member'));
  assert.equal(admin.user.role, 'superadmin');
  assert.equal(member.user.role, 'user', '注册输入不能授予超级管理员权限');
  const oldDrafts = database.prepare('SELECT id,resume_json FROM resume_drafts ORDER BY id').all();
  const server = createServer({ accountRuntime: runtime });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => helpers.close({ server }));
  async function request(session, method, path, body, extra = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1' + path, {
      method, headers: { origin, 'content-type': 'application/json',
        cookie: runtime.config.cookieName + '=' + session.token,
        'x-csrf-token': session.csrf_token, ...extra }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const path = '/auth/admin/accounts/' + member.user.id;
  assert.equal((await request(member, 'GET', '/auth/admin/accounts')).status, 403);
  assert.equal((await request(member, 'PATCH', path, { status: 'disabled' })).status, 403);
  assert.equal((await request(admin, 'PATCH', path, { status: 'disabled' }, { 'x-csrf-token': 'forged' })).status, 403);
  assert.equal((await request(admin, 'PATCH', '/auth/admin/accounts/' + admin.user.id, { status: 'disabled' })).status, 403);
  assert.equal((await request(admin, 'POST', '/auth/admin/accounts/' + admin.user.id + '/revoke-sessions')).status, 403);
  let result = await request(admin, 'GET', '/auth/admin/accounts?q=managed');
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].last_login_at, now);
  assert.equal(JSON.stringify(result.body).includes('password_hash'), false);
  assert.equal(JSON.stringify(result.body).includes('token'), false);
  const firstLogin = now;
  now += 1000;
  runtime.resolve(member.token);
  assert.equal(runtime.repository.metadata(member.user.id).last_login_at, firstLogin, '会话读取不伪造登录时间');
  await assert.rejects(runtime.login({ username: 'managed_member', password: 'wrong' }, buckets('managed_member')));
  assert.equal(runtime.repository.metadata(member.user.id).last_login_at, firstLogin, '失败登录不更新成功登录时间');
  assert.equal((await request(admin, 'PATCH', path, { status: 'disabled' })).status, 200);
  assert.throws(() => runtime.resolve(member.token), { status: 401 });
  await assert.rejects(runtime.login({ username: 'managed_member', password }, buckets('managed_member')), { status: 401 });
  assert.equal((await request(admin, 'PATCH', path, { status: 'active' })).status, 200);
  assert.throws(() => runtime.resolve(member.token), { status: 401 }, '启用不复活旧会话');
  member = await runtime.login({ username: 'managed_member', password }, buckets('managed_member'));
  assert.equal(runtime.repository.metadata(member.user.id).last_login_at, now);
  const pending = runtime.login({ username: 'managed_member', password }, buckets('managed_member'));
  const rejected = assert.rejects(pending, { status: 401 });
  runtime.management.setStatus(admin.token, member.user.id, 'disabled');
  runtime.management.setStatus(admin.token, member.user.id, 'active');
  await rejected;
  member = await runtime.login({ username: 'managed_member', password }, buckets('managed_member'));
  assert.equal((await request(admin, 'POST', path + '/revoke-sessions')).status, 200);
  assert.throws(() => runtime.resolve(member.token), { status: 401 });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM account_admin_actions WHERE actor_id=? AND target_id=?')
    .get(admin.user.id, member.user.id).n, 5);
  assert.deepEqual(database.prepare('SELECT id,resume_json FROM resume_drafts ORDER BY id').all(), oldDrafts);
  // Reconstruct the previous deployed schema; migration only backfills role and known successful login time.
  database.exec('DROP TABLE account_metadata; DELETE FROM account_schema_versions WHERE version=2');
  migrateAccounts(database, now);
  assert.equal(runtime.repository.metadata(admin.user.id).role, 'superadmin');
  assert.equal(runtime.repository.metadata(member.user.id).last_login_at, now);
  runtime.repository.cleanup({ now: now + 40 * 86400000, retentionMs: 30 * 86400000 });
  assert.equal(runtime.repository.metadata(member.user.id).last_login_at, now, '审计清理后仍保留每个账号最近登录时间');
  assert.deepEqual(database.prepare('SELECT id,resume_json FROM resume_drafts ORDER BY id').all(), oldDrafts);
});
