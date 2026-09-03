'use strict';
/**
 * DOCX 渲染：结构化内容映射 OOXML（TECH §11.2）。
 * - 不通过 PDF 反转 DOCX；
 * - 固定标题、段落、列表、页边距和字体样式；
 * - 清理作者、路径、修订记录等隐私元数据。
 */
const { createZip } = require('./zip');
const ResumeDom = require('../../../resume-dom');

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 生成一段带直接格式的文本 run。 */
function run(text, { bold = false, size = 21, color = '414448', font = 'Microsoft YaHei' } = {}) {
  const content = String(text)
    .split('\n')
    .map((part, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${escape(part)}</w:t>`)
    .join('');
  return (
    `<w:r><w:rPr>` +
    `<w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/>` +
    (bold ? '<w:b/><w:bCs/>' : '') +
    `<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` +
    `</w:rPr>${content}</w:r>`
  );
}

function paragraph(runs, { spacing = 120, align = 'left', indent = 0 } = {}) {
  return (
    `<w:p><w:pPr>` +
    `<w:spacing w:before="0" w:after="${spacing}" w:line="300" w:lineRule="auto"/>` +
    `<w:jc w:val="${align}"/>` +
    (indent ? `<w:ind w:left="${indent}"/>` : '') +
    `</w:pPr>${Array.isArray(runs) ? runs.join('') : runs}</w:p>`
  );
}

/** 带底边框的标题（模拟简历模块标题）。 */
function heading(text, accent = '1D1D1F', level = 2) {
  const size = level <= 2 ? 24 : 22;
  return (
    `<w:p><w:pPr>` +
    `<w:spacing w:before="240" w:after="120"/>` +
    `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="D1D1D6"/></w:pBdr>` +
    `</w:pPr>` +
    run(text, { bold: true, size, color: accent }) +
    `</w:p>`
  );
}

function bulletParagraph(text) {
  return (
    `<w:p><w:pPr>` +
    `<w:spacing w:before="0" w:after="60" w:line="300" w:lineRule="auto"/>` +
    `<w:ind w:left="284" w:hanging="142"/>` +
    `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` +
    `</w:pPr>` +
    run(text, { size: 21 }) +
    `</w:p>`
  );
}

function colorFromCss(value, fallback = '') {
  const match = String(value || '').match(/#([0-9a-f]{6})/i);
  return match ? match[1].toUpperCase() : fallback;
}

function tableCell(cell, width) {
  const lines = cell.lines && cell.lines.length ? cell.lines : [cell.text || ''];
  const fill = colorFromCss(cell.style && cell.style['background-color']);
  const paragraphs = lines.map((line, index) => paragraph(
    run(line, { size: 19, bold: index === 0 && lines.length > 1 }),
    { spacing: index === lines.length - 1 ? 0 : 50 },
  )).join('');
  return (
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
    + (cell.colspan > 1 ? `<w:gridSpan w:val="${cell.colspan}"/>` : '')
    + (cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '')
    + (fill ? `<w:shd w:val="clear" w:fill="${fill}"/>` : '')
    + `<w:vAlign w:val="center"/><w:tcMar>`
    + `<w:top w:w="80" w:type="dxa"/><w:left w:w="90" w:type="dxa"/>`
    + `<w:bottom w:w="80" w:type="dxa"/><w:right w:w="90" w:type="dxa"/>`
    + `</w:tcMar></w:tcPr>${paragraphs}</w:tc>`
  );
}

function tableBlock(block) {
  const columnCount = Math.max(
    1,
    ...(block.rows || []).map((row) =>
      (row.cells || []).reduce((sum, cell) => sum + Math.max(1, Number(cell.colspan || 1)), 0)),
  );
  const tableWidth = 9300;
  const columnWidth = Math.floor(tableWidth / columnCount);
  const grid = Array.from({ length: columnCount }, () =>
    `<w:gridCol w:w="${columnWidth}"/>`).join('');
  const rows = (block.rows || []).map((row) => {
    const cells = (row.cells || []).map((cell) =>
      tableCell(cell, columnWidth * Math.max(1, Number(cell.colspan || 1)))).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="${tableWidth}" w:type="dxa"/>`
    + `<w:tblLayout w:type="fixed"/><w:tblBorders>`
    + `<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/>`
    + `<w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>`
    + `</w:tblBorders><w:tblCellSpacing w:w="30" w:type="dxa"/></w:tblPr>`
    + `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`
  );
}

/** 构建 document.xml 主体。 */
function buildDocumentXml(resume, template) {
  const schema = template.schema || template;
  const accent = ((schema.typography && schema.typography.accent) || '#1d1d1f').replace('#', '');
  const attached = ResumeDom.attachDocument(resume);
  const rendered = ResumeDom.toRenderBlocks(attached.dom_document);
  const body = [];

  // 页眉
  const title = (rendered.header && rendered.header.title)
    || (attached.basics && attached.basics.name)
    || '';
  if (title) {
    body.push(paragraph(run(title, { bold: true, size: 44, color: '1D1D1F' }), { spacing: 60 }));
  }
  if (rendered.header && rendered.header.subtitle) {
    body.push(paragraph(run(rendered.header.subtitle, { size: 18, color: '5F6265' }), { spacing: 180 }));
  }

  let numberedIndex = 0;
  rendered.blocks.forEach((block) => {
    if (block.type !== 'numbered') numberedIndex = 0;
    if (block.type === 'heading') {
      body.push(heading(block.text, accent, block.level));
    } else if (block.type === 'row') {
      body.push(
        paragraph(
          [
            run(block.main || block.text || '', { bold: true, size: 22, color: '1D1D1F' }),
            block.secondary ? run(`　${block.secondary}`, { size: 21, color: '4D5155' }) : '',
            block.trailing ? run(`　${block.trailing}`, { size: 18, color: '73767A' }) : '',
          ],
          { spacing: 80 },
        ),
      );
    } else if (block.type === 'bullet') {
      body.push(bulletParagraph(block.text));
    } else if (block.type === 'numbered') {
      numberedIndex += 1;
      body.push(
        paragraph(run(`${numberedIndex}. ${block.text}`, { size: 21 }), { indent: 142 }),
      );
    } else if (block.type === 'table') {
      body.push(tableBlock(block));
    } else if (block.type === 'paragraph') {
      body.push(paragraph(run(block.text, { size: 21 })));
    }
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1191" w:bottom="1134" w:left="1191" w:header="851" w:footer="992" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>
<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="284" w:hanging="142"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

/** 核心属性：不写入作者与公司等隐私元数据（TECH §11.2、§12）。 */
const CORE_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>简历</dc:title>
<dc:creator>简历星球</dc:creator>
<cp:lastModifiedBy>简历星球</cp:lastModifiedBy>
<cp:revision>1</cp:revision>
</cp:coreProperties>`;

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>简历星球</Application>
</Properties>`;

/**
 * 渲染 DOCX。
 * @returns {{buffer:Buffer, pages:number|null}} pages 为 null：DOCX 无固定页数
 */
function renderDocx({ resume, template }) {
  const documentXml = buildDocumentXml(resume, template);
  const buffer = createZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
    { name: 'docProps/core.xml', data: CORE_PROPS },
    { name: 'docProps/app.xml', data: APP_PROPS },
  ]);
  return { buffer, pages: null };
}

module.exports = { renderDocx, buildDocumentXml };
