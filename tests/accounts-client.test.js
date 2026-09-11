'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');
const code = fs.readFileSync(require.resolve('../account-client.js'), 'utf8');

async function client(t, fetchNext) {
  const dom = new JSDOM('', { url: 'https://resume.example/', runScripts: 'outside-only',
    virtualConsole: new VirtualConsole() });
  t.after(() => dom.window.close());
  const session = { authenticated: true, user: { id: 'old-owner' }, csrf_token: 'test-csrf' };
  let first = true;
  dom.window.fetch = async (...args) => {
    if (first) { first = false; return Response.json(session); }
    return fetchNext(...args);
  };
  dom.window.eval(code);
  const account = dom.window.ResumeAccount;
  await account.bootstrap({ apiBase: '/api/v1' });
  return account;
}

test('账号设置会话失效立即清理旧账号，密码错误不清理有效账号', async t => {
  let status = 422;
  const account = await client(t, () => Response.json({ detail: '密码错误' }, { status }));
  const reasons = [];
  account.onInvalidate(reason => reasons.push(reason));
  await assert.rejects(account.request('/auth/password', { method: 'POST', body: {} }));
  assert.equal(account.session().user.id, 'old-owner');
  assert.equal(reasons.length, 0);
  status = 401;
  await assert.rejects(account.request('/auth/sessions'), { code: 'UNAUTHORIZED' });
  assert.equal(account.session(), null);
  assert.deepEqual(reasons, ['expired']);
});

test('账号切换取消账号请求，迟到登录结果不能恢复已清除的身份', async t => {
  let finish, signal;
  const account = await client(t, (_url, options) => {
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = account.login('login', { username: 'old-owner', password: 'test' });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await account.onUnauthorized();
  assert.equal(signal.aborted, true);
  finish(Response.json({ authenticated: true, user: { id: 'old-owner' } }));
  await rejected;
  assert.equal(account.session(), null);
});
