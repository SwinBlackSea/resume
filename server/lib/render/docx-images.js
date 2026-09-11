'use strict';
const ResumeDom = require('../../../resume-dom');
const { createZip } = require('./zip');

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const EMU = 12700;
const namespaces = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

function buildImageDocx(documentValue, images, parts) {
  const document = ResumeDom.toResumeDocument(documentValue);
  const page = ResumeDom.resolvePageLayout(document, { margins: { top: 36, right: 36, bottom: 36, left: 36 } });
  const usable = page.width - page.margins.left - page.margins.right;
  const media = [];
  const identities = new Map();
  let drawingId = 0;
  function styleOf(node, inherited) {
    const inheritable = ['font-size', 'font-weight', 'font-style', 'color', 'text-align', 'line-height', 'font-family'];
    const style = { ...Object.fromEntries(Object.entries(inherited || {}).filter(([key]) => inheritable.includes(key))), ...node.style };
    if (/^h[1-6]$/.test(node.tag) || ['b', 'strong'].includes(node.tag)) style['font-weight'] = 'bold';
    if (['i', 'em'].includes(node.tag)) style['font-style'] = 'italic';
    return style;
  }
  function textRun(text, style) {
    const size = ResumeDom.pageLengthPt(style['font-size']) || 10.5;
    const bold = style['font-weight'] === 'bold' || Number(style['font-weight']) >= 600;
    const color = /^#([0-9a-f]{6})$/i.exec(style.color || '')?.[1] || '30343A';
    return `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Microsoft YaHei"/>`
      + `<w:sz w:val="${Math.round(size * 2)}"/><w:color w:val="${color}"/>`
      + (bold ? '<w:b/>' : '') + (style['font-style'] === 'italic' ? '<w:i/>' : '')
      + `</w:rPr>${String(text).split('\n').map((line, i) =>
        (i ? '<w:br/>' : '') + `<w:t xml:space="preserve">${esc(line)}</w:t>`).join('')}</w:r>`;
  }
  function imageRun(node, width) {
    const image = images.get(node.id);
    if (!image) throw new Error('Word image resource unavailable');
    let item = identities.get(image.buffer);
    if (!item) {
      item = { name: `image${media.length + 1}.png`, rid: `rImage${media.length + 1}`, buffer: image.buffer };
      identities.set(image.buffer, item); media.push(item);
    }
    const style = node.style || {}, attr = node.attributes || {};
    let preferredWidth = ResumeDom.pageLengthPt(style.width) || Number(attr.width) * .75 || image.width * .75;
    let preferredHeight = ResumeDom.pageLengthPt(style.height) || Number(attr.height) * .75 || preferredWidth * image.height / image.width;
    let crop = '';
    const imageRatio = image.width / image.height, boxRatio = preferredWidth / preferredHeight;
    if (style['object-fit'] === 'cover') {
      const fraction = imageRatio > boxRatio ? (1 - boxRatio / imageRatio) / 2 : (1 - imageRatio / boxRatio) / 2;
      const amount = Math.round(fraction * 100000);
      crop = imageRatio > boxRatio ? `<a:srcRect l="${amount}" r="${amount}"/>` : `<a:srcRect t="${amount}" b="${amount}"/>`;
    } else if (style['object-fit'] !== 'fill') {
      // Photos preserve their native aspect ratio unless explicitly stretched.
      if (imageRatio > boxRatio) preferredHeight = preferredWidth / imageRatio;
      else preferredWidth = preferredHeight * imageRatio;
    }
    const scale = Math.min(1, width / preferredWidth, (page.height - page.margins.top - page.margins.bottom) / preferredHeight);
    const cx = Math.max(1, Math.round(preferredWidth * scale * EMU));
    const cy = Math.max(1, Math.round(preferredHeight * scale * EMU));
    const id = ++drawingId;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="图片 ${id}" descr="${esc(attr.alt || '简历图片')}"/>`
      + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>'
      + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${item.name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${item.rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
      + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
      + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }
  const editorOnly = node => node.attributes?.['data-editor-only'] === 'true'
    || node.tag === 'button';
  function inline(node, inherited, width) {
    if (editorOnly(node)) return '';
    const style = styleOf(node, inherited);
    if (node.type === 'text') return textRun(node.value || '', style);
    if (node.tag === 'img') return imageRun(node, width);
    if (node.tag === 'br') return '<w:r><w:br/></w:r>';
    return (node.text ? textRun(node.text, style) : '')
      + (node.children || []).map((child, index) =>
        (index && /^(p|div|li|h[1-6])$/.test(child.tag) ? '<w:r><w:br/></w:r>' : '') + inline(child, style, width)).join('');
  }
  function paragraph(runs, style, heading = false) {
    const align = ['left', 'right', 'center', 'justify'].includes(style['text-align']) ? style['text-align'] : 'left';
    return '<w:p><w:pPr>' + `<w:jc w:val="${align === 'justify' ? 'both' : align}"/>`
      + `<w:spacing w:after="${heading ? 120 : 80}"/>` + (heading ? '<w:keepNext/>' : '')
      + `</w:pPr>${runs}</w:p>`;
  }
  const containsImage = node => node.tag === 'img' || (node.children || []).some(containsImage);
  function table(rows, width, inherited) {
    const grid = [];
    let count = 1;
    const spanOf = (cell, key) => Math.min(100, Math.max(1, Number(cell.attributes?.[key]) || 1));
    rows.forEach((row, r) => {
      grid[r] ||= [];
      let col = 0;
      (row.children || []).forEach(cell => {
        const span = spanOf(cell, 'colspan'), height = Math.min(rows.length - r, spanOf(cell, 'rowspan'));
        while (Array.from({ length: span }, (_, i) => grid[r][col + i]).some(Boolean)) col++;
        for (let y = 0; y < height; y++) {
          grid[r + y] ||= [];
          for (let x = 0; x < span; x++) grid[r + y][col + x] = { cell, span, height, start: x === 0, continued: y > 0 };
        }
        col += span;
      });
      count = Math.max(count, grid[r].length);
    });
    // A photo sidebar can keep its explicit width; unspecified columns share
    // the rest. This also prevents a small headshot claiming half the page.
    let widths = Array.from({ length: count }, (_, col) => {
      const item = grid[0]?.[col];
      return item?.span === 1 ? ResumeDom.pageLengthPt(item.cell.style?.width) || 0 : 0;
    });
    const specified = widths.reduce((a, b) => a + b, 0), flexible = widths.filter(v => !v).length;
    if (specified >= width || (!flexible && !specified)) widths = widths.map(() => width / count);
    else if (flexible) widths = widths.map(v => v || (width - specified) / flexible);
    else widths = widths.map(v => v * width / specified);
    const columns = widths.map(value => `<w:gridCol w:w="${Math.round(value * 20)}"/>`).join('');
    const body = grid.map(row => '<w:tr>' + Array.from({ length: count }, (_, col) => {
      const item = row[col];
      if (item && !item.start) return '';
      const span = item?.span || 1;
      const cellWidth = widths.slice(col, col + span).reduce((a, b) => a + b, 0);
      return '<w:tc><w:tcPr>' + `<w:tcW w:w="${Math.round(cellWidth * 20)}" w:type="dxa"/>`
        + (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '')
        + (item?.continued ? '<w:vMerge/>' : item?.height > 1 ? '<w:vMerge w:val="restart"/>' : '')
        + '</w:tcPr>' + (item && !item.continued ? render(item.cell, inherited, cellWidth) : '') + '<w:p/></w:tc>';
    }).join('') + '</w:tr>').join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${Math.round(width * 20)}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${columns}</w:tblGrid>${body}</w:tbl>`;
  }
  function render(node, inherited = {}, width = usable) {
    if (editorOnly(node)) return '';
    const style = styleOf(node, inherited);
    if (node.type === 'text') return paragraph(textRun(node.value || '', style), style);
    if (node.tag === 'table') {
      const rows = [];
      const visit = n => { if (n.tag === 'tr') rows.push(n); else (n.children || []).forEach(visit); };
      visit(node); return table(rows, width, style);
    }
    const children = node.children || [];
    const horizontal = (style.display === 'flex' && style['flex-direction'] !== 'column')
      || (style.display === 'grid' && String(style['grid-template-columns'] || '').trim().split(/\s+/).length > 1);
    if (horizontal && children.length > 1 && containsImage(node)) {
      return table([{ children }], width, style);
    }
    if (node.tag === 'img' || /^h[1-6]$/.test(node.tag)
      || ['p', 'li', 'dt', 'dd', 'figcaption'].includes(node.tag) || node.editable) {
      return paragraph((node.tag === 'li' ? textRun('• ', style) : '') + inline(node, inherited, width), style, /^h[1-6]$/.test(node.tag));
    }
    return (node.text ? paragraph(textRun(node.text, style), style) : '') + children.map(child => render(child, style, width)).join('');
  }
  const body = render(document.root);
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document ${namespaces}><w:body>${body}`
    + `<w:sectPr><w:pgSz w:w="${Math.round(page.width * 20)}" w:h="${Math.round(page.height * 20)}"/>`
    + `<w:pgMar ${Object.entries(page.margins).map(([side, value]) => `w:${side}="${Math.round(value * 20)}"`).join(' ')}/>`
    + '</w:sectPr></w:body></w:document>';
  const relationships = media.map(item => `<Relationship Id="${item.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${item.name}"/>`).join('');
  return { buffer: createZip([
    ...parts.filter(part => !['word/document.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml'].includes(part.name)),
    { name: 'word/document.xml', data: xml },
    { name: 'word/_rels/document.xml.rels', data: parts.find(p => p.name === 'word/_rels/document.xml.rels').data.replace('</Relationships>', relationships + '</Relationships>') },
    { name: '[Content_Types].xml', data: parts.find(p => p.name === '[Content_Types].xml').data.replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>') },
    ...media.map(item => ({ name: 'word/media/' + item.name, data: item.buffer })),
  ]), pages: null };
}
module.exports = { buildImageDocx };
