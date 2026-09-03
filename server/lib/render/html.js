'use strict';
/**
 * HTML 渲染产物：Resume DOM + Template → 打印用 HTML 字符串。
 * 仅作为生成产物（artifact）存入对象存储供预览与缩略图使用，
 * 不是产品页面（产品页面统一维护在 index.html）。
 */
const ResumeDom = require('../../../resume-dom');
const db = require('../db');
const { getObject } = require('../storage');

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function inlineSceneAssets(documentValue, ownerId) {
  const document = ResumeDom.clone(documentValue);
  if (!ownerId) return document;
  function visit(node) {
    if (!node || node.type !== 'element') return;
    const artifactId =
      node.attributes && node.attributes['data-scene-background-artifact-id'];
    if (node.tag === 'img' && artifactId) {
      const artifact = db.get(
        `SELECT object_key, mime_type
         FROM artifacts
         WHERE id = ? AND owner_id = ? AND status = 'ready'`,
        [artifactId, ownerId],
      );
      const buffer = artifact && getObject(artifact.object_key);
      if (buffer && String(artifact.mime_type || '').startsWith('image/')) {
        node.attributes.src =
          `data:${artifact.mime_type};base64,${buffer.toString('base64')}`;
      }
    }
    (node.children || []).forEach(visit);
  }
  visit(document.root);
  return document;
}

function renderHtml({ resume, template, ownerId }) {
  const schema = template.schema || template;
  const accent = (schema.typography && schema.typography.accent) || '#1d1d1f';
  const importedLayout = /^imported-(?:native|positioned|scene)$/.test(String(schema.layout || ''));
  const attached = ResumeDom.attachDocument(resume);
  const exportDocument = inlineSceneAssets(attached.dom_document, ownerId);
  const body = ResumeDom.renderToHtml(exportDocument, { forExport: true });
  const title = (attached.basics && attached.basics.name)
    || (ResumeDom.toRenderBlocks(attached.dom_document).header || {}).title
    || '简历';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)} · 简历</title>
<style>@page{size:A4;margin:${importedLayout ? '0' : '18mm'}}html,body{margin:${importedLayout ? '0' : 'initial'};padding:0}body{font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;color:#414448;font-size:10.5pt;line-height:1.75}.resume-top h1,h1{font-size:22pt;letter-spacing:2px;margin:0}.resume-section h2,h2{font-size:12pt;color:${accent};border-bottom:1px solid #d1d1d6;padding-bottom:4pt;margin:18pt 0 8pt}.resume-top p,.contact{color:#5f6265;font-size:9pt;margin:6pt 0 14pt;border-bottom:1px solid ${accent};padding-bottom:10pt}.resume-row,.row{margin-top:10pt;font-weight:700;font-size:10pt}.resume-row .role,.row span{margin-left:10pt;font-weight:400;color:#4d5155}.resume-row time,.row time{float:right;font-weight:400;color:#73767a;font-size:9pt}ul{margin:6pt 0;padding-left:16px}li{white-space:pre-line}.imported-document-page{break-after:page;page-break-after:always;box-shadow:none!important}.imported-document-page:last-child{break-after:auto;page-break-after:auto}.imported-scene-background{display:block}.imported-scene-span{display:inline-block}.imported-paragraph span{margin-left:0}.imported-table{break-inside:avoid}</style>
</head><body>${body}</body></html>`;
}

module.exports = { renderHtml, inlineSceneAssets };
