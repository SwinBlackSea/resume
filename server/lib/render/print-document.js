'use strict';
const ResumeDom = require('../../../resume-dom');
const { documentRenderCss } = require('../resume-harness/render-style-context');

// One complete document, the real editor's document CSS and no editor chrome.
// Resource bytes are resolved privately before reaching this pure projection.
function printDocumentHtml(documentValue) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const page = ResumeDom.resolvePageLayout(document);
  const hasPages = document.root.children.some(n => n.semantic?.kind === 'page');
  const root = document.root;
  root.attributes = { ...root.attributes, id: 'resume-document',
    class: ['resume', root.attributes?.class || ''].join(' ') };
  const pageStyle = hasPages ? {} : { width: `${page.width}pt`, 'min-height': `${page.height}pt`, 'box-sizing': 'border-box' };
  if (!hasPages) for (const [side, value] of Object.entries(page.explicitMargins)) pageStyle[`padding-${side}`] = `${value}pt`;
  root.style = { ...pageStyle, ...root.style };
  // CSS is normalized by the same renderer; do not interpolate raw model CSS.
  const css = documentRenderCss([document]).replace(/<\/style/gi, '<\\/style');
  const html = ResumeDom.renderToHtml(document, { forExport: true, includeRoot: true });
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<title>简历</title><style>${css}
@page{size:${page.width}pt ${page.height}pt;margin:0}
html,body{margin:0!important;padding:0!important;background:white!important;min-height:0!important}
.resume{box-shadow:none!important;margin:0!important;zoom:1!important}
.imported-document-page{break-after:page;page-break-after:always;box-shadow:none!important}
.imported-document-page:last-child{break-after:auto;page-break-after:auto}
.imported-scene-background{visibility:visible!important}
img{max-width:100%;print-color-adjust:exact;-webkit-print-color-adjust:exact}
</style></head><body>${html}</body></html>`;
}
module.exports = { printDocumentHtml };
