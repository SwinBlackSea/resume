'use strict';

// This helper must precede every import of the application database.
const { db, close } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/index');
const { seedIfEmpty } = require('../server/lib/seed');
const { createAccountRuntime, peerAddress } = require('../server/lib/accounts/runtime');
const { bootstrapLegacyAdmin, resetPassword } = require('../server/lib/accounts/admin');

const ORIGIN = 'https://resume.example';
const STRONG = 'a strong administrative test phrase 9371';

async function setup(t) {
  seedIfEmpty();
  const database = db.getDb();
  const legacy = db.get("SELECT id FROM users WHERE email='demo@resume-planet.local'");
  await bootstrapLegacyAdmin(database, { apply: true });
  await resetPassword(database, { username: 'admin', password: STRONG, apply: true });
  const runtime = createAccountRuntime({ database, config: { enabled: true, registration: 'open',
    publicOrigin: ORIGIN, basePath: '/resume' }, rateSecret: 'isolated-account-http-rate-secret-0123456789' });
  const server = createServer({ accountRuntime: runtime });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => close({ server }));
  return { base: `http://127.0.0.1:${server.address().port}`, runtime, legacyId: legacy.id };
}

function browser(ctx) {
  const jar = new Map();
  let csrf = null, userId = null;
  return {
    jar,
    async request(method, path, body, extra = {}) {
      const headers = { origin: ORIGIN, 'content-type': 'application/json',
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join(';'),
        ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(userId ? { 'x-account-id': userId } : {}),
        ...extra };
      for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
      const response = await fetch(ctx.base + '/api/v1' + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0], index = pair.indexOf('=');
        if (pair.slice(index + 1)) jar.set(pair.slice(0, index), pair.slice(index + 1));
        else jar.delete(pair.slice(0, index));
      }
      const value = await response.json();
      if (value.csrf_token) csrf = value.csrf_token;
      if (value.authenticated) userId = value.user.id;
      return { status: response.status, body: value, headers: response.headers };
    },
    anonymous: function() { userId = null; csrf = null; jar.clear(); },
  };
}

test('HTTP真实密码认证：匿名拒绝、CSRF/CORS、跨owner、原始上传、注册原子会话和吊销', async (t) => {
  const ctx = await setup(t);
  const first = browser(ctx), second = browser(ctx);
  assert.equal((await first.request('GET', '/projects')).status, 401);
  assert.equal((await first.request('GET', '/projects', undefined, { 'x-user-id': ctx.legacyId })).status, 401);
  const anon = await first.request('GET', '/auth/session');
  assert.equal(anon.body.authenticated, false);
  assert.match(anon.headers.get('cache-control'), /no-store/);
  const forged = await first.request('POST', '/auth/login', { username: 'admin', password: STRONG }, { origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers.get('access-control-allow-origin'), null);
  assert.equal((await first.request('POST', '/auth/login', { username: 'admin', password: STRONG }, { 'x-csrf-token': null })).status, 403);
  const logged = await first.request('POST', '/auth/login', { username: 'admin', password: STRONG });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.user.id, ctx.legacyId);
  assert.equal(logged.body.user.username, 'admin');
  const oldCookie = [...first.jar].map(([name, value]) => `${name}=${value}`).join(';');
  const projects = await first.request('GET', '/projects');
  assert.ok(projects.body.items.length);
  const projectId = projects.body.items[0].id;
  assert.equal((await first.request('POST', '/projects', { name: '坏请求' }, { 'x-csrf-token': null })).status, 403);
  assert.equal((await first.request('POST', '/uploads/not-real/content', {}, { 'x-csrf-token': null })).status, 403);
  await second.request('GET', '/auth/session');
  const registered = await second.request('POST', '/auth/register', { username: 'fresh_http_user', password: 'a fresh private testing phrase 8821' });
  assert.equal(registered.status, 200);
  assert.notEqual(registered.body.user.id, ctx.legacyId);
  assert.deepEqual((await second.request('GET', '/projects')).body.items, []);
  assert.equal((await second.request('GET', '/projects/' + projectId)).status, 404);
  assert.equal((await second.request('GET', '/projects', undefined, { 'x-account-id': ctx.legacyId })).status, 401);
  const sessions = await first.request('GET', '/auth/sessions');
  const ownSession = sessions.body.items.find((item) => item.current);
  assert.ok(ownSession);
  assert.equal((await second.request('DELETE', '/auth/sessions/' + ownSession.id)).status, 404);
  const invalidPassword = await first.request('POST', '/auth/password', {
    current_password: 'not correct', new_password: 'another strong testing phrase 2821',
  });
  assert.equal(invalidPassword.status, 422);
  assert.equal(invalidPassword.body.title, 'PASSWORD_INCORRECT');
  assert.equal((await first.request('GET', '/projects')).status, 200);
  assert.equal((await first.request('POST', '/auth/logout')).status, 200);
  assert.equal((await first.request('GET', '/projects')).status, 401);
  const delayedRead = await first.request('GET', '/auth/session?touch=0', undefined, { cookie: oldCookie });
  assert.equal(delayedRead.body.authenticated, false);
  assert.equal(delayedRead.headers.getSetCookie().some((value) => value.startsWith('__Secure-resume_session=')), false,
    '旧会话状态读取不得清除另一个响应刚设置的新会话 Cookie');
  assert.equal((await second.request('GET', '/projects')).status, 200);
  const index = await fetch(ctx.base + '/');
  assert.match(await index.text(), /__RESUME_ACCOUNTS_ENABLED__=true/);
  const privateFile = await fetch(ctx.base + '/server/lib/accounts/passwords.js');
  assert.equal(privateFile.status, 404);
});

test('可信代理逐跳校验，不信任伪造的首个 forwarded IP', () => {
  const req = (peer, header) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': header } });
  assert.equal(peerAddress(req('192.0.2.1', '198.51.100.1')), '192.0.2.1');
  assert.equal(peerAddress(req('127.0.0.1', '198.51.100.99, 192.0.2.8'), ['127.0.0.1']), '192.0.2.8');
  assert.equal(peerAddress(req('::ffff:127.0.0.1', 'not-an-ip'), ['127.0.0.1']), '127.0.0.1');
});
