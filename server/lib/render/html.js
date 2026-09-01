'use strict';
/**
 * HTML 渲染产物：Resume DOM + Template → 打印用 HTML 字符串。
 * 仅作为生成产物（artifact）存入对象存储供预览与缩略图使用，
 * 不是产品页面（产品页面统一维护在 index.html）。
 */
const ResumeDom = require('../../../resume-dom');

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function renderHtml({ resume, template }) {
  const schema = template.schema || template;
  const accent = (schema.typography && schema.typography.accent) || '#1d1d1f';
  const attached = ResumeDom.attachDocument(resume);
  const body = ResumeDom.renderToHtml(attached.dom_document, { forExport: true });
  const title = (attached.basics && attached.basics.name)
    || (ResumeDom.toRenderBlocks(attached.dom_document).header || {}).title
    || '简历';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)} · 简历</title>
<style>@page{size:A4;margin:18mm}body{font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;color:#414448;font-size:10.5pt;line-height:1.75}.resume-top h1,h1{font-size:22pt;letter-spacing:2px;margin:0}.resume-section h2,h2{font-size:12pt;color:${accent};border-bottom:1px solid #d1d1d6;padding-bottom:4pt;margin:18pt 0 8pt}.resume-top p,.contact{color:#5f6265;font-size:9pt;margin:6pt 0 14pt;border-bottom:1px solid ${accent};padding-bottom:10pt}.resume-row,.row{margin-top:10pt;font-weight:700;font-size:10pt}.resume-row .role,.row span{margin-left:10pt;font-weight:400;color:#4d5155}.resume-row time,.row time{float:right;font-weight:400;color:#73767a;font-size:9pt}ul{margin:6pt 0;padding-left:16px}li{white-space:pre-line}</style>
</head><body>${body}</body></html>`;
}

module.exports = { renderHtml };
