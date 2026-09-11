'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers');

let ctx;
let origin;
test.before(async () => {
  ctx = await helpers.boot();
  origin = ctx.base.replace('/api/v1', '');
});
test.after(() => helpers.close(ctx));

test('静态入口只开放实际前端资源，支持HEAD', async () => {
  for (const pathname of ['/', '/index.html', '/resume-dom.js']) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await response.text()).length > 100);
    const head = await fetch(origin + pathname, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  }
  assert.equal((await fetch(origin + '/index.html', { method: 'POST' })).status, 405);
});

test('服务端源码、密钥配置、数据和原型不得作为静态资源下载', async () => {
  for (const pathname of [
    '/server/index.js', '/.env', '/.env.example', '/package.json',
    '/data/resume.db', '/index.prototype.backup.html', '/AGENTS.md',
    '/node_modules/jsdom/package.json', '/server/../package.json',
    '/%2eenv', '/%2e%2e/resume/package.json',
  ]) {
    const response = await fetch(origin + pathname);
    assert.equal(response.status, 404, pathname);
    assert.equal(await response.text(), '未找到资源');
  }
});
