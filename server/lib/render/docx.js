'use strict';
/**
 * DOCX 渲染：结构化内容映射 OOXML（TECH §11.2）。
 * - 不通过 PDF 反转 DOCX；
 * - 固定标题、段落、列表、页边距和字体样式；
 * - 清理作者、路径、修订记录等隐私元数据。
 */
const { createZip } = require('./zip');

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
function heading(text, accent = '1D1D1F') {
  return (
    `<w:p><w:pPr>` +
    `<w:spacing w:before="240" w:after="120"/>` +
    `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="D1D1D6"/></w:pBdr>` +
    `</w:pPr>` +
    run(text, { bold: true, size: 24, color: accent }) +
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

function periodText(item) {
  const start = item.start || item.start_date || '';
  const end = item.end || item.end_date || '';
  if (!start && !end) return '';
  return `${start} — ${end || '至今'}`;
}

/** 构建 document.xml 主体。 */
function buildDocumentXml(resume, template) {
  const schema = template.schema || template;
  const titles = (schema.section_rules && schema.section_rules.titles) || {};
  const order = (schema.section_rules && schema.section_rules.order) || [
    'summary',
    'experience',
    'projects',
    'education',
    'skills',
  ];
  const accent = ((schema.typography && schema.typography.accent) || '#1d1d1f').replace('#', '');

  const body = [];

  // 页眉
  body.push(paragraph(run(resume.basics.name || '', { bold: true, size: 44, color: '1D1D1F' }), { spacing: 60 }));
  const contactParts = [resume.headline, resume.basics.city, resume.basics.phone, resume.basics.email].filter(
    Boolean,
  );
  if (contactParts.length) {
    body.push(paragraph(run(contactParts.join('　|　'), { size: 18, color: '5F6265' }), { spacing: 180 }));
  }

  order.forEach((key) => {
    if (key === 'summary' && resume.summary) {
      body.push(heading(titles.summary || '个人优势', accent));
      body.push(paragraph(run(resume.summary, { size: 21 })));
    }
    if (key === 'experience' && (resume.experience || []).length) {
      body.push(heading(titles.experience || '工作经历', accent));
      resume.experience.forEach((item) => {
        body.push(
          paragraph(
            [
              run(item.organization || '', { bold: true, size: 22, color: '1D1D1F' }),
              run(`　${item.title || ''}`, { size: 21, color: '4D5155' }),
              run(`　${periodText(item)}`, { size: 18, color: '73767A' }),
            ],
            { spacing: 80 },
          ),
        );
        (item.bullets || []).forEach((bullet) => {
          body.push(bulletParagraph(typeof bullet === 'string' ? bullet : bullet.text));
        });
      });
    }
    if (key === 'projects' && (resume.projects || []).length) {
      body.push(heading(titles.projects || '项目经历', accent));
      resume.projects.forEach((item) => {
        body.push(
          paragraph(
            [
              run(item.name || item.organization || '', { bold: true, size: 22, color: '1D1D1F' }),
              run(`　${item.role || item.title || ''}`, { size: 21, color: '4D5155' }),
              run(`　${periodText(item)}`, { size: 18, color: '73767A' }),
            ],
            { spacing: 80 },
          ),
        );
        (item.bullets || []).forEach((bullet) => {
          body.push(bulletParagraph(typeof bullet === 'string' ? bullet : bullet.text));
        });
      });
    }
    if (key === 'education' && (resume.education || []).length) {
      body.push(heading(titles.education || '教育经历', accent));
      resume.education.forEach((item) => {
        const detail = [item.major, item.degree].filter(Boolean).join(' · ');
        body.push(
          paragraph(
            [
              run(item.school || item.organization || '', { bold: true, size: 22, color: '1D1D1F' }),
              run(`　${detail}`, { size: 21, color: '4D5155' }),
              run(`　${periodText(item)}`, { size: 18, color: '73767A' }),
            ],
            { spacing: 80 },
          ),
        );
      });
    }
    if (key === 'skills') {
      const skills = (resume.skills || []).map((skill) => (typeof skill === 'string' ? skill : skill.name));
      if (skills.length) {
        body.push(heading(titles.skills || '专业技能', accent));
        body.push(paragraph(run(skills.join('　'), { size: 21 })));
      }
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
