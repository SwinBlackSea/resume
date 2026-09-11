'use strict';

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const ResumeDom = require('../resume-dom');
const { renderHtml } = require('../server/lib/render/html');
const { renderPdf } = require('../server/lib/render/pdf');
const { buildDocumentXml } = require('../server/lib/render/docx');

function document() {
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'body', type: 'element', tag: 'p', editable: true, text: '页面设置测试' },
    ] },
    page_setup: {
      size: 'Letter', orientation: 'landscape',
      margins: { top: '1in', right: '36pt', bottom: '48px', left: '2.54cm' },
    },
  });
}

test('共用页面解析器支持尺寸、方向、物理单位、自定义尺寸及零边距', () => {
  const page = ResumeDom.resolvePageLayout(document());
  assert.equal(page.width, 792);
  assert.equal(page.height, 612);
  assert.deepEqual(page.margins, { top: 72, right: 36, bottom: 36, left: 72 });
  assert.equal(ResumeDom.pageLengthPt('url(evil)'), null);
  assert.equal(ResumeDom.pageLengthPt('-1mm'), null);
  const custom = ResumeDom.resolvePageLayout({
    page_setup: { width: 100, height: 200, unit: 'mm', margins: { top: 0 } },
  });
  assert.ok(Math.abs(custom.width - 100 * 72 / 25.4) < 0.001);
  assert.equal(custom.margins.top, 0);
});

test('画布读取完整页面设置，切换或撤销后恢复原尺寸和边距', () => {
  const dom = new JSDOM('<article class="resume"></article>');
  const host = dom.window.document.querySelector('article');
  const renderer = new ResumeDom.Renderer(host);
  renderer.render(document());
  assert.equal(host.style.width, '792pt');
  assert.equal(host.style.minHeight, '612pt');
  assert.equal(host.style.paddingLeft, '72pt');
  const reverted = document();
  reverted.page_setup = { size: 'A4', orientation: 'portrait', margins: {} };
  renderer.render(reverted);
  assert.equal(host.style.width, '595.28pt');
  assert.equal(host.style.minHeight, '841.89pt');
  assert.equal(host.style.paddingLeft, '');
  dom.window.close();
});

test('HTML、PDF及DOCX均使用当前文档的页面尺寸与边距', () => {
  const resume = document();
  const html = renderHtml({ resume });
  assert.match(html, /@page\{size:792pt 612pt;margin:72pt 36pt 36pt 72pt\}/);
  const xml = buildDocumentXml(resume);
  assert.match(xml, /w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/);
  assert.match(xml, /w:pgMar w:top="1440" w:right="720" w:bottom="720" w:left="1440"/);
  const pdf = renderPdf({ resume });
  assert.equal(pdf.pages, 1);
  assert.match(pdf.buffer.toString('latin1'), /\/MediaBox \[0 0 792 612\]/);
  assert.match(pdf.buffer.toString('latin1'), /72 530\.5 Tm/, 'PDF正文起点使用左上页边距');
});
