'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { readJsonBody } = require('../server/lib/util');

test('JSON流跨UTF-8边界仍保留中文，不以半个字符解码', async () => {
  const req = new PassThrough();
  const parsed = readJsonBody(req);
  for (const byte of Buffer.from('{"text":"职业技术"}')) req.write(Buffer.from([byte]));
  req.end();
  assert.deepEqual(await parsed, { text: '职业技术' });
});
test('JSON超预算返回错误并停止累积，不销毁连接；完整文档可显式设置预算', async () => {
  const req = new PassThrough();
  const rejected = assert.rejects(readJsonBody(req, 10), /请求体过大/);
  req.write(Buffer.from('x'.repeat(11)));
  assert.equal(req.destroyed, false);
  req.end(); await rejected;
  const document = new PassThrough();
  const parsed = readJsonBody(document, 2_000_000);
  document.end(JSON.stringify({ text: 'a'.repeat(1_000_001) }));
  assert.equal((await parsed).text.length, 1_000_001);
});
