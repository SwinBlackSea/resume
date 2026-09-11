'use strict';
require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const ResumeDom = require('../resume-dom');
const { prepareDocumentImages } = require('../server/lib/render/document-images');
const { renderPdfAsync } = require('../server/lib/render/pdf');
const { renderDocxAsync } = require('../server/lib/render/docx');
const { renderHtmlAsync } = require('../server/lib/render/html');

async function fixture() {
  const buffer = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#cf293c' } }).png().toBuffer();
  return ResumeDom.toResumeDocument({
    schema_version: ResumeDom.RESUME_DOCUMENT_VERSION,
    root: { id: 'root', type: 'element', tag: 'article', children: [
      { id: 'header', type: 'element', tag: 'div', style: { display: 'flex', gap: '16px' }, children: [
        { id: 'intro', type: 'element', tag: 'div', children: [
          { id: 'name', type: 'element', tag: 'h1', editable: true, text: '林晨 TEST RESUME' },
          { id: 'role', type: 'element', tag: 'p', editable: true, text: '产品经理｜项目成果保留123' },
        ] },
        { id: 'portrait', type: 'element', tag: 'img', attributes: { alt: '测试头像', src: `data:image/png;base64,${buffer.toString('base64')}` },
          style: { width: '60pt', height: '90pt', 'object-fit': 'cover' } },
      ] },
      { id: 'work', type: 'element', tag: 'p', editable: true, text: '工作经历\n上线12个项目' },
    ] },
  });
}

test('图片导出投影不修改原始文档，保留图片和文字，HTML不依赖私有URL', async () => {
  const doc = await fixture(), original = JSON.stringify(doc);
  const prepared = await prepareDocumentImages(doc);
  assert.equal(prepared.images.size, 1);
  const html = await renderHtmlAsync({ resume: doc });
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /项目成果保留123/);
  assert.match(html, /Content-Security-Policy/);
  assert.equal(JSON.stringify(doc), original);
});

test('无法安全读取的图片明确失败，不静默导出无头像文件', async () => {
  const doc = await fixture();
  const photo = doc.root.children[0].children[1];
  for (const src of ['https://example.com/photo.png', 'file:///etc/passwd', '/api/v1/document-assets/unknown/content', 'data:image/png;base64,ZmFrZQ==']) {
    photo.attributes.src = src;
    await assert.rejects(prepareDocumentImages(doc), /图片/);
  }
});

test('Word原生嵌入图片且保留可编辑文字、图片关系和尺寸', async () => {
  const { buffer } = await renderDocxAsync({ resume: await fixture() });
  // ZIP uses store, so parts remain directly inspectable without external tools.
  const xml = buffer.toString('utf8');
  assert.match(xml, /word\/media\/image1.png/);
  assert.match(xml, /<a:blip r:embed="rImage1"/);
  assert.match(xml, /<w:drawing>/);
  assert.match(xml, /<w:t[^>]*>产品经理｜项目成果保留123/);
  assert.match(xml, /<wp:extent cx="762000" cy="1143000"/);
});

test('带照片Word保留合并表格行列、段落换行及照片比例', async () => {
  const doc = await fixture();
  doc.root.children[0].children[1].style = { width: '100pt', height: '100pt', 'object-fit': 'contain' };
  const cell = (id, text, attributes = {}) => ({ id, type: 'element', tag: 'td', attributes,
    children: [{ id: id + '-p', type: 'element', tag: 'p', editable: true, text }] });
  doc.root.children.push({ id: 'table', type: 'element', tag: 'table', children: [
    { id: 'row1', type: 'element', tag: 'tr', children: [
      cell('merged', '两行合并', { rowspan: '2' }), cell('wide', '两列合并', { colspan: '2' }),
    ] },
    { id: 'row2', type: 'element', tag: 'tr', children: [cell('second', '技能甲'), cell('third', '技能乙')] },
  ] });
  const xml = (await renderDocxAsync({ resume: doc })).buffer.toString('utf8');
  assert.match(xml, /<w:vMerge w:val="restart"/);
  assert.match(xml, /<w:vMerge\/>/);
  assert.match(xml, /<w:gridSpan w:val="2"/);
  assert.match(xml, /工作经历<\/w:t><w:br\/><w:t[^>]*>上线12个项目/);
  const dimensions = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(xml);
  assert.ok(Math.abs(Number(dimensions[1]) / Number(dimensions[2]) - 2 / 3) < .001);
  for (const text of ['两行合并', '两列合并', '技能甲', '技能乙']) assert.ok(xml.includes(text));
});

test('真实Chromium PDF保留头像像素、中文和完整可复制文字', { timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-image-render-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await renderPdfAsync({ resume: await fixture() });
  assert.equal(result.pages, 1, '短简历不能因打印纸张取整额外产生空白页');
  const file = path.join(dir, 'resume.pdf');
  fs.writeFileSync(file, result.buffer);
  const text = execFileSync('pdftotext', [file, '-'], { encoding: 'utf8' }).replace(/\s/g, '');
  assert.ok(text.includes('林晨TESTRESUME'), text);
  assert.ok(text.includes('产品经理｜项目成果保留123'), text);
  assert.ok(text.includes('上线12个项目'), text);
  const imageBase = path.join(dir, 'page');
  execFileSync('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '900', '-png', file, imageBase], { timeout: 20000 });
  const { data, info } = await sharp(imageBase + '.png').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < data.length; i += info.channels) if (data[i] > 150 && data[i + 1] < 90 && data[i + 2] < 110) red++;
  assert.ok(red > 1000, `头像红色像素不足：${red}`);
});
