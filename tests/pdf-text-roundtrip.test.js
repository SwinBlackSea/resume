'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { renderPdf, FONT_PATH } = require('../server/lib/render/pdf');
const { document, FACTS } = require('./fixtures/full-resume-comparison');
const available = fs.existsSync(FONT_PATH) && spawnSync('pdftotext', ['-v']).status === 0;

test('下载 PDF 保留实际汉字，不将共享字形反查为康熙部首；同字形不同字符可同时往返', {
  skip: available ? false : '需要项目字体与 pdftotext',
}, t => {
  const doc = document('single');
  doc.root.children.push({ id: 'aliases', type: 'element', tag: 'p', editable: true,
    text: '舟⾈山⼭大⼤青⻘禾⽲' });
  const { buffer } = renderPdf({ resume: doc });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-pdf-roundtrip-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'generated.pdf');
  fs.writeFileSync(file, buffer);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s/g, '');
  for (const fact of FACTS) assert.ok(text.includes(fact), fact);
  assert.ok(text.includes('舟⾈山⼭大⼤青⻘禾⽲'), text);
});
