'use strict';

const { db, close } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { seedIfEmpty } = require('../server/lib/seed');
const { createServer } = require('../server/index');
const { createAccountRuntime } = require('../server/lib/accounts/runtime');
const { bootstrapLegacyAdmin, resetPassword } = require('../server/lib/accounts/admin');
const { openBrowser, available } = require('./browser-driver');

test('真实浏览器独立登录：表单错误、390px、开放注册、私有Cookie与安全回跳', { skip: !available }, async (t) => {
  seedIfEmpty();
  await bootstrapLegacyAdmin(db.getDb(), { apply: true });
  await resetPassword(db.getDb(), { username: 'admin', password: 'a browser admin testing phrase 40392', apply: true });
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const runtime = createAccountRuntime({ database: db.getDb(),
    config: { enabled: true, registration: 'open', publicOrigin: origin,
      allowInsecureLoopback: true, basePath: '/' },
    rateSecret: 'account-browser-isolated-rate-secret-93481' });
  const server = createServer({ accountRuntime: runtime });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  t.after(() => close({ server }));
  const page = await openBrowser(t, origin + '/login.html?return=https%3A%2F%2Fevil.example', {
    home: true,
    readyExpression: 'Boolean(window.ResumeAccount && document.querySelector("#submit") && !document.querySelector("#submit").disabled)',
  });
  await page.cdp('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: false,
  });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  await page.click('#switch');
  assert.equal(await page.evaluate('document.querySelector("#title").textContent'), '创建账号');
  await page.click('#username');
  await page.cdp('Input.insertText', { text: 'browser_new_user' });
  await page.click('#password');
  await page.cdp('Input.insertText', { text: 'too short' });
  await page.click('#submit');
  await page.until('document.querySelector("#error").textContent.includes("15")');
  assert.equal(await page.evaluate('document.querySelector("#submit").disabled'), false);
  await page.evaluate('document.querySelector("#password").value=""');
  await page.click('#password');
  await page.cdp('Input.insertText', { text: 'a brand new browser testing phrase 6389' });
  await page.click('#submit');
  await page.until('!location.pathname.endsWith("login.html") && window.ResumeAccount && ResumeAccount.session() && ResumeAccount.session().authenticated', 15_000);
  assert.equal(await page.evaluate('location.origin'), origin);
  assert.equal(await page.evaluate('location.pathname'), '/');
  assert.equal(await page.evaluate('ResumeAccount.session().user.username'), 'browser_new_user');
  assert.equal(await page.evaluate('document.cookie.includes("resume_session")'), false);
  const privateSession = await page.evaluate(`fetch('/api/v1/auth/session').then(async r=>({cache:r.headers.get('cache-control'),body:await r.json()}))`);
  assert.match(privateSession.cache, /no-store/);
  assert.equal(privateSession.body.user.username, 'browser_new_user');
  assert.equal('token' in privateSession.body, false);
  const cookies = await page.cdp('Network.getAllCookies');
  const session = cookies.cookies.find((cookie) => cookie.name === 'resume_session_local');
  assert.ok(session && session.httpOnly && session.sameSite === 'Lax');
  assert.equal(await page.evaluate(`ResumeAccount.safeReturn('//evil.example/path')`), '/');
  assert.equal(await page.evaluate(`ResumeAccount.safeReturn('/api/v1/projects')`), '/');
  assert.deepEqual(page.errors, []);
});
